"""Transcribe a VOD audio/video file into a streams/*.md transcript.

Two backends funnel through one ``Segment`` shape, so the chunker and the
markdown renderer stay provider-agnostic:

- ``soniox`` (default) — cloud async API, ~$0.10/hour of audio, much better
  on Mandarin, game/character names, and code-switching. Reuses the
  ``SONIOX_API_KEY`` already set for the realtime STT bot.
- ``whisper`` — local ``faster-whisper`` (CTranslate2 backend, no PyTorch
  dependency, native on Apple Silicon). Free and offline, but slower and
  weaker on Mandarin punctuation and proper nouns.

Both emit units far too granular for retrieval — Whisper 5-30s segments,
Soniox sub-word tokens — so segments are regrouped into fixed-time windows.
Each window becomes one H2 section, and H2 boundaries are what later gets
indexed.

Soniox jobs also carry a glossary of recurring vocabulary, loaded from a
TOML file. It's deliberately per-project rather than per-stream: one VOD
spans chat, gaming, karaoke, and watchalongs, so a stream-level topic hint
would mislead. Per-scene topics come later, from ``tools/refine.py``.
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

from dotenv import load_dotenv
from loguru import logger

# Both backends live in the optional `[tools]` extra. Their imports stay
# deferred inside the dispatcher functions so a runtime-only install fails
# with a friendly message instead of crashing at import time.


@dataclass
class Segment:
    """Provider-agnostic segment; ``start``/``end`` in seconds."""

    start: float
    end: float
    text: str


@dataclass
class TranscribeInfo:
    """Audio-level metadata returned alongside segments.

    ``raw`` holds the provider's own payload (only Soniox populates it today)
    and is saved verbatim to a sibling ``.soniox.json``, so re-chunking
    locally doesn't mean re-paying the transcription bill.
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
    """``42`` → ``"42s"``, ``312`` → ``"5m12s"``, ``5025`` → ``"1h23m"``."""
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
    """Bucket segments into fixed-time scenes of ``start`` / ``end`` / ``text``."""
    if not segments:
        return []
    scenes: list[dict[str, Any]] = []
    current_start: float | None = None
    current_end: float = 0.0
    current_parts: list[str] = []

    for seg in segments:
        if current_start is None:
            current_start = (seg.start // window_seconds) * window_seconds
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


PROGRESS_EVERY_SEC = 10.0


def transcribe_with_whisper(
    args: argparse.Namespace,
) -> tuple[list[Segment], TranscribeInfo]:
    """Transcribe ``args.audio`` locally with faster-whisper."""
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

    # `model.transcribe` returns a lazy generator: wrapping it in `list(...)`
    # blocks silently for tens of minutes on a long VOD. Drain it by hand so
    # the loop below can report progress and an ETA.
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


# Soniox returns sub-word tokens; grouping them into pseudo-segments of
# Whisper-comparable length keeps the downstream chunker behaving identically.
SONIOX_MIN_SEGMENT_SEC = 3.0
SONIOX_MAX_SEGMENT_SEC = 30.0
_SENTENCE_END_RE = re.compile(r"[.!?。！？]\s*$")
# Soniox's hard per-file limit; checked locally so an oversized file fails
# before the upload rather than after it.
SONIOX_MAX_DURATION_MIN = 300
# Default per-part cap for --auto-slice. 280 leaves ~20 min of headroom for
# server-side measurement drift and container padding, and still yields only
# 2 parts for a typical 300-340 min VOD.
SONIOX_SLICE_MAX_MIN_DEFAULT = 280

# Structured context shape — see https://soniox.com/docs/stt/concepts/context
SONIOX_CONTEXT_ALLOWED_KEYS = {"general", "text", "terms", "translation_terms"}
# The SDK defaults to a 30s HTTP timeout, far too short for multi-hundred-MB
# uploads on a residential uplink. It covers connect/read/write only — job
# processing time is bounded by the 5s poll loop instead.
SONIOX_HTTP_TIMEOUT_SEC = 600.0
# Consecutive poll-GET failures tolerated before aborting a job. At 5s
# between attempts this rides out ~1 min of network flakiness.
SONIOX_POLL_MAX_FAILURES = 12
# Soniox caps context at ~8000 tokens; ~10k chars is a deliberately
# conservative stand-in, since CJK runs ~1 token/char against English's ~4
# chars/token and this content mixes both.
SONIOX_CONTEXT_MAX_CHARS = 10_000


def _load_soniox_context_dict(
    path: Path | None,
    *,
    skip: bool,
) -> dict[str, Any] | None:
    """Load a TOML glossary file and return it as a Soniox-shaped dict.

    The result matches Soniox's ``StructuredContext`` schema and can go
    straight into ``StructuredContext(**dict)``. Returns ``None`` when
    context is disabled, the file is missing, or nothing usable is in it.
    """
    if skip:
        return None
    if path is None:
        return None
    if not path.exists():
        logger.info(
            f"No Soniox context file at {path} — running without glossary. "
            f"Create one to bias the model toward your vocabulary."
        )
        return None

    import tomllib

    with path.open("rb") as f:
        raw: dict[str, Any] = tomllib.load(f)

    unknown = set(raw.keys()) - SONIOX_CONTEXT_ALLOWED_KEYS
    if unknown:
        logger.warning(
            f"Ignoring unknown keys in {path}: {sorted(unknown)}. "
            f"Allowed: {sorted(SONIOX_CONTEXT_ALLOWED_KEYS)}."
        )
        for k in unknown:
            raw.pop(k)

    # TOML silently nests a top-level scalar (`text = "..."`, `terms = [...]`)
    # into the last `[[general]]` entry when it's written after that block.
    # Catch it loudly — otherwise the run goes out with phantom context.
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

    raw = {k: v for k, v in raw.items() if v}

    if not raw:
        return None

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

    Joining is bare concatenation on purpose: Soniox already includes leading
    whitespace where the target language wants it (English does, Mandarin
    doesn't), so ``" ".join(...)`` would wreck the Mandarin output.
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

    Files under the per-file cap are one upload/poll/fetch cycle. Longer ones
    need ``--auto-slice``, which splits them with ffmpeg and merges the parts
    back into a single logical transcript; without it, the run fails fast
    rather than spending a long upload on a job Soniox will reject.
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

    client = SonioxClient(timeout_sec=SONIOX_HTTP_TIMEOUT_SEC)
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

    The raw payload keeps one ``.soniox.json`` shape across single-file and
    sliced runs, so the on-disk format doesn't reveal which path produced it.
    """
    # httpx is a hard dependency of the soniox SDK, so it's importable
    # wherever this function is reachable; deferred like the SDK itself to
    # keep the whisper-only install import-clean.
    import httpx

    language_hints = [language] if language else None
    # ``client_reference_id`` goes on the create call, not the config: the SDK
    # deprecated the config field and drops it in the next major.
    config = config_cls(
        language_hints=language_hints,
        context=structured_context,
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
            client_reference_id=client_reference_id,
            config=config,
        )
        transcription_id = transcription.id
        logger.info(
            f"Job submitted: id={transcription_id}, status={transcription.status}. "
            f"Polling every 5s…"
        )

        last_status: str | None = None
        last_log = time.monotonic()
        poll_failures = 0
        while True:
            # A blip on one poll GET must not kill the run: the job keeps
            # processing server-side, and the `finally` below would destroy a
            # transcription we've already paid for.
            try:
                t = client.stt.get(transcription_id)
                poll_failures = 0
            except httpx.HTTPError as e:
                poll_failures += 1
                if poll_failures >= SONIOX_POLL_MAX_FAILURES:
                    raise RuntimeError(
                        f"Polling Soniox job {transcription_id} failed "
                        f"{poll_failures} times in a row; giving up. "
                        f"Last error: {type(e).__name__}: {e}"
                    ) from e
                logger.warning(
                    f"  poll error ({poll_failures}/{SONIOX_POLL_MAX_FAILURES}), "
                    f"retrying: {type(e).__name__}: {e}"
                )
                time.sleep(5)
                continue
            elapsed = time.monotonic() - start_wall
            now = time.monotonic()

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

        # Same tolerance as the poll loop — the job is complete and paid for
        # here, so one flaky GET must not hand it to the destructive
        # `finally`.
        for attempt in range(SONIOX_POLL_MAX_FAILURES):
            try:
                transcript = client.stt.get_transcript(transcription_id)
                break
            except httpx.HTTPError as e:
                if attempt + 1 >= SONIOX_POLL_MAX_FAILURES:
                    raise
                logger.warning(
                    f"  transcript fetch error "
                    f"({attempt + 1}/{SONIOX_POLL_MAX_FAILURES}), retrying: "
                    f"{type(e).__name__}: {e}"
                )
                time.sleep(5)
        tokens = transcript.tokens or []
        segments = _tokens_to_segments(tokens)
        elapsed = time.monotonic() - start_wall

        # Soniox is the source of truth for what it actually processed, so its
        # measurement beats the local ffprobe estimate.
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

        # The SDK's types are Pydantic models, so ``model_dump(mode="json")``
        # handles the datetimes and nested types. The exact `context` sent is
        # persisted too, so editing a glossary entry doesn't silently make
        # yesterday's transcripts unexplainable.
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

    ``-c copy`` keeps the slice fast and lossless, at the cost of
    keyframe-bounded cuts that can drift a few seconds either way. That's far
    below the 5-minute scene window, and merged timestamps are rebuilt from
    the requested start rather than where ffmpeg landed, so the transcript
    stays monotonic regardless.
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
        # Soniox only needs audio, and dropping any video stream (mp4 cover
        # art, say) makes the upload smaller.
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

    Parts run strictly one at a time, so only one Soniox job is ever in
    flight — the outer pipeline may already be parallelising across files,
    and per-account concurrency caps apply. Each part's segments and tokens
    are shifted by its start offset, leaving downstream code unable to tell
    the result from a single-file transcription. The source audio is never
    touched; slices live in a temp dir wiped on exit, exceptions included.
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
    # An even split costs the same (Soniox bills per second) but makes
    # wall-clock progress more predictable than N-1 full parts and a tiny tail.
    part_dur_sec = duration_sec / n_parts

    logger.info(
        f"Auto-slicing {args.audio.name}: {duration_sec / 60:.1f} min "
        f"→ {n_parts} parts × ~{part_dur_sec / 60:.1f} min "
        f"(cap={slice_max_min} min/part)"
    )

    # The same context on every part keeps Soniox's bias consistent across the
    # merged transcript.
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

    client = client_cls(timeout_sec=SONIOX_HTTP_TIMEOUT_SEC)
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
            # The last part absorbs the rounding remainder so the full source
            # duration is covered without trusting ffmpeg's landing point.
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

            # Shift into the parent timeline so the merge reads as one
            # continuous transcription.
            for s in part_segments:
                merged_segments.append(
                    Segment(start=s.start + offset_sec, end=s.end + offset_sec, text=s.text)
                )

            # Same for the raw tokens, so the persisted .soniox.json can be
            # re-chunked later against the global timeline. These are
            # millisecond ints, not the seconds ``Segment`` uses.
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

            # A per-part audit trail without the heavy token list, which is
            # already in merged_tokens.
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
            # A sliced run has no single transcript id; the first part's keeps
            # anything keying on "transcript.id" working.
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
    """Return audio duration in seconds via ffprobe, or None on failure."""
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


def main() -> int:
    # Pick up SONIOX_API_KEY from .env without requiring it to be exported.
    load_dotenv(override=True)

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
        default="stt-async-v5",
        help="Soniox async STT model (default: stt-async-v5)",
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
    # Resolved against this file, not the CWD, so the default glossary is the
    # same one wherever the command is run from.
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

    # `--language ""` is the documented auto-detect escape hatch, but
    # faster-whisper's language= kwarg needs a real None, not an empty string.
    if args.language == "":
        args.language = None

    if not args.audio.exists():
        logger.error(f"Audio file not found: {args.audio}")
        # BLREC filenames are long and full of CJK plus punctuation, so a
        # missing `!!` or `_1` is near-invisible. Offer near-matching siblings
        # to copy-paste instead.
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

    # Persist the raw provider response so a later re-chunk doesn't have to
    # re-transcribe. The path is built by hand because `.with_suffix` replaces
    # only the last suffix.
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
