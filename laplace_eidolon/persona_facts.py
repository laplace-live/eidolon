"""Persona facts — LanceDB-backed RAG over fan-compiled streamer facts.

``PersonaFactsService`` is a Pipecat ``FrameProcessor`` that intercepts
``LLMContextFrame``, searches the ``persona_facts`` LanceDB table that
``tools/ingest_facts.py`` builds from ``data/*设定集.txt``, and injects
the top matches as a system message before the LLM runs.

Sister service: ``stream_archive.StreamArchiveService`` — same pipeline
position, 5-minute transcript scenes instead of one-line facts.
"""

from __future__ import annotations

import os
from typing import Any, cast

from loguru import logger
from pipecat.frames.frames import Frame, LLMContextFrame
from pipecat.processors.aggregators.llm_context import LLMContext, LLMStandardMessage
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pydantic import BaseModel, Field

from .embeddings import DEFAULT_DB_PATH
from .env import env_int
from .retrieval import build_query_text
from .retriever import QUERY_EMBEDDING_CACHE_KEY, LanceRetriever, QueryEmbeddingCache

DEFAULT_TABLE = "persona_facts"
LABEL = "Persona facts"
INGEST_HINT = "uv run laplace-ingest-facts"


def summarize_hits(results: list[dict[str, Any]]) -> str:
    """Per-table detail for the hit log line."""
    sources = sorted({r.get("source", "?") for r in results})
    dated_n = sum(1 for r in results if r.get("date"))
    return f"sources={sources}, dated={dated_n}/{len(results)}"


def build_retriever(
    db_path: str | os.PathLike[str] = DEFAULT_DB_PATH,
    table_name: str = DEFAULT_TABLE,
    *,
    embed_model: str | None = None,
) -> LanceRetriever:
    """A retriever over the persona-facts table, configured as the bot uses it."""
    return LanceRetriever(
        db_path,
        table_name,
        date_column="date",
        label=LABEL,
        summarize=summarize_hits,
        ingest_hint=INGEST_HINT,
        embed_model=embed_model,
    )


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

        candidates: int = Field(
            default_factory=lambda: env_int("PERSONA_FACTS_CANDIDATES", 30),
            ge=1,
            le=200,
        )
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
        self._retriever = build_retriever(
            db_path, table_name, embed_model=self._params.embed_model
        )
        self._last_query: str | None = None

        if self._retriever.table is not None:
            logger.info(
                f"PersonaFactsService initialized with "
                f"{self._retriever.row_count()} facts "
                f"(candidates={self._params.candidates}, top_k={self._params.top_k}, "
                f"date_prefilter={self._params.date_prefilter})"
            )

    async def _search(
        self, query: str, *, embedding_cache: QueryEmbeddingCache | None = None
    ) -> list[dict[str, Any]]:
        return await self._retriever.search(
            query,
            candidates=self._params.candidates,
            top_k=self._params.top_k,
            date_prefilter=self._params.date_prefilter,
            embedding_cache=embedding_cache,
        )

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

    async def _enhance(
        self,
        context: LLMContext,
        query: str,
        *,
        embedding_cache: QueryEmbeddingCache | None = None,
    ) -> None:
        """Inject retrieved facts into the LLM context as a system message."""
        if self._last_query == query:
            return
        self._last_query = query

        facts = await self._search(query, embedding_cache=embedding_cache)
        if not facts:
            return

        content = self._format_facts(facts, self._params.system_prompt)
        memory_msg: LLMStandardMessage = {
            "role": "system",
            "content": content,
        }
        messages = context.get_messages()
        position = max(0, min(self._params.position, len(messages)))
        messages.insert(position, memory_msg)
        context.set_messages(messages)
        logger.info(
            f"Persona facts injected {len(facts)} facts at position {position} "
            f"({len(content)} chars)"
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
                    await self._enhance(
                        context,
                        query,
                        embedding_cache=frame.metadata.setdefault(QUERY_EMBEDDING_CACHE_KEY, {}),
                    )

                await self.push_frame(frame)
            except Exception as e:
                await self.push_error(
                    error_msg=f"PersonaFactsService error: {e}", exception=e
                )
                await self.push_frame(frame)
        else:
            await self.push_frame(frame, direction)
