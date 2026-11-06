"""Prints golden.json: what tools/pipeline.py makes of the synthetic inputs below. main() runs with
../download/fake-yt-dlp.sh as the yt-dlp on PATH, and its transcribe, refine, ingest and catalog
children faked by exit code (each call's argv is recorded instead). The TS tests replay the same
inputs from the golden, so change both together.

Reprint: uv run --offline --no-sync python packages/ingest/test/fixtures/pipeline/golden.py \
    > packages/ingest/test/fixtures/pipeline/golden.json
then format the JSON with `bunx biome check --write`.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from importlib.metadata import version
from pathlib import Path
from typing import Any

from loguru import logger

from laplace_eidolon.tools import download, pipeline
from laplace_eidolon.tools.download import DownloadReport

HERE = Path(__file__).resolve().parent
FAKE_YTDLP = HERE.parent / "download" / "fake-yt-dlp.sh"
URL = "https://example.invalid/"

# main() would read the repository's .env; nothing here may.
pipeline.load_dotenv = lambda **_: None
download.load_dotenv = lambda **_: None


def placehold(value: Any, paths: dict[str, Path]) -> Any:
    if isinstance(value, str):
        for name, path in paths.items():
            value = value.replace(str(path), name)
        return value
    if isinstance(value, list):
        return [placehold(v, paths) for v in value]
    if isinstance(value, dict):
        return {k: placehold(v, paths) for k, v in value.items()}
    return value


@contextlib.contextmanager
def captured_logs():
    records: list[list[str]] = []
    logger.remove()
    sink = logger.add(lambda m: records.append([m.record["level"].name, m.record["message"]]))
    try:
        yield records
    finally:
        logger.remove(sink)


@contextlib.contextmanager
def silent_fd1():
    """yt-dlp's stdout is inherited; keep it out of the golden this script prints."""
    sys.stdout.flush()
    saved = os.dup(1)
    devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, 1)
    try:
        yield
    finally:
        os.dup2(saved, 1)
        os.close(devnull)
        os.close(saved)


STAGES = [
    "",
    "all",
    "ALL",
    " All ",
    "download",
    "ingest,download",
    "DOWNLOAD , Refine",
    "\tingest\n",
    "transcribe,transcribe",
    "　refine　",
    ",",
    " , ,",
    "foo",
    "Refine, foo,ALL",
    "download,foo,bar,foo",
    "all,download",
    "ｄｏｗｎｌｏａｄ",
]


def parse_stages() -> list[dict]:
    out = []
    for raw in STAGES:
        try:
            out.append({"raw": raw, "stages": pipeline._parse_stages(raw)})
        except argparse.ArgumentTypeError as error:
            out.append({"raw": raw, "error": str(error)})
    return out


def download_report(
    requested: int, succeeded: int, failed: int, new: int, duration: float
) -> DownloadReport:
    return DownloadReport(
        requested_urls=requested,
        succeeded_urls=succeeded,
        failed_urls=[(f"u{i}", f"exit=1: e{i}") for i in range(failed)],
        new_files=[Path(f"vods/n{i}.m4a") for i in range(new)],
        duration_sec=duration,
    )


SUMMARIES: list[dict] = [
    {"stages": [], "vods_dir": "vods", "duration": 0.0},
    {
        "stages": ["download", "transcribe", "refine", "ingest"],
        "vods_dir": "vods",
        "duration": 856.55,
        "download": [66, 49, 17, 2, 856.55],
        "aborted": True,
    },
    {
        "stages": ["download", "transcribe", "refine", "ingest"],
        "vods_dir": "/data/sources/x/vods",
        "duration": 1.25,
        "download": [3, 3, 0, 1, 0.05],
        "transcribe": [5, 2, 1, 1, [], 0.25],
        "refine": [0, 0.35],
        "ingest": [0, 0.45],
    },
    {
        "stages": ["transcribe", "refine", "ingest"],
        "vods_dir": ".",
        "duration": 12.0,
        "transcribe": [7, 0, 0, 3, ["a", "b"], 1.45],
        "refine": [1, 2.5],
        "ingest": [2, 3.75],
    },
    {
        "stages": ["refine"],
        "vods_dir": "vods",
        "duration": 0.04,
        "refine": [0, 0.04],
    },
    {
        "stages": ["ingest"],
        "vods_dir": "vods",
        "duration": 0.15,
        "ingest": [1, 0.15],
        "aborted": True,
    },
]


