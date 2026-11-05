"""Prints run.golden.json: tools/transcribe.py's main() run through the real soniox SDK against a
fake Soniox (an httpx.MockTransport serving each scenario's canned responses), with ffprobe and
ffmpeg stubbed. Records the requests and the files written. transcribe_run.test.ts serves the same
responses to the TS client and compares.

    TMPDIR=<scratch> uv run --offline --no-sync python \
        packages/ingest/test/fixtures/transcribe/run.golden.py \
        > packages/ingest/test/fixtures/transcribe/run.golden.json
    bunx biome format --write packages/ingest/test/fixtures/transcribe/run.golden.json
"""

from __future__ import annotations

import json
import os
import platform
import sys
import tempfile
import time
from importlib.metadata import version
from pathlib import Path
from typing import Any

import httpx
import soniox
from loguru import logger

from laplace_eidolon.tools import transcribe as t

HERE = Path(__file__).resolve().parent
SDK_CLIENT = soniox.SonioxClient


def token(text: str, start: int | None, end: int | None, confidence: Any = 0.5, **extra: Any) -> dict:
    return {"text": text, "start_ms": start, "end_ms": end, "confidence": confidence, **extra}


def job(n: int, filename: str, duration_ms: int, tokens: list[dict], text: str) -> dict:
    tid = f"00000000-0000-4000-8000-00000000000{n}"
    meta = {
        "id": tid,
        "created_at": f"2026-01-02T03:0{n}:05.678Z",
        "model": "stt-async-v5",
        "file_id": f"file-{n}",
        "filename": filename,
        "language_hints": ["zh"],
        "enable_speaker_diarization": False,
        "enable_language_identification": False,
    }
    return {
        "file": {
            "id": f"file-{n}",
            "filename": filename,
            "size": 4,
            "created_at": "2026-01-02T03:04:00Z",
        },
        "created": {**meta, "status": "queued", "audio_duration_ms": None},
        "polls": [
            {**meta, "status": "processing", "audio_duration_ms": 0},
            {**meta, "status": "completed", "audio_duration_ms": duration_ms},
        ],
        "transcript": {"id": tid, "text": text, "tokens": tokens},
    }


SINGLE_TOKENS = [
    token("喂", 341_000, 341_200, 0.9195119142532349),
    token("？", 341_200, 341_300, 1),
    token("好", 342_000, 342_100, 1.0, is_audio_event=None),
    token("了", 344_000, 344_500),
    token("。", 344_500, 344_600),
    token(" ", 344_600, 344_600),
    token("x", None, None),
    token("Hello", 400_000, 400_400),
    token(" world", 400_400, 401_000, is_audio_event=False),
    token(".", 401_000, 401_100),
    token(" ", 401_100, 401_100),
    token("在", 3_660_000, 3_660_100),
    token("那", 3_700_000, 3_700_200),
]

PART1 = [
    token("一", 0, 100),
    token("二", 9_336_000, 9_336_100),
    token("。", 9_336_200, 9_336_300),
]
PART2 = [
    token("三", 100, 200),
    token("四", 3_000, 3_100),
    token("！", 3_100, 3_200),
    token(" ", 3_200, 3_200),
    token("五", 400_000, 400_100),
]

SCENARIOS = [
    {
        "name": "single",
        "audio": "BV1aaaaaaaaa.m4a",
        "date": "2026-01-02",
        "duration": 3_725.5,
        "args": ["--context-file", str(HERE / "glossary" / "full.toml")],
        "jobs": [job(1, "BV1aaaaaaaaa.m4a", 3_725_400, SINGLE_TOKENS, "喂？好了。 Hello world. 在那")],
    },
    {
        "name": "sliced",
        "audio": "BV1bbbbbbbbb.m4a",
        "date": "2022-09-27",
        "duration": 18_675.394833,
        "args": ["--no-context", "--auto-slice"],
        "jobs": [
            job(1, "part_01_of_02.m4a", 9_337_280, PART1, "一二。"),
            job(2, "part_02_of_02.m4a", 9_337_269, PART2, "三四！ 五"),
        ],
    },
    {
        "name": "no_language",
        "audio": "BV1ccccccccc.m4a",
        "date": "2026-03-04",
        "duration": 60.0,
        "args": ["--language", "", "--no-context", "--window", "60"],
        "jobs": [job(1, "BV1ccccccccc.m4a", 59_999, SINGLE_TOKENS[:6], "喂？好了。 ")],
    },
]


