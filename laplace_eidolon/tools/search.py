"""Probe the stream archive index from the command line.

Runs the exact retrieval path the bot uses (``StreamArchiveService._search``
— hybrid vector + jieba-tokenized FTS, optional Cohere rerank), so what
comes back here is what the bot would have recalled. For scoring retrieval
quality across many queries, use ``laplace-eval-retrieval`` instead.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from dotenv import load_dotenv
from loguru import logger

from ..embeddings import DEFAULT_DB_PATH
from ..stream_archive import DEFAULT_TABLE, StreamArchiveService


async def main_async(args: argparse.Namespace) -> int:
    # Silence StreamArchiveService.__init__'s INFO line so it doesn't land
    # in the middle of the CLI's own output.
    logger.remove()
    logger.add(sys.stderr, level="WARNING")

    svc = StreamArchiveService(
        db_path=args.db_path,
        table_name=args.table,
        params=StreamArchiveService.InputParams(top_k=args.top_k),
    )
    if svc._table is None:
        print(f"No LanceDB table at {args.db_path}/{args.table}.lance", file=sys.stderr)
        print("Run `uv run laplace-ingest-streams` first.", file=sys.stderr)
        return 1

    hits = await svc._search(args.query)

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
    print(f"Index: {svc._table.count_rows()} rows in {args.db_path}/{args.table}.lance")
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
        dist = h.get("_distance", 0.0) if relevance is None else None
        is_refined = bool(h.get("refined"))

        extras: dict[str, object] = {}
        extras_raw = h.get("extras_json") or ""
        if extras_raw:
            try:
                extras = json.loads(extras_raw)
            except json.JSONDecodeError:
                extras = {}

        # refine.py emits 3-7 short per-chunk tags. Decoded defensively:
        # unrefined chunks store the string "[]" rather than a real list.
        topics: list[str] = []
        topics_raw = h.get("topics") or ""
        if topics_raw:
            try:
                decoded = json.loads(topics_raw)
                if isinstance(decoded, list):
                    topics = [str(t) for t in decoded]
            except json.JSONDecodeError:
                topics = []

        if relevance is not None:
            header = f"[{i}] score={relevance:.3f}  {date}"
        else:
            header = f"[{i}] dist={dist:.3f}  {date}"
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
        "--db-path", default=DEFAULT_DB_PATH, help=f"LanceDB dir (default: {DEFAULT_DB_PATH})"
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
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
