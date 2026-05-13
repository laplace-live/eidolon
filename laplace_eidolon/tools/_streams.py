"""Shared parsing for ``streams/*.md`` files.

Both ``tools/ingest_streams.py`` and ``tools/refine.py`` need to agree on:

- How an .md file splits into chunks (H2 boundaries)
- How chunk IDs are generated (``{stream_id}::{idx:03d}``)
- Where the .refined.json sidecar lives next to its source

Keeping this in one place means refine.py's chunk IDs always match
ingest_streams.py's, so refined data can be looked up at ingest time without
re-deriving anything.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import frontmatter

H2_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)


@dataclass
class StreamChunk:
    """A single H2-delimited chunk from a stream transcript."""

    id: str
    """Stable across runs: ``{stream_id}::{idx:03d}``."""
    stream_id: str
    idx: int
    heading: str
    text: str


@dataclass
class ParsedStream:
    """A parsed ``streams/*.md`` file."""

    md_path: Path
    """Path to the source markdown."""
    stream_id: str
    metadata: dict[str, Any]
    """The full YAML frontmatter (whatever was authored)."""
    chunks: list[StreamChunk]

    @property
    def sidecar_path(self) -> Path:
        """``streams/foo.md`` → ``streams/foo.refined.json``."""
        return self.md_path.with_suffix(".refined.json")


def split_into_chunks(body: str) -> list[dict[str, str]]:
    """Split a markdown body into chunks at H2 boundaries.

    Returns ``[{"heading": str, "text": str}, ...]``. Content before the
    first H2 (intro paragraph, if any) is dropped — H2 sections are the
    unit of retrieval.
    """
    chunks: list[dict[str, str]] = []
    matches = list(H2_RE.finditer(body))
    for i, match in enumerate(matches):
        heading = match.group(1).strip()
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        text = body[start:end].strip()
        if text:
            chunks.append({"heading": heading, "text": text})
    return chunks


def parse_stream(md_path: Path) -> ParsedStream:
    """Parse one ``streams/*.md`` into structured chunks with stable IDs."""
    post = frontmatter.load(str(md_path))
    meta: dict[str, Any] = dict(post.metadata or {})
    stream_id = str(meta.get("stream_id", md_path.stem))
    raw = split_into_chunks(post.content)
    chunks = [
        StreamChunk(
            id=f"{stream_id}::{idx:03d}",
            stream_id=stream_id,
            idx=idx,
            heading=c["heading"],
            text=c["text"],
        )
        for idx, c in enumerate(raw)
    ]
    return ParsedStream(
        md_path=md_path,
        stream_id=stream_id,
        metadata=meta,
        chunks=chunks,
    )


def iter_streams(streams_dir: Path) -> list[ParsedStream]:
    """Parse every ``*.md`` file under ``streams_dir`` (sorted, deterministic)."""
    if not streams_dir.exists():
        return []
    return [parse_stream(p) for p in sorted(streams_dir.glob("*.md"))]


def load_sidecar(parsed: ParsedStream) -> dict[str, Any]:
    """Read the .refined.json sidecar for a stream, or an empty stub.

    Empty stub shape::

        {
          "schema_version": 1,
          "stream_id": "...",
          "chunks": {<chunk_id>: {refinement fields}, ...},
          "stats": {...}  # only present after a successful run
        }
    """
    if parsed.sidecar_path.exists():
        try:
            return json.loads(parsed.sidecar_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            # Corrupt sidecar; let the caller decide whether to overwrite.
            return _empty_sidecar(parsed.stream_id)
    return _empty_sidecar(parsed.stream_id)


def _empty_sidecar(stream_id: str) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "stream_id": stream_id,
        "chunks": {},
    }


def save_sidecar(parsed: ParsedStream, data: dict[str, Any]) -> None:
    """Atomically write the .refined.json sidecar."""
    tmp = parsed.sidecar_path.with_suffix(".refined.json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(parsed.sidecar_path)
