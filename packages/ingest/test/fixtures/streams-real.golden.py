"""Prints streams-real.golden.json: what _streams.iter_streams makes of the real transcripts, as
counts and hashes that carry no text. streams_real.test.ts hashes the same lines; change both.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import sys
from importlib.metadata import version
from pathlib import Path

from laplace_eidolon.tools._streams import iter_streams


def _line(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False) + "\n").encode()


def main() -> None:
    home = os.environ.get("EIDOLON_REAL_HOME") or os.environ.get("EIDOLON_HOME")
    root = Path(home).expanduser() if home else Path.home() / ".laplace" / "eidolon"
    streams_dir = root / "sources" / "milky-green" / "streams"
    files = sorted(
        hashlib.sha256(os.fsencode(path.name) + b"\0" + path.read_bytes()).hexdigest()
        for path in streams_dir.glob("*.md")
    )
    headings = hashlib.sha256()
    texts = hashlib.sha256()
    metadata = hashlib.sha256()
    streams = iter_streams(streams_dir)
    chunks = 0
    for stream in streams:
        meta = {key: str(value) for key, value in stream.metadata.items()}
        metadata.update(_line([stream.stream_id, meta]))
        for chunk in stream.chunks:
            chunks += 1
            headings.update(_line([chunk.id, chunk.heading]))
            texts.update(_line([chunk.id, chunk.text]))
    golden = {
        "printed_by": (
            f"CPython {platform.python_version()}, "
            f"python-frontmatter {version('python-frontmatter')}, PyYAML {version('PyYAML')}: "
            "packages/ingest/test/fixtures/streams-real.golden.py over "
            "<EIDOLON_REAL_HOME>/sources/milky-green/streams"
        ),
        "streams": len(streams),
        "chunks": chunks,
        "ids_headings_sha256": headings.hexdigest(),
        "ids_texts_sha256": texts.hexdigest(),
        "metadata_sha256": metadata.hexdigest(),
        "files_sha256": files,
    }
    json.dump(golden, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
