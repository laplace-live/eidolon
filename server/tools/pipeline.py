"""End-to-end pipeline: bilibili URL list → ingested LanceDB rows.

Glues the four existing tools into one re-runnable command:

    1. download   tools.download      → vods/<id>.m4a + vods/<id>.info.json
    2. transcribe tools.transcribe    → streams/<date>-<id>.md (+ .soniox.json)
    3. refine     tools.refine        → streams/<date>-<id>.refined.json
    4. ingest     tools.ingest        → data/lancedb/stream_chunks.lance

Every stage uses **filesystem-as-state**, so the pipeline is idempotent
and resumable: re-run after a Ctrl-C (or a flaky network) and it picks
up exactly where it left off — already-downloaded files are skipped by
yt-dlp's ``--no-overwrites``, already-transcribed audio is skipped if a
matching ``streams/*.md`` exists, and refine + ingest are idempotent by
construction.

Stage isolation
---------------
The download stage runs in-process (via ``tools.download.download_urls``).
Transcribe/refine/ingest run in **subprocesses** (one per audio file for
transcribe, one global call for refine and ingest each). Subprocess
isolation matters because Soniox uploads are slow and can crash mid-
flight; failing one file shouldn't take down the rest of the batch.

Per-item failures are logged and the pipeline continues; the final
summary reports what was attempted, skipped, and failed. Pass
``--abort-on-error`` if you'd rather fail fast.

Multi-part bilibili VODs
------------------------
A single URL like ``https://www.bilibili.com/video/BV1mLd9BTEBV/`` may
expand into ``BV1mLd9BTEBV_p1``, ``_p2``, ``_p3`` files (Bilibili splits
long stream replays into ~2-hour chunks). Each part is treated as its
own stream — separate ``streams/<date>-<id>_pN.md``, separate scenes,
separate refinement records. This stays well under Soniox's 5-hour
per-file limit and keeps retrieval simple. Group by ``stream_date`` at
query time if you need to span all parts of one broadcast day.

The ``--date`` passed to ``tools.transcribe`` comes from
``upload_date`` in yt-dlp's per-part info.json — the actual date the
streamer broadcast it, not today.

Usage::

    cd server

    # Full pipeline on a URL list (this is the common case):
    uv run python -m tools.pipeline data/video-sample.txt

    # Skip download (already have the m4a files locally):
    uv run python -m tools.pipeline data/video-sample.txt \\
        --stages transcribe,refine,ingest

    # See what would happen without doing anything:
    uv run python -m tools.pipeline data/video-sample.txt --dry-run

    # Fewer surprises if a single bad URL should fail the whole run:
    uv run python -m tools.pipeline data/video-sample.txt --abort-on-error

    # Custom transcribe / refine knobs (pipeline forwards the common ones):
    uv run python -m tools.pipeline data/video-sample.txt \\
        --language zh --provider soniox \\
        --refine-model openai/gpt-4o-mini --refine-concurrency 16
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from loguru import logger

# Allow running both as module (`python -m tools.pipeline`) and as a
# script. Mirrors the pattern used in tools/ingest.py and tools/refine.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.download import (  # noqa: E402
    DEFAULT_BROWSER,
    DEFAULT_FORMAT,
    DEFAULT_VODS_DIR,
    DownloadReport,
    download_urls,
    print_summary as print_download_summary,
    read_url_list,
)

ALL_STAGES = ("download", "transcribe", "refine", "ingest")
DEFAULT_STREAMS_DIR = Path("streams")


# ---------------------------------------------------------------------------
# Per-stage reports
# ---------------------------------------------------------------------------


@dataclass
class TranscribeReport:
    """Per-run accounting for ``stage_transcribe``."""

    audio_total: int
    audio_skipped: int = 0
    """Audio files whose .md already exists — left alone."""
    audio_skipped_no_date: int = 0
    """Audio files we couldn't infer a date for; can't safely transcribe."""
    succeeded: int = 0
    failed: list[tuple[Path, str]] = field(default_factory=list)
    duration_sec: float = 0.0


@dataclass
class StageResult:
    """Generic exit-code-style result for stages that wrap subprocess calls."""

    name: str
    returncode: int
    duration_sec: float

    @property
    def ok(self) -> bool:
        return self.returncode == 0


# ---------------------------------------------------------------------------
# Helpers shared by the transcribe stage
# ---------------------------------------------------------------------------


def _info_json_for(audio_path: Path) -> Path:
    """yt-dlp writes ``<id>.info.json`` next to ``<id>.m4a``."""
    return audio_path.with_suffix(".info.json")


def _read_upload_date(audio_path: Path) -> str | None:
    """Return ISO ``YYYY-MM-DD`` from the audio's info.json, or None.

    yt-dlp's ``upload_date`` is a compact ``YYYYMMDD`` string. We
    convert to ISO so it can be passed straight to ``tools.transcribe
    --date``. Returns None if the sidecar is missing, malformed, or has
    no usable date — in which case the file is skipped (not auto-dated
    to today) because the transcribe stage's ``stream_id`` becomes
    permanent and using "today" for an old VOD would be wrong forever.
    """
    info_path = _info_json_for(audio_path)
    if not info_path.exists():
        return None
    try:
        data = json.loads(info_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    raw = data.get("upload_date")
    s = str(raw or "").strip()
    if len(s) != 8 or not s.isdigit():
        return None
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}"


def _stream_md_path(streams_dir: Path, date_iso: str, audio_stem: str) -> Path:
    """Mirrors ``transcribe.py``'s ``stream_id = f'{date}-{audio.stem}'`` rule."""
    return streams_dir / f"{date_iso}-{audio_stem}.md"


