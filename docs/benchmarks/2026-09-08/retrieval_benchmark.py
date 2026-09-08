from __future__ import annotations

import asyncio
import json
import math
import os
import platform
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
from loguru import logger

logger.remove()
logger.add(sys.stderr, level="WARNING")
from laplace_eidolon import embeddings, retrieval, retriever
from laplace_eidolon.env import env_int
from laplace_eidolon.persona_facts import PersonaFactsService
from laplace_eidolon.stream_archive import StreamArchiveService
from laplace_eidolon.tools.eval_retrieval import _matches, _row_text_for_match, load_queries

OUT = ROOT / "docs/benchmarks/2026-09-08/retrieval.json"
CONTEXTS = ROOT / "docs/benchmarks/2026-09-08/retrieval-contexts.json"
OUT.parent.mkdir(parents=True, exist_ok=True)
EVENTS: list[dict[str, Any]] = []
CURRENT: dict[str, Any] = {}
VECTORS: dict[str, list[float]] = {}
RERANK_ROWS: dict[tuple[str, str], list[dict[str, Any]]] = {}


def ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 3)


def stats(values: list[float]) -> dict[str, Any]:
    ordered = sorted(values)
    return (
        {
            "n": len(ordered),
            "median_ms": round(statistics.median(ordered), 3),
            "mean_ms": round(statistics.mean(ordered), 3),
            "p95_ms": ordered[math.ceil(len(ordered) * 0.95) - 1],
            "min_ms": ordered[0],
            "max_ms": ordered[-1],
        }
        if ordered
        else {"n": 0}
    )


original_embed = retriever.embed_texts


async def timed_embed(texts: list[str], model: str | None = None) -> list[list[float]]:
    start = time.perf_counter()
    event: dict[str, Any] = {"kind": "embedding", **CURRENT, "texts": texts}
    try:
        result = await original_embed(texts, model=model)
        for text, vector in zip(texts, result):
            VECTORS[text] = vector
        event["vector_count"] = len(result)
        return result
    except Exception as exc:
        event["error_type"] = type(exc).__name__
        raise
    finally:
        event["elapsed_ms"] = ms(start)
        EVENTS.append(event)


retriever.embed_texts = timed_embed

original_hybrid = retrieval.hybrid_search


