"""What tools/pipeline.py's dry run makes of the real sources, for pipeline_real.test.ts, which runs
this at test time; its output names audio files and transcripts, carries no transcript text, and is
never committed. It prints one JSON object:

- transcribe: _plan_transcribe_jobs' log lines and counts under --dry-run, and the audio files a
  real run would transcribe;
- refine: what the pipeline's refine child prints under --dry-run, _dry_run_report's text.

    uv run --offline --no-sync python packages/ingest/test/fixtures/pipeline/real.py \
        VODS_DIR STREAMS_DIR MODEL
"""

from __future__ import annotations

import contextlib
import io
import json
import platform
import sys
from importlib.metadata import version
from pathlib import Path

from loguru import logger

from laplace_eidolon.tools import pipeline, refine
from laplace_eidolon.tools._streams import iter_streams


def plan_kwargs(streams: Path, dry_run: bool) -> dict:
    return {
        "streams_dir": streams,
        "language": "zh",
        "provider": "soniox",
        "soniox_model": None,
        "no_context": False,
        "context_file": None,
        "keep_soniox_files": False,
        "auto_slice": True,
        "slice_max_min": None,
        "dry_run": dry_run,
    }


def main() -> None:
    vods, streams, model = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    records: list[list[str]] = []
    logger.remove()
    logger.add(lambda m: records.append([m.record["level"].name, m.record["message"]]))

    files = pipeline._list_audio_files(vods)
    report = pipeline.TranscribeReport(audio_total=len(files))
    pipeline._plan_transcribe_jobs(files, report=report, **plan_kwargs(streams, True))
    logs = list(records)
    jobs = pipeline._plan_transcribe_jobs(
        files,
        report=pipeline.TranscribeReport(audio_total=len(files)),
        **plan_kwargs(streams, False),
    )

    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        refine._dry_run_report(iter_streams(streams.resolve()), model)

    json.dump(
        {
            "printed_by": (
                f"{platform.python_implementation()} {platform.python_version()}, "
                f"python-frontmatter {version('python-frontmatter')}: "
                "packages/ingest/test/fixtures/pipeline/real.py"
            ),
            "transcribe": {
                "logs": logs,
                "counts": {
                    "total": report.audio_total,
                    "skipped": report.audio_skipped,
                    "skipped_no_date": report.audio_skipped_no_date,
                },
                "jobs": [job.audio.name for job in jobs],
            },
            "refine": {"text": out.getvalue()},
        },
        sys.stdout,
        ensure_ascii=False,
    )


if __name__ == "__main__":
    main()