def summaries() -> list[dict]:
    out = []
    for case in SUMMARIES:
        summary = pipeline.PipelineSummary(stages_run=case["stages"])
        summary.total_duration_sec = case["duration"]
        summary.aborted = case.get("aborted", False)
        if "download" in case:
            summary.download = download_report(*case["download"])
        if "transcribe" in case:
            total, skipped, no_date, succeeded, failed, duration = case["transcribe"]
            summary.transcribe = pipeline.TranscribeReport(
                audio_total=total,
                audio_skipped=skipped,
                audio_skipped_no_date=no_date,
                succeeded=succeeded,
                failed=[(Path(name), "exit=1") for name in failed],
                duration_sec=duration,
            )
        for stage in ("refine", "ingest"):
            if stage in case:
                rc, duration = case[stage]
                result = pipeline.StageResult(name=stage, returncode=rc, duration_sec=duration)
                setattr(summary, stage, result)
        out_text = io.StringIO()
        with contextlib.redirect_stdout(out_text):
            pipeline.print_pipeline_summary(summary, Path(case["vods_dir"]))
        out.append({**case, "text": out_text.getvalue()})
    return out


# The audio a download leaves, and its info.json (None: no info.json). The dry run plans them all.
VODS: dict[str, str | None] = {
    "BV1aaaaaaaa1_p1.m4a": '{"id": "BV1aaaaaaaa1_p1", "upload_date": "20260814"}',
    "BV1aaaaaaaa1_p2.m4a": '{"id": "BV1aaaaaaaa1_p2", "upload_date": "20260814"}',
    "BV1bbbbbbbb1.m4a": None,
    "BV1ccccccccc.mp3": '{"upload_date": "2026-08-14"}',
    "BV1dddddddd1.opus": '{"upload_date": 20260815}',
    "BV1eeeeeeee1.webm": "{",
    "BV1ffffffff1.m4a": '{"upload_date": ""}',
    "BV1gggggggg1.flac": '{"upload_date": " 20260816 "}',
    "BV1hhhhhhhh1.aac": '{"upload_date": "２０２６０８１７"}',
    "BV1iiiiiiii1.wav": '{"upload_date": null}',
    "BV1jjjjjjjj1.M4A": '{"upload_date": "20260819"}',
    "BV1kkkkkkkk1.m4a.part": None,
    ".hidden.m4a": '{"upload_date": "20260820"}',
    "直播回放.m4a": '{"upload_date": "20260821"}',
    "Z-upper.m4a": '{"upload_date": "20260822", "title": "x"}',
    "notes.txt": None,
}
# Transcripts already there: the second part is done.
STREAMS = ["2026-08-14-BV1aaaaaaaa1_p2.md"]


def make_vods(vods: Path, streams: Path) -> None:
    vods.mkdir(parents=True)
    (vods / "sub.m4a").mkdir()
    for name, info in VODS.items():
        (vods / name).write_bytes(b"audio")
        if info is not None:
            (vods / name).with_suffix(".info.json").write_text(info, encoding="utf-8")
    streams.mkdir(parents=True, exist_ok=True)
    for name in STREAMS:
        (streams / name).write_text("---\nstream_id: x\n---\n\n## 00:00 — a\n\nb\n")


