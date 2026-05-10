"""Probe the stream archive index from the command line.

Same retrieval path the bot uses (``StreamArchiveService._search``) — just
without the pipeline around it. Useful for:

- Sanity-checking the index after ``tools/ingest.py``
- Debugging "why didn't the bot recall X?" (run the same query here, see
  what comes back and at what distance)
- A/B-ing query phrasing before changing transcripts or persona

Usage::

    cd server
    uv run python -m tools.search "你5月9号干啥了"
    uv run python -m tools.search "fire temple" --top-k 5 --full
    uv run python -m tools.search "茶馆" --json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from dotenv import load_dotenv
from loguru import logger

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from archive import (  # noqa: E402
    DEFAULT_DB_PATH,
    DEFAULT_TABLE,
    StreamArchiveService,
)


async def main_async(args: argparse.Namespace) -> int:
    # Quiet the loguru INFO line from StreamArchiveService.__init__ so the
    # CLI output isn't mixed up with logging noise.
    logger.remove()
    logger.add(sys.stderr, level="WARNING")

    svc = StreamArchiveService(
        db_path=args.db_path,
        table_name=args.table,
        params=StreamArchiveService.InputParams(top_k=args.top_k),
    )
    if svc._table is None:
        print(f"No LanceDB table at {args.db_path}/{args.table}.lance", file=sys.stderr)
        print("Run `uv run python -m tools.ingest` first.", file=sys.stderr)
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

    print(f"Query: {args.query!r}")
    print(f"Index: {svc._table.count_rows()} rows in {args.db_path}/{args.table}.lance")
    print(f"Hits:  {len(hits)} (lower distance = better match)")
    print()
    for i, h in enumerate(hits, 1):
        date = h.get("stream_date", "?")
        heading = h.get("heading", "")
        summary = h.get("summary") or ""
        details = h.get("details") or ""
        text = h.get("text", "")
        chunk_type = h.get("chunk_type") or ""
        dist = h.get("_distance", 0.0)
        is_refined = bool(h.get("refined"))

        # Decode v2 extras blob if present.
        extras: dict[str, object] = {}
        extras_raw = h.get("extras_json") or ""
        if extras_raw:
            try:
                extras = json.loads(extras_raw)
            except json.JSONDecodeError:
                extras = {}

        # Topics are per-chunk (refine.py emits 3-7 short tags). JSON-decode
        # defensively — unrefined chunks store "[]" rather than a real list.
        topics: list[str] = []
        topics_raw = h.get("topics") or ""
        if topics_raw:
            try:
                decoded = json.loads(topics_raw)
                if isinstance(decoded, list):
                    topics = [str(t) for t in decoded]
            except json.JSONDecodeError:
                topics = []

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
            # In --full mode, show everything the bot would see.
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
                    f"《{s.get('title', '?')}》"
                    if isinstance(s, dict) else f"《{s}》"
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