def serve(scenario: dict, requests: list[dict]) -> httpx.MockTransport:
    jobs = scenario["jobs"]
    uploads = iter(jobs)
    creates = iter(jobs)
    by_id = {j["created"]["id"]: j for j in jobs}
    polls = {tid: list(j["polls"]) for tid, j in by_id.items()}

    def handle(request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/v1")
        record: dict[str, Any] = {"method": request.method, "path": path}
        if path == "/files" and request.method == "POST":
            body = request.read()
            fields = {}
            for part in body.split(b"--" + request.headers["content-type"].split("boundary=")[1].encode()):
                if b'name="client_reference_id"' in part:
                    fields["client_reference_id"] = part.split(b"\r\n\r\n", 1)[1].rstrip(b"\r\n").decode()
                if b'name="file"' in part:
                    head = part.split(b"\r\n\r\n", 1)[0].decode()
                    fields["filename"] = head.split('filename="', 1)[1].split('"', 1)[0]
            record["form"] = fields
            requests.append(record)
            return httpx.Response(201, json=next(uploads)["file"])
        if path == "/transcriptions" and request.method == "POST":
            record["json"] = request.content.decode()
            requests.append(record)
            return httpx.Response(201, json=next(creates)["created"])
        requests.append(record)
        parts = path.split("/")
        tid = parts[2]
        if request.method == "DELETE":
            return httpx.Response(204)
        if len(parts) == 4:
            return httpx.Response(200, json=by_id[tid]["transcript"])
        queue = polls[tid]
        return httpx.Response(200, json=queue.pop(0) if len(queue) > 1 else queue[0])

    return httpx.MockTransport(handle)


def run(scenario: dict) -> dict:
    requests: list[dict] = []
    transport = serve(scenario, requests)

    class Client(SDK_CLIENT):  # type: ignore[valid-type,misc]
        def __init__(self, **kwargs: Any) -> None:
            super().__init__(transport=transport, **kwargs)

    with tempfile.TemporaryDirectory(prefix="run-golden-") as tmp:
        work = Path(tmp)
        audio = work / scenario["audio"]
        audio.write_bytes(b"\0" * 2048)
        out = work / "streams"

        def fake_slice(src: Path, *, start_sec: float, duration_sec: float, out_path: Path) -> None:
            out_path.write_bytes(b"part")

        soniox.SonioxClient = Client  # type: ignore[misc]
        t._probe_duration_sec = lambda path: scenario["duration"]  # type: ignore[assignment]
        t._ffmpeg_slice = fake_slice  # type: ignore[assignment]
        sys.argv = [
            "laplace-transcribe",
            str(audio),
            "--date",
            scenario["date"],
            "--out-dir",
            str(out),
            *scenario["args"],
        ]
        code = t.main()
        stem = f"{scenario['date']}-{audio.stem}"
        md = out / f"{stem}.md"
        payload = out / f"{stem}.soniox.json"
        return {
            "name": scenario["name"],
            "audio": scenario["audio"],
            "date": scenario["date"],
            "duration": scenario["duration"],
            "args": [a.replace(str(HERE), "<FIXTURES>") for a in scenario["args"]],
            "jobs": scenario["jobs"],
            "exit_code": code,
            "requests": requests,
            "md": md.read_text(encoding="utf-8") if md.exists() else None,
            "payload": payload.read_text(encoding="utf-8") if payload.exists() else None,
        }


def main() -> None:
    logger.remove()
    t.load_dotenv = lambda *args, **kwargs: None  # type: ignore[assignment]
    os.environ["SONIOX_API_KEY"] = "test-key"
    time.sleep = lambda seconds: None  # type: ignore[assignment]
    golden = {
        "printed_by": (
            f"CPython {platform.python_version()}, soniox {version('soniox')}, "
            f"httpx {version('httpx')}: packages/ingest/test/fixtures/transcribe/run.golden.py"
        ),
        "scenarios": [run(s) for s in SCENARIOS],
    }
    json.dump(golden, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