def plan(root: Path) -> dict:
    """The transcribe stage's planning, dry and not: its log lines, counts and jobs."""
    work = root / "plan"
    vods, streams = work / "vods", work / "streams"
    make_vods(vods, streams)
    paths = {"<WORK>": work}
    with captured_logs() as records:
        report = pipeline.stage_transcribe(
            vods_dir=vods,
            streams_dir=streams,
            language="zh",
            provider="soniox",
            soniox_model=None,
            no_context=False,
            context_file=None,
            keep_soniox_files=False,
            auto_slice=True,
            slice_max_min=None,
            transcribe_concurrency=1,
            abort_on_error=False,
            dry_run=True,
        )
    files = pipeline._list_audio_files(vods)
    jobs_report = pipeline.TranscribeReport(audio_total=len(files))
    with captured_logs():
        jobs = pipeline._plan_transcribe_jobs(
            files,
            streams_dir=streams,
            language="zh",
            provider="soniox",
            soniox_model=None,
            no_context=False,
            context_file=None,
            keep_soniox_files=False,
            auto_slice=True,
            slice_max_min=None,
            dry_run=False,
            report=jobs_report,
        )
    empty = work / "empty"
    with captured_logs() as empty_records:
        pipeline.stage_transcribe(
            vods_dir=empty,
            streams_dir=work / "never",
            language="zh",
            provider="soniox",
            soniox_model=None,
            no_context=False,
            context_file=None,
            keep_soniox_files=False,
            auto_slice=True,
            slice_max_min=None,
            transcribe_concurrency=1,
            abort_on_error=False,
            dry_run=True,
        )
    return placehold(
        {
            "vods": VODS,
            "streams": STREAMS,
            "files": [p.name for p in files],
            "logs": records,
            "counts": {
                "total": report.audio_total,
                "skipped": report.audio_skipped,
                "skipped_no_date": report.audio_skipped_no_date,
                "succeeded": report.succeeded,
                "failed": len(report.failed),
            },
            "jobs": [[job.label, job.audio.name, job.date] for job in jobs],
            "empty_logs": empty_records,
            "never_created": not (work / "never").exists(),
        },
        paths,
    )


TRANSCRIPT = "---\nstream_date: 2026-08-01\nstream_id: {id}\n---\n\n## 00:00 — a\n\nb\n"

