"""What tools/refine.py makes of the real transcripts, for refine_real.test.ts, which runs this at
test time; its output carries no transcript text and is never committed. Modes:

- bodies: per chunk, the SHA-256 of the pass-1 body the OpenAI SDK sends, captured by
  httpx2.MockTransport and answered 400, so nothing follows it;
- dry-run: _dry_run_report's text;
- resave: per sidecar, the SHA-256 of what save_sidecar writes, into a temporary folder, for
  what load_sidecar read, and whether that equals the file.
"""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import shutil
import sys
import tempfile
from pathlib import Path

import httpx2
from loguru import logger
from openai import AsyncOpenAI

from laplace_eidolon.tools import refine
from laplace_eidolon.tools._streams import iter_streams, load_sidecar, save_sidecar


async def bodies(streams_dir: Path, model: str) -> None:
    sent: list[bytes] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        sent.append(request.content)
        return httpx2.Response(400, json={"error": {"message": "parity test"}})

    client = AsyncOpenAI(
        base_url=refine.DEFAULT_BASE_URL,
        api_key="parity-test",
        max_retries=4,
        http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
    )
    sem = asyncio.Semaphore(1)
    out = sys.stdout
    for parsed in iter_streams(streams_dir):
        for chunk in parsed.chunks:
            sent.clear()
            _, refinement, _ = await refine._refine_one(client, model, parsed, chunk, sem)
            if refinement is not None or len(sent) != 1:
                raise SystemExit(f"{chunk.id}: expected one failed pass-1 request")
            digest = hashlib.sha256(sent[0]).hexdigest()
            out.write(f"{parsed.md_path.name}\t{chunk.id}\t{digest}\n")


def resave(streams_dir: Path) -> None:
    out = Path(tempfile.mkdtemp(prefix="refine-resave-"))
    try:
        for parsed in iter_streams(streams_dir):
            if not parsed.sidecar_path.exists():
                continue
            copy = dataclasses.replace(parsed, md_path=out / parsed.md_path.name)
            save_sidecar(copy, load_sidecar(parsed))
            written = copy.sidecar_path.read_bytes()
            copy.sidecar_path.unlink()
            same = int(written == parsed.sidecar_path.read_bytes())
            name = parsed.sidecar_path.name
            sys.stdout.write(f"{name}\t{hashlib.sha256(written).hexdigest()}\t{same}\n")
    finally:
        shutil.rmtree(out)


def main() -> None:
    logger.remove()
    mode, streams_dir = sys.argv[1], Path(sys.argv[2])
    if mode == "bodies":
        asyncio.run(bodies(streams_dir, sys.argv[3]))
    elif mode == "dry-run":
        refine._dry_run_report(iter_streams(streams_dir.resolve()), sys.argv[3])
    elif mode == "resave":
        resave(streams_dir)
    else:
        raise SystemExit(f"unknown mode {mode!r}")


if __name__ == "__main__":
    main()
