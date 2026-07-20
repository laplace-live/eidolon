"""Download bilibili (or any yt-dlp-supported) audio from a URL list.

Reads URLs from a text file (one per line; ``#`` and blank lines ignored)
and shells out to yt-dlp once per URL, writing audio plus an
``<id>.info.json`` sidecar into ``vods/``.

A multi-part Bilibili VOD lands as one file per part (``BV…_p1``, ``_p2``,
…), and each part is treated as its own stream downstream — the H2 scene
clock restarts at ``00:00`` for every part. Parts are continuous slices of
one broadcast, but Soniox caps a single job at 5 hours, so they're never
glued back together.

``--cookies-from-browser chrome`` is the default. Chrome has to be quit
first or the cookie-DB read hits a SQLite lock;
``--cookies path/to/cookies.txt`` loads a static export instead.
"""

from __future__ import annotations

import argparse
import shlex
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from loguru import logger

# Defaults are exposed as module-level constants because pipeline.py
# imports them to keep CLI defaults aligned across the two tools.
DEFAULT_VODS_DIR = Path("vods")
DEFAULT_FORMAT = "bestaudio[ext=m4a]"
DEFAULT_BROWSER = "chrome"


@dataclass
class DownloadReport:
    """Per-run accounting for ``download_urls``."""

    requested_urls: int
    succeeded_urls: int = 0
    """URLs yt-dlp returned 0 for, including ones that hit --no-overwrites."""
    failed_urls: list[tuple[str, str]] = field(default_factory=list)
    """``[(url, short_error), ...]``."""
    new_files: list[Path] = field(default_factory=list)
    """Audio files that appeared in ``vods/`` during this run.

    Computed by glob-diff (before vs after), so it survives yt-dlp's
    ``--no-overwrites`` printing nothing for skipped files.
    """
    duration_sec: float = 0.0


def read_url_list(path: Path) -> list[str]:
    """Read one-URL-per-line file; strip blanks and ``#`` comment lines."""
    if not path.exists():
        raise FileNotFoundError(f"URL list not found: {path}")
    urls: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        urls.append(line)
    return urls


# The default format spec only ever yields .m4a, but a user overriding
# `--format` shouldn't have their files invisible to the new-file diff.
_AUDIO_EXTS = {".m4a", ".mp3", ".wav", ".flac", ".webm", ".opus", ".aac"}


def _audio_files_in(directory: Path) -> set[Path]:
    if not directory.exists():
        return set()
    return {p for p in directory.iterdir() if p.is_file() and p.suffix in _AUDIO_EXTS}


def _build_yt_dlp_cmd(
    url: str,
    *,
    vods_dir: Path,
    format_spec: str,
    cookies_from_browser: str | None,
    cookies_file: Path | None,
    extra_args: list[str],
) -> list[str]:
    cmd = [
        "yt-dlp",
        "-f",
        format_spec,
        "-o",
        str(vods_dir / "%(id)s.%(ext)s"),
        # pipeline.py reads `upload_date` out of this sidecar to fill
        # `--date` for the transcribe stage, and has no other way to
        # discover the stream date. Don't drop this flag.
        "--write-info-json",
        "--no-overwrites",
        # Skip the per-VOD playlist info.json (`BVxxx.info.json` without
        # `_pN`) — only per-part metadata is ever consumed.
        "--no-write-playlist-metafiles",
    ]
    if cookies_from_browser:
        cmd += ["--cookies-from-browser", cookies_from_browser]
    if cookies_file:
        cmd += ["--cookies", str(cookies_file)]
    cmd += list(extra_args)
    cmd.append(url)
    return cmd


