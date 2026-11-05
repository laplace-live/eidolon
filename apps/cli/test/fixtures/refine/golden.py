"""Prints goldens/refine.json: tools/refine.py's main_async over a copy of fixtures/refine/streams,
answered by the canned responses in fixtures/refine/responses.json through httpx2.MockTransport,
with the clock and the date fixed. refine.test.ts replays each scenario through refineMain and
compares the requests, logs, printed text, exit code and sidecars.
"""

from __future__ import annotations

import os

# openrouter.py reads these at import; unset, its headers carry the defaults.
for _name in ("OPENROUTER_APP_NAME", "OPENROUTER_APP_URL", "REFINE_BASE_URL"):
    os.environ.pop(_name, None)

import asyncio
import contextlib
import hashlib
import io
import json
import platform
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx2
from loguru import logger
from openai import AsyncOpenAI

from laplace_eidolon.openrouter import openrouter_headers
from laplace_eidolon.tools import refine as r

HERE = Path(__file__).resolve().parent
FLASH = "~google/gemini-flash-latest"
HEADERS = (
    "authorization",
    "content-type",
    "accept",
    "http-referer",
    "x-title",
    "x-openrouter-title",
    "x-openrouter-categories",
)
PLACEHOLDERS = {
    r.EXTRACT_SYSTEM_PROMPT: "<EXTRACT_SYSTEM_PROMPT>",
    r.SYNTHESIZE_SYSTEM_PROMPT: "<SYNTHESIZE_SYSTEM_PROMPT>",
}

# name, TS argv ("<DIR>" is the copied streams folder), canned responses, CLIArgs fields
SCENARIOS: list[tuple[str, list[str], str | None, dict[str, Any]]] = [
    (
        "run",
        ["--streams-dir", "<DIR>", "--model", FLASH, "--concurrency", "1"],
        "run",
        {"model": FLASH},
    ),
    (
        "force",
        [
            "--force",
            "--concurrency",
            "1",
            "<DIR>/2026-01-04-BV1ccccccccc.md",
            "<DIR>/missing.md",
        ],
        "force",
        {
            "paths": ["<DIR>/2026-01-04-BV1ccccccccc.md", "<DIR>/missing.md"],
            "force": True,
        },
    ),
    (
        "dry-run",
        ["--dry-run", "--streams-dir", "<DIR>", "--model", FLASH],
        None,
        {
            "model": FLASH,
            "dry_run": True,
        },
    ),
    ("dry-run-unpriced", ["--dry-run", "--streams-dir", "<DIR>"], None, {"dry_run": True}),
]


class _FixedDatetime(datetime):
    @classmethod
    def now(cls, tz: Any = None) -> datetime:  # type: ignore[override]
        return datetime(2026, 1, 9, 12, 0, 0, tzinfo=timezone.utc)


def _completion(entry: dict[str, Any]) -> httpx2.Response:
    if "json" in entry:
        return httpx2.Response(entry["status"], headers=entry.get("headers"), json=entry["json"])
    body = {
        "id": "gen-test",
        "object": "chat.completion",
        "created": 1767225600,
        "model": "test/model",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": entry["content"]},
                "finish_reason": entry["finish_reason"],
            }
        ],
        "usage": entry["usage"],
    }
    return httpx2.Response(entry["status"], headers=entry.get("headers"), json=body)


def _request(request: httpx2.Request) -> dict[str, Any]:
    body = json.loads(request.content)
    system = body["messages"][0]
    system["content"] = PLACEHOLDERS.get(system["content"], system["content"])
    name = body["response_format"]["json_schema"]["name"]
    body["response_format"] = f"<{name}>"
    return {
        "url": str(request.url),
        "headers": {name: request.headers.get(name) for name in HEADERS},
        "sha256": hashlib.sha256(request.content).hexdigest(),
        "body": body,
    }


def _run(argv: list[str], responses: list[dict[str, Any]], fields: dict[str, Any]) -> dict:
    tmp = Path(tempfile.mkdtemp(prefix="refine-golden-"))
    work = tmp / "streams"
    shutil.copytree(HERE / "streams", work)
    # Not JSON, so refine starts the stream afresh. Written here: the linter parses committed JSON.
    (work / "2026-01-05-BV1ddddddddd.refined.json").write_text("{not json", encoding="utf-8")
    folder = str(work)
    queue = list(responses)
    requests: list[dict[str, Any]] = []

    async def handler(request: httpx2.Request) -> httpx2.Response:
        requests.append(_request(request))
        # Suspend once, as a real request does; a transport that never suspends lets every
        # chunk finish before as_completed's consumer runs.
        await asyncio.sleep(0)
        if not queue:
            return httpx2.Response(418, json={"error": "no canned response left"})
        return _completion(queue.pop(0))

    def client() -> AsyncOpenAI:
        return AsyncOpenAI(
            base_url=os.getenv("REFINE_BASE_URL", r.DEFAULT_BASE_URL),
            api_key="test-key",
            max_retries=4,
            default_headers=openrouter_headers(),
            http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
        )

    logs: list[list[str]] = []
    logger.remove()
    logger.add(lambda m: logs.append([m.record["level"].name, m.record["message"]]), level="DEBUG")
    r._get_client = client
    r.time = SimpleNamespace(monotonic=lambda: 100.0)  # type: ignore[assignment]
    r.datetime = _FixedDatetime  # type: ignore[misc]

    args = r.CLIArgs(
        paths=[Path(p.replace("<DIR>", folder)) for p in fields.get("paths", [])],
        streams_dir=work,
        model=fields.get("model", r.DEFAULT_MODEL),
        concurrency=1,
        force=fields.get("force", False),
        dry_run=fields.get("dry_run", False),
    )
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        code = asyncio.run(r.main_async(args))

    sidecars = {
        path.name: path.read_text(encoding="utf-8") for path in sorted(work.glob("*.refined.json"))
    }
    files = sorted(path.name for path in work.iterdir())
    shutil.rmtree(tmp)

    def unplace(text: str) -> str:
        return text.replace(folder, "<DIR>")

    return {
        "argv": argv,
        "exit_code": code,
        "stdout": unplace(stdout.getvalue()),
        "logs": [[level, unplace(message)] for level, message in logs],
        "requests": requests,
        "unused_responses": len(queue),
        "sidecars": sidecars,
        "files": files,
    }


def main() -> None:
    responses = json.loads((HERE / "responses.json").read_text(encoding="utf-8"))
    scenarios = []
    for name, argv, canned, fields in SCENARIOS:
        result = _run(argv, responses[canned] if canned else [], fields)
        scenarios.append({"name": name, "responses": canned, **result})
    golden = {
        "printed_by": (
            f"CPython {platform.python_version()}, openai {version('openai')}, "
            f"httpx2 {version('httpx2')}: laplace_eidolon.tools.refine.main_async through "
            "apps/cli/test/fixtures/refine/golden.py"
        ),
        "scenarios": scenarios,
    }
    json.dump(golden, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
