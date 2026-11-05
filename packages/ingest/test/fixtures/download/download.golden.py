"""Prints download.golden.json: what tools/download.py and the skill's prepare_batch.py make of the
synthetic inputs below, with fake-yt-dlp.sh as the yt-dlp on PATH. The TS tests replay the same
inputs from the golden, so change both together.
"""

from __future__ import annotations

import base64
import contextlib
import importlib.util
import io
import json
import os
import platform
import re
import shlex
import shutil
import sys
import tempfile
import time
from datetime import datetime
from importlib.metadata import version
from pathlib import Path
from typing import Any

from loguru import logger

from laplace_eidolon.tools import download

HERE = Path(__file__).resolve().parent
FAKE = HERE / "fake-yt-dlp.sh"
URL = "https://example.invalid/"

spec = importlib.util.spec_from_file_location("prepare_batch", HERE / "prepare_batch.py")
assert spec and spec.loader
prepare_batch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare_batch)

# main() would read the repository's .env; nothing here may.
download.load_dotenv = lambda **_: None


def placehold(value: Any, work: Path) -> Any:
    if isinstance(value, str):
        return value.replace(str(work), "<WORK>")
    if isinstance(value, list):
        return [placehold(v, work) for v in value]
    if isinstance(value, dict):
        return {k: placehold(v, work) for k, v in value.items()}
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
    """The fake's stdout is inherited; keep it out of the golden this script prints."""
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


def read_argv_log(path: Path) -> list[list[str]]:
    if not path.exists():
        return []
    fields = path.read_bytes().split(b"\0")[:-1]
    calls: list[list[str]] = []
    i = 0
    while i < len(fields):
        n = int(fields[i])
        calls.append([f.decode() for f in fields[i + 1 : i + 1 + n]])
        i += 1 + n
    return calls


SHLEX = [
    "",
    "   ",
    "--rate-limit 2M --sleep-interval 5",
    "--sleep-requests 2 -o 'x y'",
    "a\\ b",
    '"a\\"b" c',
    "'a\\b'",
    '"a\\b"',
    '"a\\\\b"',
    "a#b # c",
    "''",
    '""',
    'a""b',
    "a'b'c\"d\"e",
    "a\x0bb\tc\rd\ne",
    "\u3000x y\u3000",
    "\\",
    "x\\",
    "'abc",
    '"abc',
    "'a\"b'",
    '"a\'b"',
    "\\'",
    'tab\\\tafter',
    "中文 '引号'",
]

URL_LIST = (
    "\ufeff# a BOM keeps the first line from reading as a comment\r\n"
    "https://www.bilibili.com/video/BV1aaaaaaaa1\r\n"
    "   https://www.bilibili.com/video/BV1aaaaaaaa2/   \n"
    "\n"
    "  # an indented comment\n"
    "https://www.bilibili.com/video/BV1aaaaaaaa3 # not a comment\r"
    "\x1c\x1dhttps://www.bilibili.com/video/BV1aaaaaaaa4\x85\u2028"
    "\u3000https://www.bilibili.com/video/BV1aaaaaaaa5\u3000\x0c"
    "\ufeffhttps://www.bilibili.com/video/BV1aaaaaaaa6\v"
    "-o /tmp/elsewhere\n"
    "https://www.bilibili.com/video/BV1aaaaaaaa1\n"
)

ARGV = [
    {"url": URL + "ok/x", "vods_dir": "vods", "format": "bestaudio[ext=m4a]",
     "browser": "chrome", "cookies": None, "extra": ""},
    {"url": URL + "ok/x", "vods_dir": "vods", "format": "bestaudio[ext=m4a]",
     "browser": None, "cookies": None, "extra": "--sleep-requests 2 -o 'x y'"},
    {"url": "--exec=touch pwned", "vods_dir": "/abs/v o d s/", "format": "ba",
     "browser": "firefox:default", "cookies": "c/cookies.txt", "extra": "--rate-limit 2M"},
    {"url": URL + "ok/x", "vods_dir": ".", "format": "bestaudio[ext=m4a]",
     "browser": "chrome", "cookies": "./c//k.txt", "extra": ""},
    {"url": URL + "ok/x", "vods_dir": "a/../b", "format": "bestaudio[ext=m4a]",
     "browser": "", "cookies": None, "extra": "-- --x"},
]

SUMMARIES = [
    {"vods_dir": "vods", "requested": 0, "succeeded": 0, "failed": [], "new": 0,
     "duration": 0.0},
    {"vods_dir": "/data/sources/x/vods", "requested": 2, "succeeded": 1,
     "failed": [["https://www.bilibili.com/video/BV1Tp7W64EP7", "exit=1: WARNING: line one\n    ERROR: two"]],
     "new": 1, "duration": 0.25},
    {"vods_dir": ".", "requested": 3, "succeeded": 0,
     "failed": [["u1", ""], ["u2", "\nsecond"], ["u3", "exit=-9: (no stderr captured)"]],
     "new": 0, "duration": 856.55},
]

