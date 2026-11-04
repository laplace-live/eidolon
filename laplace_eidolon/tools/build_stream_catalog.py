"""Build broadcast overviews from every transcript scene, including songs and anime playback."""

from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import asdict
from datetime import date, datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from loguru import logger

from ..embeddings import default_db_path
from ..stream_catalog import (
    CATALOG_FILENAME,
    CATALOG_VERSION,
    OVERVIEW_MAX_CHARS,
    Broadcast,
    BroadcastScene,
    compact_overview,
)
from ._streams import ParsedStream, iter_streams, load_sidecar


def _broadcast_id(parsed: ParsedStream, stream_date: str) -> str:
    bv = re.search(r"BV[A-Za-z0-9]+", parsed.stream_id)
    base = bv.group(0) if bv else re.sub(r"_p\d+$", "", parsed.stream_id)
    if base.startswith(stream_date + "-"):
        return base
    return f"{stream_date}-{base}" if stream_date else base


def _part_order(parsed: ParsedStream) -> tuple[int, str]:
    match = re.search(r"_p(\d+)$", parsed.stream_id)
    return (int(match.group(1)) if match else 0, parsed.stream_id)


def build_catalog(streams_dir: Path, output: Path) -> list[Broadcast]:
    streams = iter_streams(streams_dir)
    if not streams:
        raise ValueError(f"No stream transcripts found in {streams_dir}")
    groups: dict[tuple[str, str], list[ParsedStream]] = {}
    for parsed in streams:
        stream_date = str(parsed.metadata.get("stream_date") or "")
        if stream_date:
            stream_date = date.fromisoformat(stream_date).isoformat()
        key = (stream_date, _broadcast_id(parsed, stream_date))
        groups.setdefault(key, []).append(parsed)

    broadcasts: list[Broadcast] = []
    for (stream_date, broadcast_id), parts in sorted(groups.items(), reverse=True):
        parts.sort(key=_part_order)
        scenes: list[BroadcastScene] = []
        for parsed in parts:
            refined_map = load_sidecar(parsed).get("chunks") or {}
            for chunk in parsed.chunks:
                refined = refined_map.get(chunk.id) or {}
                timestamp = re.match(r"\d{1,3}:\d{2}(?::\d{2})?", chunk.heading)
                scenes.append(
                    BroadcastScene(
                        id=chunk.id,
                        stream_id=parsed.stream_id,
                        heading=str(refined.get("heading") or chunk.heading),
                        summary=str(refined.get("summary") or ""),
                        topics=tuple(str(topic) for topic in refined.get("topics") or []),
                        chunk_type=str(refined.get("chunk_type") or ""),
                        refined=bool(refined.get("summary")),
                        timestamp=timestamp.group(0) if timestamp else "",
                    )
                )
        scene_tuple = tuple(scenes)
        broadcasts.append(
            Broadcast(
                id=broadcast_id,
                stream_date=stream_date,
                stream_ids=tuple(parsed.stream_id for parsed in parts),
                overview=compact_overview(scene_tuple, OVERVIEW_MAX_CHARS),
                source_chunk_ids=tuple(scene.id for scene in scenes),
                scenes=scene_tuple,
                source_paths=tuple(
                    str(parsed.md_path.relative_to(streams_dir.parent)) for parsed in parts
                ),
                unrefined_count=sum(not scene.refined for scene in scenes),
                overview_compressed=True,
            )
        )

    payload = {
        "schema_version": CATALOG_VERSION,
        "built_at": datetime.now(timezone.utc).isoformat(),
        "source_parts": len(streams),
        "broadcasts": [asdict(item) for item in broadcasts],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return broadcasts


def main() -> int:
    load_dotenv(override=True)
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--streams-dir", type=Path, default=Path("streams"))
    parser.add_argument(
        "--db-path", type=Path, default=Path(os.getenv("LANCEDB_PATH") or default_db_path())
    )
    args = parser.parse_args()
    try:
        broadcasts = build_catalog(args.streams_dir, args.db_path / CATALOG_FILENAME)
    except Exception as exc:
        logger.error(f"Stream catalog build failed: {exc}")
        return 1
    logger.info(
        f"Built {len(broadcasts)} broadcast overviews from "
        f"{sum(len(item.stream_ids) for item in broadcasts)} recording parts into "
        f"{args.db_path / CATALOG_FILENAME}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
