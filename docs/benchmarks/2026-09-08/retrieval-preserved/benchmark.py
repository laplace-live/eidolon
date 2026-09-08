"""Compare sequential retrieval with a shared embedding and concurrent searches."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import threading
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env", override=True)

from loguru import logger

from laplace_eidolon import embeddings, retrieval, retriever
from laplace_eidolon.persona_facts import PersonaFactsService
from laplace_eidolon.persona_facts import build_retriever as facts_retriever
from laplace_eidolon.stream_archive import StreamArchiveService
from laplace_eidolon.stream_archive import build_retriever as archive_retriever

LABEL: ContextVar[str] = ContextVar("benchmark_label", default="setup")
SHARED: ContextVar[list[list[float]] | None] = ContextVar("benchmark_vector", default=None)
EVENTS: list[dict[str, Any]] = []
ORIGINAL_EMBED = embeddings.embed_texts
STARTED = time.perf_counter()
REQUEST_LOCK = threading.Lock()
REQUESTS = 0
MAX_REQUESTS = 45


def sha(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def emit(kind: str, **values: Any) -> dict[str, Any]:
    event = {"kind": kind, "label": LABEL.get(), "at": time.perf_counter() - STARTED, **values}
    EVENTS.append(event)
    return event


async def measured_embed(
    texts: list[str], model: str | None = None, dimensions: int | None = None
) -> list[list[float]]:
    start = time.perf_counter()
    vectors = await ORIGINAL_EMBED(texts, model=model, dimensions=dimensions)
    emit("embedding", seconds=time.perf_counter() - start, texts=texts,
         vector_hashes=[sha(v) for v in vectors], vectors=vectors)
    return vectors


async def injected_embed(
    texts: list[str], model: str | None = None, dimensions: int | None = None
) -> list[list[float]]:
    vectors = SHARED.get()
    if vectors is not None:
        emit("embedding_shared", texts=texts, vector_hashes=[sha(v) for v in vectors])
        return vectors
    return await measured_embed(texts, model=model, dimensions=dimensions)


def reserve_request() -> None:
    global REQUESTS
    with REQUEST_LOCK:
        if REQUESTS >= MAX_REQUESTS:
            emit("request_cap", cap=MAX_REQUESTS)
            raise RuntimeError("Benchmark HTTP request cap reached")
        REQUESTS += 1


def instrument_reranker(ranker: Any) -> None:
    client = ranker._client
    original_post = client.post
    original_rerank = ranker._rerank

    def post(url: Any, **kwargs: Any) -> Any:
        payload = kwargs["json"]
        start = time.perf_counter()
        reserve_request()
        response = original_post(url, **kwargs)
        emit("rerank_http", seconds=time.perf_counter() - start,
             payload=payload, payload_hash=sha(payload), status=response.status_code,
             response=response.json())
        return response

    def rerank(result_set: Any, query: str) -> Any:
        candidates = result_set.to_pylist()
        emit("rerank_candidates", query=query,
             rows=[{k: v for k, v in row.items() if k != "vector"} for row in candidates])
        return original_rerank(result_set, query)

    client.post = post
    ranker._rerank = rerank


def instrument_embedding_http() -> None:
    client: Any = embeddings._get_embed_client()._client
    original_send = client.send

    async def send(request: Any, **kwargs: Any) -> Any:
        start = time.perf_counter()
        reserve_request()
        response = await original_send(request, **kwargs)
        emit("embedding_http", seconds=time.perf_counter() - start,
             status=response.status_code, payload_hash=sha(json.loads(request.content)))
        return response

    client.send = send


def compact_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{k: v for k, v in row.items() if k != "vector"} for row in rows]


async def main(output: Path, mode_override: str | None = None) -> None:
    params = {
        "persona_facts": PersonaFactsService.InputParams(),
        "stream_chunks": StreamArchiveService.InputParams(),
    }
    handles = {
        "persona_facts": facts_retriever(embeddings.resolve_db_path()),
        "stream_chunks": archive_retriever(embeddings.resolve_db_path()),
    }
    retrieval.warm_tokenizer()
    ranker = retrieval.make_reranker()
    if ranker is None:
        raise RuntimeError("Configured reranker must remain enabled")
    instrument_reranker(ranker)
    instrument_embedding_http()
    retriever.embed_texts = injected_embed
    warnings: list[str] = []
    logger.add(lambda message: warnings.append(str(message)), level="WARNING")
    runs: list[dict[str, Any]] = []
    queries = ["你梦想是什么", "你拔过智齿吗", "26年3月24直播内容"]

    async def search(name: str, query: str, label: str) -> dict[str, Any]:
        token = LABEL.set(f"{label}/{name}")
        start = time.perf_counter()
        try:
            rows = await handles[name].search(
                query, candidates=params[name].candidates, top_k=params[name].top_k,
                date_prefilter=params[name].date_prefilter,
            )
            duration = time.perf_counter() - start
            if name == "persona_facts":
                context = PersonaFactsService._format_facts(rows, params[name].system_prompt)
            else:
                context = StreamArchiveService._format_chunks(rows, params[name].system_prompt)
            return {"table": name, "seconds": duration, "rows": compact_rows(rows),
                    "ids": [r.get("id") for r in rows],
                    "scores": [retrieval.score_of(r) for r in rows],
                    "context": context, "context_hash": sha(context),
                    "where": retrieval.extract_date_filter(query, column=handles[name]._date_column)}
        finally:
            LABEL.reset(token)

    for index, query in enumerate(queries):
        modes = ["serial", "shared_parallel"] if index % 2 == 0 else ["shared_parallel", "serial"]
        if mode_override:
            modes = [mode_override]
        if REQUESTS >= MAX_REQUESTS:
            break
        for mode in modes:
            label = f"q{index}/{mode}"
            LABEL.set(label)
            before_events = len(EVENTS)
            before_warnings = len(warnings)
            start = time.perf_counter()
            if mode == "serial":
                results = [await search(name, query, label) for name in handles]
            else:
                vector = await measured_embed([query])
                token = SHARED.set(vector)
                try:
                    if mode == "serial_shared":
                        results = [await search(name, query, label) for name in handles]
                    else:
                        results = list(await asyncio.gather(
                            *(search(name, query, label) for name in handles)
                        ))
                finally:
                    SHARED.reset(token)
            run = {"query": query, "mode": mode, "seconds": time.perf_counter() - start,
                   "tables": results, "events": EVENTS[before_events:],
                   "warnings": warnings[before_warnings:]}
            runs.append(run)
            output.write_text(json.dumps({"runs": runs}, ensure_ascii=False, indent=2))
            print(json.dumps({"query": query, "mode": mode, "seconds": run["seconds"],
                              "ids": {r["table"]: r["ids"] for r in results},
                              "warnings": len(run["warnings"])}, ensure_ascii=False), flush=True)

    comparisons = []
    for query in ([] if mode_override else queries):
        serial = next(r for r in runs if r["query"] == query and r["mode"] == "serial")
        parallel = next(r for r in runs if r["query"] == query and r["mode"] == "shared_parallel")
        tables = {}
        for a, b in zip(serial["tables"], parallel["tables"], strict=True):
            name = a["table"]
            payloads = []
            for run in (serial, parallel):
                payloads.append([e["payload_hash"] for e in run["events"]
                                 if e["kind"] == "rerank_http" and e["label"].endswith(name)])
            tables[name] = {"ids_equal": a["ids"] == b["ids"],
                            "context_equal": a["context"] == b["context"],
                            "scores_equal": a["scores"] == b["scores"],
                            "rerank_payloads_equal": bool(payloads[0]) and bool(payloads[1])
                            and len(set(payloads[0] + payloads[1])) == 1}
        comparisons.append({"query": query, "serial_seconds": serial["seconds"],
                            "shared_parallel_seconds": parallel["seconds"],
                            "saved_seconds": serial["seconds"] - parallel["seconds"],
                            "tables": tables})
    report = {"config": {"model": ranker.model_name,
                          "tables": {n: {"candidates": p.candidates, "top_k": p.top_k,
                                        "row_count": handles[n].row_count()}
                                     for n, p in params.items()}},
              "runs": runs, "comparisons": comparisons,
              "request_counts": {kind: sum(e["kind"] == kind for e in EVENTS)
                                 for kind in ("embedding_http", "rerank_http")},
              "warnings": warnings, "request_cap": MAX_REQUESTS,
              "request_cap_hit": any(e["kind"] == "request_cap" for e in EVENTS)}
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({"comparisons": comparisons, "request_counts": report["request_counts"]},
                     ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("results.json"))
    parser.add_argument("--mode", choices=["serial_shared"])
    parser.add_argument("--max-requests", type=int, default=45)
    args = parser.parse_args()
    MAX_REQUESTS = args.max_requests
    asyncio.run(asyncio.wait_for(main(args.output, args.mode), timeout=240))
