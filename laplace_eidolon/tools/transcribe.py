"""Transcribe a VOD audio/video file into a streams/*.md transcript.

Two providers are supported:

- ``soniox`` (default) — cloud async API, ~$0.10/hour audio, much better on
  Mandarin, game/character names, and code-switching. Reuses the
  ``SONIOX_API_KEY`` you already have set for the realtime STT bot.
- ``whisper`` — local ``faster-whisper`` (CTranslate2 backend, no PyTorch
  dependency, runs on Apple Silicon natively). Free, offline, slower, weaker
  on Mandarin punctuation and proper nouns.

Both providers return the same internal ``Segment`` shape; the rest of the
pipeline (chunk-into-scenes, render markdown) is provider-agnostic.

Workflow::

    uv sync --extra tools             # one-time, installs both backends

    # Cloud Soniox (default, better Mandarin; --language defaults to zh):
    uv run laplace-transcribe vods/2026-04-15-stream.m4a \\
        --date 2026-04-15

    # Local Whisper (free, offline):
    uv run laplace-transcribe vods/2026-04-15-stream.m4a \\
        --date 2026-04-15 \\
        --provider whisper --model medium --compute-type int8

    # Auto-detect language (override the zh default):
    uv run laplace-transcribe vods/foo.m4a --language ""

    # One-off vocabulary spike (new game/show, unfamiliar proper nouns)?
    # Override the default glossary for this run only:
    uv run laplace-transcribe vods/foo.m4a \\
        --context-file path/to/my_glossary.toml

    # Then ingest into the LanceDB stream archive:
    uv run laplace-ingest-streams

Chunking strategy
-----------------
Both providers emit fine-grained units (Whisper: 5–30s segments, Soniox:
sub-word tokens). For retrieval purposes that's too granular — every chunk
would be a few sentences with no context. We group everything into
fixed-time windows (default 5 minutes) so each H2 section is a coherent
"scene". You can hand-edit the output afterwards to split or merge
sections; H2 boundaries drive what gets indexed.

The first sentence of each scene becomes the heading hint. You'll usually
want to replace it with something more descriptive ("00:15 — Stone Talus
fight" instead of "00:15 — So I'm heading into Eldin..."). Manual editing
of these files is a feature, not a chore — your judgment beats the
transcriber's sentence boundaries every time.

Soniox glossary / structured context
------------------------------------
Soniox accepts a "structured context" hint with each job that biases the
model toward your domain vocabulary — character names, audience slang,
recurring topics. For Mandarin streams full of proper nouns and
code-switching, this is a huge accuracy win. We load it from a TOML file
(default ``server/soniox_context.toml``) and pass it on every soniox run.

The context is intentionally **per-project**, not per-stream. A single VOD
often spans chat, gaming, karaoke, and watchalongs, so a single per-stream
"topic" hint would be misleading. Per-scene topics live on each chunk
post-refinement (see ``tools/refine.py``); Soniox just gets the project's
recurring vocabulary.

  --context-file PATH    Use a different TOML file for this run.
  --no-context           Skip context entirely (clean A/B comparison).

Schema and limits: https://soniox.com/docs/stt/concepts/context
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from loguru import logger

# Both backends live in the optional `[tools]` extra; type-checkers running
# against the runtime extras alone can't see them. Imports are deferred into
# the dispatcher functions so missing extras yield a friendly error instead
# of an import-time crash.


# ──────────────────────────────────────────────────────────────────────
# Provider-agnostic shapes — both transcribers funnel through these so the
# downstream chunker and renderer stay backend-unaware.
# ──────────────────────────────────────────────────────────────────────


@dataclass
class Segment:
    """Provider-agnostic segment (matches faster-whisper's Segment surface).

    Times are in **seconds** so the existing chunker works unchanged.
    """

    start: float
    end: float
    text: str


@dataclass
class TranscribeInfo:
    """Audio-level metadata returned alongside segments.

    ``raw`` is an optional provider-specific payload — currently only the
    Soniox backend populates it (full transcription metadata + per-token
    timing/confidence). Saved verbatim to a sibling ``.soniox.json`` so
    you can re-chunk locally without re-paying the transcription bill.
    """

    duration: float  # seconds; 0 if unknown
    language: str | None  # detected/declared ISO code, e.g. "zh"
    raw: dict[str, Any] | None = field(default=None)


def _format_ts(seconds: float) -> str:
    """``734.5`` → ``"00:12:14"``."""
    total = int(seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def _short_ts(seconds: float) -> str:
    """``734.5`` → ``"00:12"`` (used in H2 headings, hours dropped if 0)."""
    total = int(seconds)
    h, rem = divmod(total, 3600)
    m, _ = divmod(rem, 60)
    if h:
        return f"{h:02d}:{m:02d}"
    return f"{m:02d}:00"


def _format_dur(seconds: float) -> str:
    """Friendly duration: ``42`` → ``"42s"``, ``312`` → ``"5m12s"``,
    ``5025`` → ``"1h23m"``."""
    s = int(max(0, seconds))
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m{s % 60:02d}s"
    return f"{s // 3600}h{(s % 3600) // 60:02d}m"


def _heading_hint(text: str, max_chars: int = 60) -> str:
    """First sentence-ish, trimmed. Used as a placeholder H2 label."""
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return "(no transcript)"
    sentence = re.split(r"(?<=[.!?。！？])\s", text, maxsplit=1)[0]
    sentence = sentence.strip().rstrip(".!?。！？")
    if len(sentence) > max_chars:
        sentence = sentence[: max_chars - 1].rstrip() + "…"
    return sentence


def group_segments_into_scenes(
    segments: list[Any],
    window_seconds: int,
) -> list[dict[str, Any]]:
    """Bucket Whisper segments into fixed-time scenes.

    Returns a list of scenes with ``start``, ``end``, and ``text`` (joined
    transcript for that window).
    """
    if not segments:
        return []
    scenes: list[dict[str, Any]] = []
    current_start: float | None = None
    current_end: float = 0.0
    current_parts: list[str] = []

    for seg in segments:
        if current_start is None:
            current_start = (seg.start // window_seconds) * window_seconds
        # If this segment starts in a new window, flush the current scene.
        if seg.start - current_start >= window_seconds:
            scenes.append(
                {
                    "start": current_start,
                    "end": current_end,
                    "text": " ".join(current_parts).strip(),
                }
            )
            current_start = (seg.start // window_seconds) * window_seconds
            current_parts = []
        current_parts.append(seg.text.strip())
        current_end = seg.end

    if current_parts and current_start is not None:
        scenes.append(
            {
                "start": current_start,
                "end": current_end,
                "text": " ".join(current_parts).strip(),
            }
        )
    return scenes


def render_markdown(
    *,
    stream_date: str,
    stream_id: str,
    duration_min: int,
    scenes: list[dict[str, Any]],
    source_file: str,
    language: str | None,
) -> str:
    """Assemble the final markdown file (frontmatter + H2 scenes)."""
    fm_lines = [
        "---",
        f"stream_date: {stream_date}",
        f"stream_id: {stream_id}",
        f"duration_min: {duration_min}",
    ]
    if language:
        fm_lines.append(f"language: {language}")
    fm_lines.append(f"source_file: {source_file}")
    fm_lines.append("---")
    fm_lines.append("")

    body_lines: list[str] = []
    for scene in scenes:
        start = float(scene["start"])
        text = str(scene["text"])
        ts = _short_ts(start)
        hint = _heading_hint(text)
        body_lines.append(f"## {ts} — {hint}")
        body_lines.append("")
        body_lines.append(text)
        body_lines.append("")

    return "\n".join(fm_lines + body_lines).rstrip() + "\n"


# ──────────────────────────────────────────────────────────────────────
# Provider: faster-whisper (local)
# ──────────────────────────────────────────────────────────────────────

PROGRESS_EVERY_SEC = 10.0


def transcribe_with_whisper(
    args: argparse.Namespace,
) -> tuple[list[Segment], TranscribeInfo]:
    """Transcribe ``args.audio`` locally with faster-whisper.

    Drains the segment generator with periodic progress + ETA logs so a
    multi-hour VOD doesn't sit silent for the entire run.
    """
    try:
        from faster_whisper import WhisperModel  # type: ignore[import-not-found]
    except ImportError as e:
        raise RuntimeError(
            "faster-whisper is not installed. Install the tools extra:\n    uv sync --extra tools"
        ) from e

    logger.info(f"Loading Whisper model: {args.model} (device={args.device})")
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)

    logger.info(f"Transcribing {args.audio}…")
    segments_iter, info = model.transcribe(
        str(args.audio),
        language=args.language,
        vad_filter=True,
    )

    # `model.transcribe` returns a generator — segments are produced lazily
    # as ctranslate2 chews through the audio. Materializing the whole thing
    # with `list(...)` would block silently for tens of minutes on a long
    # VOD. Drain it manually and emit a progress line every
    # PROGRESS_EVERY_SEC of wall time so the user sees an ETA.
    duration_sec = info.duration
    detected_lang = info.language
    logger.info(
        f"Audio loaded: {_format_ts(duration_sec)} of {detected_lang} audio. "
        f"Streaming segments… (progress every {int(PROGRESS_EVERY_SEC)}s)"
    )

    segments: list[Segment] = []
    start_wall = time.monotonic()
    last_log = -float("inf")
    for seg in segments_iter:
        segments.append(Segment(start=seg.start, end=seg.end, text=seg.text))
        now = time.monotonic()
        if now - last_log < PROGRESS_EVERY_SEC:
            continue
        last_log = now
        elapsed = now - start_wall
        pos = seg.end
        if duration_sec > 0:
            pct = min(1.0, pos / duration_sec)
            eta = (elapsed * (1 - pct) / pct) if pct > 0 else 0.0
            rate = (pos / elapsed) if elapsed > 0 else 0.0
            logger.info(
                f"  {pct * 100:5.1f}%  audio {_format_ts(pos)}/{_format_ts(duration_sec)}  "
                f"elapsed {_format_dur(elapsed)}  ETA {_format_dur(eta)}  "
                f"({rate:.2f}x realtime, {len(segments)} segments)"
            )
        else:
            logger.info(
                f"  audio {_format_ts(pos)}  elapsed {_format_dur(elapsed)}  "
                f"({len(segments)} segments)"
            )

    elapsed = time.monotonic() - start_wall
    if duration_sec > 0 and elapsed > 0:
        logger.info(
            f"Whisper done: {len(segments)} segments, "
            f"{_format_ts(duration_sec)} of audio in {_format_dur(elapsed)} "
            f"({duration_sec / elapsed:.2f}x realtime, language={detected_lang})"
        )
    return segments, TranscribeInfo(duration=duration_sec, language=detected_lang)


# ──────────────────────────────────────────────────────────────────────
# Provider: Soniox (cloud async)
# ──────────────────────────────────────────────────────────────────────

# Soniox returns sub-word tokens with millisecond timestamps. We group
# consecutive tokens into pseudo-segments roughly comparable to Whisper's
# 5-30s segments so the downstream chunker behaves identically. A segment
# closes when EITHER:
#   - it ends with sentence-final punctuation AND is at least
#     SONIOX_MIN_SEGMENT_SEC long, OR
#   - it reaches SONIOX_MAX_SEGMENT_SEC.
SONIOX_MIN_SEGMENT_SEC = 3.0
SONIOX_MAX_SEGMENT_SEC = 30.0
_SENTENCE_END_RE = re.compile(r"[.!?。！？]\s*$")
# Soniox's hard limit per file; fail fast rather than discovering this
# server-side after a full upload.
SONIOX_MAX_DURATION_MIN = 300
# Default per-part cap when --auto-slice is on. Sits well below the hard
# 300-min cap so server-side measurement drift, container padding, or the
# odd extra frame doesn't tip a slice over the line. 280 min leaves a
# comfortable ~20 min margin and keeps part counts low for typical
# 300–340 min VODs (2 parts each).
SONIOX_SLICE_MAX_MIN_DEFAULT = 280

# Structured context shape — see https://soniox.com/docs/stt/concepts/context
SONIOX_CONTEXT_ALLOWED_KEYS = {"general", "text", "terms", "translation_terms"}
# Soniox caps context at ~8000 tokens. We approximate as ~10k characters
# (deliberately conservative — CJK chars are typically 1 token each, English
# is closer to ~4 chars/token, so this errs on the safe side for mixed
# Mandarin/English content).
SONIOX_CONTEXT_MAX_CHARS = 10_000


def _load_soniox_context_dict(
    path: Path | None,
    *,
    skip: bool,
) -> dict[str, Any] | None:
    """Load a TOML glossary file and return it as a Soniox-shaped dict.

    The returned dict matches Soniox's ``StructuredContext`` schema —
    ``general`` / ``text`` / ``terms`` / ``translation_terms`` — and can
    be passed straight into ``StructuredContext(**dict)``. Returns
    ``None`` when context is disabled, the file is missing, or the file
    contains nothing usable.
    """
    if skip:
        return None
    if path is None:
        return None
    if not path.exists():
        # Friendly heads-up rather than a hard error: the user might just
        # not have created the file yet, and that's fine.
        logger.info(
            f"No Soniox context file at {path} — running without glossary. "
            f"Create one to bias the model toward your vocabulary."
        )
        return None

    try:
        import tomllib  # Python 3.11+ stdlib
    except ImportError as e:
        raise RuntimeError(
            "Soniox context loading needs Python 3.11+ (stdlib tomllib). "
            f"You're on {sys.version_info.major}.{sys.version_info.minor}. "
            "Either upgrade Python or pass --no-context."
        ) from e

    with path.open("rb") as f:
        raw: dict[str, Any] = tomllib.load(f)

    # Warn (don't fail) on unknown top-level keys so typos surface fast.
    unknown = set(raw.keys()) - SONIOX_CONTEXT_ALLOWED_KEYS
    if unknown:
        logger.warning(
            f"Ignoring unknown keys in {path}: {sorted(unknown)}. "
            f"Allowed: {sorted(SONIOX_CONTEXT_ALLOWED_KEYS)}."
        )
        for k in unknown:
            raw.pop(k)

    # Defensive per-entry shape check. The most common TOML mistake is
    # putting a top-level scalar (`text = "..."` or `terms = [...]`) AFTER
    # a `[[general]]` array-of-tables block — TOML silently nests it inside
    # the last general entry instead of at the root. Catch it loudly so
    # the user fixes the file rather than running with phantom context.
    for i, item in enumerate(raw.get("general") or []):
        extras = set(item.keys()) - {"key", "value"}
        if extras:
            raise RuntimeError(
                f"{path}: general[{i}] has unexpected keys {sorted(extras)}. "
                f"Each [[general]] entry must contain ONLY `key` and `value`. "
                f'Hint: top-level scalars like `text = "..."` and '
                f"`terms = [...]` MUST appear ABOVE all [[general]] / "
                f"[[translation_terms]] blocks in the TOML — otherwise TOML "
                f"silently nests them into the last array entry."
            )
    for i, item in enumerate(raw.get("translation_terms") or []):
        extras = set(item.keys()) - {"source", "target"}
        if extras:
            raise RuntimeError(
                f"{path}: translation_terms[{i}] has unexpected keys "
                f"{sorted(extras)}. Each entry must contain ONLY `source` "
                f"and `target`. (Same TOML-ordering pitfall as above.)"
            )

    # Strip empty / falsy sections so the final payload is minimal.
    raw = {k: v for k, v in raw.items() if v}

    if not raw:
        return None

    # Soft size check: warn if approaching the limit, error if over.
    serialized = json.dumps(raw, ensure_ascii=False)
    char_count = len(serialized)
    if char_count > SONIOX_CONTEXT_MAX_CHARS:
        raise RuntimeError(
            f"Soniox context from {path} is {char_count} chars "
            f"(~{char_count // 4} tokens), which exceeds the ~8000-token / "
            f"~{SONIOX_CONTEXT_MAX_CHARS}-char limit. Trim or split the file."
        )
    if char_count > SONIOX_CONTEXT_MAX_CHARS * 0.8:
        logger.warning(
            f"Soniox context is {char_count} chars — within 20% of the "
            f"~{SONIOX_CONTEXT_MAX_CHARS}-char limit. Consider trimming."
        )

    return raw


def _summarize_soniox_context(ctx: dict[str, Any]) -> str:
    """One-line summary suitable for an info log."""
    parts: list[str] = []
    if "general" in ctx:
        parts.append(f"{len(ctx['general'])} general")
    if "text" in ctx:
        parts.append(f"{len(ctx['text'])} chars text")
    if "terms" in ctx:
        parts.append(f"{len(ctx['terms'])} terms")
    if "translation_terms" in ctx:
        parts.append(f"{len(ctx['translation_terms'])} translation_terms")
    return ", ".join(parts) if parts else "(empty)"


def _tokens_to_segments(tokens: list[Any]) -> list[Segment]:
    """Group Soniox tokens into Whisper-shaped segments.

    Tokens carry ``start_ms``, ``end_ms``, and ``text``. Joining is just
    concatenation — Soniox already includes leading whitespace where the
    target language requires it (English does, Mandarin doesn't), so naive
    ``"".join(...)`` produces correct output for both.
    """
    segments: list[Segment] = []
    cur_start: float | None = None
    cur_end: float = 0.0
    cur_parts: list[str] = []

    def _flush() -> None:
        nonlocal cur_start, cur_end, cur_parts
        if not cur_parts or cur_start is None:
            return
        text = "".join(cur_parts).strip()
        if text:
            segments.append(Segment(start=cur_start, end=cur_end, text=text))
        cur_start = None
        cur_end = 0.0
        cur_parts = []

    for tok in tokens:
        # Skip tokens without timing (rare, defensive).
        if tok.start_ms is None or tok.end_ms is None:
            continue
        start = tok.start_ms / 1000.0
        end = tok.end_ms / 1000.0
        if cur_start is None:
            cur_start = start
        cur_parts.append(tok.text)
        cur_end = end

        dur = cur_end - cur_start  # type: ignore[operator]  # cur_start is non-None here
        ends_sentence = bool(_SENTENCE_END_RE.search("".join(cur_parts)))
        if (ends_sentence and dur >= SONIOX_MIN_SEGMENT_SEC) or dur >= SONIOX_MAX_SEGMENT_SEC:
            _flush()

    _flush()
    return segments


def transcribe_with_soniox(
    args: argparse.Namespace,
) -> tuple[list[Segment], TranscribeInfo]:
    """Transcribe via Soniox cloud async API.

    For files within the 300-min cap this is a single upload+poll+fetch
    cycle (delegated to ``_soniox_transcribe_single``). For longer files,
    if ``--auto-slice`` is set, the audio is split into ≤ ``--slice-max-min``
    minute parts via ffmpeg, each part is transcribed independently, and
    the resulting segments / tokens are merged with offset timestamps so
    the rest of the pipeline (chunker, markdown renderer, ingest) sees
    one logical transcript. Without ``--auto-slice`` we fail fast with a
    helpful message rather than silently spending a long upload.
    """
    try:
        from soniox import SonioxClient
        from soniox.types import CreateTranscriptionConfig, StructuredContext
    except ImportError as e:
        raise RuntimeError(
            "soniox SDK is not installed. Install the tools extra:\n    uv sync --extra tools"
        ) from e

    if not os.getenv("SONIOX_API_KEY"):
        raise RuntimeError(
            "SONIOX_API_KEY is not set. Add it to .env (it's the same key "
            "you already use for the realtime STT in the bot)."
        )

    # Soniox enforces a hard 300-minute per-file limit. Probe the duration
    # via ffprobe (already installed because faster-whisper pulls av) so we
    # can fail fast instead of after a multi-minute upload.
    duration_sec = _probe_duration_sec(args.audio)
    auto_slice = getattr(args, "auto_slice", False)
    if duration_sec is not None and duration_sec / 60 > SONIOX_MAX_DURATION_MIN:
        if not auto_slice:
            raise RuntimeError(
                f"Audio is {duration_sec / 60:.1f} min — Soniox caps async jobs "
                f"at {SONIOX_MAX_DURATION_MIN} min per file. Re-run with "
                f"--auto-slice to chunk it via ffmpeg, or use --provider whisper."
            )
        return _transcribe_with_soniox_sliced(
            args,
            duration_sec=duration_sec,
            client_cls=SonioxClient,
            config_cls=CreateTranscriptionConfig,
            structured_context_cls=StructuredContext,
        )

    # Structured context (glossary + domain hints) — biases the model
    # toward project vocabulary. Returns None if the file is missing or
    # --no-context was passed; the request just goes out without context.
    context_dict = _load_soniox_context_dict(
        args.context_file,
        skip=args.no_context,
    )
    structured_context: StructuredContext | None = None
    if context_dict is not None:
        structured_context = StructuredContext(**context_dict)
        logger.info(
            f"Soniox context: {_summarize_soniox_context(context_dict)} (from {args.context_file})"
        )

    client = SonioxClient()
    segments, raw_payload, server_duration_sec = _soniox_transcribe_single(
        client=client,
        audio_path=args.audio,
        client_reference_id=f"laplace-eidolon:{args.audio.name}",
        soniox_model=args.soniox_model,
        language=args.language,
        structured_context=structured_context,
        context_dict=context_dict,
        keep_files=args.keep_soniox_files,
        config_cls=CreateTranscriptionConfig,
        probed_duration_sec=duration_sec,
    )
    final_duration = server_duration_sec or (duration_sec or 0.0)
    return segments, TranscribeInfo(
        duration=final_duration,
        language=args.language,
        raw=raw_payload,
    )


def _soniox_transcribe_single(
    *,
    client: Any,
    audio_path: Path,
    client_reference_id: str,
    soniox_model: str,
    language: str | None,
    structured_context: Any | None,
    context_dict: dict[str, Any] | None,
    keep_files: bool,
    config_cls: Any,
    probed_duration_sec: float | None,
) -> tuple[list[Segment], dict[str, Any], float]:
    """Upload one file to Soniox, poll, fetch tokens, return (segments, raw, dur).

    Cleanup is unconditional in the ``finally`` so caller doesn't have to
    track ``transcription_id`` themselves. Returns the raw payload shaped
    exactly like the historical ``.soniox.json`` schema so the on-disk
    format is stable across single-file and sliced runs.
    """
    language_hints = [language] if language else None
    config = config_cls(
        language_hints=language_hints,
        context=structured_context,
        client_reference_id=client_reference_id,
    )

    file_size_mb = audio_path.stat().st_size / (1024 * 1024)
    logger.info(
        f"Uploading {file_size_mb:.1f} MB to Soniox "
        f"(model={soniox_model}, language_hints={language_hints})…"
    )
    transcription_id: str | None = None
    start_wall = time.monotonic()
    try:
        transcription = client.stt.transcribe(
            model=soniox_model,
            file=audio_path,
            config=config,
        )
        transcription_id = transcription.id
        logger.info(
            f"Job submitted: id={transcription_id}, status={transcription.status}. "
            f"Polling every 5s…"
        )

        last_status: str | None = None
        last_log = time.monotonic()
        while True:
            t = client.stt.get(transcription_id)
            elapsed = time.monotonic() - start_wall
            now = time.monotonic()

            # Always log on status transitions; otherwise heartbeat every 10s.
            should_log = t.status != last_status or now - last_log >= PROGRESS_EVERY_SEC
            if should_log:
                last_log = now
                last_status = t.status
                audio_dur = (
                    f", audio={_format_ts((t.audio_duration_ms or 0) / 1000)}"
                    if t.audio_duration_ms
                    else ""
                )
                logger.info(f"  status={t.status}  elapsed {_format_dur(elapsed)}{audio_dur}")

            if t.status == "completed":
                break
            if t.status == "error":
                raise RuntimeError(f"Soniox job failed: {t.error_type}: {t.error_message}")
            time.sleep(5)

        transcript = client.stt.get_transcript(transcription_id)
        tokens = transcript.tokens or []
        segments = _tokens_to_segments(tokens)
        elapsed = time.monotonic() - start_wall

        # Prefer the server's measured duration over our ffprobe estimate
        # since Soniox is the source of truth for what was actually processed.
        server_duration_sec = (
            (t.audio_duration_ms or 0) / 1000.0
            if t.audio_duration_ms
            else (probed_duration_sec or 0.0)
        )
        if server_duration_sec > 0 and elapsed > 0:
            logger.info(
                f"Soniox done: {len(tokens)} tokens → {len(segments)} segments, "
                f"{_format_ts(server_duration_sec)} of audio in {_format_dur(elapsed)} "
                f"({server_duration_sec / elapsed:.2f}x realtime)"
            )

        # Build the raw payload for sibling ``.soniox.json``. The Soniox SDK
        # types are Pydantic models, so ``model_dump(mode="json")`` handles
        # datetimes and any nested types cleanly. We also persist the exact
        # `context` we sent so future re-runs / refinement passes can audit
        # what biased the model — and so renaming a glossary entry doesn't
        # silently invalidate yesterday's transcripts.
        raw_payload: dict[str, Any] = {
            "provider": "soniox",
            "transcription_id": transcription_id,
            "model": soniox_model,
            "language_hints": language_hints,
            "context": context_dict,
            "audio_filename": t.filename,
            "audio_duration_ms": t.audio_duration_ms,
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "transcript": {
                "id": transcript.id,
                "text": transcript.text,
                "tokens": [tok.model_dump(mode="json") for tok in tokens],
            },
        }
        return segments, raw_payload, server_duration_sec
    finally:
        if transcription_id and not keep_files:
            try:
                client.stt.destroy(transcription_id)
                logger.info(f"Cleaned up Soniox job {transcription_id}")
            except Exception as e:
                logger.warning(f"Failed to cleanup Soniox job {transcription_id}: {e}")


def _ffmpeg_slice(
    audio: Path,
    *,
    start_sec: float,
    duration_sec: float,
    out_path: Path,
) -> None:
    """Cut ``[start_sec, start_sec + duration_sec)`` from ``audio`` to ``out_path``.

    Uses ``-c copy`` so the slice is fast and lossless — no re-encoding,
    no quality drift between parts and the original. Keyframe-bounded
    cuts can drift by up to a few seconds on either side; for speech
    that's well below scene-window granularity (5 min) and the
    timestamps we *reconstruct* are based on the requested start, not
    where ffmpeg actually landed, so the merged transcript stays
    monotonic regardless.
    """
    import shutil
    import subprocess

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError(
            "ffmpeg not found on PATH — required for --auto-slice. Install "
            "ffmpeg (brew install ffmpeg / apt install ffmpeg) and retry."
        )

    cmd = [
        ffmpeg,
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{start_sec:.3f}",
        "-t",
        f"{duration_sec:.3f}",
        "-i",
        str(audio),
        "-c",
        "copy",
        # Drop video streams if present (e.g. mp4 with cover art) — Soniox
        # only needs audio and a stripped file uploads faster.
        "-vn",
        "-map_metadata",
        "-1",
        str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg slice failed (exit={proc.returncode}) for "
            f"{audio.name} [{start_sec:.1f}s + {duration_sec:.1f}s]:\n"
            f"{proc.stderr.strip()}"
        )


def _transcribe_with_soniox_sliced(
    args: argparse.Namespace,
    *,
    duration_sec: float,
    client_cls: Any,
    config_cls: Any,
    structured_context_cls: Any,
) -> tuple[list[Segment], TranscribeInfo]:
    """Split oversized audio with ffmpeg, transcribe each part, merge.

    Each part is independently uploaded to Soniox and cleaned up before
    the next one starts (sequential, single Soniox job in flight at a
    time — keeps memory low and respects per-account concurrency caps
    when the outer pipeline is already parallelising across files).

    Segments and tokens from each part have their timestamps shifted by
    the part's start offset so the merged transcript is monotonic and
    looks identical to a single-file transcription downstream.

    Original audio is never modified — all slices live in a
    ``TemporaryDirectory`` that's wiped on exit (including exceptions).
    """
    import math
    import tempfile

    slice_max_min = getattr(args, "slice_max_min", SONIOX_SLICE_MAX_MIN_DEFAULT)
    if slice_max_min <= 0 or slice_max_min > SONIOX_MAX_DURATION_MIN:
        raise RuntimeError(
            f"--slice-max-min must be in (0, {SONIOX_MAX_DURATION_MIN}], got {slice_max_min}"
        )
    part_max_sec = slice_max_min * 60.0
    n_parts = math.ceil(duration_sec / part_max_sec)
    # Even split so part sizes are balanced rather than "N-1 full parts
    # + one tiny tail". Soniox bills per-second so total cost is the
    # same; balanced parts just make wall-clock progress more predictable.
    part_dur_sec = duration_sec / n_parts

    logger.info(
        f"Auto-slicing {args.audio.name}: {duration_sec / 60:.1f} min "
        f"→ {n_parts} parts × ~{part_dur_sec / 60:.1f} min "
        f"(cap={slice_max_min} min/part)"
    )

    # Build context once and reuse across parts — sending it with every
    # part keeps Soniox's bias consistent across the merged transcript.
    context_dict = _load_soniox_context_dict(
        args.context_file,
        skip=args.no_context,
    )
    structured_context: Any | None = None
    if context_dict is not None:
        structured_context = structured_context_cls(**context_dict)
        logger.info(
            f"Soniox context: {_summarize_soniox_context(context_dict)} (from {args.context_file})"
        )

    client = client_cls()
    merged_segments: list[Segment] = []
    merged_tokens: list[dict[str, Any]] = []
    merged_text_parts: list[str] = []
    part_payloads: list[dict[str, Any]] = []
    total_server_duration_sec = 0.0

    suffix = args.audio.suffix or ".m4a"
    with tempfile.TemporaryDirectory(prefix="laplace-slice-") as tmp_str:
        tmp_dir = Path(tmp_str)
        for i in range(n_parts):
            offset_sec = i * part_dur_sec
            # Last part absorbs any rounding remainder so we always cover
            # the full source duration without depending on ffmpeg's
            # exact landing point.
            this_dur_sec = (
                duration_sec - offset_sec if i == n_parts - 1 else part_dur_sec
            )
            part_path = tmp_dir / f"part_{i + 1:02d}_of_{n_parts:02d}{suffix}"

            logger.info(
                f"[part {i + 1}/{n_parts}] slicing "
                f"{_format_ts(offset_sec)} + {_format_ts(this_dur_sec)} → {part_path.name}"
            )
            _ffmpeg_slice(
                args.audio,
                start_sec=offset_sec,
                duration_sec=this_dur_sec,
                out_path=part_path,
            )

            part_segments, part_raw, part_server_dur = _soniox_transcribe_single(
                client=client,
                audio_path=part_path,
                client_reference_id=(
                    f"laplace-eidolon:{args.audio.name}:part_{i + 1}_of_{n_parts}"
                ),
                soniox_model=args.soniox_model,
                language=args.language,
                structured_context=structured_context,
                context_dict=context_dict,
                keep_files=args.keep_soniox_files,
                config_cls=config_cls,
                probed_duration_sec=this_dur_sec,
            )

            # Offset segments. ``Segment`` is a dataclass with float
            # start/end in seconds — shift both by the part's wall-clock
            # offset so the merged stream reads as if it came from one
            # continuous transcription.
            for s in part_segments:
                merged_segments.append(
                    Segment(start=s.start + offset_sec, end=s.end + offset_sec, text=s.text)
                )

            # Offset raw tokens too so the persisted .soniox.json can be
            # re-chunked later without losing the global timeline. Tokens
            # use millisecond ints; missing values stay None.
            offset_ms = int(offset_sec * 1000)
            tokens = part_raw.get("transcript", {}).get("tokens") or []
            for tok in tokens:
                if tok.get("start_ms") is not None:
                    tok["start_ms"] = tok["start_ms"] + offset_ms
                if tok.get("end_ms") is not None:
                    tok["end_ms"] = tok["end_ms"] + offset_ms
            merged_tokens.extend(tokens)

            part_text = part_raw.get("transcript", {}).get("text") or ""
            if part_text:
                merged_text_parts.append(part_text)

            total_server_duration_sec += part_server_dur or this_dur_sec

            # Keep a per-part audit trail (ids, model, etc.) without the
            # heavy token list — that lives in merged_tokens above.
            part_payloads.append(
                {
                    "part_index": i + 1,
                    "part_count": n_parts,
                    "offset_sec": offset_sec,
                    "duration_sec": this_dur_sec,
                    "transcription_id": part_raw.get("transcription_id"),
                    "audio_filename": part_raw.get("audio_filename"),
                    "audio_duration_ms": part_raw.get("audio_duration_ms"),
                    "created_at": part_raw.get("created_at"),
                    "transcript_id": (part_raw.get("transcript") or {}).get("id"),
                }
            )
        # tmp_dir (and all part files) auto-delete here, including on
        # exceptions thrown above.

    final_duration_sec = total_server_duration_sec or duration_sec
    logger.info(
        f"Merged {n_parts} parts: {len(merged_segments)} segments, "
        f"{len(merged_tokens)} tokens, {_format_ts(final_duration_sec)} total"
    )

    merged_raw: dict[str, Any] = {
        "provider": "soniox",
        "sliced": True,
        "slice_max_min": slice_max_min,
        "model": args.soniox_model,
        "language_hints": [args.language] if args.language else None,
        "context": context_dict,
        "audio_filename": args.audio.name,
        "audio_duration_ms": int(final_duration_sec * 1000),
        "parts": part_payloads,
        "transcript": {
            # No single transcript id for sliced runs — use the first
            # part's so anything keying on "transcript.id" still works.
            "id": part_payloads[0]["transcript_id"] if part_payloads else None,
            "text": "".join(merged_text_parts),
            "tokens": merged_tokens,
        },
    }

    return merged_segments, TranscribeInfo(
        duration=final_duration_sec,
        language=args.language,
        raw=merged_raw,
    )


def _probe_duration_sec(path: Path) -> float | None:
    """Return audio duration in seconds via ffprobe, or None on failure.

    Used as a pre-flight check for Soniox's 300-minute per-file limit so
    we don't waste a multi-minute upload just to get rejected server-side.
    """
    import shutil
    import subprocess

    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        out = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return float(out.stdout.strip()) if out.returncode == 0 else None
    except Exception:
        return None


# ──────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────


def main() -> int:
    # Load .env so SONIOX_API_KEY (and any other env vars) are picked up
    # regardless of whether the user activated their venv beforehand.
    try:
        from dotenv import load_dotenv

        load_dotenv(override=True)
    except ImportError:
        pass  # dotenv missing is fine; env may already be exported.

    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("audio", type=Path, help="VOD file (mp3, m4a, mp4, wav, ...)")
    parser.add_argument(
        "--provider",
        choices=("whisper", "soniox"),
        default="soniox",
        help="Transcription backend (default: soniox, cloud).",
    )
    parser.add_argument(
        "--date",
        default=date.today().isoformat(),
        help="Stream date YYYY-MM-DD (default: today)",
    )
    parser.add_argument(
        "--language",
        default="zh",
        help=(
            "ISO 639-1 code (e.g. 'en', 'zh'). For whisper: language to use. "
            "For soniox: language hint (model still auto-detects). Default: zh "
            "(this project is Mandarin-focused). Pass --language '' for auto-detect."
        ),
    )
    parser.add_argument(
        "--window",
        type=int,
        default=300,
        help="Scene window in seconds (default: 300 = 5 minutes)",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("streams"),
        help="Output directory (default: streams/)",
    )

    whisper_group = parser.add_argument_group("whisper provider")
    whisper_group.add_argument(
        "--model",
        default="small",
        help="Whisper model size: tiny, base, small, medium, large-v3 (default: small)",
    )
    whisper_group.add_argument(
        "--device",
        default="auto",
        help="faster-whisper device: cpu, cuda, auto (default: auto)",
    )
    whisper_group.add_argument(
        "--compute-type",
        default="default",
        help="faster-whisper compute type: int8, int8_float16, float16, default",
    )

    soniox_group = parser.add_argument_group("soniox provider")
    soniox_group.add_argument(
        "--soniox-model",
        default="stt-async-v4",
        help="Soniox async STT model (default: stt-async-v4)",
    )
    soniox_group.add_argument(
        "--keep-soniox-files",
        action="store_true",
        help=(
            "Don't delete the uploaded file + transcription record from "
            "Soniox after success. Default is to clean up so the 10GB / "
            "1000-file quota stays open."
        ),
    )
    # Default lives next to ``server/`` so the path is invariant under CWD —
    # someone running from ``server/tools/`` still hits the same file.
    _default_context = Path(__file__).resolve().parent.parent / "soniox_context.toml"
    soniox_group.add_argument(
        "--context-file",
        type=Path,
        default=_default_context,
        help=(
            "TOML file with structured context (glossary + domain hints) "
            "passed to Soniox to improve accuracy. Mirrors Soniox's "
            "StructuredContext schema. Defaults to "
            f"{_default_context.name} next to server/. Missing file is "
            "fine — the run just goes out without context."
        ),
    )
    soniox_group.add_argument(
        "--no-context",
        action="store_true",
        help=(
            "Skip the context file even if it exists. Useful for clean "
            "A/B comparisons or when you want to confirm a transcription "
            "issue is not caused by your glossary."
        ),
    )
    soniox_group.add_argument(
        "--auto-slice",
        action="store_true",
        help=(
            f"When the source audio exceeds Soniox's {SONIOX_MAX_DURATION_MIN}-min "
            "per-file cap, split it with ffmpeg into multiple parts, "
            "transcribe each independently, and merge the segments + "
            "tokens with offset timestamps. Original file is never "
            "modified — slices live in a temp directory and are wiped "
            "on exit. Default off so the existing fail-fast behavior "
            "is preserved for one-off runs."
        ),
    )
    soniox_group.add_argument(
        "--slice-max-min",
        type=int,
        default=SONIOX_SLICE_MAX_MIN_DEFAULT,
        help=(
            "Max minutes per slice when --auto-slice is on (default: "
            f"{SONIOX_SLICE_MAX_MIN_DEFAULT}). Must be ≤ "
            f"{SONIOX_MAX_DURATION_MIN}. Lower values produce more "
            "parts and more Soniox jobs but tolerate more drift from "
            "ffmpeg's keyframe-bounded cuts."
        ),
    )

    args = parser.parse_args()

    # Normalize empty `--language ""` (the documented "auto" escape hatch)
    # to None so faster-whisper's language= kwarg gets a real None rather
    # than an invalid empty string.
    if args.language == "":
        args.language = None

    if not args.audio.exists():
        logger.error(f"Audio file not found: {args.audio}")
        # BLREC-style filenames are long and full of CJK + punctuation; a
        # single missing `!!` or `_1` is hard to spot. Suggest siblings whose
        # name is a near match so the user can copy-paste the correct one.
        parent = args.audio.parent
        if parent.exists():
            try:
                from difflib import get_close_matches

                names = [p.name for p in parent.iterdir() if p.is_file()]
                hints = get_close_matches(args.audio.name, names, n=5, cutoff=0.5)
                if hints:
                    logger.error("Did you mean one of these (in the same directory)?")
                    for h in hints:
                        logger.error(f"  {parent / h}")
            except Exception:
                pass
        else:
            logger.error(f"Parent directory also missing: {parent}")
        return 1

    args.out_dir.mkdir(parents=True, exist_ok=True)
    stream_id = f"{args.date}-{args.audio.stem}"
    out_path = args.out_dir / f"{stream_id}.md"

    try:
        if args.provider == "whisper":
            segments, info = transcribe_with_whisper(args)
        elif args.provider == "soniox":
            segments, info = transcribe_with_soniox(args)
        else:
            raise RuntimeError(f"Unknown provider: {args.provider}")
    except RuntimeError as e:
        logger.error(str(e))
        return 1

    if not segments:
        logger.error("No segments returned. Is the audio file empty, silent, or unreadable?")
        return 1

    scenes = group_segments_into_scenes(segments, args.window)
    md = render_markdown(
        stream_date=args.date,
        stream_id=stream_id,
        duration_min=int(info.duration / 60),
        scenes=scenes,
        source_file=str(args.audio.name),
        language=info.language,
    )
    out_path.write_text(md, encoding="utf-8")
    logger.info(f"Wrote {out_path} ({len(scenes)} scenes via {args.provider})")

    # Persist the raw provider response next to the markdown for future
    # re-chunking without re-transcribing. Only Soniox populates this today;
    # `.with_suffix` is single-suffix-only so we build the path manually.
    if info.raw is not None:
        raw_path = out_path.parent / f"{out_path.stem}.{args.provider}.json"
        raw_path.write_text(
            json.dumps(info.raw, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        logger.info(
            f"Wrote raw {args.provider} payload to {raw_path} "
            f"({raw_path.stat().st_size // 1024} KB)"
        )
    logger.info(
        "Next: hand-edit the H2 headings to be more descriptive, then run:\n"
        "    uv run laplace-ingest-streams"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