RUNS = [
    {
        "name": "mixed",
        "initial": [],
        "urls": [
            URL + "ok/BV1aaaaaaaa1",
            URL + "parts/BV1bbbbbbbb1/3",
            URL + "fail/8",
            URL + "quiet",
            URL + "warn",
            URL + "exists/BV1aaaaaaaa1",
            URL + "412",
            "--version",
            URL + "crlf",
            URL + "unicode",
            URL + "kill",
            URL + "cookies",
            URL + "fail/1",
        ],
        "extra": "--sleep-requests 2",
        "browser": "chrome",
        "cookies": None,
    },
    {
        "name": "fallback",
        "initial": ["BV1cccccccc1_p1.m4a", "BV1cccccccc1_p1.info.json", "BV1cccccccc1_p2.m4a",
                    "BV1dddddddd1.info.json", "notes.txt", ".hidden.m4a"],
        "urls": [URL + "fallback/BV1cccccccc1", URL + "ok/BV1dddddddd1"],
        "extra": "",
        "browser": None,
        "cookies": None,
    },
]


def run_scenario(case: dict, root: Path) -> dict:
    work = root / case["name"]
    vods = work / "vods"
    if case["initial"]:
        vods.mkdir(parents=True)
    for name in case["initial"]:
        (vods / name).write_text("x", encoding="utf-8")
    log = work / "argv.log"
    os.environ["FAKE_YTDLP_LOG"] = str(log)
    with captured_logs() as records, silent_fd1():
        report = download.download_urls(
            case["urls"],
            vods_dir=vods,
            cookies_from_browser=case["browser"],
            cookies_file=Path(case["cookies"]) if case["cookies"] else None,
            extra_args=shlex.split(case["extra"]),
        )
    report.duration_sec = 0.0
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        download.print_summary(report, vods)
    return placehold(
        {
            "argv": read_argv_log(log),
            "requested": report.requested_urls,
            "succeeded": report.succeeded_urls,
            "failed": [list(f) for f in report.failed_urls],
            "new_files": [p.name for p in report.new_files],
            "files": sorted(p.name for p in vods.iterdir()),
            "summary": out.getvalue(),
            "logs": records,
        },
        work,
    )


MAIN = [
    {"name": "missing", "list": None, "argv": ["<WORK>/missing.txt", "--vods-dir", "<WORK>/vods"]},
    {"name": "empty", "list": "# nothing yet\n\n", "argv": ["<LIST>", "--vods-dir", "<WORK>/vods"]},
    {"name": "run", "list": f"{URL}ok/BV1aaaaaaaa1\n{URL}fail/2\n",
     "argv": ["<LIST>", "--vods-dir", "<WORK>/vods/", "--yt-dlp-args=--sleep-requests 2"]},
    {"name": "ok", "list": f"{URL}ok/BV1aaaaaaaa1\n",
     "argv": ["--cookies-from-browser", "", "--vods-dir=<WORK>/vods", "<LIST>"]},
    {"name": "both-cookies", "list": f"{URL}ok/BV1aaaaaaaa1\n",
     "argv": ["<LIST>", "--vods-dir", "<WORK>/vods", "--cookies", "<WORK>/c.txt",
              "--format", "ba/b"]},
    {"name": "shlex", "list": f"{URL}ok/BV1aaaaaaaa1\n",
     "argv": ["<LIST>", "--vods-dir", "<WORK>/vods", "--yt-dlp-args", "'unclosed"]},
]


def run_main(case: dict, root: Path) -> dict:
    work = root / f"main-{case['name']}"
    work.mkdir()
    list_path = work / "urls.txt"
    if case["list"] is not None:
        list_path.write_text(case["list"], encoding="utf-8")
    argv = [a.replace("<WORK>", str(work)).replace("<LIST>", str(list_path)) for a in case["argv"]]
    os.environ["FAKE_YTDLP_LOG"] = str(work / "argv.log")
    sys.argv = ["laplace-download", *argv]
    out = io.StringIO()
    raised = None
    code = None
    with captured_logs() as records, silent_fd1(), contextlib.redirect_stdout(out):
        try:
            code = download.main()
        except Exception as error:
            raised = f"{type(error).__name__}: {error}"
    summary = re.sub(r"Duration: +\d+\.\ds", "Duration:       <D>s", out.getvalue())
    return placehold(
        {"code": code, "raises": raised, "stdout": summary, "logs": records,
         "argv_calls": read_argv_log(work / "argv.log")},
        work,
    )