# Audio extensions we expect tools.transcribe to handle. Match the set in
# tools/download.py so a custom --format that produces, say, opus, still
# flows through correctly.
_TRANSCRIBABLE_EXTS = {".m4a", ".mp3", ".wav", ".flac", ".webm", ".opus", ".aac"}


def _list_audio_files(vods_dir: Path) -> list[Path]:
    if not vods_dir.exists():
        return []
    return sorted(
        p for p in vods_dir.iterdir()
        if p.is_file() and p.suffix in _TRANSCRIBABLE_EXTS
    )


# ---------------------------------------------------------------------------
# Stage 1 — download
# ---------------------------------------------------------------------------


def stage_download(
    *,
    urls: list[str],
    vods_dir: Path,
    cookies_from_browser: str | None,
    cookies_file: Path | None,
    format_spec: str,
    extra_args: list[str],
    dry_run: bool,
) -> DownloadReport | None:
    """Run yt-dlp on each URL. ``dry_run=True`` just reports the URL count."""
    if dry_run:
        logger.info(
            f"[dry-run] would download {len(urls)} URL(s) → {vods_dir}/ "
            f"(format={format_spec!r})"
        )
        return None
    return download_urls(
        urls,
        vods_dir=vods_dir,
        format_spec=format_spec,
        cookies_from_browser=cookies_from_browser,
        cookies_file=cookies_file,
        extra_args=extra_args,
    )


# ---------------------------------------------------------------------------
# Stage 2 — transcribe
# ---------------------------------------------------------------------------


def _build_transcribe_cmd(
    audio: Path,
    *,
    date_iso: str,
    streams_dir: Path,
    language: str,
    provider: str,
    soniox_model: str | None,
    no_context: bool,
    context_file: Path | None,
    keep_soniox_files: bool,
) -> list[str]:
    """Construct the ``python -m tools.transcribe`` command for one audio file."""
    cmd = [
        sys.executable, "-m", "tools.transcribe",
        str(audio),
        "--date", date_iso,
        "--out-dir", str(streams_dir),
        "--provider", provider,
        # Empty string is the documented "auto-detect" escape hatch in
        # transcribe.py, so we forward it verbatim.
        "--language", language,
    ]
    if soniox_model:
        cmd += ["--soniox-model", soniox_model]
    if no_context:
        cmd += ["--no-context"]
    if context_file is not None:
        cmd += ["--context-file", str(context_file)]
    if keep_soniox_files:
        cmd += ["--keep-soniox-files"]
    return cmd


