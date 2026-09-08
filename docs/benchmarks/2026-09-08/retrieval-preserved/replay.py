"""Replay captured provider responses through real LanceDB under three schedules."""

from __future__ import annotations

import asyncio
import json
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Any

import httpx
from benchmark import (
    LABEL,
    PersonaFactsService,
    StreamArchiveService,
    archive_retriever,
    embeddings,
    facts_retriever,
    retrieval,
    retriever,
    sha,
)

HERE = Path(__file__).resolve().parent
SHARED: ContextVar[list[list[float]] | None] = ContextVar("shared_replay", default=None)


async def main() -> None:
    live = json.loads((HERE / "results.json").read_text())
    fixtures = {}
    vectors = {}
    for run in live["runs"]:
        for event in run["events"]:
            if event["kind"] == "rerank_http" and event["status"] == 200:
                fixtures[event["payload_hash"]] = event["response"]
            if event["kind"] == "embedding":
                vectors[run["query"]] = event["vectors"]
    params = {
        "persona_facts": PersonaFactsService.InputParams(),
        "stream_chunks": StreamArchiveService.InputParams(),
    }
    handles = {
        "persona_facts": facts_retriever(embeddings.resolve_db_path()),
        "stream_chunks": archive_retriever(embeddings.resolve_db_path()),
    }
    retrieval.warm_tokenizer()
    ranker: Any = retrieval.make_reranker()
    events: list[dict[str, Any]] = []
    failure_mode = False

    async def embed(
        texts: list[str], model: str | None = None, dimensions: int | None = None
    ) -> list[list[float]]:
        shared = SHARED.get()
        if shared is not None:
            return shared
        events.append({"kind": "embedding", "label": LABEL.get(), "texts": texts})
        return vectors[texts[0]]

    def post(url: Any, **kwargs: Any) -> httpx.Response:
        payload_hash = sha(kwargs["json"])
        if payload_hash not in fixtures:
            raise AssertionError(f"Unrecorded rerank payload {payload_hash}")
        fail = failure_mode and LABEL.get().endswith("stream_chunks")
        events.append({"kind": "rerank", "label": LABEL.get(), "payload_hash": payload_hash,
                       "status": 429 if fail else 200})
        time.sleep(0.02 if LABEL.get().endswith("persona_facts") else 0.01)
        return httpx.Response(
            status_code=429 if fail else 200,
            json={"error": "recorded outage scenario"} if fail else fixtures[payload_hash],
            request=httpx.Request("POST", "https://replay.invalid/rerank"),
        )

    retriever.embed_texts = embed
    ranker._client.post = post
    cases = []

    async def search(name: str, query: str) -> dict[str, Any]:
        LABEL.set(name)
        rows = await handles[name].search(query, candidates=params[name].candidates,
                                          top_k=params[name].top_k)
        formatter = (PersonaFactsService._format_facts if name == "persona_facts"
                     else StreamArchiveService._format_chunks)
        return {"table": name, "ids": [row["id"] for row in rows],
                "rows_hash": sha(rows),
                "context_hash": sha(formatter(rows, params[name].system_prompt))}

    for failure_mode in (False, True):
        for query in vectors:
            outputs = []
            for mode in ("serial", "serial_shared", "shared_parallel"):
                start = len(events)
                if mode == "serial":
                    results = [await search(name, query) for name in handles]
                else:
                    vector = await embed([query])
                    token = SHARED.set(vector)
                    try:
                        if mode == "serial_shared":
                            results = [await search(name, query) for name in handles]
                        else:
                            results = list(await asyncio.gather(
                                *(search(name, query) for name in handles)
                            ))
                    finally:
                        SHARED.reset(token)
                outputs.append({"mode": mode, "results": results, "events": events[start:]})
            exact = all(out["results"] == outputs[0]["results"] for out in outputs)
            cases.append({"query": query, "archive_forced_429": failure_mode,
                          "exact_rows_and_formatted_context": exact, "runs": outputs})
            assert exact
    report = {"network_requests": 0, "cases": cases, "all_exact": True,
              "schedule_runs": sum(len(c["runs"]) for c in cases)}
    (HERE / "replay-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({k: v for k, v in report.items() if k != "cases"}))


if __name__ == "__main__":
    asyncio.run(main())
