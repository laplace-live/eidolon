"""Persona facts — LanceDB-backed RAG over fan-compiled streamer facts.

``PersonaFactsService`` is a Pipecat ``FrameProcessor`` that intercepts
``LLMContextFrame``, searches the ``persona_facts`` LanceDB table that
``tools/ingest_facts.py`` builds from ``data/*设定集.txt``, and injects
the top matches as a system message before the LLM runs.

Sister service: ``stream_archive.StreamArchiveService`` — same pipeline
position, 5-minute transcript scenes instead of one-line facts.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, cast

from lancedb.table import Table
from loguru import logger
from pipecat.frames.frames import Frame, LLMContextFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pydantic import BaseModel, Field

from .embeddings import DEFAULT_DB_PATH, embed_texts, open_table
from .retrieval import (
    build_query_text,
    extract_date_filter,
    hybrid_search,
)

DEFAULT_TABLE = "persona_facts"


class PersonaFactsService(FrameProcessor):
    """RAG over hand-compiled streamer facts, fronted as a Pipecat FrameProcessor.

    Place between the user aggregator and the LLM. Coexists with
    ``Mem0MemoryService`` and ``StreamArchiveService``; each inserts one
    system message per turn, in processor order.
    """

    class InputParams(BaseModel):
        """Tunables for persona-fact retrieval."""

        top_k: int = Field(default=8, ge=1, le=50)
        """Facts shown to the LLM after reranking. Each is ~30 chars, so a
        generous top_k stays cheap in prompt tokens."""

        candidates: int = Field(default=30, ge=1, le=200)
        """Hybrid-search pool the reranker picks ``top_k`` from. 30 is the
        sweet spot at ~3k facts; raise it as the corpus grows.
        ``PERSONA_FACTS_CANDIDATES`` overrides."""

        min_query_chars: int = Field(default=4, ge=1)
        """Skip retrieval below this length — such queries embed poorly and
        inject noise. ``build_query_text`` folds in prior turns first, so
        this only trips on a genuinely vacant conversation."""

        max_user_turns: int = Field(default=3, ge=1, le=10)
        """Recent user turns concatenated when the latest message is too
        short alone. Voice users say "嗯" / "再说说", which embed
        hopelessly on their own."""

        date_prefilter: bool = Field(default=True)
        """SQL pre-filter on ``date`` when the query names a day ("5月9号"),
        applied before vector + FTS scoring. Disable if your corpus has
        unreliable date metadata."""

        system_prompt: str = Field(
            default=(
                "你过去在直播里说过 / 设定过的相关事实"
                "（用来 ground 你的回复，不要照念，也不要把日期念出来）：\n\n"
            )
        )
        """Prefix for the injected facts block. The source data is written
        in third person, so the prompt has to tell the LLM these are its
        own past statements."""

        position: int = Field(default=2, ge=0)
        """Insert index inside ``context.get_messages()``, clamped to its
        length."""

        embed_model: str | None = Field(default=None)
        """Overrides the ``EMBED_MODEL`` env var. Must match what ingest
        used, or the vectors aren't comparable."""

    def __init__(
        self,
        *,
        db_path: str | os.PathLike[str] = DEFAULT_DB_PATH,
        table_name: str = DEFAULT_TABLE,
        params: InputParams | None = None,
    ):
        """Initialize the persona-facts service.

        Args:
            db_path: LanceDB directory, shared with the stream archive —
                same database, different table.
        """
        super().__init__()
        self._params = params or PersonaFactsService.InputParams()
        env_candidates = os.getenv("PERSONA_FACTS_CANDIDATES")
        if env_candidates:
            try:
                self._params = self._params.model_copy(
                    update={"candidates": int(env_candidates)}
                )
            except ValueError:
                logger.warning(
                    f"PERSONA_FACTS_CANDIDATES={env_candidates!r} not an int; ignoring"
                )

        self._table_name = table_name
        self._db_path = Path(db_path)
        self._table: Table | None = open_table(self._db_path, self._table_name)
        self._last_query: str | None = None

        if self._table is None:
            logger.warning(
                f"PersonaFactsService: no LanceDB table at "
                f"{self._db_path}/{self._table_name}.lance — retrieval will be a no-op. "
                "Run `uv run laplace-ingest-facts` after authoring data/*设定集.txt."
            )
        else:
            logger.info(
                f"PersonaFactsService initialized with {self._table.count_rows()} facts "
                f"(candidates={self._params.candidates}, top_k={self._params.top_k}, "
                f"date_prefilter={self._params.date_prefilter})"
            )

    def _reopen_table(self) -> None:
        """Re-open the table after a re-ingest invalidated the cached handle."""
        try:
            new_table = open_table(self._db_path, self._table_name)
        except Exception as e:
            logger.error(f"PersonaFactsService re-open failed: {e}")
            self._table = None
            return
        if new_table is None:
            logger.warning(
                f"PersonaFactsService re-open: no table at "
                f"{self._db_path}/{self._table_name}.lance"
            )
            self._table = None
            return
        self._table = new_table
        logger.info(
            f"PersonaFactsService re-opened table ({new_table.count_rows()} facts)"
        )

    async def _search(self, query: str) -> list[dict[str, Any]]:
        """Run hybrid (vector + FTS) + optional rerank against the facts table.

        Retries once against the stale handle a concurrent
        ``laplace-ingest-facts`` leaves behind; LanceDB surfaces that as a
        plain ``Exception`` carrying "Not found", hence the substring match.
        """
        if self._table is None:
            logger.warning("Persona facts search skipped: no table loaded")
            return []

        try:
            vectors = await embed_texts([query], model=self._params.embed_model)
        except Exception as e:
            logger.error(f"Persona facts embed failed for query={query!r}: {e}")
            return []
        if not vectors:
            return []

        where = (
            extract_date_filter(query, column="date")
            if self._params.date_prefilter
            else None
        )
        if where:
            logger.info(f"Persona facts date pre-filter: {where!r}")

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
                    sources = sorted({r.get("source", "?") for r in results})
                    dated_n = sum(1 for r in results if r.get("date"))
                    logger.info(
                        f"Persona facts hit: query={query!r} → {len(results)} facts "
                        f"(top_score={score:.3f}, sources={sources}, "
                        f"dated={dated_n}/{len(results)})"
                    )
                else:
                    logger.info(
                        f"Persona facts miss: query={query!r} returned 0 facts"
                    )
                return results
            except Exception as e:
                err = str(e)
                if attempt == 1 and "Not found" in err:
                    logger.warning(
                        "Persona facts hit stale table (likely re-ingested while "
                        "bot was running); re-opening and retrying once."
                    )
                    self._reopen_table()
                    continue
                logger.error(f"Persona facts search failed for query={query!r}: {e}")
                return []
        return []

    @staticmethod
    def _format_facts(facts: list[dict[str, Any]], prefix: str) -> str:
        """Render retrieved facts as a single system message, one line each."""
        lines = [prefix]
        for fact in facts:
            text = (fact.get("text") or "").strip()
            if not text:
                continue
            date = fact.get("date") or ""
            if date:
                lines.append(f"- [{date}] {text}")
            else:
                lines.append(f"- {text}")
        return "\n".join(lines).rstrip() + "\n"

    async def _enhance(self, context, query: str) -> None:
        """Inject retrieved facts into the LLM context as a system message."""
        if self._last_query == query:
            return
        self._last_query = query

        facts = await self._search(query)
        if not facts:
            return

        memory_msg = {
            "role": "system",
            "content": self._format_facts(facts, self._params.system_prompt),
        }
        messages = context.get_messages()
        position = max(0, min(self._params.position, len(messages)))
        messages.insert(position, memory_msg)
        context.set_messages(messages)
        logger.info(
            f"Persona facts injected {len(facts)} facts at position {position} "
            f"({len(memory_msg['content'])} chars)"
        )

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        """Intercept ``LLMContextFrame`` and enrich it with persona facts."""
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
                    error_msg=f"PersonaFactsService error: {e}", exception=e
                )
                await self.push_frame(frame)
        else:
            await self.push_frame(frame, direction)
