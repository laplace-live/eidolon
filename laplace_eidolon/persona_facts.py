"""Persona facts — LanceDB-backed RAG over fan-compiled streamer facts.

This is the "tier 2" persona layer in the bot:

- ``persona.md``         (tier 1, always-on)  — hand-curated evergreen identity
- ``persona_facts``      (tier 2, retrieved)  — atomic dated facts from data/*设定集.txt + data/*事件集.txt  ← THIS module
- ``stream_chunks``      (tier 3, retrieved)  — refined 5-min transcript scenes from streams/*.md
- Mem0                   (tier 4, retrieved)  — per-viewer episodic memory

Why a separate tier from ``stream_chunks``: persona facts are atomic
(one line ≈ one fact, ~30 chars) while transcript chunks are 5-minute
scenes (~500-1500 tokens). Different optimal top_k (8-10 vs 3),
different framing prefix ("things you've said about yourself" vs
"past stream context"), different retrieval taste. Easier to tune
each independently.

Schema mirrors what ``tools/ingest_facts.py`` writes:
``id, source, date, text, tokens, vector``.

Retrieval pipeline (per turn, when a user message arrives):

1. Build a search query from recent turns (handles voice utterances
   like "嗯，那个？" by pulling in prior context). See
   ``retrieval.build_query_text``.
2. Embed it once with the same model used at ingest.
3. Detect any date references in the query and apply a SQL pre-filter
   on the ``date`` column. ``retrieval.extract_date_filter``.
4. Run hybrid search (vector + jieba-tokenized BM25/FTS) for
   ``candidates`` rows (default 30 — wide net for the reranker to
   choose from).
5. If ``COHERE_API_KEY`` is set, Cohere ``rerank-v4.0-fast``
   re-scores down to ``top_k`` (default 8). Without the key, hybrid
   search uses RRF fusion only — still better than pure vector at our
   scale, but a cross-encoder reranker is strongly recommended above
   ~10k rows.
6. Inject the surviving facts as a system message before the LLM call.

Embedding provider config and helpers are shared via ``embeddings.py``;
hybrid search + reranker live in ``retrieval.py`` so the eval harness
(``tools/eval_retrieval.py``) and this service share one code path.
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

    Mirrors ``StreamArchiveService``:

    - Intercepts every ``LLMContextFrame`` flowing toward the LLM.
    - Pulls the latest user message, embeds it, queries the
      ``persona_facts`` LanceDB table.
    - Injects the top-k matching facts as a single system message.
    - Forwards the (now-enriched) frame downstream.

    Place this between the user aggregator and the LLM, alongside
    ``Mem0MemoryService`` and ``StreamArchiveService``. Each inserts one
    system message per turn; ordering is controlled by ``InputParams.position``
    and the order processors appear in the pipeline.
    """

    class InputParams(BaseModel):
        """Tunables for persona-fact retrieval."""

        top_k: int = Field(default=8, ge=1, le=50)
        """Facts shown to the LLM after reranking. 8 = enough variety
        without bloating the system prompt. Bumps higher than
        transcript retrieval (3) because facts are tiny (~30 chars each)
        so a generous top_k stays cheap in token cost."""

        candidates: int = Field(default=30, ge=1, le=200)
        """Total candidates pulled by hybrid search (vector + FTS)
        BEFORE reranking. The reranker picks ``top_k`` of these.
        Larger = better recall but more reranker tokens spent. 30 is
        the sweet spot at ~3k facts; bump if you grow the corpus.
        Defaults to ``PERSONA_FACTS_CANDIDATES`` env var when set."""

        min_query_chars: int = Field(default=4, ge=1)
        """Skip retrieval for short queries like "hi" or "嗯" alone —
        they embed poorly and would inject noise. Note that
        ``build_query_text`` rescues short utterances by pulling in
        prior turns, so this only triggers for genuinely vacant queries."""

        max_user_turns: int = Field(default=3, ge=1, le=10)
        """How many recent user turns to concatenate when the latest
        message is too short on its own. Voice users often say "嗯",
        "再说说", "那呢" — embedding those alone is hopeless. See
        ``retrieval.build_query_text``."""

        date_prefilter: bool = Field(default=True)
        """When the query references a specific date (e.g. "5月9号"),
        narrow the candidate pool with a SQL pre-filter on the ``date``
        column before vector + FTS scoring. Disable for debugging or
        if your corpus has unreliable date metadata."""

        system_prompt: str = Field(
            default=(
                "你过去在直播里说过 / 设定过的相关事实"
                "（用来 ground 你的回复，不要照念，也不要把日期念出来）：\n\n"
            )
        )
        """Prefix prepended to the injected facts block. Tells the LLM
        these are *its own* past statements, framed in third person in
        the source data."""

        position: int = Field(default=2, ge=0)
        """Where to insert the facts message inside ``context.get_messages()``.

        See ``StreamArchiveService.InputParams.position`` for the full
        explanation. With Mem0 (default 1), PersonaFacts (default 2),
        and StreamArchive (default 2) all enabled, message ordering
        depends on processor order in the pipeline; the LLM treats them
        all as system messages so exact ordering matters less than
        having all three present.
        """

        embed_model: str | None = Field(default=None)
        """Override the embedding model. Falls back to ``EMBED_MODEL``
        env var. Must match what was used at ingest time, or vectors won't
        be comparable."""

    def __init__(
        self,
        *,
        db_path: str | os.PathLike[str] = DEFAULT_DB_PATH,
        table_name: str = DEFAULT_TABLE,
        params: InputParams | None = None,
    ):
        """Initialize the persona-facts service.

        Args:
            db_path: Filesystem path to the LanceDB directory (shared
                with the stream archive — different table inside the same DB).
            table_name: Table within the LanceDB database.
            params: Retrieval tunables. See :class:`InputParams`.
        """
        super().__init__()
        # Resolve params, then let env vars override the candidate pool
        # so it can be tuned without code changes (matches the .env
        # variables documented in .env.example).
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
        """Re-open the LanceDB table to pick up files written by a re-ingest.

        Same recovery path as ``StreamArchiveService._reopen_table`` —
        ``tools/ingest_facts.py`` drops + recreates the table on every
        run, invalidating cached file handles.
        """
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

        Pipeline:

        1. Detect a date pre-filter from the query (when enabled).
        2. Embed the query once.
        3. Hybrid search pulls ``candidates`` rows.
        4. Cohere reranker (if ``COHERE_API_KEY`` is set) trims to ``top_k``.

        Recovers once from the stale-table error you get when
        ``tools/ingest_facts.py`` runs while the bot is alive
        (LanceDB drops + recreates the table, invalidating the cached
        Table handle).
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
                    # Hybrid results carry _relevance_score; reranked ones
                    # carry both. Log whichever is present so the units in
                    # the log line are interpretable.
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
        """Render retrieved facts as a single readable system message.

        Format per fact: ``- [date] text`` if dated, else ``- text``.
        Compact because each fact is already self-contained — no
        narrative wrapping needed.
        """
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
        """Intercept ``LLMContextFrame`` and enrich it with persona facts.

        Uses ``retrieval.build_query_text`` to assemble the search query
        from the last few user turns (not just the latest message),
        which rescues short voice utterances like "嗯", "再说说" that
        embed badly on their own.
        """
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMContextFrame):
            try:
                context = frame.context
                # Build a richer query from recent turns; falls back to
                # the latest message alone when it's already long enough.
                # Returns None if the conversation has no user content
                # yet (e.g. opening kickoff frame).
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
