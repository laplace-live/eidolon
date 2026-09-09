"""Date-scoped broadcast overviews and detailed archive retrieval."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, tzinfo
from typing import Any

from .retriever import LanceRetriever
from .stream_catalog import Broadcast, StreamCatalog, format_broadcasts
from .stream_time import StreamScope, is_stream_overview, resolve_stream_scope

OVERVIEW_FRAME_KEY = "stream_archive_overview"


@dataclass
class RecallResult:
    scope: StreamScope | None
    overview: bool
    broadcasts: list[Broadcast] = field(default_factory=list)
    chunks: list[dict[str, Any]] = field(default_factory=list)
    note: str = ""

    def overview_text(self, max_chars: int = 10000) -> str:
        return format_broadcasts(self.broadcasts, max_chars=max_chars)


def scope_filter(scope: StreamScope, broadcasts: list[Broadcast]) -> str | None:
    if broadcasts and (scope.latest is not None or scope.stream_ids):
        ids = [part for broadcast in broadcasts for part in broadcast.stream_ids]
    else:
        ids = list(scope.stream_ids)
    if ids:
        values = ", ".join("'" + value.replace("'", "''") + "'" for value in ids)
        return f"stream_id IN ({values})"
    conditions = []
    if scope.start_date:
        conditions.append(f"stream_date >= '{scope.start_date.isoformat()}'")
    if scope.end_date:
        conditions.append(f"stream_date < '{scope.end_date.isoformat()}'")
    return " AND ".join(conditions) or None


class StreamRecall:
    def __init__(
        self,
        retriever: LanceRetriever,
        catalog: StreamCatalog,
        *,
        timezone: tzinfo,
        candidates: int = 15,
        top_k: int = 3,
        today: Callable[[], date] | None = None,
    ) -> None:
        self.retriever = retriever
        self.catalog = catalog
        self.candidates = candidates
        self.top_k = top_k
        self._today = today or (lambda: datetime.now(timezone).date())
        self.selected_scope: StreamScope | None = None

    def resolve(self, query: str) -> StreamScope | None:
        return resolve_stream_scope(query, today=self._today(), previous=self.selected_scope)

    def select(self, scope: StreamScope) -> list[Broadcast]:
        if scope.latest is not None:
            broadcasts = [
                broadcast for broadcast in self.catalog.broadcasts()
                if broadcast.stream_date <= self._today().isoformat()
            ]
            chosen = broadcasts[scope.latest - 1:scope.latest]
            if not chosen:
                return []
            return [b for b in broadcasts if b.stream_date == chosen[0].stream_date]
        return self.catalog.select(
            start_date=scope.start_date,
            end_date=scope.end_date,
            stream_ids=list(scope.stream_ids) if scope.stream_ids else None,
        )

    def remember(self, result: RecallResult) -> None:
        if result.scope is None:
            return
        scope = result.scope
        dates = [date.fromisoformat(b.stream_date) for b in result.broadcasts if b.stream_date]
        self.selected_scope = StreamScope(
            start_date=scope.start_date or (min(dates) if dates else None),
            end_date=scope.end_date or (max(dates) + timedelta(days=1) if dates else None),
            stream_ids=tuple(broadcast.id for broadcast in result.broadcasts),
            label=scope.label,
        ) if result.broadcasts else scope

    async def lookup(
        self,
        query: str,
        *,
        scope: StreamScope | None = None,
        overview: bool | None = None,
    ) -> RecallResult:
        overview = is_stream_overview(query) if overview is None else overview
        broadcasts = await asyncio.to_thread(self.select, scope) if scope is not None else []
        result = RecallResult(scope=scope, overview=overview, broadcasts=broadcasts)
        if scope is not None and scope.latest is not None and len(broadcasts) > 1:
            result.note = "当天有多场归档但没有开播时间，无法确定这些场次的先后；不要猜测哪场最后。"
        if overview:
            if scope is None:
                result.note = "还没有明确要回顾哪场直播或哪个时间段，请先确定范围。"
            elif not broadcasts:
                result.note = "这个范围没有已归档的直播概览；不能据此断定没有直播。"
            self.remember(result)
            return result

        where = scope_filter(scope, broadcasts) if scope is not None else None
        if scope is not None and scope.latest is not None and not broadcasts:
            result.note = "没有可确定最近场次的直播概览，不能把其他日期的片段当作最近直播。"
            return result
        result.chunks = await self.retriever.search(
            query,
            candidates=self.candidates,
            top_k=self.top_k,
            date_prefilter=scope is None,
            where=where,
        )
        if not result.chunks:
            result.note += "没有找到能回答这个问题的直播片段；概览只能支持其中明确记录的内容。"
        self.remember(result)
        return result
