from __future__ import annotations

import asyncio
import json
import math
import os
import platform
import sqlite3
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv

load_dotenv(ROOT / ".env", override=True)
from lancedb.table import Table
from loguru import logger

logger.remove()
from laplace_eidolon.embeddings import (
    DEFAULT_EMBED_DIM,
    DEFAULT_EMBED_MODEL,
    EmbedCache,
    open_table,
    resolve_db_path,
)
from laplace_eidolon.env import env_int
from laplace_eidolon.persona_facts import PersonaFactsService
from laplace_eidolon.retrieval import (
    extract_date_filter,
    hybrid_search,
    tokenize_zh_query,
    warm_tokenizer,
)
from laplace_eidolon.stream_archive import StreamArchiveService
from laplace_eidolon.tools.eval_retrieval import load_queries

OUT = ROOT / "docs/benchmarks/2026-09-08/retrieval-local.json"


def stats(values: list[float]) -> dict[str, Any]:
    ordered = sorted(values)
    return {
        "n": len(ordered),
        "median_ms": round(statistics.median(ordered), 3),
        "mean_ms": round(statistics.mean(ordered), 3),
        "p95_ms": ordered[math.ceil(len(ordered) * 0.95) - 1],
        "min_ms": ordered[0],
        "max_ms": ordered[-1],
    }


def ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 3)


async def main() -> None:
    start = time.perf_counter()
    warm_tokenizer()
    result: dict[str, Any] = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "method": "No external API calls. Replay stored vectors from real corpus rows selected by query FTS; run unchanged hybrid_search(rerank=False) against both actual tables. Queries are the 17 curated evaluation texts, with query-specific existing row vectors substituted because external embedding/rerank requests were blocked by automatic approval review. These are local search latency and context-size measurements only, not query embedding or retrieval quality measurements. Three serial passes, tokenizer warmed. Index files never mutated.",
        "platform": platform.platform(),
        "tokenizer_startup_ms": ms(start),
        "source_query_file": "data/eval/queries.toml",
        "samples": [],
        "config": {},
    }
    tables: dict[str, Table] = {}
    for name in ["persona_facts", "stream_chunks"]:
        table = open_table(resolve_db_path(), name)
        assert table is not None
        tables[name] = table
    candidates = {
        "persona_facts": env_int("PERSONA_FACTS_CANDIDATES", 30),
        "stream_chunks": env_int("STREAM_ARCHIVE_CANDIDATES", 15),
    }
    top_k = {"persona_facts": 8, "stream_chunks": 3}
    result["config"] = {
        "embed_model": os.getenv("EMBED_MODEL") or DEFAULT_EMBED_MODEL,
        "embed_dim": DEFAULT_EMBED_DIM,
        "candidates": candidates,
        "top_k": top_k,
    }
    result["corpus"] = {
        name: {
            "rows": t.count_rows(),
            "version": t.version,
            "indices": [str(index) for index in t.list_indices()],
        }
        for name, t in tables.items()
    }
    queries = load_queries(ROOT / "data/eval/queries.toml")
    vectors = {}
    for query in queries:
        t = tables[query.table]
        seed = t.search(tokenize_zh_query(query.text), query_type="fts").limit(1).to_list()
        if not seed:
            seed = t.search().limit(1).to_list()
        vectors[query.text] = (seed[0]["vector"], seed[0]["id"])
    contexts: list[dict[str, Any]] = []
    for repetition in range(3):
        for query in queries:
            pair_start = time.perf_counter()
            rows_by_table = {}
            for name, table in tables.items():
                where = extract_date_filter(
                    query.text, column="date" if name == "persona_facts" else "stream_date"
                )
                vector, seed_id = vectors[query.text]
                start = time.perf_counter()
                rows = await hybrid_search(
                    table,
                    vector=vector,
                    query_text=query.text,
                    candidates=candidates[name],
                    final_k=top_k[name],
                    where=where,
                    rerank=False,
                )
                elapsed = ms(start)
                result["samples"].append(
                    {
                        "query": query.text,
                        "table": name,
                        "pass": repetition + 1,
                        "seed_vector_source_table": query.table,
                        "seed_vector_source_id": seed_id,
                        "elapsed_ms": elapsed,
                        "where": where,
                        "returned_rows": len(rows),
                    }
                )
                rows_by_table[name] = [
                    {k: v for k, v in row.items() if k != "vector"} for row in rows
                ]
            if repetition == 0:
                facts_context = PersonaFactsService._format_facts(
                    rows_by_table["persona_facts"], PersonaFactsService.InputParams().system_prompt
                )
                archive_context = StreamArchiveService._format_chunks(
                    rows_by_table["stream_chunks"], StreamArchiveService.InputParams().system_prompt
                )
                contexts.append(
                    {
                        "query": query.text,
                        "method": "local replay using FTS-matched existing corpus row vector; no live query embedding or rerank",
                        "rows": rows_by_table,
                        "facts_context": facts_context,
                        "archive_context": archive_context,
                        "facts_chars": len(facts_context),
                        "archive_chars": len(archive_context),
                        "retrieval_elapsed_ms": ms(pair_start),
                    }
                )
                Path("/tmp/eidolon-retrieval-contexts-local.json").write_text(
                    json.dumps(contexts, ensure_ascii=False, indent=2)
                )
    result["summary"] = {}
    for name in tables:
        subset = [s["elapsed_ms"] for s in result["samples"] if s["table"] == name]
        result["summary"][name] = stats(subset)
    result["summary"]["sequential_two_table_sum"] = stats(
        [
            sum(
                s["elapsed_ms"]
                for s in result["samples"]
                if s["query"] == q.text and s["pass"] == repetition
            )
            for repetition in [1, 2, 3]
            for q in queries
        ]
    )
    result["context_sizes"] = [
        {"query": c["query"], "facts_chars": c["facts_chars"], "archive_chars": c["archive_chars"]}
        for c in contexts
    ]
    cache_path = ROOT / "data/embed_cache.db"
    with sqlite3.connect(f"file:{cache_path}?mode=ro", uri=True) as conn:
        model = os.getenv("EMBED_MODEL") or DEFAULT_EMBED_MODEL
        cache_hits = [
            q.text
            for q in queries
            if conn.execute(
                "select 1 from embed_cache where key=?",
                (EmbedCache._key(model, DEFAULT_EMBED_DIM, q.text),),
            ).fetchone()
        ]
        result["embedding_cache"] = {
            "rows": conn.execute("select count(*) from embed_cache").fetchone()[0],
            "curated_query_hits": len(cache_hits),
            "curated_query_count": len(queries),
            "used_by_runtime": False,
        }
    result["finished_at"] = datetime.now(timezone.utc).isoformat()
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(
        json.dumps(
            {
                "summary": result["summary"],
                "context_sizes": result["context_sizes"],
                "embedding_cache": result["embedding_cache"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


asyncio.run(main())
