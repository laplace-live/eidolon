from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path
from threading import Event

import pytest

import laplace_eidolon.stream_catalog as stream_catalog
from laplace_eidolon.stream_catalog import CATALOG_FILENAME, StreamCatalog, format_broadcasts
from laplace_eidolon.tools.build_stream_catalog import build_catalog


def _write_part(
    directory: Path,
    stream_id: str,
    stream_date: str,
    chunk_types: tuple[str, ...] = ("commentary",),
    *,
    unrefined: bool = False,
) -> None:
    directory.mkdir(exist_ok=True)
    body = (
        f"---\nstream_id: {stream_id}\nstream_date: {stream_date}\n---\n"
        + "\n".join(
            f"## {i * 5:02d}:00 — Scene {i}\nTranscript {i}" for i in range(len(chunk_types))
        )
    )
    (directory / f"{stream_id}.md").write_text(body)
    if not unrefined:
        (directory / f"{stream_id}.refined.json").write_text(
            json.dumps(
                {
                    "chunks": {
                        f"{stream_id}::{i:03d}": {
                            "heading": f"Heading {i}",
                            "summary": f"Summary of {kind} {i}",
                            "topics": [kind, f"Topic {i}"],
                            "chunk_type": kind,
                        }
                        for i, kind in enumerate(chunk_types)
                    }
                }
            )
        )


def test_parts_group_by_date_and_bv_without_merging_distinct_broadcasts(tmp_path: Path) -> None:
    streams = tmp_path / "streams"
    for part in (10, 2, 1):
        _write_part(streams, f"2026-09-08-BV1abc_p{part}", "2026-09-08")
    _write_part(streams, "2026-09-08-BV2def_p1", "2026-09-08")
    _write_part(streams, "2026-09-09-BV1abc_p1", "2026-09-09")
    broadcasts = build_catalog(streams, tmp_path / CATALOG_FILENAME)
    assert len(broadcasts) == 3
    grouped = next(item for item in broadcasts if item.id == "2026-09-08-BV1abc")
    assert grouped.stream_ids == tuple(f"2026-09-08-BV1abc_p{i}" for i in (1, 2, 10))
    assert len(grouped.source_chunk_ids) == 3
    assert StreamCatalog(tmp_path).recent(1)[0].stream_date == "2026-09-09"


def test_songs_anime_and_unrefined_scenes_remain_in_catalog(tmp_path: Path) -> None:
    streams = tmp_path / "streams"
    _write_part(
        streams,
        "2026-09-08-BV1abc_p1",
        "2026-09-08",
        ("commentary", "karaoke", "anime_audio"),
    )
    _write_part(streams, "2026-09-08-BV1abc_p2", "2026-09-08", unrefined=True)
    build_catalog(streams, tmp_path / CATALOG_FILENAME)
    broadcast = StreamCatalog(tmp_path).broadcasts()[0]
    assert len(broadcast.scenes) == 4
    assert broadcast.scenes[1].summary == "Summary of karaoke 1"
    assert broadcast.scenes[2].summary == "Summary of anime_audio 2"
    assert broadcast.scenes[2].timestamp == "10:00"
    assert broadcast.unrefined_count == 1
    assert "唱歌" in broadcast.overview and "动画播放" in broadcast.overview
    output = format_broadcasts([broadcast])
    assert "1段未精炼" in output and "代表性摘录" in output


def test_select_uses_exclusive_end_and_resolves_part_or_broadcast_ids(tmp_path: Path) -> None:
    streams = tmp_path / "streams"
    for day in (7, 8, 9):
        _write_part(streams, f"2026-09-{day:02d}-BV1abc_p1", f"2026-09-{day:02d}")
    build_catalog(streams, tmp_path / CATALOG_FILENAME)
    catalog = StreamCatalog(tmp_path)
    selected = catalog.select(date(2026, 9, 7), date(2026, 9, 9))
    assert [item.stream_date for item in selected] == ["2026-09-08", "2026-09-07"]
    assert catalog.select(stream_ids=[selected[0].id]) == [selected[0]]
    assert catalog.select(stream_ids=list(selected[0].stream_ids)) == [selected[0]]
    assert catalog.select(stream_ids=[]) == []