def download_urls(
    urls: list[str],
    *,
    vods_dir: Path,
    format_spec: str = DEFAULT_FORMAT,
    cookies_from_browser: str | None = DEFAULT_BROWSER,
    cookies_file: Path | None = None,
    extra_args: list[str] | None = None,
) -> DownloadReport:
    """Download every URL in ``urls`` to ``vods_dir`` via yt-dlp.

    One URL per yt-dlp invocation so a single bad URL (deleted, paywalled,
    cookies expired) doesn't abort the batch. Returns only after every URL
    was attempted, never raising on a per-URL failure — check
    ``report.failed_urls``, which carries the stderr tail for triage.
    """
    if shutil.which("yt-dlp") is None:
        raise RuntimeError(
            "yt-dlp not found on PATH. Install with `brew install yt-dlp` "
            "or `pipx install yt-dlp` and retry."
        )
    vods_dir.mkdir(parents=True, exist_ok=True)
    extra_args = list(extra_args or [])

    started = time.monotonic()
    report = DownloadReport(requested_urls=len(urls))
    before = _audio_files_in(vods_dir)

    for idx, url in enumerate(urls, 1):
        logger.info(f"[{idx}/{len(urls)}] {url}")
        cmd = _build_yt_dlp_cmd(
            url,
            vods_dir=vods_dir,
            format_spec=format_spec,
            cookies_from_browser=cookies_from_browser,
            cookies_file=cookies_file,
            extra_args=extra_args,
        )
        try:
            # stdout stays uncaptured so yt-dlp's progress bar renders live;
            # stderr is captured so the failure tail can go in the report
            # instead of flooding the log on every transient warning.
            result = subprocess.run(
                cmd,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
        except KeyboardInterrupt:
            raise
        except Exception as e:  # noqa: BLE001 — catch-all so one bad URL never aborts the batch
            logger.error(f"  ✗ subprocess error: {e}")
            report.failed_urls.append((url, str(e)))
            continue

        if result.returncode != 0:
            stderr_tail = (
                "\n    ".join((result.stderr or "").strip().splitlines()[-6:])
                or "(no stderr captured)"
            )
            logger.error(
                f"  ✗ yt-dlp failed (exit={result.returncode}). stderr tail:\n    {stderr_tail}"
            )
            report.failed_urls.append((url, f"exit={result.returncode}: {stderr_tail}"))
            continue

        report.succeeded_urls += 1

    after = _audio_files_in(vods_dir)
    report.new_files = sorted(after - before)
    report.duration_sec = time.monotonic() - started
    return report


def print_summary(report: DownloadReport, vods_dir: Path) -> None:
    print()
    print("=" * 60)
    print("Download Summary")
    print("=" * 60)
    print(f"URLs requested: {report.requested_urls}")
    print(f"URLs succeeded: {report.succeeded_urls}")
    print(f"URLs failed:    {len(report.failed_urls)}")
    print(f"New audio:      {len(report.new_files)} files in {vods_dir}/")
    print(f"Duration:       {report.duration_sec:.1f}s")
    if report.failed_urls:
        print()
        print("Failures (re-run the same command to retry these):")
        for url, err in report.failed_urls:
            first_line = err.splitlines()[0] if err else "(no detail)"
            print(f"  ✗ {url}\n      {first_line}")
    print("=" * 60)


def main() -> int:
    # Nothing here needs env vars, but pipeline.py hands off to later
    # stages that want SONIOX_API_KEY loaded by then.
    try:
        from dotenv import load_dotenv

        load_dotenv(override=True)
    except ImportError:
        pass

    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument(
        "url_list",
        type=Path,
        help="Path to a text file with one URL per line (# comments and blank lines ignored).",
    )
    parser.add_argument(
        "--vods-dir",
        type=Path,
        default=DEFAULT_VODS_DIR,
        help=f"Where to store downloaded audio (default: {DEFAULT_VODS_DIR}/).",
    )
    parser.add_argument(
        "--format",
        default=DEFAULT_FORMAT,
        help=f"yt-dlp format spec (default: {DEFAULT_FORMAT!r}).",
    )
    parser.add_argument(
        "--cookies-from-browser",
        default=DEFAULT_BROWSER,
        help=(
            f"Browser to read cookies from (default: {DEFAULT_BROWSER}). "
            "Pass an empty string to disable. Conflicts with --cookies."
        ),
    )
    parser.add_argument(
        "--cookies",
        type=Path,
        default=None,
        help="Path to a cookies.txt file (alternative to --cookies-from-browser).",
    )
    parser.add_argument(
        "--yt-dlp-args",
        default="",
        help=(
            "Extra args forwarded to yt-dlp as a single shell-quoted string. "
            'Example: --yt-dlp-args="--rate-limit 2M --sleep-interval 5". '
            "Using a single string instead of REMAINDER avoids argparse "
            "swallowing flags placed after the URL list path."
        ),
    )

    args = parser.parse_args()

    cookies_browser = args.cookies_from_browser or None
    if cookies_browser and args.cookies:
        logger.warning(
            "Both --cookies-from-browser and --cookies were given; "
            "--cookies-from-browser will win in yt-dlp's flag order."
        )

    extra = shlex.split(args.yt_dlp_args or "")

    try:
        urls = read_url_list(args.url_list)
    except FileNotFoundError as e:
        logger.error(str(e))
        return 1

    if not urls:
        logger.warning(f"No URLs in {args.url_list}.")
        return 0

    logger.info(
        f"Downloading {len(urls)} URL(s) to {args.vods_dir}/ "
        f"(format={args.format!r}, cookies_from_browser={cookies_browser!r})"
    )

    try:
        report = download_urls(
            urls,
            vods_dir=args.vods_dir,
            format_spec=args.format,
            cookies_from_browser=cookies_browser,
            cookies_file=args.cookies,
            extra_args=extra,
        )
    except RuntimeError as e:
        logger.error(str(e))
        return 1

    print_summary(report, args.vods_dir)
    return 0 if not report.failed_urls else 1


if __name__ == "__main__":
    sys.exit(main())
