"""Probe the stream archive index from the command line.

Runs the exact retrieval path the bot uses (``LanceRetriever.search`` —
hybrid vector + jieba-tokenized FTS, optional Cohere rerank), so what comes
back here is what the bot would have recalled. For scoring retrieval quality
across many queries, use ``laplace-eval-retrieval`` instead.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import date
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dotenv import load_dotenv
from loguru import logger

from ..embeddings import default_db_path
from ..retriever import LanceRetriever
from ..stream_archive import (
    DEFAULT_TABLE,
    StreamArchiveService,
    build_retriever,
    decode_topics,
)
from ..stream_catalog import StreamCatalog
from ..stream_recall import RecallResult, StreamRecall
from ..stream_time import has_stream_time_reference, is_stream_overview


async def _recall(args: argparse.Namespace, retriever: LanceRetriever) -> int:
    try:
        timezone = ZoneInfo(os.getenv("PERSONA_TIMEZONE") or "Asia/Shanghai")
    except ZoneInfoNotFoundError:
        timezone = ZoneInfo("UTC")
    recall = StreamRecall(
        retriever,
        StreamCatalog(args.db_path),
        timezone=timezone,
        candidates=StreamArchiveService.InputParams().candidates,
        top_k=args.top_k,
        today=(lambda: args.today) if args.today is not None else None,
    )
    scope = recall.resolve(args.query)
    if scope is None and has_stream_time_reference(args.query):
        result = RecallResult(
            scope=None, overview=is_stream_overview(args.query),
            note="无法直接确定这个时间范围；请给出明确日期。对话中的直播查询工具可解析复杂指代。",
        )
    else:
        result = await recall.lookup(args.query, scope=scope)
    overview = result.overview_text() if result.broadcasts else ""
    if args.json:
        period = None if scope is None else {
            "start_date": scope.start_date.isoformat() if scope.start_date else None,
            "end_date": scope.end_date.isoformat() if scope.end_date else None,
            "latest": scope.latest,
            "stream_ids": list(scope.stream_ids),
            "label": scope.label,
        }
        print(json.dumps({
            "mode": "overview" if result.overview else "details",
            "period": period,
            "broadcast_ids": [broadcast.id for broadcast in result.broadcasts],
            "chunks": [{k: v for k, v in chunk.items() if k != "vector"}
                       for chunk in result.chunks],
            "overview": overview,
            "note": result.note,
        }, ensure_ascii=False, indent=2))
        return 0
    print(f"Query: {args.query!r}")
    if scope:
        print(f"Period: {scope.label}")
    if overview:
        print(overview)
    if result.chunks:
        print(StreamArchiveService._format_chunks(result.chunks, "直播详细片段：\n"))
    if result.note:
        print(result.note)
    return 0


async def main_async(args: argparse.Namespace) -> int:
    # Silence the retriever's own log lines so they don't land in the middle
    # of the CLI's output.
    logger.remove()
    logger.add(sys.stderr, level="WARNING")

    retriever = build_retriever(args.db_path, args.table)
    if args.recall:
        return await _recall(args, retriever)
    if retriever.table is None:
        print(f"No LanceDB table at {args.db_path}/{args.table}.lance", file=sys.stderr)
        print("Run `uv run laplace-ingest-streams` first.", file=sys.stderr)
        return 1

    hits = await retriever.search(
        args.query,
        candidates=StreamArchiveService.InputParams().candidates,
        top_k=args.top_k,
    )

    if args.json:
        # Drop the (huge) vector field from JSON output.
        for h in hits:
            h.pop("vector", None)
        print(json.dumps(hits, ensure_ascii=False, indent=2))
        return 0

    if not hits:
        print(f"No hits for {args.query!r}.")
        return 0

    # Hybrid + reranked results carry _relevance_score (higher is better);
    # the unreranked-vector path carries _distance (lower is better). Which
    # field is present decides the hint, and the per-hit header below.
    score_hint = (
        "higher relevance = better match"
        if hits and hits[0].get("_relevance_score") is not None
        else "lower distance = better match"
    )
    print(f"Query: {args.query!r}")
    print(f"Index: {retriever.row_count()} rows in {args.db_path}/{args.table}.lance")
    print(f"Hits:  {len(hits)} ({score_hint})")
    print()
    for i, h in enumerate(hits, 1):
        date = h.get("stream_date", "?")
        heading = h.get("heading", "")
        summary = h.get("summary") or ""
        details = h.get("details") or ""
        text = h.get("text", "")
        chunk_type = h.get("chunk_type") or ""
        relevance = h.get("_relevance_score")
        is_refined = bool(h.get("refined"))

        extras: dict[str, object] = {}
        extras_raw = h.get("extras_json") or ""
        if extras_raw:
            try:
                extras = json.loads(extras_raw)
            except json.JSONDecodeError:
                extras = {}

        topics = decode_topics(h)

        if relevance is not None:
            header = f"[{i}] score={relevance:.3f}  {date}"
        else:
            header = f"[{i}] dist={h.get('_distance', 0.0):.3f}  {date}"
        if topics:
            header += f"  ({', '.join(topics)})"
        if chunk_type:
            tag = "v2" if details else ("v1" if is_refined else "raw")
            header += f"  [{chunk_type} · {tag}]"
        print(header)
        print(f"     {heading}")

        # Always show the summary line — it's what gets embedded.
        if summary:
            print(f"     SUMMARY: {summary}")

        if args.full:
            if details:
                print()
                print("     DETAILS:")
                for line in details.splitlines():
                    print(f"     {line}")

            sc_events = extras.get("sc_events") or []
            if sc_events:
                print()
                print("     SC EVENTS:")
                for sc in sc_events:  # type: ignore[union-attr]
                    if not isinstance(sc, dict):
                        continue
                    viewer = sc.get("viewer") or "?"
                    amount = sc.get("amount_yuan")
                    suffix = f"（¥{amount}）" if amount else ""
                    print(f"       • {viewer}{suffix}: {sc.get('content', '')}")
                    resp = sc.get("response") or ""
                    if resp:
                        print(f"         → {resp}")

            songs = extras.get("songs") or []
            if songs:
                titles = [
                    f"《{s.get('title', '?')}》" if isinstance(s, dict) else f"《{s}》"
                    for s in songs  # type: ignore[union-attr]
                ]
                print(f"     SONGS:    {' '.join(titles)}")

            for label, key in (("EVENTS  ", "events"), ("PROMISES", "promises")):
                items = extras.get(key) or []
                if items:
                    print(f"     {label}: {'; '.join(str(x) for x in items)}")  # type: ignore[union-attr]

            quotes = extras.get("key_quotes") or []
            if quotes:
                print("     QUOTES:")
                for q in quotes:  # type: ignore[union-attr]
                    print(f"       「{q}」")

            print()
            print("     RAW TRANSCRIPT:")
            for line in text.splitlines():
                print(f"     {line}")
        elif not summary:
            preview = text.replace("\n", " ").strip()
            if len(preview) > 200:
                preview = preview[:197] + "…"
            print(f"     {preview}")
        print()
    return 0


def main() -> int:
    load_dotenv(override=True)
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("query", help="Search query (the question you'd ask the bot)")
    parser.add_argument(
        "--top-k", type=int, default=5, help="Number of results to return (default: 5)"
    )
    parser.add_argument(
        "--db-path", default=default_db_path(), help=f"LanceDB dir (default: {default_db_path()})"
    )
    parser.add_argument(
        "--table", default=DEFAULT_TABLE, help=f"Table name (default: {DEFAULT_TABLE})"
    )
    parser.add_argument(
        "--full", action="store_true", help="Print full chunk text instead of a 200-char preview"
    )
    parser.add_argument(
        "--json", action="store_true", help="Emit raw JSON (drops vector field for readability)"
    )
    parser.add_argument(
        "--recall", action="store_true",
        help="Use broadcast recaps or details within a resolved period (JSON emits an envelope)",
    )
    parser.add_argument(
        "--today", type=date.fromisoformat, metavar="YYYY-MM-DD",
        help="Persona-local reference date for --recall (default: today in PERSONA_TIMEZONE)",
    )
    args = parser.parse_args()
    if args.today is not None and not args.recall:
        parser.error("--today requires --recall")
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
