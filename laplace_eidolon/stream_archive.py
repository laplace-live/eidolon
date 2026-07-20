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
from pathlib import Path
from typing import Any, cast

from lancedb.table import Table
from loguru import logger
from pipecat.frames.frames import Frame, LLMContextFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pydantic import BaseModel, Field

from .embeddings import DEFAULT_DB_PATH, embed_texts, open_table
from .retrieval import build_query_text, extract_date_filter, hybrid_search

DEFAULT_TABLE = "stream_chunks"


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

        candidates: int = Field(default=15, ge=1, le=100)
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
        env_candidates = os.getenv("STREAM_ARCHIVE_CANDIDATES")
        if env_candidates:
            try:
                self._params = self._params.model_copy(
                    update={"candidates": int(env_candidates)}
                )
            except ValueError:
                logger.warning(
                    f"STREAM_ARCHIVE_CANDIDATES={env_candidates!r} not an int; ignoring"
                )

        self._table_name = table_name
        self._db_path = Path(db_path)
        self._table: Table | None = open_table(self._db_path, self._table_name)
        self._last_query: str | None = None

        if self._table is None:
            logger.warning(
                f"StreamArchiveService: no LanceDB table at "
                f"{self._db_path}/{self._table_name}.lance — retrieval will be a no-op. "
                "Run `uv run laplace-ingest-streams` after authoring streams/."
            )
        else:
            logger.info(
                f"StreamArchiveService initialized with {self._table.count_rows()} chunks "
                f"(candidates={self._params.candidates}, top_k={self._params.top_k}, "
                f"date_prefilter={self._params.date_prefilter})"
            )

    def _reopen_table(self) -> None:
        """Re-open the table after a re-ingest invalidated the cached handle.

        LanceDB stores per-version data files, so ``tools/ingest_streams.py``
        dropping and recreating the table strands the filenames our cached
        ``Table`` was holding.
        """
        try:
            new_table = open_table(self._db_path, self._table_name)
        except Exception as e:
            logger.error(f"StreamArchiveService re-open failed: {e}")
            self._table = None
            return
        if new_table is None:
            logger.warning(
                f"StreamArchiveService re-open: no table at "
                f"{self._db_path}/{self._table_name}.lance"
            )
            self._table = None
            return
        self._table = new_table
        logger.info(
            f"StreamArchiveService re-opened table ({new_table.count_rows()} chunks)"
        )

    async def _search(self, query: str) -> list[dict[str, Any]]:
        """Run hybrid (vector + FTS) + optional rerank against the chunks table.

        Retries once against the stale handle a concurrent
        ``laplace-ingest-streams`` leaves behind.
        """
        if self._table is None:
            logger.warning("Archive search skipped: no table loaded")
            return []

        try:
            vectors = await embed_texts([query], model=self._params.embed_model)
        except Exception as e:
            logger.error(f"Archive embed failed for query={query!r}: {e}")
            return []
        if not vectors:
            return []

        where = (
            extract_date_filter(query, column="stream_date")
            if self._params.date_prefilter
            else None
        )
        if where:
            logger.info(f"Archive date pre-filter: {where!r}")

        for attempt in (1, 2):
            table = self._table
            if table is None:
                return []
            try:
                results = await hybrid_search(
                    table,
                    vector=vectors[0],
                    query_text=query,
                    candidates=self._params.candidates,
                    where=where,
                    final_k=self._params.top_k,
                    rerank=True,
                )
                if results:
                    score = results[0].get(
                        "_relevance_score", results[0].get("_distance", float("nan"))
                    )
                    dates = sorted({r.get("stream_date", "?") for r in results})
                    refined_n = sum(1 for r in results if r.get("refined"))
                    types = sorted({r.get("chunk_type") or "raw" for r in results})
                    logger.info(
                        f"Archive hit: query={query!r} → {len(results)} chunks "
                        f"(top_score={score:.3f}, dates={dates}, "
                        f"refined={refined_n}/{len(results)}, types={types})"
                    )
                else:
                    logger.info(f"Archive miss: query={query!r} returned 0 chunks")
                return results
            except Exception as e:
                # lance-namespace exposes no typed errors: a stale data file
                # arrives as a bare Exception carrying "Not found".
                if attempt == 1 and "Not found" in str(e):
                    logger.warning(
                        "Archive hit stale table (likely re-ingested while bot was "
                        "running); re-opening and retrying once."
                    )
                    self._reopen_table()
                    continue
                logger.error(f"Archive search failed for query={query!r}: {e}")
                return []
        return []

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

            # refine.py writes topics as a JSON list[str]; unrefined rows "[]".
            topics: list[str] = []
            topics_raw = chunk.get("topics") or ""
            if topics_raw:
                try:
                    decoded = json.loads(topics_raw)
                    if isinstance(decoded, list):
                        topics = [str(t) for t in decoded]
                except json.JSONDecodeError:
                    topics = []

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

    async def _enhance(self, context, query: str) -> None:
        """Inject retrieved chunks into the LLM context as a system message."""
        if self._last_query == query:
            return
        self._last_query = query

        chunks = await self._search(query)
        if not chunks:
            return

        memory_msg = {
            "role": "system",
            "content": self._format_chunks(chunks, self._params.system_prompt),
        }
        messages = context.get_messages()
        position = max(0, min(self._params.position, len(messages)))
        messages.insert(position, memory_msg)
        context.set_messages(messages)
        logger.info(
            f"Archive injected {len(chunks)} chunks at position {position} "
            f"({len(memory_msg['content'])} chars)"
        )

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

                if query and len(query.strip()) >= self._params.min_query_chars:
                    await self._enhance(context, query)

                await self.push_frame(frame)
            except Exception as e:
                await self.push_error(
                    error_msg=f"StreamArchiveService error: {e}", exception=e
                )
                await self.push_frame(frame)
        else:
            await self.push_frame(frame, direction)