# The baselines and batches of a prepared repository, as prepare_batch.py finds them under data/.
PREPARED = {
    "data/video-full.txt": (
        "https://www.bilibili.com/video/BV1aaaaaaaa1\n"
        "https://www.bilibili.com/video/BV1aaaaaaaa2/\n"
        "//www.bilibili.com/video/BV1aaaaaaaa3\n"
        "# a comment\n"
        "BV1aaaaaaaa4\n"
        "\n"
        "http://bilibili.com/video/BV1aaaaaaaa5?p=2#t=1\n"
        "HTTPS://WWW.BILIBILI.COM:443/video/BV1aaaaaaaa1/\n"
    ),
    "data/video-sample.txt": "  BV1aaaaaaaa6  \r\nhttps://user@www.bilibili.com/video/BV1aaaaaaaa7\r\n",
    "data/auto-embed/videos-2026-01-01-000000.txt": (
        "# Source: x\n# Captured: 2026-01-01T00:00:00+00:00\n# Archive total: 9; new BV IDs: 1\n"
        "https://www.bilibili.com/video/BV1bbbbbbbb1\n"
    ),
    "data/auto-embed/videos-2026-01-01-000000.done.json": "{}\n",
    "data/auto-embed/videos-2026-01-01-000000.log": "a log\n",
    "data/auto-embed/videos-2026-02-01-000000.txt": "https://www.bilibili.com/video/BV1bbbbbbbb2\n",
}

CAPTURES = {
    "capture.txt": (
        "BV1aaaaaaaa1\n"
        "https://www.bilibili.com/video/BV1cccccccc1\n"
        "# the archive page, newest first\n"
        "https://www.bilibili.com/video/BV1bbbbbbbb2/?spm_id_from=333\n"
        "//bilibili.com/video/BV1cccccccc2\n"
        "BV1cccccccc1\n"
        "\x1chttps://www.bilibili.com/video/BV1cccccccc3\x1c\n"
        "BV1aaaaaaaa7\n"
    ),
    "known.txt": "BV1aaaaaaaa1\nBV1bbbbbbbb1\n",
    "mobile.txt": "BV1aaaaaaaa1\nhttps://m.bilibili.com/video/BV1cccccccc1\n",
    "short.txt": "https://b23.tv/AbCdEf1\n",
    "ipv6.txt": "https://[::1/video/BV1cccccccc1\n",
    "bom.txt": "\ufeffBV1cccccccc1\n",
    "space.txt": "https://space.bilibili.com/2132180406/video/BV1cccccccc1\n",
    "lowercase.txt": "bv1cccccccc1\nBV1cccccccc\n",
}
BINARY_CAPTURES = {"latin1.txt": b"BV1cccccccc1\n\xe9t\xe9\n", "truncated.txt": b"BV1cccccccc1\n\xe4\xb8"}

PREPARE = [
    {"name": "dry-run", "capture": "capture.txt", "expected": 6, "dry_run": True},
    {"name": "write", "capture": "capture.txt", "expected": 6, "dry_run": False},
    {"name": "nothing-new", "capture": "known.txt", "expected": 2, "dry_run": False},
    {"name": "mismatch", "capture": "capture.txt", "expected": 7, "dry_run": True},
    {"name": "zero", "capture": "capture.txt", "expected": 0, "dry_run": True},
    {"name": "mobile", "capture": "mobile.txt", "expected": 2, "dry_run": True},
    {"name": "short", "capture": "short.txt", "expected": 1, "dry_run": True},
    {"name": "ipv6", "capture": "ipv6.txt", "expected": 1, "dry_run": True},
    {"name": "bom", "capture": "bom.txt", "expected": 1, "dry_run": True},
    {"name": "space", "capture": "space.txt", "expected": 1, "dry_run": True},
    {"name": "lowercase", "capture": "lowercase.txt", "expected": 2, "dry_run": True},
    {"name": "latin1", "capture": "latin1.txt", "expected": 1, "dry_run": True},
    {"name": "truncated", "capture": "truncated.txt", "expected": 1, "dry_run": True},
    {"name": "missing", "capture": "nope/capture.txt", "expected": 1, "dry_run": True},
    {"name": "no-baselines", "capture": "capture.txt", "expected": 6, "dry_run": True,
     "drop": ["data/video-full.txt", "data/video-sample.txt"]},
    {"name": "bad-baseline", "capture": "capture.txt", "expected": 6, "dry_run": True,
     "extra": {"data/video-bad.txt": "BV1aaaaaaaa1\nnot a url\n"}},
    {"name": "taken", "capture": "capture.txt", "expected": 6, "dry_run": False,
     "extra": {"data/auto-embed/videos-2026-09-08-100209.txt": "BV1aaaaaaaa1\n"}},
]

