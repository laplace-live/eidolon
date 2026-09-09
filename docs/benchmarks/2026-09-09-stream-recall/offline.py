"""Check archive recall coverage and local overview latency without provider requests."""

from __future__ import annotations

import asyncio
import json
import socket
import statistics
import sys
import time
from collections import Counter
from datetime import date
from pathlib import Path
from typing import Any, Never, cast
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from laplace_eidolon.embeddings import open_table
from laplace_eidolon.retriever import LanceRetriever
from laplace_eidolon.stream_catalog import StreamCatalog
from laplace_eidolon.stream_recall import StreamRecall

TODAY = date(2026, 9, 9)
LATEST = "2026-09-08-BV1c3YJ6VETN"
WEEK = [
    "2026-09-06-BV1Lrbx6GEMo",
    "2026-09-05-BV1r9b76cEDM",
    "2026-09-04-BV1TYtz6wEbz",
    "2026-09-03-BV1kEtf6GEWE",
    "2026-09-02-BV1CPtE6hEpo",
    "2026-09-01-BV1uAtL6eEUr",
]
NETWORK_ATTEMPTS: list[str] = []


def block_connect(*args: Any, **kwargs: Any) -> Never:
    NETWORK_ATTEMPTS.append("socket.connect")
    raise AssertionError("Offline benchmark attempted a network connection")


class NoSearch:
    def __init__(self) -> None:
        self.calls = 0

    async def search(self, query: str, **kwargs: Any) -> list[dict[str, Any]]:
        self.calls += 1
        raise AssertionError("An overview attempted embedding/hybrid/reranking search")


async def main() -> None:
    catalog = StreamCatalog(ROOT / "data/lancedb")
    started = time.perf_counter()
    broadcasts = catalog.broadcasts()
    cold_catalog_ms = (time.perf_counter() - started) * 1000
    table = open_table(ROOT / "data/lancedb", "stream_chunks")
    assert table is not None
    indexed_week = table.count_rows("stream_date >= '2026-08-31' AND stream_date < '2026-09-07'")
    week = catalog.select(date(2026, 8, 31), date(2026, 9, 7))
    assert [broadcast.id for broadcast in week] == WEEK
    assert len({part for broadcast in week for part in broadcast.stream_ids}) == 14
    assert len({chunk for broadcast in week for chunk in broadcast.source_chunk_ids}) == 310
    socket.socket.connect = block_connect
    socket.socket.connect_ex = block_connect
    cases = [
        ("latest", "你上次直播播了什么？", [LATEST]),
        ("last_week", "你上周直播都播了什么？", WEEK),
        ("explicit_zh", "2026年9月8日直播播了什么？", [LATEST]),
        ("explicit_en", "What did you stream on September 8, 2026?", [LATEST]),
        ("same_week_followup", "那周播了什么？", WEEK),
    ]
    results = []
    search = NoSearch()
    for name, query, expected_ids in cases:
        times: list[float] = []
        result = None
        rendered = ""
        for _ in range(20):
            recall = StreamRecall(
                cast(LanceRetriever, search),
                catalog,
                timezone=ZoneInfo("Asia/Shanghai"),
                today=lambda: TODAY,
            )
            if name == "same_week_followup":
                previous = "你上周直播都播了什么？"
                await recall.lookup(previous, scope=recall.resolve(previous))
            started = time.perf_counter()
            scope = recall.resolve(query)
            assert scope is not None
            result = await recall.lookup(query, scope=scope)
            rendered = result.overview_text(max_chars=10000)
            times.append((time.perf_counter() - started) * 1000)
            actual_ids = [broadcast.id for broadcast in result.broadcasts]
            assert actual_ids == expected_ids, (query, actual_ids)
            assert result.overview and not result.chunks
            assert all(broadcast_id in rendered for broadcast_id in expected_ids)
        assert result is not None
        results.append(
            {
                "name": name,
                "query": query,
                "broadcast_ids": [broadcast.id for broadcast in result.broadcasts],
                "dates": [broadcast.stream_date for broadcast in result.broadcasts],
                "parts": sum(len(broadcast.stream_ids) for broadcast in result.broadcasts),
                "source_scenes": sum(
                    len(broadcast.source_chunk_ids) for broadcast in result.broadcasts
                ),
                "rendered_characters": len(rendered),
                "all_broadcast_ids_in_rendered_context": True,
                "warm_resolve_lookup_render_ms": {
                    "n": len(times),
                    "median": statistics.median(times),
                    "min": min(times),
                    "max": max(times),
                },
            }
        )
    assert search.calls == 0 and NETWORK_ATTEMPTS == []
    report = {
        "boundary": (
            "Offline real catalog/date selection plus overview formatting only. "
            "Fake retriever raises on search; socket connections blocked during recall. "
            "No generated answer, live provider, or full voice latency measurement."
        ),
        "today": TODAY.isoformat(),
        "timezone": "Asia/Shanghai",
        "catalog_broadcast_count": len(broadcasts),
        "cold_catalog_load_ms": cold_catalog_ms,
        "last_week_indexed_chunks": indexed_week,
        "last_week_catalog_scenes": sum(len(broadcast.scenes) for broadcast in week),
        "last_week_scene_types": dict(
            Counter(scene.chunk_type for broadcast in week for scene in broadcast.scenes)
        ),
        "search_attempts": search.calls,
        "network_attempts": len(NETWORK_ATTEMPTS),
        "cases": results,
    }
    output = Path(__file__).with_name("offline-results.json")
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
