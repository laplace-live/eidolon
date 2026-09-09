"""Cached broadcast overviews shared by the runtime and the offline catalog builder."""

from __future__ import annotations

import json
import threading
from collections import Counter
from dataclasses import dataclass
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Any

from loguru import logger

CATALOG_FILENAME = "stream_catalog.json"
CATALOG_VERSION = 1
OVERVIEW_MAX_CHARS = 1800
_CATALOG_LOCK = threading.Lock()
_TYPE_NAMES = {
    "commentary": "杂谈/解说",
    "sc_session": "读SC",
    "anime_audio": "动画播放",
    "karaoke": "唱歌",
    "opening": "开场",
    "closing": "收尾",
    "mixed": "混合内容",
    "transition": "转场",
    "": "未分类",
}


@dataclass(frozen=True)
class BroadcastScene:
    id: str
    stream_id: str
    heading: str
    summary: str
    topics: tuple[str, ...]
    chunk_type: str
    refined: bool
    timestamp: str = ""


@dataclass(frozen=True)
class Broadcast:
    id: str
    stream_date: str
    stream_ids: tuple[str, ...]
    overview: str
    source_chunk_ids: tuple[str, ...]
    scenes: tuple[BroadcastScene, ...] = ()
    source_paths: tuple[str, ...] = ()
    unrefined_count: int = 0
    overview_compressed: bool = False


def _clip(text: str, max_chars: int) -> str:
    if max_chars <= 0:
        return ""
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1] + "…"