def stage_transcribe(
    *,
    vods_dir: Path,
    streams_dir: Path,
    language: str,
    provider: str,
    soniox_model: str | None,
    no_context: bool,
    context_file: Path | None,
    keep_soniox_files: bool,
    abort_on_error: bool,
    dry_run: bool,
) -> TranscribeReport:
    """Transcribe each audio file in ``vods_dir`` whose .md doesn't yet exist.

    Each file runs in its own subprocess so a Soniox upload crash on one
    multi-hour VOD doesn't take down the rest of the batch. Per-file
    failures are recorded and we move on (unless ``abort_on_error``).
    """
    started = time.monotonic()
    files = _list_audio_files(vods_dir)
    report = TranscribeReport(audio_total=len(files))

    if not files:
        logger.warning(
            f"No audio files in {vods_dir}/ — did the download stage run? "
            f"(extensions checked: {sorted(_TRANSCRIBABLE_EXTS)})"
        )
        report.duration_sec = time.monotonic() - started
        return report

    streams_dir.mkdir(parents=True, exist_ok=True)

    for idx, audio in enumerate(files, 1):
        date = _read_upload_date(audio)
        if date is None:
            logger.warning(
                f"[{idx}/{len(files)}] {audio.name}: no upload_date in "
                f"{_info_json_for(audio).name}, skipping. Re-download "
                f"the URL or transcribe manually with `tools.transcribe "
                f"{audio} --date YYYY-MM-DD`."
            )
            report.audio_skipped_no_date += 1
            continue

        out_md = _stream_md_path(streams_dir, date, audio.stem)
        if out_md.exists():
            logger.info(
                f"[{idx}/{len(files)}] {audio.name}: already transcribed → {out_md.name}"
            )
            report.audio_skipped += 1
            continue

        if dry_run:
            logger.info(
                f"[{idx}/{len(files)}] [dry-run] would transcribe {audio.name} "
                f"(date={date}) → {out_md.name}"
            )
            continue

        cmd = _build_transcribe_cmd(
            audio,
            date_iso=date,
            streams_dir=streams_dir,
            language=language,
            provider=provider,
            soniox_model=soniox_model,
            no_context=no_context,
            context_file=context_file,
            keep_soniox_files=keep_soniox_files,
        )
        logger.info(
            f"[{idx}/{len(files)}] transcribing {audio.name} "
            f"(date={date}, provider={provider})"
        )
        try:
            # No stdout/stderr capture — let transcribe.py's own loguru
            # progress lines flow live to the user. Multi-hour upload
            # heartbeats are already designed for foreground display.
            result = subprocess.run(cmd, check=False)
        except KeyboardInterrupt:
            raise
        except Exception as e:  # noqa: BLE001 — keep batch alive on any per-file crash
            logger.error(f"  ✗ subprocess error: {e}")
            report.failed.append((audio, str(e)))
            if abort_on_error:
                break
            continue

        if result.returncode != 0:
            logger.error(f"  ✗ transcribe failed (exit={result.returncode})")
            report.failed.append((audio, f"exit={result.returncode}"))
            if abort_on_error:
                break
            continue

        report.succeeded += 1

    report.duration_sec = time.monotonic() - started
    return report


# ---------------------------------------------------------------------------
# Stages 3 & 4 — refine and ingest (one global call each; both already
# idempotent on their own)
# ---------------------------------------------------------------------------