MAIN: list[dict] = [
    {"name": "missing-list", "argv": ["<WORK>/missing.txt"]},
    {"name": "no-stages", "list": f"{URL}ok/BV1aaaaaaaa1\n", "argv": ["<LIST>", "--stages", ","]},
    {"name": "bad-stages", "list": "", "argv": ["<LIST>", "--stages", "Refine, foo,ALL"]},
    {"name": "bad-provider", "list": "", "argv": ["<LIST>", "--provider", "whisperx"]},
    {
        "name": "shlex",
        "list": f"{URL}ok/BV1aaaaaaaa1\n",
        "argv": ["<LIST>", "--yt-dlp-args", "'unclosed", "--stages", "transcribe"],
    },
    {
        "name": "dry-run",
        "list": f"# a batch\n{URL}ok/BV1aaaaaaaa2\n{URL}fail/1\n",
        "vods": {
            "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}',
            "BV1zzzzzzzz1.m4a": '{"upload_date": "20260802"}',
            "BV1yyyyyyyy1.m4a": None,
        },
        "streams": {"2026-08-02-BV1zzzzzzzz1.md": TRANSCRIPT.format(id="2026-08-02-BV1zzzzzzzz1")},
        "argv": ["<LIST>", "--dry-run", "--vods-dir", "<WORK>/vods/", "--streams-dir",
                 "<WORK>/streams"],
    },
    {
        "name": "run",
        "list": f"{URL}ok/BV1aaaaaaaa2\n{URL}fail/2\n",
        "vods": {"BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}'},
        "rc": {"BV1aaaaaaaa2.m4a": 1},
        "argv": ["<LIST>", "--vods-dir", "<WORK>/vods", "--streams-dir", "<WORK>/streams",
                 "--yt-dlp-args=--sleep-requests 2", "--cookies-from-browser", ""],
    },
    {
        "name": "abort-download",
        "list": f"{URL}fail/1\n{URL}ok/BV1aaaaaaaa2\n",
        "vods": {"BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}'},
        "argv": ["<LIST>", "--vods-dir", "<WORK>/vods", "--streams-dir", "<WORK>/streams",
                 "--abort-on-error", "--cookies-from-browser", ""],
    },
    {
        "name": "abort-transcribe",
        "list": "",
        "vods": {
            "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}',
            "BV1aaaaaaaa2.m4a": '{"upload_date": "20260802"}',
            "BV1aaaaaaaa3.m4a": '{"upload_date": "20260803"}',
        },
        "rc": {"BV1aaaaaaaa1.m4a": 1},
        "argv": ["<LIST>", "--vods-dir", "<WORK>/vods", "--streams-dir", "<WORK>/streams",
                 "--stages", "transcribe,refine", "--abort-on-error"],
    },
    {
        "name": "refine-fails",
        "list": "",
        "rc": {"refine": 1},
        "argv": ["<LIST>", "--streams-dir", "<WORK>/streams", "--stages", "ingest,refine"],
    },
    {
        "name": "refine-aborts",
        "list": "",
        "rc": {"refine": 1},
        "argv": ["<LIST>", "--streams-dir", "<WORK>/streams", "--stages", "refine,ingest",
                 "--abort-on-error"],
    },
    {
        "name": "ingest-fails",
        "list": "",
        "rc": {"ingest_streams": 1},
        "argv": ["<LIST>", "--streams-dir", "<WORK>/streams", "--stages", "ingest"],
    },
    {
        "name": "catalog-fails",
        "list": "",
        "rc": {"build_stream_catalog": 1},
        "argv": ["<LIST>", "--streams-dir", "<WORK>/streams", "--stages", "ingest"],
    },
    {
        "name": "empty-list",
        "list": "# nothing yet\n\n",
        "argv": ["<LIST>", "--vods-dir", "<WORK>/vods", "--stages", "download",
                 "--cookies-from-browser", ""],
    },
    {
        "name": "flags",
        "list": "",
        "vods": {"BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}'},
        "argv": ["<LIST>", "--vods-dir", "<WORK>/vods", "--streams-dir", "<WORK>/streams",
                 "--stages", "transcribe,refine,ingest", "--language", "", "--soniox-model",
                 "stt-x", "--no-context", "--context-file", "<WORK>/c.toml",
                 "--keep-soniox-files", "--slice-max-min", "100", "--refine-model", "m",
                 "--refine-concurrency", "3", "--refine-force", "--skip-types", ""],
    },
    {
        "name": "no-auto-slice",
        "list": "",
        "vods": {"BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}'},
        "argv": ["<LIST>", "--vods-dir", "<WORK>/vods", "--streams-dir", "<WORK>/streams",
                 "--stages", "transcribe", "--no-auto-slice", "--slice-max-min", "100",
                 "--refine-model", ""],
    },
]


def run_main(case: dict, root: Path) -> dict:
    work = root / f"main-{case['name']}"
    work.mkdir()
    home = work / "home"
    os.environ["EIDOLON_HOME"] = str(home)
    os.environ["FAKE_YTDLP_LOG"] = str(work / "argv.log")
    list_path = work / "urls.txt"
    if "list" in case:
        list_path.write_text(case["list"], encoding="utf-8")
    vods = work / "vods"
    if "vods" in case:
        vods.mkdir()
        for name, info in case["vods"].items():
            (vods / name).write_bytes(b"audio")
            if info is not None:
                (vods / name).with_suffix(".info.json").write_text(info, encoding="utf-8")
    if "streams" in case:
        (work / "streams").mkdir()
        for name, text in case["streams"].items():
            (work / "streams" / name).write_text(text, encoding="utf-8")
    argv = [a.replace("<WORK>", str(work)).replace("<LIST>", str(list_path)) for a in case["argv"]]
    rcs = case.get("rc", {})
    calls: list[list[str]] = []
    real_run = subprocess.run

    def fake_run(cmd, *args, **kwargs):
        if cmd[0] != sys.executable or cmd[1] != "-m":
            return real_run(cmd, *args, **kwargs)
        calls.append(list(cmd[2:]))
        module = cmd[2].rsplit(".", 1)[-1]
        rc = rcs.get(Path(cmd[3]).name, 0) if module == "transcribe" else rcs.get(module, 0)
        return subprocess.CompletedProcess(cmd, rc)

    sys.argv = ["laplace-pipeline", *argv]
    out, err = io.StringIO(), io.StringIO()
    code: int | str | None = None
    raised = None
    subprocess.run = fake_run
    try:
        with (
            captured_logs() as records,
            silent_fd1(),
            contextlib.redirect_stdout(out),
            contextlib.redirect_stderr(err),
        ):
            try:
                code = pipeline.main()
            except SystemExit as exit_:
                code = exit_.code
            except Exception as error:
                raised = f"{type(error).__name__}: {error}"
    finally:
        subprocess.run = real_run
    stdout = re.sub(r"\(\d+\.\ds\)", "(<D>s)", out.getvalue())
    stdout = re.sub(r"(Duration: +)\d+\.\ds", r"\1<D>s", stdout)
    paths = {"<PYTHON>": Path(sys.executable), "<HOME>": home, "<WORK>": work}
    return placehold(
        {
            **{k: v for k, v in case.items() if k != "rc"},
            "rc": rcs,
            "code": code,
            "raises": raised,
            "stdout": stdout,
            "stderr": err.getvalue().splitlines()[-1:] if err.getvalue() else [],
            "logs": records,
            "calls": calls,
            "files": sorted(p.name for p in vods.iterdir()) if vods.exists() else None,
        },
        paths,
    )


def ts_parser() -> argparse.ArgumentParser:
    """laplace-pipeline as the TS port declares it, for argparse to lay out its usage and help."""
    p = argparse.ArgumentParser(
        prog="laplace-pipeline",
        description="End-to-end pipeline: bilibili URL list → ingested LanceDB rows.",
    )
    p.add_argument(
        "url_list",
        nargs="?",
        type=Path,
        help="Path to a text file with one URL per line (# comments + blanks ignored). Optional "
        "when --stages leaves out download, and with --dry-run, which then plans every video the "
        "persona's sources know.",
    )
    p.add_argument(
        "--stages",
        type=pipeline._parse_stages,
        default=list(pipeline.ALL_STAGES),
        help="Comma-separated stages to run. Default: all four. Stages always execute in "
        "download→transcribe→refine→ingest order regardless of how you list them. "
        "Valid: download,transcribe,refine,ingest.",
    )
    p.add_argument(
        "--vods-dir",
        type=Path,
        help="Where audio files live (default: the persona's vods/ in the data home's sources).",
    )
    p.add_argument(
        "--streams-dir",
        type=Path,
        help="Where transcripts go (default: the persona's streams/ in the data home's sources).",
    )
    p.add_argument(
        "--abort-on-error",
        action="store_true",
        help="Fail fast on the first per-item failure (a bad URL, a transcribe crash). Default is "
        "to log and continue so a 44-VOD batch isn't killed by one flaky video.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Don't run any stage; just report what would happen. Refine and ingest report what "
        "they would do. With --json, one plan event per video instead.",
    )
    p.add_argument(
        "--persona",
        help="Persona whose sources and index to use (default: the active persona)",
    )
    p.add_argument(
        "--json",
        action="store_true",
        help="Report progress as JSON lines on stdout; the summaries go to stderr",
    )
    d = p.add_argument_group("download stage")
    d.add_argument(
        "--format",
        default="bestaudio[ext=m4a]",
        help="yt-dlp format spec (default: 'bestaudio[ext=m4a]').",
    )
    d.add_argument(
        "--cookies-from-browser",
        help="Browser to read cookies from (default: YT_DLP_COOKIES_FROM_BROWSER, else chrome). "
        "Pass an empty string to disable.",
    )
    d.add_argument(
        "--cookies",
        type=Path,
        help="Path to a cookies.txt file (default: YT_DLP_COOKIES). yt-dlp writes the cookies it "
        "used back into it.",
    )
    d.add_argument(
        "--yt-dlp-args",
        default="",
        help="Extra args forwarded to yt-dlp as a single shell-quoted string. Example: "
        '--yt-dlp-args="--rate-limit 2M --sleep-interval 5".',
    )
    t = p.add_argument_group("transcribe stage")
    t.add_argument(
        "--language",
        help="Language hint (default: the transcription.language setting, else zh). Pass "
        "--language '' for none.",
    )
    t.add_argument(
        "--provider",
        default="soniox",
        choices=("soniox",),
        help="Transcription backend (default: soniox).",
    )
    t.add_argument(
        "--soniox-model",
        help="Override Soniox model (default: the transcription.model setting, else "
        "stt-async-v5).",
    )
    t.add_argument(
        "--no-context",
        action="store_true",
        help="Skip the Soniox structured-context glossary even if the file exists.",
    )
    t.add_argument(
        "--context-file",
        type=Path,
        help="Override the path to the Soniox context TOML (default: the persona's "
        "glossary.toml).",
    )
    t.add_argument(
        "--keep-soniox-files",
        action="store_true",
        help="Don't delete the uploaded file + transcription record from Soniox after success.",
    )
    t.add_argument(
        "--no-auto-slice",
        dest="auto_slice",
        action="store_false",
        default=True,
        help="Disable automatic ffmpeg slicing of audio that exceeds Soniox's 300-min per-file "
        "cap. With slicing off, oversized files fail their transcribe step (and are reported as "
        "failures in the summary). Default: slicing on.",
    )
    t.add_argument(
        "--slice-max-min",
        type=int,
        help="Max minutes per slice when --auto-slice is on (default: 280, which sits well under "
        "the 300-min hard cap to absorb container/encoder drift).",
    )
    t.add_argument(
        "--transcribe-concurrency",
        type=int,
        default=1,
        help="Max transcriptions in flight at once (default: 1, i.e. sequential). Soniox async "
        "accounts cap concurrent jobs at 25 — pick a number well below that for safety; 4–8 is "
        "a good sweet spot for typical home upload bandwidth.",
    )
    r = p.add_argument_group("refine stage")
    r.add_argument(
        "--refine-model",
        help="Override OpenRouter model (default: refine.model or $REFINE_MODEL, else "
        "~google/gemini-pro-latest).",
    )
    r.add_argument(
        "--refine-concurrency",
        type=int,
        help="Max concurrent LLM calls during refine (default: refine.concurrency or "
        "$REFINE_CONCURRENCY, else 8).",
    )
    r.add_argument(
        "--refine-force",
        action="store_true",
        help="Re-refine all chunks even if a sidecar already exists.",
    )
    g = p.add_argument_group("ingest stage")
    g.add_argument(
        "--skip-types",
        help="Comma-separated chunk_type values to leave out of the index (default: "
        "knowledge.archive.skipTypes or $INGEST_SKIP_TYPES, else 'anime_audio,karaoke'; none "
        "drops nothing). Pass an empty string to disable filtering.",
    )
    g.add_argument(
        "--db-path",
        help="LanceDB directory the ingest stage writes (default: the index the bot reads: "
        "knowledge.index or $LANCEDB_PATH, else the persona's index/ in the data home)",
    )
    return p


def main() -> None:
    os.environ["COLUMNS"] = "80"
    root = Path(tempfile.mkdtemp(prefix="pipeline-golden-"))
    bin_dir = root / "bin"
    bin_dir.mkdir()
    shutil.copyfile(FAKE_YTDLP, bin_dir / "yt-dlp")
    (bin_dir / "yt-dlp").chmod(0o755)
    os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ['PATH']}"
    for name in ("EIDOLON_PERSONA", "REFINE_MODEL"):
        os.environ.pop(name, None)
    try:
        parser = ts_parser()
        golden = {
            "printed_by": (
                f"{platform.python_implementation()} {platform.python_version()}, loguru "
                f"{version('loguru')}: packages/ingest/test/fixtures/pipeline/golden.py through "
                "laplace_eidolon.tools.pipeline, with ../download/fake-yt-dlp.sh as yt-dlp and "
                "the stage children faked by exit code"
            ),
            "stages": parse_stages(),
            "summaries": summaries(),
            "plan": plan(root),
            "main": [run_main(case, root) for case in MAIN],
            "help": [parser.format_usage(), parser.format_help()],
        }
    finally:
        shutil.rmtree(root)
    json.dump(golden, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