# 2026-09-08 10:02:09 in America/Los_Angeles, -07:00.
NOW = (2026, 9, 8, 10, 2, 9)


class FixedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(*NOW)


def run_prepare(case: dict, root: Path) -> dict:
    work = root / f"prepare-{case['name']}"
    files = {**PREPARED, **case.get("extra", {})}
    for name in case.get("drop", []):
        files.pop(name)
    for name, text in files.items():
        (work / name).parent.mkdir(parents=True, exist_ok=True)
        (work / name).write_text(text, encoding="utf-8")
    for name, text in CAPTURES.items():
        (work / name).write_text(text, encoding="utf-8")
    for name, data in BINARY_CAPTURES.items():
        (work / name).write_bytes(data)
    try:
        result = prepare_batch.prepare_batch(
            work.resolve(), work / case["capture"], case["expected"], case["dry_run"]
        )
        error = None
    except (OSError, ValueError) as exc:
        result, error = None, f"{exc}"
    created = None
    if result and result["created_batch"]:
        created = Path(result["created_batch"]).read_text(encoding="utf-8")
    return placehold(
        {"result": result, "error": error, "created_text": created}, work.resolve()
    )


PREPARE_MAIN = [
    [],
    ["capture.txt"],
    ["--expected-count", "3"],
    ["--expected-count", "x", "capture.txt"],
    ["--expected-count", "3", "capture.txt", "extra"],
    ["--dry-run=1", "--expected-count", "3", "capture.txt"],
]


def run_prepare_main(argv: list[str]) -> dict:
    sys.argv = ["prepare_batch.py", *argv]
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        try:
            prepare_batch.main()
            code = 0
        except SystemExit as exit_:
            code = exit_.code
    return {"argv": argv, "code": code, "error": err.getvalue().splitlines()[-1]}


def main() -> None:
    os.environ["TZ"] = "America/Los_Angeles"
    time.tzset()
    setattr(prepare_batch, "datetime", FixedDatetime)
    golden: dict = {
        "printed_by": (
            f"CPython {platform.python_version()}, loguru {version('loguru')}: "
            "packages/ingest/test/fixtures/download/download.golden.py through "
            "laplace_eidolon.tools.download and .agents/skills/stream-archive-embed/scripts/"
            "prepare_batch.py, with fake-yt-dlp.sh as yt-dlp"
        )
    }
    shlex_cases = []
    for text in SHLEX:
        try:
            shlex_cases.append({"text": text, "tokens": shlex.split(text)})
        except ValueError as error:
            shlex_cases.append({"text": text, "error": str(error)})
    golden["shlex"] = shlex_cases

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp).resolve()
        bin_dir = root / "bin"
        bin_dir.mkdir()
        shutil.copy(FAKE, bin_dir / "yt-dlp")
        os.chmod(bin_dir / "yt-dlp", 0o755)
        os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ['PATH']}"

        list_path = root / "urls.txt"
        list_path.write_text(URL_LIST, encoding="utf-8")
        try:
            download.read_url_list(root / "missing.txt")
            missing = None
        except FileNotFoundError as error:
            missing = str(error)
        golden["url_list"] = placehold(
            {"text": URL_LIST, "urls": download.read_url_list(list_path), "missing": missing},
            root,
        )

        golden["argv"] = [
            {
                **case,
                "argv": download._build_yt_dlp_cmd(
                    case["url"],
                    vods_dir=Path(case["vods_dir"]),
                    format_spec=case["format"],
                    cookies_from_browser=case["browser"] or None,
                    cookies_file=Path(case["cookies"]) if case["cookies"] else None,
                    extra_args=shlex.split(case["extra"]),
                ),
            }
            for case in ARGV
        ]

        summaries = []
        for case in SUMMARIES:
            report = download.DownloadReport(
                requested_urls=case["requested"],
                succeeded_urls=case["succeeded"],
                failed_urls=[tuple(f) for f in case["failed"]],
                new_files=[Path(f"n{i}.m4a") for i in range(case["new"])],
                duration_sec=case["duration"],
            )
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                download.print_summary(report, Path(case["vods_dir"]))
            summaries.append({**case, "text": out.getvalue()})
        golden["summary"] = summaries

        golden["runs"] = [{**case, **run_scenario(case, root)} for case in RUNS]
        golden["main"] = [{**case, **run_main(case, root)} for case in MAIN]

        golden["prepare_files"] = {
            **PREPARED,
            **CAPTURES,
            **{k: {"b64": base64.b64encode(v).decode()} for k, v in BINARY_CAPTURES.items()},
        }
        golden["prepare"] = [{**case, **run_prepare(case, root)} for case in PREPARE]
        golden["prepare_main"] = [run_prepare_main(argv) for argv in PREPARE_MAIN]

    json.dump(golden, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