def test_cache_refreshes_after_catalog_replacement_and_fails_open(tmp_path: Path) -> None:
    streams = tmp_path / "streams"
    catalog = StreamCatalog(tmp_path)
    assert catalog.broadcasts() == []
    _write_part(streams, "2026-09-08-BV1abc_p1", "2026-09-08")
    output = tmp_path / CATALOG_FILENAME
    build_catalog(streams, output)
    assert len(catalog.broadcasts()) == 1
    _write_part(streams, "2026-09-09-BV1abc_p1", "2026-09-09")
    build_catalog(streams, output)
    assert len(catalog.broadcasts()) == 2
    output.write_text("{")
    assert catalog.broadcasts() == []
    assert catalog.broadcasts() == []
    build_catalog(streams, output)
    assert len(catalog.broadcasts()) == 2
    output.unlink()
    assert catalog.broadcasts() == []


def test_weekly_format_includes_every_broadcast_within_budget(tmp_path: Path) -> None:
    streams = tmp_path / "streams"
    for day in range(1, 8):
        _write_part(
            streams,
            f"2026-09-{day:02d}-BV1abc_p1",
            f"2026-09-{day:02d}",
            ("commentary", "karaoke", "anime_audio") * 12,
        )
    broadcasts = build_catalog(streams, tmp_path / CATALOG_FILENAME)
    output = format_broadcasts(broadcasts, max_chars=4000)
    assert len(output) <= 4000
    for broadcast in broadcasts:
        assert broadcast.id in output
    assert output.count("唱歌") >= 7 and output.count("动画播放") >= 7
    for limit in (0, 1, 20, 100, 300):
        assert len(format_broadcasts(broadcasts, max_chars=limit)) <= limit
        assert len(format_broadcasts([], max_chars=limit)) <= limit
    assert "省略" in format_broadcasts(broadcasts, max_chars=300)


def test_empty_source_does_not_replace_existing_catalog(tmp_path: Path) -> None:
    output = tmp_path / CATALOG_FILENAME
    output.write_text("existing")
    with pytest.raises(ValueError, match="No stream transcripts"):
        build_catalog(tmp_path / "missing", output)
    assert output.read_text() == "existing"


def test_concurrent_cold_reads_wait_for_catalog_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    streams = tmp_path / "streams"
    _write_part(streams, "2026-09-08-BV1abc_p1", "2026-09-08")
    expected = build_catalog(streams, tmp_path / CATALOG_FILENAME)
    catalog = StreamCatalog(tmp_path)
    load_started = Event()
    second_reached = Event()
    release_load = Event()
    original_load = stream_catalog._load_catalog
    original_lock = stream_catalog._CATALOG_LOCK
    loads: list[Path] = []

    class SignalingLock:
        def __enter__(self) -> SignalingLock:
            if load_started.is_set():
                second_reached.set()
            original_lock.acquire()
            return self

        def __exit__(self, *args: object) -> None:
            original_lock.release()

    def blocked_load(
        path: Path, stamp: tuple[int, int],
    ) -> tuple[stream_catalog.Broadcast, ...]:
        loads.append(path)
        load_started.set()
        assert release_load.wait(timeout=5)
        return original_load(path, stamp)

    def second_read() -> list[stream_catalog.Broadcast]:
        result = catalog.broadcasts()
        second_reached.set()
        return result

    monkeypatch.setattr(stream_catalog, "_CATALOG_LOCK", SignalingLock())
    monkeypatch.setattr(stream_catalog, "_load_catalog", blocked_load)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(catalog.broadcasts)
        try:
            assert load_started.wait(timeout=5)
            second = executor.submit(second_read)
            assert second_reached.wait(timeout=5)
        finally:
            release_load.set()
        assert first.result(timeout=5) == expected
        assert second.result(timeout=5) == expected
    assert loads == [catalog.path]