def stage_refine(
    *,
    streams_dir: Path,
    model: str | None,
    concurrency: int | None,
    force: bool,
    dry_run: bool,
) -> StageResult:
    started = time.monotonic()
    cmd = [
        sys.executable, "-m", "tools.refine",
        "--streams-dir", str(streams_dir),
    ]
    if model:
        cmd += ["--model", model]
    if concurrency is not None:
        cmd += ["--concurrency", str(concurrency)]
    if force:
        cmd += ["--force"]
    if dry_run:
        cmd += ["--dry-run"]

    logger.info(f"Refining: {' '.join(cmd)}")
    rc = subprocess.run(cmd, check=False).returncode
    return StageResult(name="refine", returncode=rc, duration_sec=time.monotonic() - started)


def stage_ingest(
    *,
    streams_dir: Path,
    skip_types: str | None,
    dry_run: bool,
) -> StageResult:
    started = time.monotonic()
    cmd = [
        sys.executable, "-m", "tools.ingest",
        "--streams-dir", str(streams_dir),
    ]
    if skip_types is not None:
        cmd += ["--skip-types", skip_types]
    if dry_run:
        cmd += ["--dry-run"]

    logger.info(f"Ingesting: {' '.join(cmd)}")
    rc = subprocess.run(cmd, check=False).returncode
    return StageResult(name="ingest", returncode=rc, duration_sec=time.monotonic() - started)


# ---------------------------------------------------------------------------
# Final summary
# ---------------------------------------------------------------------------


@dataclass
class PipelineSummary:
    """All four stages worth of accounting, accumulated across the run."""

    stages_run: list[str] = field(default_factory=list)
    download: DownloadReport | None = None
    transcribe: TranscribeReport | None = None
    refine: StageResult | None = None
    ingest: StageResult | None = None
    total_duration_sec: float = 0.0
    aborted: bool = False

    def successful(self) -> bool:
        if self.aborted:
            return False
        if self.download is not None and self.download.failed_urls:
            return False
        if self.transcribe is not None and self.transcribe.failed:
            return False
        if self.refine is not None and not self.refine.ok:
            return False
        if self.ingest is not None and not self.ingest.ok:
            return False
        return True


def print_pipeline_summary(summary: PipelineSummary, vods_dir: Path) -> None:
    print()
    print("=" * 64)
    print("Pipeline Summary")
    print("=" * 64)
    print(f"Stages run: {', '.join(summary.stages_run) or '(none)'}")
    print(f"Duration:   {summary.total_duration_sec:.1f}s")
    print()

    if summary.download is not None:
        d = summary.download
        print(
            f"  download:   {d.succeeded_urls}/{d.requested_urls} URLs ok, "
            f"{len(d.failed_urls)} failed, {len(d.new_files)} new files "
            f"({d.duration_sec:.1f}s)"
        )
    if summary.transcribe is not None:
        t = summary.transcribe
        print(
            f"  transcribe: {t.succeeded} new, {t.audio_skipped} already done, "
            f"{t.audio_skipped_no_date} no-date, {len(t.failed)} failed "
            f"of {t.audio_total} audio files in {vods_dir}/ "
            f"({t.duration_sec:.1f}s)"
        )
    if summary.refine is not None:
        r = summary.refine
        print(
            f"  refine:     exit={r.returncode} ({r.duration_sec:.1f}s)"
            f"{'' if r.ok else '  ⚠ check refine output above for details'}"
        )
    if summary.ingest is not None:
        i = summary.ingest
        print(
            f"  ingest:     exit={i.returncode} ({i.duration_sec:.1f}s)"
            f"{'' if i.ok else '  ⚠ check ingest output above for details'}"
        )
    print()

    if summary.aborted:
        print("⚠  Pipeline aborted early (--abort-on-error was set).")
    elif summary.successful():
        print("✓  All stages succeeded.")
    else:
        print("⚠  One or more stages had failures — re-run the same command to retry.")
    print("=" * 64)


# ---------------------------------------------------------------------------
# Stage selection helpers
# ---------------------------------------------------------------------------


