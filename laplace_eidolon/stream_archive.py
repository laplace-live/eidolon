"""Stream archive — LanceDB-backed RAG over past stream transcripts.

``StreamArchiveService`` is a Pipecat ``FrameProcessor`` that intercepts
``LLMContextFrame``, searches the ``stream_chunks`` LanceDB table that
``tools/ingest_streams.py`` builds from ``streams/*.md``, and injects the
top matches as a system message before the LLM runs.

Sister service: ``persona_facts.PersonaFactsService`` — same pipeline
position, one-line facts instead of transcript scenes.
"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Literal, cast
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import Frame, LLMContextFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.llm_service import FunctionCallParams, LLMService
from pydantic import BaseModel, Field

from .embeddings import DEFAULT_DB_PATH
from .env import env_int
from .retrieval import build_query_text
from .retrieval_gate import GATE_FRAME_KEY, unless_skipped
from .retriever import LanceRetriever
from .stream_catalog import StreamCatalog, format_broadcasts
from .stream_recall import OVERVIEW_FRAME_KEY, RecallResult, StreamRecall
from .stream_time import (
    StreamScope,
    has_stream_time_reference,
    is_stream_elaboration,
    is_stream_followup,
    is_stream_overview,
    is_stream_query,
)

DEFAULT_TABLE = "stream_chunks"
LABEL = "Archive"
INGEST_HINT = "uv run laplace-ingest-streams"
RECALL_TOOL_NAME = "recall_streams"
_RECENT_PREFIX = "最近已归档的直播概览：\n"
_RECALL_PREFIX = "本次直播回忆查询：\n"


class RecallRequest(BaseModel):
    model_config = {"extra": "forbid"}

    query: str = Field(min_length=1, max_length=2000)
    mode: Literal["overview", "details"]
    period: Literal[
        "latest", "previous", "this_week", "last_week", "this_month", "last_month",
        "past_days", "date_range", "selected", "broadcasts", "all",
    ]
    start_date: date | None = None
    end_date: date | None = None
    days: int = Field(default=7, ge=1, le=366)
    broadcast_ids: list[str] = Field(default_factory=list, max_length=20)


def decode_topics(row: dict[str, Any]) -> list[str]:
    """Decode the ``topics`` column. ``tools/refine.py`` writes a JSON
    ``list[str]``; unrefined rows store the literal string ``"[]"``."""
    raw = row.get("topics") or ""
    if not raw:
        return []
    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError:
        return []
    return [str(t) for t in decoded] if isinstance(decoded, list) else []


def summarize_hits(results: list[dict[str, Any]]) -> str:
    """Per-table detail for the hit log line."""
    dates = sorted({r.get("stream_date", "?") for r in results})
    refined_n = sum(1 for r in results if r.get("refined"))
    types = sorted({r.get("chunk_type") or "raw" for r in results})
    return f"dates={dates}, refined={refined_n}/{len(results)}, types={types}"


def build_retriever(
    db_path: str | os.PathLike[str] = DEFAULT_DB_PATH,
    table_name: str = DEFAULT_TABLE,
    *,
    embed_model: str | None = None,
) -> LanceRetriever:
    """A retriever over the stream-archive table, configured as the bot uses it."""
    return LanceRetriever(
        db_path,
        table_name,
        date_column="stream_date",
        label=LABEL,
        summarize=summarize_hits,
        ingest_hint=INGEST_HINT,
        embed_model=embed_model,
    )


class StreamArchiveService(FrameProcessor):
    """RAG over past stream transcripts, fronted as a Pipecat FrameProcessor.

    Place between the user aggregator and the LLM. Coexists with
    ``Mem0MemoryService`` and ``PersonaFactsService``; each inserts one
    system message per turn.
    """

    class InputParams(BaseModel):
        """Tunables for stream-archive retrieval."""

        top_k: int = Field(default=3, ge=1, le=20)
        """Chunks injected per turn after reranking. Each is ~5 minutes of
        transcript (~500-1500 tokens), so this stays small or the system
        prompt balloons."""

        candidates: int = Field(
            default_factory=lambda: env_int("STREAM_ARCHIVE_CANDIDATES", 15),
            ge=1,
            le=100,
        )
        """Hybrid-search pool the reranker picks ``top_k`` from. Chunks are
        ~50× the size of a persona fact, so the reranker scores ~750× the
        bytes per query; 15 is the sweet spot at ~30k chunks.
        ``STREAM_ARCHIVE_CANDIDATES`` overrides."""

        min_query_chars: int = Field(default=4, ge=1)
        """Skip retrieval below this length. ``build_query_text`` folds in
        prior turns first, so this only trips on a vacant conversation."""

        max_user_turns: int = Field(default=3, ge=1, le=10)
        """Recent user turns concatenated when the latest message is too
        short alone. See ``retrieval.build_query_text``."""

        date_prefilter: bool = Field(default=True)
        """SQL pre-filter on ``stream_date`` when the query names a day,
        applied before vector + FTS scoring. Stops "26年3月24" from
        surfacing 2023-12-24 chunks; one stream day still yields ~10-20
        chunks, so the reranker isn't starved. Disable if your corpus has
        unreliable dates."""

        system_prompt: str = Field(
            default=(
                "你过去直播里相关的片段"
                "（用来 ground 你的回复，不要照念，也不要把日期念出来）：\n\n"
            )
        )

        position: int = Field(default=2, ge=0)
        """Insert index inside ``context.get_messages()``.

        ``system_instruction`` lives on the LLM service rather than in the
        context, so on the first turn the context is just ``[user_msg]``
        and any ``position >= 1`` clamps to "append at end". Set 0 to put
        stream context before the user message.
        """

        embed_model: str | None = Field(default=None)
        """Overrides the ``EMBED_MODEL`` env var, which itself defaults to
        ``google/gemini-embedding-2-preview``. Must match what ingest used,
        or the vectors aren't comparable."""

    def __init__(
        self,
        *,
        db_path: str | os.PathLike[str] = DEFAULT_DB_PATH,
        table_name: str = DEFAULT_TABLE,
        params: InputParams | None = None,
    ):
        """Initialize the stream-archive service."""
        super().__init__()
        self._params = params or StreamArchiveService.InputParams()
        self._retriever = build_retriever(
            db_path, table_name, embed_model=self._params.embed_model
        )
        try:
            timezone = ZoneInfo(os.getenv("PERSONA_TIMEZONE") or "Asia/Shanghai")
        except ZoneInfoNotFoundError:
            timezone = ZoneInfo("UTC")
        self.recall = StreamRecall(
            self._retriever,
            StreamCatalog(Path(db_path)),
            timezone=timezone,
            candidates=self._params.candidates,
            top_k=self._params.top_k,
        )
        self._turn_key: tuple[int, str] | None = None
        self._tools: ToolsSchema | None = None
        self._tool_calls = 0
        self._last_was_archive = False

        if self._retriever.table is not None:
            logger.info(
                f"StreamArchiveService initialized with "
                f"{self._retriever.row_count()} chunks "
                f"(candidates={self._params.candidates}, top_k={self._params.top_k}, "
                f"date_prefilter={self._params.date_prefilter})"
            )

    async def _search(self, query: str) -> list[dict[str, Any]]:
        return await self._retriever.search(
            query,
            candidates=self._params.candidates,
            top_k=self._params.top_k,
            date_prefilter=self._params.date_prefilter,
        )

    @staticmethod
    def _format_chunks(chunks: list[dict[str, Any]], prefix: str) -> str:
        """Render retrieved chunks as a single system message.

        Prefers a v2 refined chunk's ``details`` + extras, falls back to a
        v1 ``summary``, then to the raw transcript. Rendering ``sc_events``
        per viewer is what lets the persona recall who said what.
        """
        lines = [prefix]
        for i, chunk in enumerate(chunks, 1):
            date = chunk.get("stream_date", "unknown date")
            heading = chunk.get("heading", "")
            summary = chunk.get("summary") or ""
            details = chunk.get("details") or ""
            text = chunk.get("text", "")

            extras_raw = chunk.get("extras_json") or ""
            extras: dict[str, Any] = {}
            if extras_raw:
                try:
                    extras = json.loads(extras_raw)
                except json.JSONDecodeError:
                    extras = {}

            topics = decode_topics(chunk)

            header = f"[{i}] {date}"
            if topics:
                header += f" — {', '.join(topics)}"
            if heading:
                header += f" — {heading}"
            lines.append(header)

            if details:
                lines.append(details.strip())
                StreamArchiveService._append_extras(lines, extras)
            elif summary:
                lines.append(summary.strip())
            else:
                lines.append(text.strip())
            lines.append("")
        return "\n".join(lines).rstrip() + "\n"

    @staticmethod
    def _append_extras(lines: list[str], extras: dict[str, Any]) -> None:
        """Append the structured v2 fields: SC events, songs, events, quotes."""
        sc_events = extras.get("sc_events") or []
        if sc_events:
            lines.append("SC回顾:")
            for sc in sc_events:
                viewer = sc.get("viewer") or "?"
                amount = sc.get("amount_yuan")
                content = (sc.get("content") or "").strip()
                response = (sc.get("response") or "").strip()
                head = f"  • {viewer}"
                if amount:
                    head += f"（¥{amount}）"
                if content:
                    head += f": {content}"
                lines.append(head)
                if response:
                    lines.append(f"    → 我的回复: {response}")

        songs = extras.get("songs") or []
        if songs:
            song_titles = []
            for s in songs:
                if isinstance(s, dict):
                    title = (s.get("title") or "").strip()
                    note = (s.get("note") or "").strip()
                    song_titles.append(f"《{title}》{f'（{note}）' if note else ''}")
                elif isinstance(s, str):
                    song_titles.append(f"《{s}》")
            if song_titles:
                lines.append("歌曲: " + "; ".join(song_titles))

        events = extras.get("events") or []
        if events:
            lines.append("事件: " + "; ".join(str(e) for e in events))

        promises = extras.get("promises") or []
        if promises:
            lines.append("承诺: " + "; ".join(str(p) for p in promises))

        quotes = extras.get("key_quotes") or []
        if quotes:
            lines.append("金句:")
            for q in quotes:
                lines.append(f"  · 「{q}」")

    def _begin_turn(self, context: LLMContext) -> bool:
        users = [
            m for m in context.get_messages() if isinstance(m, dict) and m.get("role") == "user"
        ]
        key = (len(users), str(users[-1].get("content", "")) if users else "")
        if key == self._turn_key:
            return False
        self._turn_key = key
        self._tool_calls = 0
        if self._tools is not None:
            context.set_tools(self._tools)
        return True

    def _set_block(self, context: LLMContext, prefix: str, text: str) -> None:
        messages = [
            message for message in context.get_messages()
            if not (
                isinstance(message, dict) and message.get("role") == "system"
                and isinstance(message.get("content"), str)
                and str(message.get("content")).startswith(prefix)
            )
        ]
        if text:
            position = min(self._params.position, len(messages))
            messages.insert(position, {"role": "system", "content": prefix + text})
        context.set_messages(messages)

    def _render_result(self, result: RecallResult) -> str:
        lines = [
            "以下是已归档直播的记录，用来 ground 回复，不要照念，也不要主动念日期。"
        ]
        if result.scope:
            lines.append(f"查询范围：{result.scope.label or '指定场次'}")
        if result.broadcasts:
            lines.append(result.overview_text(max_chars=10000 if result.overview else 3000))
        if result.chunks:
            lines.append(self._format_chunks(result.chunks, self._params.system_prompt))
        if result.note:
            lines.append(result.note)
        return "\n".join(lines)

    async def _enhance(
        self, context: LLMContext, query: str, decision: asyncio.Future[bool] | None = None
    ) -> bool:
        recent = await asyncio.to_thread(self.recall.catalog.recent, 3)
        self._set_block(
            context, _RECENT_PREFIX, format_broadcasts(recent, max_chars=3600) if recent else ""
        )
        latest = next((
            str(message.get("content")) for message in reversed(context.get_messages())
            if isinstance(message, dict) and message.get("role") == "user"
            and isinstance(message.get("content"), str)
        ), query)
        scope = (
            self.recall.resolve(latest)
            if not is_stream_elaboration(latest) or self._last_was_archive else None
        )
        self._last_was_archive = False
        archive_query = (
            is_stream_query(latest) or is_stream_overview(latest)
            or (is_stream_followup(latest) and not is_stream_elaboration(latest))
        )
        if scope is not None and (archive_query or is_stream_followup(latest)):
            result = await self.recall.lookup(
                query, scope=scope, overview=is_stream_overview(latest)
            )
            self._last_was_archive = True
            self._set_block(context, _RECALL_PREFIX, self._render_result(result))
            logger.info(
                f"Archive recall: overview={result.overview}, broadcasts={len(result.broadcasts)}, "
                f"chunks={len(result.chunks)}, scope={scope.label!r}"
            )
            return result.overview

        if (
            archive_query and self._tools is not None
            and (is_stream_overview(latest) or has_stream_time_reference(latest))
        ):
            self._last_was_archive = True
            self._set_block(
                context, _RECALL_PREFIX,
                f"当前问题需要直播回忆。概览不足时调用 {RECALL_TOOL_NAME} 确定场次并查找记录；"
                "不要把不同时期的直播混在一起，也不要还没查询就说记不清。",
            )
            return is_stream_overview(latest)

        chunks = await unless_skipped(decision, lambda: self._search(query))
        if chunks and archive_query:
            self._last_was_archive = True
            scope = StreamScope(
                stream_ids=tuple(dict.fromkeys(str(chunk["stream_id"]) for chunk in chunks)),
                label="刚才查到的直播片段",
            )
            broadcasts = await asyncio.to_thread(self.recall.select, scope)
            self.recall.remember(RecallResult(scope=scope, overview=False, broadcasts=broadcasts))
        self._set_block(
            context, _RECALL_PREFIX,
            self._format_chunks(chunks, self._params.system_prompt) if chunks else "",
        )
        return False

    def install_tool(
        self, llm: LLMService[Any], tools: ToolsSchema | None
    ) -> ToolsSchema | None:
        if self._retriever.table is None and not self.recall.catalog.path.exists():
            return tools
        schema = FunctionSchema(
            name=RECALL_TOOL_NAME,
            description=(
                "查询自己的已归档直播。当前概览足够回答时直接回答；"
                "需要其他场次、复杂时间指代或更具体的内容时调用。"
                "结合对话解析用户指代，把问题改写成独立查询。"
                "每个用户回合最多两次；查不到不能说没有直播，也不要编造。"
            ),
            properties={
                "query": {"type": "string", "description": "独立、具体的直播问题或话题"},
                "mode": {"type": "string", "enum": ["overview", "details"],
                         "description": "整场/一段时间回顾用 overview，具体言论或事件用 details"},
                "period": {"type": "string", "enum": [
                    "latest", "previous", "this_week", "last_week", "this_month",
                    "last_month", "past_days", "date_range", "selected", "broadcasts", "all",
                ], "description": (
                    "latest 最近一场；previous 倒数第二场；week 为周一到周日；"
                    "selected 沿用刚才已查询的场次/时间段；all 跨全部归档找话题。"
                    "broadcasts 选择概览里已提供的 broadcast_ids，例如其中第二场。"
                    "昨天或明确日期用 date_range，不要猜测未经查询的场次 ID。"
                )},
                "start_date": {"type": "string", "description": "date_range 起始日 YYYY-MM-DD"},
                "end_date": {"type": "string", "description": (
                    "date_range 结束日 YYYY-MM-DD，不包含该日；只查一天时省略"
                )},
                "days": {"type": "integer", "minimum": 1, "maximum": 366,
                         "description": "past_days 天数，包含今天，默认 7"},
                "broadcast_ids": {"type": "array", "items": {"type": "string"},
                                  "description": "仅填写概览已经给出的场次 ID，不要编造"},
            },
            required=["query", "mode", "period"],
        )
        llm.register_function(RECALL_TOOL_NAME, self._handle_tool, cancel_on_interruption=True)
        self._tools = ToolsSchema(
            standard_tools=[*(tools.standard_tools if tools else []), schema],
            custom_tools=tools.custom_tools if tools else None,
        )
        return self._tools

    def _tool_scope(self, request: RecallRequest) -> StreamScope:
        period = request.period
        if period in ("latest", "previous"):
            return StreamScope(latest=1 if period == "latest" else 2, label=period)
        if period == "selected":
            if self.recall.selected_scope is None:
                raise ValueError("还没有已选定的场次，请给出日期范围或使用 latest")
            return self.recall.selected_scope
        if period == "broadcasts":
            if not request.broadcast_ids:
                raise ValueError("broadcasts 需要已知场次 ID")
            known = {broadcast.id for broadcast in self.recall.catalog.broadcasts()}
            if not set(request.broadcast_ids) <= known:
                raise ValueError("场次 ID 不在归档中，请使用日期范围查找")
            return StreamScope(stream_ids=tuple(request.broadcast_ids), label="选定的归档直播")
        if period == "date_range":
            if request.start_date is None:
                raise ValueError("date_range 需要 start_date")
            end = request.end_date or request.start_date + timedelta(days=1)
            if end <= request.start_date:
                raise ValueError("end_date 必须晚于 start_date，且不包含该日")
            return StreamScope(
                start_date=request.start_date, end_date=end,
                label=f"{request.start_date} 至 {end}（不含结束日）",
            )
        if period == "all":
            return StreamScope(label="全部已归档直播")
        query = (
            f"past {request.days} days" if period == "past_days" else period.replace("_", " ")
        )
        scope = self.recall.resolve(query)
        if scope is None:
            raise ValueError("无法确定查询时间段")
        return scope

    async def _handle_tool(self, params: FunctionCallParams) -> None:
        self._begin_turn(params.context)
        if self._tool_calls >= 2:
            await params.result_callback({"error": "本回合查询次数已用完，请根据已有记录回答。"})
            return
        self._tool_calls += 1
        if self._tool_calls == 2 and self._tools is not None:
            params.context.set_tools(ToolsSchema(
                standard_tools=[
                    s for s in self._tools.standard_tools if s.name != RECALL_TOOL_NAME
                ],
                custom_tools=self._tools.custom_tools,
            ))
        try:
            request = RecallRequest.model_validate(dict(params.arguments))
            scope = await asyncio.to_thread(self._tool_scope, request)
            result = await self.recall.lookup(
                request.query, scope=scope, overview=request.mode == "overview"
            )
            self._last_was_archive = True
            await params.result_callback({
                "content": self._render_result(result),
                "broadcast_ids": [broadcast.id for broadcast in result.broadcasts],
                "chunk_ids": [chunk.get("id") for chunk in result.chunks],
            })
        except Exception as e:
            logger.warning(f"Archive recall tool unavailable: {e}")
            await params.result_callback({"error": "直播查询未完成", "reason": str(e)})

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        """Intercept ``LLMContextFrame`` and enrich it with stream memories."""
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMContextFrame):
            try:
                context = frame.context
                query = build_query_text(
                    [cast(dict[str, Any], m) for m in context.get_messages()],
                    max_user_turns=self._params.max_user_turns,
                )

                if self._begin_turn(context) and query:
                    if len(query.strip()) >= self._params.min_query_chars:
                        frame.metadata[OVERVIEW_FRAME_KEY] = await self._enhance(
                            context, query, frame.metadata.get(GATE_FRAME_KEY)
                        )

                await self.push_frame(frame)
            except Exception as e:
                await self.push_error(
                    error_msg=f"StreamArchiveService error: {e}", exception=e
                )
                await self.push_frame(frame)
        else:
            await self.push_frame(frame, direction)
