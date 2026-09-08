"""Verify the implemented embedding reuse with recorded providers and real LanceDB."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import socket
import sys
from contextvars import ContextVar
from pathlib import Path
from typing import Any
from unittest.mock import patch

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env", override=True)

from laplace_eidolon import embeddings, retrieval, retriever
from laplace_eidolon.persona_facts import PersonaFactsService
from laplace_eidolon.persona_facts import build_retriever as facts_retriever
from laplace_eidolon.retriever import QueryEmbeddingCache
from laplace_eidolon.stream_archive import StreamArchiveService
from laplace_eidolon.stream_archive import build_retriever as archive_retriever

LABEL: ContextVar[str] = ContextVar("embedding_replay_table", default="setup")


def sha(value: Any) -> str:
    serialized = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode()).hexdigest()


async def main() -> None:
    recorded = json.loads((HERE.parent / "retrieval-preserved" / "results.json").read_text())
    fixtures: dict[str, Any] = {}
    vectors: dict[str, list[list[float]]] = {}
    for run in recorded["runs"]:
        for event in run["events"]:
            if event["kind"] == "rerank_http" and event["status"] == 200:
                fixtures[event["payload_hash"]] = event["response"]
            if event["kind"] == "embedding":
                vectors[run["query"]] = event["vectors"]

    events: list[dict[str, Any]] = []
    blocked_network_attempts: list[str] = []
    forced_archive_429 = False

    def block_network(*args: Any, **kwargs: Any) -> Any:
        blocked_network_attempts.append(LABEL.get())
        raise AssertionError("Network access is forbidden during provider replay")

    async def embed(
        texts: list[str], model: str | None = None, dimensions: int | None = None
    ) -> list[list[float]]:
        assert len(texts) == 1
        events.append({"kind": "embedding", "table": LABEL.get(), "texts": texts})
        return copy.deepcopy(vectors[texts[0]])

    def post(url: Any, **kwargs: Any) -> httpx.Response:
        payload_hash = sha(kwargs["json"])
        assert payload_hash in fixtures, f"Unrecorded rerank payload: {payload_hash}"
        fail = forced_archive_429 and LABEL.get() == "stream_chunks"
        status = 429 if fail else 200
        events.append({
            "kind": "rerank",
            "table": LABEL.get(),
            "payload_hash": payload_hash,
            "status": status,
        })
        return httpx.Response(
            status_code=status,
            json={"error": "recorded outage scenario"} if fail else fixtures[payload_hash],
            request=httpx.Request("POST", "https://replay.invalid/rerank"),
        )

    cases: list[dict[str, Any]] = []
    with (
        patch.object(socket.socket, "connect", side_effect=block_network),
        patch.object(socket.socket, "connect_ex", side_effect=block_network),
        patch.object(httpx.Client, "send", side_effect=block_network),
        patch.object(httpx.AsyncClient, "send", side_effect=block_network),
        patch.object(retriever, "embed_texts", side_effect=embed),
    ):
        params = {
            "persona_facts": PersonaFactsService.InputParams(),
            "stream_chunks": StreamArchiveService.InputParams(),
        }
        handles = {
            "persona_facts": facts_retriever(embeddings.resolve_db_path()),
            "stream_chunks": archive_retriever(embeddings.resolve_db_path()),
        }
        assert all(handle.table is not None for handle in handles.values())
        row_counts = {name: handle.row_count() for name, handle in handles.items()}
        retrieval.warm_tokenizer()
        ranker: Any = retrieval.make_reranker()
        assert isinstance(ranker, retrieval.OpenRouterReranker)

        async def search(
            table: str, query: str, cache: QueryEmbeddingCache | None
        ) -> dict[str, Any]:
            token = LABEL.set(table)
            events.append({"kind": "search_started", "table": table})
            try:
                options: dict[str, Any] = {
                    "candidates": params[table].candidates,
                    "top_k": params[table].top_k,
                    "date_prefilter": params[table].date_prefilter,
                }
                if cache is not None:
                    options["embedding_cache"] = cache
                rows = await handles[table].search(query, **options)
                assert rows, f"Unexpected empty retrieval for {table}: {query}"
                formatter = (
                    PersonaFactsService._format_facts if table == "persona_facts"
                    else StreamArchiveService._format_chunks
                )
                return {
                    "table": table,
                    "ids": [row["id"] for row in rows],
                    "rows_hash": sha(rows),
                    "context_hash": sha(formatter(rows, params[table].system_prompt)),
                }
            finally:
                events.append({"kind": "search_completed", "table": table})
                LABEL.reset(token)

        with patch.object(ranker._client, "post", side_effect=post):
            for forced_archive_429 in (False, True):
                for query in vectors:
                    outputs: list[dict[str, Any]] = []
                    for mode in ("baseline", "shared_embedding"):
                        start = len(events)
                        cache: QueryEmbeddingCache | None = {} if mode == "shared_embedding" else None
                        results = [await search(table, query, cache) for table in handles]
                        run_events = events[start:]
                        embedding_calls = sum(e["kind"] == "embedding" for e in run_events)
                        assert embedding_calls == (1 if cache is not None else 2)
                        search_events = [
                            (e["kind"], e["table"]) for e in run_events
                            if e["kind"].startswith("search_")
                        ]
                        assert search_events == [
                            ("search_started", "persona_facts"),
                            ("search_completed", "persona_facts"),
                            ("search_started", "stream_chunks"),
                            ("search_completed", "stream_chunks"),
                        ]
                        outputs.append({
                            "mode": mode,
                            "results": results,
                            "embedding_calls": embedding_calls,
                            "events": run_events,
                        })
                    exact_rows = outputs[0]["results"] == outputs[1]["results"]
                    payloads = [
                        [e for e in out["events"] if e["kind"] == "rerank"] for out in outputs
                    ]
                    assert exact_rows
                    assert payloads[0] == payloads[1]
                    assert len(payloads[0]) == (4 if forced_archive_429 else 2)
                    cases.append({
                        "query": query,
                        "archive_forced_429": forced_archive_429,
                        "exact_rows_and_formatted_context": exact_rows,
                        "exact_rerank_payloads_and_statuses": True,
                        "sequential_searches": True,
                        "runs": outputs,
                    })

    assert not blocked_network_attempts
    report = {
        "boundary": "Implemented LanceRetriever.search with versus without its embedding_cache; "
                    "real local LanceDB and reranking adapter, recorded provider responses.",
        "network_requests": 0,
        "blocked_network_attempts": len(blocked_network_attempts),
        "row_counts": row_counts,
        "cases": cases,
        "all_exact": True,
        "schedule_runs": sum(len(case["runs"]) for case in cases),
    }
    (HERE / "replay-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({key: value for key, value in report.items() if key != "cases"}))


if __name__ == "__main__":
    asyncio.run(main())