def compact_overview(scenes: tuple[BroadcastScene, ...], max_chars: int) -> str:
    if not scenes:
        return _clip("没有可用的分段摘要。", max_chars)
    types = Counter(scene.chunk_type for scene in scenes)
    activities = "、".join(
        f"{_TYPE_NAMES.get(kind, kind)}({count}段)" for kind, count in types.most_common()
    )
    topics: Counter[str] = Counter()
    for scene in scenes:
        topics.update(list(dict.fromkeys(scene.topics)))
    themes = "、".join(topic for topic, _ in topics.most_common(12))
    prefix = f"活动：{activities}。"
    if themes:
        prefix += f"主题：{_clip(themes, max(30, max_chars // 4))}。"

    selected: set[int] = set()
    seen_types: set[str] = set()
    seen_parts: set[str] = set()
    for index, scene in enumerate(scenes):
        if scene.chunk_type not in seen_types or scene.stream_id not in seen_parts:
            selected.add(index)
            seen_types.add(scene.chunk_type)
            seen_parts.add(scene.stream_id)
    for step in range(min(8, len(scenes))):
        selected.add(round(step * (len(scenes) - 1) / max(1, min(8, len(scenes)) - 1)))
    remaining = max_chars - len(prefix) - len("代表片段：")
    if remaining < 40:
        return _clip(prefix, max_chars)
    per_scene = min(150, max(24, remaining // len(selected) - 1))
    snippets = [
        _clip(
            f"{scenes[index].heading}：{scenes[index].summary}"
            if scenes[index].summary
            else f"{scenes[index].heading}（尚无精炼摘要）",
            per_scene,
        )
        for index in sorted(selected)
    ]
    return _clip(prefix + "代表片段：" + "；".join(snippets), max_chars)


def _broadcast_from_json(item: dict[str, Any]) -> Broadcast:
    return Broadcast(
        id=item["id"],
        stream_date=item["stream_date"],
        stream_ids=tuple(item["stream_ids"]),
        overview=item["overview"],
        source_chunk_ids=tuple(item["source_chunk_ids"]),
        scenes=tuple(
            BroadcastScene(
                id=scene["id"],
                stream_id=scene["stream_id"],
                heading=scene["heading"],
                summary=scene["summary"],
                topics=tuple(scene["topics"]),
                chunk_type=scene["chunk_type"],
                refined=scene["refined"],
                timestamp=scene.get("timestamp", ""),
            )
            for scene in item.get("scenes", [])
        ),
        source_paths=tuple(item.get("source_paths", [])),
        unrefined_count=item.get("unrefined_count", 0),
        overview_compressed=item.get("overview_compressed", False),
    )


@lru_cache(maxsize=2)
def _load_catalog(path: Path, stamp: tuple[int, int]) -> tuple[Broadcast, ...]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload["schema_version"] != CATALOG_VERSION:
        raise ValueError("Unsupported stream catalog version")
    return tuple(sorted(
        (_broadcast_from_json(item) for item in payload["broadcasts"]),
        key=lambda item: (item.stream_date, item.id), reverse=True,
    ))


class StreamCatalog:
    def __init__(self, db_path: str | Path) -> None:
        self.path = (Path(db_path) / CATALOG_FILENAME).resolve()
        self._stamp: tuple[int, int] | None = None
        self._broadcasts: list[Broadcast] = []
        self._missing_logged = False

    def broadcasts(self) -> list[Broadcast]:
        try:
            stat = self.path.stat()
            stamp = (stat.st_mtime_ns, stat.st_size)
            with _CATALOG_LOCK:
                if stamp != self._stamp:
                    self._broadcasts = list(_load_catalog(self.path, stamp))
                    self._stamp = stamp
                    self._missing_logged = False
        except FileNotFoundError:
            self._stamp = None
            self._broadcasts = []
            if not self._missing_logged:
                logger.debug(f"Stream catalog unavailable: {self.path}")
                self._missing_logged = True
        except Exception as exc:
            self._broadcasts = []
            logger.warning(f"Stream catalog unavailable: {exc}")
        return list(self._broadcasts)

    def select(
        self,
        start_date: date | None = None,
        end_date: date | None = None,
        stream_ids: list[str] | None = None,
    ) -> list[Broadcast]:
        selected_ids = set(stream_ids) if stream_ids is not None else None
        return [
            item
            for item in self.broadcasts()
            if (start_date is None or item.stream_date >= start_date.isoformat())
            and (
                end_date is None
                or bool(item.stream_date) and item.stream_date < end_date.isoformat()
            )
            and (
                selected_ids is None
                or item.id in selected_ids
                or bool(selected_ids.intersection(item.stream_ids))
            )
        ]

    def recent(self, n: int = 3) -> list[Broadcast]:
        return self.broadcasts()[: max(0, n)]


def format_broadcasts(broadcasts: list[Broadcast], max_chars: int = 7000) -> str:
    if not broadcasts:
        return _clip("该范围没有已归档录播；这不代表当时没有直播。", max_chars)
    intro = f"已归档录播共{len(broadcasts)}场；仅据现有记录，不能视为完整开播记录。\n"
    headers = [
        f"{item.stream_date or '日期未知'} [{item.id}] "
        f"{len(item.stream_ids)}个录播分P/{len(item.source_chunk_ids)}段"
        + (f"，{item.unrefined_count}段未精炼" if item.unrefined_count else "")
        for item in broadcasts
    ]
    footer = "\n以上是压缩概览，片段为代表性摘录；具体细节需查询原始分段。"
    base_size = len(intro) + len(footer) + sum(len(header) + 2 for header in headers)
    per_broadcast = min(OVERVIEW_MAX_CHARS, max(0, (max_chars - base_size) // len(broadcasts)))
    if per_broadcast < 50:
        footer = "\n篇幅不足，以下场次及内容可能省略，不能据此声称完整回顾。"
        available = max(0, max_chars - len(intro) - len(footer))
        return _clip(intro + _clip("\n".join(headers), available) + footer, max_chars)
    entries: list[str] = []
    for item, header in zip(broadcasts, headers):
        overview = (
            compact_overview(item.scenes, per_broadcast)
            if item.scenes
            else _clip(item.overview, per_broadcast)
        )
        entries.append(f"{header}\n{overview}")
    return _clip(intro + "\n".join(entries) + footer, max_chars)
