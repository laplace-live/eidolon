"""One LanceDB table, searched the way the bot searches it.

Owns the cached ``Table`` handle, recovery from the stale handle a
concurrent re-ingest leaves behind, and the embed → date-filter → hybrid
call. ``PersonaFactsService`` and ``StreamArchiveService`` wrap one each to
serve the pipeline; ``mcp_server`` and ``laplace-search`` hold one directly,
with no Pipecat frame machinery involved.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from lancedb.table import Table
from loguru import logger

from .embeddings import embed_texts, open_table
from .retrieval import extract_date_filter, hybrid_search, score_of


class LanceRetriever:
    """Hybrid search over one LanceDB table, with stale-handle recovery.

    Args:
        date_column: column ``extract_date_filter`` pre-filters on when the
            query names a day.
        label: prefix for this table's log lines ("Persona facts").
        summarize: renders the extra per-table fields on a hit log line.
        ingest_hint: command that builds the table, shown when it's absent.
    """

    def __init__(
        self,
        db_path: str | os.PathLike[str],
        table_name: str,
        *,
        date_column: str,
        label: str,
        summarize: Callable[[list[dict[str, Any]]], str] | None = None,
        ingest_hint: str = "",
        embed_model: str | None = None,
    ) -> None:
        self._db_path = Path(db_path)
        self._table_name = table_name
        self._date_column = date_column
        self._label = label
        self._summarize = summarize
        self._embed_model = embed_model
        self._table: Table | None = open_table(self._db_path, self._table_name)

        if self._table is None:
            hint = f" Run `{ingest_hint}` to build it." if ingest_hint else ""
            logger.warning(
                f"{label}: no LanceDB table at "
                f"{self._db_path}/{self._table_name}.lance — retrieval "
                f"will be a no-op.{hint}"
            )

    @property
    def table(self) -> Table | None:
        """The live handle, or ``None`` when the table has never been built."""
        return self._table

    def row_count(self) -> int:
        return self._table.count_rows() if self._table is not None else 0

    def _reopen(self) -> None:
        try:
            new_table = open_table(self._db_path, self._table_name)
        except Exception as e:
            logger.error(f"{self._label} re-open failed: {e}")
            self._table = None
            return
        if new_table is None:
            logger.warning(
                f"{self._label} re-open: no table at "
                f"{self._db_path}/{self._table_name}.lance"
            )
            self._table = None
            return
        self._table = new_table
        logger.info(f"{self._label} re-opened table ({new_table.count_rows()} rows)")

    async def search(
        self,
        query: str,
        *,
        candidates: int,
        top_k: int,
        date_prefilter: bool = True,
        where: str | None = None,
    ) -> list[dict[str, Any]]:
        """Run hybrid (vector + FTS) + optional rerank against the table.

        Retries once against the stale handle a concurrent re-ingest leaves
        behind; lance-namespace exposes no typed errors, so a stranded data
        file arrives as a bare ``Exception`` carrying "Not found".
        """
        if self._table is None:
            logger.warning(f"{self._label} search skipped: no table loaded")
            return []

        try:
            vectors = await embed_texts([query], model=self._embed_model)
        except Exception as e:
            logger.error(f"{self._label} embed failed for query={query!r}: {e}")
            return []
        if not vectors:
            return []

        if where is None and date_prefilter:
            where = extract_date_filter(query, column=self._date_column)
        if where:
            logger.info(f"{self._label} date pre-filter: {where!r}")

        for attempt in (1, 2):
            table = self._table
            if table is None:
                return []
            try:
                results = await hybrid_search(
                    table,
                    vector=vectors[0],
                    query_text=query,
                    candidates=candidates,
                    where=where,
                    final_k=top_k,
                    rerank=True,
                )
                self._log_outcome(query, results)
                return results
            except Exception as e:
                if attempt == 1 and "Not found" in str(e):
                    logger.warning(
                        f"{self._label} hit stale table (likely re-ingested "
                        "while bot was running); re-opening and retrying once."
                    )
                    self._reopen()
                    continue
                logger.error(f"{self._label} search failed for query={query!r}: {e}")
                return []
        return []

    def _log_outcome(self, query: str, results: list[dict[str, Any]]) -> None:
        if not results:
            logger.info(f"{self._label} miss: query={query!r} returned 0 rows")
            return
        score = score_of(results[0])
        score = score if score is not None else float("nan")
        extra = f", {self._summarize(results)}" if self._summarize else ""
        logger.info(
            f"{self._label} hit: query={query!r} → {len(results)} rows "
            f"(top_score={score:.3f}{extra})"
        )