async def timed_hybrid(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
    start = time.perf_counter()
    event: dict[str, Any] = {"kind": "hybrid", **CURRENT}
    try:
        rows = await original_hybrid(*args, **kwargs)
        event["row_count"] = len(rows)
        return rows
    except Exception as exc:
        event["error_type"] = type(exc).__name__
        raise
    finally:
        event["elapsed_ms"] = ms(start)
        EVENTS.append(event)


retriever.hybrid_search = timed_hybrid


async def main() -> None:
    global CURRENT
    started_at = datetime.now(timezone.utc).isoformat()
    token_start = time.perf_counter()
    retrieval.warm_tokenizer()
    tokenizer_ms = ms(token_start)
    queries = load_queries(ROOT / "data/eval/queries.toml")
    retrievers = {
        name: retriever.LanceRetriever(
            embeddings.resolve_db_path(),
            name,
            date_column="date" if name == "persona_facts" else "stream_date",
            label=name,
        )
        for name in ["persona_facts", "stream_chunks"]
    }
    candidates = {
        "persona_facts": env_int("PERSONA_FACTS_CANDIDATES", 30),
        "stream_chunks": env_int("STREAM_ARCHIVE_CANDIDATES", 15),
    }
    top_k = {"persona_facts": 8, "stream_chunks": 3}
    active = retrieval.make_reranker()
    if active is not None:
        original_post = active._client.post

        def timed_post(*args: Any, **kwargs: Any) -> Any:
            start = time.perf_counter()
            payload = kwargs.get("json", {})
            docs = payload.get("documents", [])
            event = {
                "kind": "rerank_http",
                **CURRENT,
                "document_count": len(docs),
                "document_chars": sum(len(d) for d in docs),
                "query_sent": payload.get("query"),
            }
            try:
                response = original_post(*args, **kwargs)
                event["http_status"] = response.status_code
                return response
            except Exception as exc:
                event["error_type"] = type(exc).__name__
                raise
            finally:
                event["elapsed_ms"] = ms(start)
                EVENTS.append(event)

        active._client.post = timed_post
        original_rerank = active._rerank

        def timed_rerank(*args: Any, **kwargs: Any) -> Any:
            start = time.perf_counter()
            event = {"kind": "rerank", **CURRENT}
            try:
                rows = original_rerank(*args, **kwargs)
                RERANK_ROWS[(CURRENT["query"], CURRENT["table"])] = rows.slice(0, 10).to_pylist()
                return rows
            except Exception as exc:
                event["error_type"] = type(exc).__name__
                raise
            finally:
                event["elapsed_ms"] = ms(start)
                EVENTS.append(event)

        active._rerank = timed_rerank
    result: dict[str, Any] = {
        "started_at": started_at,
        "platform": platform.platform(),
        "python": platform.python_version(),
        "query_source": "data/eval/queries.toml",
        "config": {
            "embed_model": os.getenv("EMBED_MODEL") or embeddings.DEFAULT_EMBED_MODEL,
            "embed_dim": embeddings.DEFAULT_EMBED_DIM,
            "embed_base_url": os.getenv("EMBED_BASE_URL") or embeddings.DEFAULT_EMBED_BASE_URL,
            "rerank_model": active.model_name if active else None,
            "rerank_base_url": active.base_url if active else None,
            "candidates": candidates,
            "runtime_top_k": top_k,
        },
        "corpus": {
            name: {"rows": r.row_count(), "version": r.table.version if r.table else None}
            for name, r in retrievers.items()
        },
        "tokenizer_startup_ms": tokenizer_ms,
        "method": "Serial requests on local existing read-only indexes. Exact LanceRetriever.search for three two-table turns. Quality on all 17 curated queries via the shared hybrid_search path, with one saved live embedding per query reused across modes; final_k=10 for recall@10. Warm tokenizer before timed retrieval. No runtime embedding cache exists. No indexes or runtime config changed.",
        "pairs": [],
        "quality": [],
        "events": EVENTS,
    }
    contexts: list[dict[str, Any]] = []
    for i in [0, 12, 16]:
        query = queries[i].text
        pair_start = time.perf_counter()
        pair: dict[str, Any] = {"query": query, "tables": {}}
        rows_by_table: dict[str, list[dict[str, Any]]] = {}
        for name, handle in retrievers.items():
            CURRENT = {"phase": "exact_pair", "query": query, "table": name}
            event_start = len(EVENTS)
            start = time.perf_counter()
            rows = await asyncio.wait_for(
                handle.search(query, candidates=candidates[name], top_k=top_k[name]), timeout=90
            )
            pair["tables"][name] = {
                "elapsed_ms": ms(start),
                "row_count": len(rows),
                "events_start": event_start,
                "events_end": len(EVENTS),
            }
            rows_by_table[name] = [
                {key: value for key, value in row.items() if key != "vector"} for row in rows
            ]
        pair["elapsed_ms"] = ms(pair_start)
        result["pairs"].append(pair)
        facts_context = PersonaFactsService._format_facts(
            rows_by_table["persona_facts"], PersonaFactsService.InputParams().system_prompt
        )
        archive_context = StreamArchiveService._format_chunks(
            rows_by_table["stream_chunks"], StreamArchiveService.InputParams().system_prompt
        )
        contexts.append(
            {
                "query": query,
                "rows": rows_by_table,
                "facts_context": facts_context,
                "archive_context": archive_context,
                "facts_chars": len(facts_context),
                "archive_chars": len(archive_context),
                "retrieval_elapsed_ms": pair["elapsed_ms"],
            }
        )
        CONTEXTS.write_text(json.dumps(contexts, ensure_ascii=False, indent=2))
        OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print(
            json.dumps(
                {
                    "pair_done": query,
                    "elapsed_ms": pair["elapsed_ms"],
                    "contexts_file": str(CONTEXTS),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    for query in queries:
        CURRENT = {"phase": "quality_embedding", "query": query.text, "table": query.table}
        if query.text not in VECTORS:
            await asyncio.wait_for(timed_embed([query.text]), timeout=90)
        vector = VECTORS[query.text]
        where = retrieval.extract_date_filter(
            query.text, column="date" if query.table == "persona_facts" else "stream_date"
        )
        for mode in ["rrf", "configured_rerank"]:
            CURRENT = {"phase": "quality", "query": query.text, "table": query.table, "mode": mode}
            start_events = len(EVENTS)
            start = time.perf_counter()
            saved_key = (query.text, query.table)
            reused_pair = mode == "configured_rerank" and saved_key in RERANK_ROWS
            if reused_pair:
                rows = RERANK_ROWS[saved_key]
                elapsed = next(
                    e["elapsed_ms"]
                    for e in EVENTS
                    if e["kind"] == "hybrid"
                    and e.get("phase") == "exact_pair"
                    and e.get("query") == query.text
                    and e.get("table") == query.table
                )
            else:
                rows = await asyncio.wait_for(
                    timed_hybrid(
                        retrievers[query.table].table,
                        vector=vector,
                        query_text=query.text,
                        candidates=candidates[query.table],
                        final_k=10,
                        where=where,
                        rerank=mode == "configured_rerank",
                    ),
                    timeout=90,
                )
                elapsed = ms(start)
            rank = next(
                (
                    i
                    for i, row in enumerate(rows, 1)
                    if _matches(_row_text_for_match(row), query.expect_substrings)
                ),
                None,
            )
            result["quality"].append(
                {
                    "query": query.text,
                    "table": query.table,
                    "mode": mode,
                    "rank": rank,
                    "elapsed_ms": elapsed,
                    "where": where,
                    "events_start": start_events,
                    "events_end": len(EVENTS),
                    "top_id": rows[0]["id"] if rows else None,
                    "top_text": _row_text_for_match(rows[0])[:200] if rows else "",
                    "returned_rows": len(rows),
                    "reused_pair_rerank": reused_pair,
                }
            )
        OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print(json.dumps({"quality_done": query.text}, ensure_ascii=False), flush=True)
    result["summary"] = {
        "pair_total": stats([p["elapsed_ms"] for p in result["pairs"]]),
        "embedding": stats([e["elapsed_ms"] for e in EVENTS if e["kind"] == "embedding"]),
        "rerank_http": stats([e["elapsed_ms"] for e in EVENTS if e["kind"] == "rerank_http"]),
        "rerank_http_status_counts": {
            str(status): sum(
                e.get("http_status") == status for e in EVENTS if e["kind"] == "rerank_http"
            )
            for status in sorted(
                set(e.get("http_status", 0) for e in EVENTS if e["kind"] == "rerank_http")
            )
        },
        "quality": {},
    }
    for name in retrievers:
        for mode in ["rrf", "configured_rerank"]:
            subset = [q for q in result["quality"] if q["table"] == name and q["mode"] == mode]
            result["summary"]["quality"][f"{name}/{mode}"] = {
                "n": len(subset),
                "mrr": sum(1 / q["rank"] if q["rank"] else 0 for q in subset) / len(subset),
                "recall_at": {
                    str(k): sum(q["rank"] is not None and q["rank"] <= k for q in subset)
                    / len(subset)
                    for k in [1, 3, 5, 10]
                },
                "latency": stats([q["elapsed_ms"] for q in subset]),
            }
    result["finished_at"] = datetime.now(timezone.utc).isoformat()
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result["summary"], ensure_ascii=False, indent=2), flush=True)
    if active is not None:
        active._client.close()
    if embeddings._embed_client is not None:
        await embeddings._embed_client.close()


asyncio.run(main())