def _parse_stages(raw: str) -> list[str]:
    """Validate and normalize ``--stages``.

    Accepts ``"all"`` (run everything), an empty string (also "all" — be
    forgiving), or a comma-separated subset of ``ALL_STAGES`` in any
    order. We always **execute** in the canonical order regardless of
    the order the user typed them in, so passing ``ingest,download``
    still does download first.
    """
    raw = (raw or "").strip().lower()
    if not raw or raw == "all":
        return list(ALL_STAGES)
    requested = {s.strip() for s in raw.split(",") if s.strip()}
    unknown = requested - set(ALL_STAGES)
    if unknown:
        raise argparse.ArgumentTypeError(
            f"Unknown stage(s): {sorted(unknown)}. Valid: {list(ALL_STAGES)}."
        )
    # Preserve canonical execution order.
    return [s for s in ALL_STAGES if s in requested]


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> int:
    try:
        from dotenv import load_dotenv

        load_dotenv(override=True)
    except ImportError:
        pass

    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument(
        "url_list",
        type=Path,
        help="Path to a text file with one URL per line (# comments + blanks ignored).",
    )
    parser.add_argument(
        "--stages",
        type=_parse_stages,
        default=list(ALL_STAGES),
        help=(
            "Comma-separated stages to run. Default: all four. "
            "Stages always execute in download→transcribe→refine→ingest "
            "order regardless of how you list them. "
            f"Valid: {','.join(ALL_STAGES)}."
        ),
    )
    parser.add_argument(
        "--vods-dir",
        type=Path,
        default=DEFAULT_VODS_DIR,
        help=f"Where audio files live (default: {DEFAULT_VODS_DIR}/).",
    )
    parser.add_argument(
        "--streams-dir",
        type=Path,
        default=DEFAULT_STREAMS_DIR,
        help=f"Where transcripts go (default: {DEFAULT_STREAMS_DIR}/).",
    )
    parser.add_argument(
        "--abort-on-error",
        action="store_true",
        help=(
            "Fail fast on the first per-item failure (a bad URL, a "
            "transcribe crash). Default is to log and continue so a "
            "44-VOD batch isn't killed by one flaky video."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Don't run any stage; just report what would happen. "
            "Forwards --dry-run to tools.refine and tools.ingest where "
            "they support it."
        ),
    )

    download_group = parser.add_argument_group("download stage")
    download_group.add_argument(
        "--format",
        default=DEFAULT_FORMAT,
        help=f"yt-dlp format spec (default: {DEFAULT_FORMAT!r}).",
    )
    download_group.add_argument(
        "--cookies-from-browser",
        default=DEFAULT_BROWSER,
        help=(
            f"Browser to read cookies from (default: {DEFAULT_BROWSER}). "
            "Pass an empty string to disable."
        ),
    )
    download_group.add_argument(
        "--cookies",
        type=Path,
        default=None,
        help="Path to a cookies.txt file (alternative to --cookies-from-browser).",
    )
    download_group.add_argument(
        "--yt-dlp-args",
        default="",
        help=(
            "Extra args forwarded to yt-dlp as a single shell-quoted "
            'string. Example: --yt-dlp-args="--rate-limit 2M --sleep-interval 5".'
        ),
    )

    transcribe_group = parser.add_argument_group("transcribe stage")
    transcribe_group.add_argument(
        "--language",
        default="zh",
        help="Language hint passed to tools.transcribe (default: zh).",
    )
    transcribe_group.add_argument(
        "--provider",
        default="soniox",
        choices=("soniox", "whisper"),
        help="Transcription backend (default: soniox).",
    )
    transcribe_group.add_argument(
        "--soniox-model",
        default=None,
        help="Override Soniox model (default: tools.transcribe's own default).",
    )
    transcribe_group.add_argument(
        "--no-context",
        action="store_true",
        help="Skip the Soniox structured-context glossary even if the file exists.",
    )
    transcribe_group.add_argument(
        "--context-file",
        type=Path,
        default=None,
        help="Override the path to the Soniox context TOML.",
    )
    transcribe_group.add_argument(
        "--keep-soniox-files",
        action="store_true",
        help="Don't delete the uploaded file + transcription record from Soniox after success.",
    )

    refine_group = parser.add_argument_group("refine stage")
    refine_group.add_argument(
        "--refine-model",
        default=os.getenv("REFINE_MODEL"),
        help="Override OpenRouter model (default: $REFINE_MODEL or tools.refine's default).",
    )
    refine_group.add_argument(
        "--refine-concurrency",
        type=int,
        default=None,
        help="Max concurrent LLM calls during refine (default: tools.refine's default).",
    )
    refine_group.add_argument(
        "--refine-force",
        action="store_true",
        help="Re-refine all chunks even if a sidecar already exists.",
    )

    ingest_group = parser.add_argument_group("ingest stage")
    ingest_group.add_argument(
        "--skip-types",
        default=None,
        help=(
            "Forwarded to tools.ingest's --skip-types (default: that tool's "
            "default, which excludes anime_audio + karaoke chunks)."
        ),
    )

    args = parser.parse_args()
    stages: list[str] = args.stages

    cookies_browser = args.cookies_from_browser or None
    extra_yt_dlp = _split_extra_args(args.yt_dlp_args)

    # Read URLs up front even if download is disabled — empty/bad list
    # should fail fast, before we, e.g., bill a Soniox transcription.
    try:
        urls = read_url_list(args.url_list)
    except FileNotFoundError as e:
        logger.error(str(e))
        return 1

    if "download" in stages and not urls:
        logger.warning(f"No URLs in {args.url_list} — download stage is a no-op.")

    logger.info(f"Pipeline stages: {', '.join(stages)} (url_list={args.url_list})")
    summary = PipelineSummary(stages_run=stages)
    started = time.monotonic()

    try:
        if "download" in stages:
            summary.download = stage_download(
                urls=urls,
                vods_dir=args.vods_dir,
                cookies_from_browser=cookies_browser,
                cookies_file=args.cookies,
                format_spec=args.format,
                extra_args=extra_yt_dlp,
                dry_run=args.dry_run,
            )
            if summary.download is not None:
                print_download_summary(summary.download, args.vods_dir)
                if args.abort_on_error and summary.download.failed_urls:
                    summary.aborted = True
                    raise _Abort

        if "transcribe" in stages:
            summary.transcribe = stage_transcribe(
                vods_dir=args.vods_dir,
                streams_dir=args.streams_dir,
                language=args.language,
                provider=args.provider,
                soniox_model=args.soniox_model,
                no_context=args.no_context,
                context_file=args.context_file,
                keep_soniox_files=args.keep_soniox_files,
                abort_on_error=args.abort_on_error,
                dry_run=args.dry_run,
            )
            if args.abort_on_error and summary.transcribe.failed:
                summary.aborted = True
                raise _Abort

        if "refine" in stages:
            summary.refine = stage_refine(
                streams_dir=args.streams_dir,
                model=args.refine_model,
                concurrency=args.refine_concurrency,
                force=args.refine_force,
                dry_run=args.dry_run,
            )
            if args.abort_on_error and not summary.refine.ok:
                summary.aborted = True
                raise _Abort

        if "ingest" in stages:
            summary.ingest = stage_ingest(
                streams_dir=args.streams_dir,
                skip_types=args.skip_types,
                dry_run=args.dry_run,
            )
            if args.abort_on_error and not summary.ingest.ok:
                summary.aborted = True
                raise _Abort
    except _Abort:
        # Abort is just a control-flow signal so we can fall through to
        # the summary and exit with a non-zero code without stack trace.
        pass

    summary.total_duration_sec = time.monotonic() - started
    print_pipeline_summary(summary, args.vods_dir)
    return 0 if summary.successful() else 1


class _Abort(Exception):
    """Internal control flow to short-circuit the stage pipeline cleanly."""


def _split_extra_args(raw: str) -> list[str]:
    """Tokenize --yt-dlp-extra-args via shlex so quoted args round-trip safely."""
    raw = (raw or "").strip()
    if not raw:
        return []
    import shlex

    return shlex.split(raw)


if __name__ == "__main__":
    sys.exit(main())
