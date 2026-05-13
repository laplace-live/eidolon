"""Ingest persona-fact .txt files into a local LanceDB index.

Source of truth: ``server/data/*设定集.txt`` and ``server/data/*事件集.txt`` —
fan-compiled atomic facts about the streamer (one fact per line, optional
date prefix). Built artifact: ``server/data/lancedb/persona_facts.lance/``.

Each non-empty line becomes one chunk. Lines look like::

    2022年10月3日 / 明前奶绿声称坚果排斥戴墨镜，会甩掉
    2023年8月10日 / 明前奶绿声称坚果5.6kg
    花店的地下室里是坚果的敌人：狗

Date prefix (``YYYY年MM月DD日`` / optional `日`) is parsed and stored as
metadata on the row so we can filter or surface it. Lines without a parseable
date keep the full text and an empty date column.

This is the second LanceDB tier in the pipeline:

- ``stream_chunks``  — refined 5-min transcript scenes, retrieved by relevance
- ``persona_facts``  — atomic dated facts about the streamer (THIS module)
- ``persona.md``     — hand-curated evergreen identity (always in system prompt)

The whole table is dropped and rebuilt on every run; facts are small and
embeddings are cheap, so reproducibility beats incrementalism.

Usage::

    cd server
    uv run python -m tools.ingest_facts                          # rebuild from data/*设定集.txt + data/*事件集.txt
    uv run python -m tools.ingest_facts --files data/x.txt       # custom file list
    uv run python -m tools.ingest_facts --dry-run                # show what would be written
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import os
import re
import sys
from pathlib import Path
from typing import Any

import lancedb
import pyarrow as pa
from dotenv import load_dotenv
from loguru import logger

# Allow running both as module (``python -m tools.ingest_facts``) and as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from embeddings import (  # noqa: E402
    DEFAULT_DB_PATH,
    DEFAULT_EMBED_CACHE_PATH,
    DEFAULT_EMBED_DIM,
    DEFAULT_EMBED_MODEL,
    EmbedCache,
    EmbeddingUsage,
    embed_texts_with_usage,
)

DEFAULT_TABLE = "persona_facts"

# Default file patterns under ``data/``. Picks up the streamer-fact files
# without sweeping in unrelated .txt artefacts (video-full.txt, etc.).
DEFAULT_FACT_PATTERNS = ("*设定集.txt", "*事件集.txt")

# Parse a leading Chinese date like "2022年10月3日" or "2026年5月9日".
# The trailing 日 is required so we don't match strings like "2022年圣诞节".
DATE_RE = re.compile(r"^\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*[/、,，]?\s*")

# Strip a leading BV-id reference like "BV1em4y187Nc / ..." — these are
# video citations, not facts. Same for bracketed video titles.
BV_RE = re.compile(r"^\s*BV[0-9A-Za-z]+\s*[/、,，]\s*")


def _parse_line(line: str) -> tuple[str, str]:
    """Extract (iso_date, cleaned_text) from one raw fact line.

    Returns ``("YYYY-MM-DD", "...")`` if a date prefix is present, else
    ``("", line)``. The cleaned_text drops the date prefix and any
    immediately-following ``/`` separator so the body reads naturally.
    BV-id references are also stripped.
    """
    line = line.strip()
    if not line:
        return "", ""

    # Strip BV-id citation prefix if present.
    line = BV_RE.sub("", line, count=1)

    m = DATE_RE.match(line)
    if not m:
        return "", line
    year, month, day = (int(g) for g in m.groups())
    try:
        iso = f"{year:04d}-{month:02d}-{day:02d}"
    except ValueError:
        return "", line
    return iso, line[m.end() :].lstrip()


def load_facts(
    files: list[Path],
    *,
    min_chars: int = 4,
) -> list[dict[str, Any]]:
    """Read fact files and return rows ready for embedding.

    Each non-empty line in each file becomes one row. Duplicates (same
    cleaned text across files) are collapsed — the 设定集 and 事件集
    files overlap heavily on cat lines.

    Skips lines shorter than ``min_chars`` after cleaning — those are
    almost always parse artefacts (stray punctuation, single chars).
    """
    rows: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    total_seen = 0
    total_skipped_short = 0

    for fp in files:
        if not fp.exists():
            logger.warning(f"Fact file not found, skipping: {fp}")
            continue
        text = fp.read_text(encoding="utf-8")
        kept = 0
        skipped = 0
        for raw_line in text.splitlines():
            total_seen += 1
            iso_date, cleaned = _parse_line(raw_line)
            if not cleaned or len(cleaned) < min_chars:
                if cleaned:
                    total_skipped_short += 1
                continue

            # Dedup key: the cleaned line. We keep the *first* occurrence,
            # which preserves the earliest reported date for evolving facts
            # (e.g. cat weight). For genuinely repeated lines (the file has
            # 3 copies of the same toilet incident) this drops the dupes.
            key = cleaned
            if key in seen_keys:
                skipped += 1
                continue
            seen_keys.add(key)

            # Stable id: hash of cleaned text. Lets us be re-runnable
            # without churning row ids when a file is re-edited.
            row_id = hashlib.sha1(cleaned.encode("utf-8")).hexdigest()[:16]

            # Embed the original-shaped line (date + body) so semantic
            # queries that mention dates can match. The cleaned_text is
            # what we render at recall time — it's already self-contained.
            if iso_date:
                embed_input = f"{iso_date}：{cleaned}"
            else:
                embed_input = cleaned

            rows.append(
                {
                    "id": row_id,
                    "source": fp.name,
                    "date": iso_date,
                    "text": cleaned,
                    "embed_input": embed_input,
                }
            )
            kept += 1

        logger.info(f"Loaded {fp.name}: {kept} facts kept, {skipped} duplicates skipped")

    if total_skipped_short:
        logger.info(f"Filtered out {total_skipped_short} lines shorter than {min_chars} chars")
    logger.info(
        f"Total: {len(rows)} unique facts from {total_seen} raw lines across {len(files)} file(s)"
    )
    return rows


def build_arrow_schema() -> pa.Schema:
    """Schema for the persona_facts table.

    Vector dim must match ``DEFAULT_EMBED_DIM`` (3072 for Gemini). If you
    swap embedding models or change ``EMBED_DIM``, this schema picks up
    the new dim on the next ingest because we drop and recreate the table.
    """
    return pa.schema(
        [
            pa.field("id", pa.string()),
            pa.field("source", pa.string()),
            pa.field("date", pa.string()),  # "YYYY-MM-DD" or ""
            pa.field("text", pa.string()),
            pa.field("vector", pa.list_(pa.float32(), DEFAULT_EMBED_DIM)),
        ]
    )


async def embed_in_batches(
    rows: list[dict[str, Any]],
    *,
    batch_size: int = 96,
    cache: EmbedCache | None = None,
) -> EmbeddingUsage:
    """Embed each row's ``embed_input`` and stash the vector on the row.

    Larger batch_size than the streams ingest (96 vs 64) because facts
    are tiny — average ~30 chars, so we can pack more per request without
    blowing the embedding-API payload limit.

    Caching mirrors the streams ingest exactly — see that module's docstring.
    The two ingest scripts share the same on-disk cache file by default
    (different rows produce different keys, so they never collide).
    """
    total = EmbeddingUsage()

    model = os.getenv("EMBED_MODEL", DEFAULT_EMBED_MODEL)
    dim = DEFAULT_EMBED_DIM

    if cache is not None:
        texts = [r["embed_input"] for r in rows]
        cached = cache.get_many(model, dim, texts)
        for i, vec in cached.items():
            rows[i]["vector"] = vec
        misses = [r for i, r in enumerate(rows) if i not in cached]
        if cached:
            logger.info(
                f"Cache: {len(cached)}/{len(rows)} embeddings reused, "
                f"{len(misses)} need fresh embedding"
            )
    else:
        misses = rows

    if not misses:
        logger.info("All embeddings served from cache; nothing to embed.")
        return total

    for start in range(0, len(misses), batch_size):
        batch = misses[start : start + batch_size]
        texts = [r["embed_input"] for r in batch]
        vectors, usage = await embed_texts_with_usage(texts, model=model, dimensions=dim)
        for row, vec in zip(batch, vectors):
            row["vector"] = vec
        if cache is not None:
            cache.put_many(model, dim, [(r["embed_input"], r["vector"]) for r in batch])
        total.add(usage)
        progress = min(start + batch_size, len(misses))
        cost_str = f", ${usage.cost_usd:.6f}" if usage.cost_source == "openrouter" else ""
        logger.info(
            f"Embedded {progress}/{len(misses)} facts ({usage.total_tokens} tokens{cost_str})"
        )
    return total


def write_table(rows: list[dict[str, Any]], db_path: Path, table_name: str) -> None:
    """Drop and recreate the LanceDB table with the embedded rows."""
    db = lancedb.connect(str(db_path))
    if table_name in db.list_tables().tables:
        db.drop_table(table_name)
    schema = build_arrow_schema()
    projected = [{k: row[k] for k in schema.names} for row in rows]
    db.create_table(table_name, data=projected, schema=schema)
    logger.info(f"Wrote {len(rows)} rows to {db_path}/{table_name}.lance")


def _resolve_files(files: list[str] | None, data_dir: Path) -> list[Path]:
    """Resolve the file list: explicit args, else default patterns under data/."""
    if files:
        return [Path(f).resolve() for f in files]
    matches: list[Path] = []
    for pattern in DEFAULT_FACT_PATTERNS:
        matches.extend(sorted(data_dir.glob(pattern)))
    # Dedupe while preserving order.
    seen: set[Path] = set()
    unique: list[Path] = []
    for p in matches:
        if p not in seen:
            seen.add(p)
            unique.append(p)
    return unique


async def main_async(args: argparse.Namespace) -> int:
    data_dir = Path(args.data_dir).resolve()
    db_path = Path(args.db_path).resolve()

    files = _resolve_files(args.files, data_dir)
    if not files:
        logger.warning(
            f"No fact files found. Looked under {data_dir} for "
            f"{list(DEFAULT_FACT_PATTERNS)}. Pass --files to specify explicitly."
        )
        return 0

    logger.info(f"Ingesting from: {[f.name for f in files]}")
    rows = load_facts(files, min_chars=args.min_chars)
    if not rows:
        logger.warning("No facts to ingest. Files were empty or filtered out.")
        return 0

    if args.dry_run:
        logger.info(f"Dry run: {len(rows)} facts would be embedded and written.")
        for r in rows[:5]:
            logger.info(
                f"  - {r['id']} [{r['date'] or 'undated'}, {r['source']}]: {r['text'][:60]}..."
            )
        return 0

    db_path.mkdir(parents=True, exist_ok=True)

    cache: EmbedCache | None = None
    if not args.no_cache:
        cache_path = Path(args.cache_path).resolve()
        if args.clear_cache and cache_path.exists():
            cache_path.unlink()
            logger.info(f"Cleared embedding cache at {cache_path}")
        cache = EmbedCache(cache_path)
        logger.info(
            f"Embedding cache: {cache_path} ({cache.count()} vectors on disk)"
        )

    try:
        usage = await embed_in_batches(rows, cache=cache)
    finally:
        if cache is not None:
            cache.close()
    write_table(rows, db_path, args.table)
    if usage.cost_source == "openrouter":
        logger.info(
            f"Embedding totals: {len(rows)} facts, "
            f"{usage.total_tokens} tokens, ${usage.cost_usd:.6f} USD"
        )
    else:
        logger.info(
            f"Embedding totals: {len(rows)} facts, {usage.total_tokens} tokens "
            "(provider did not report cost)"
        )
    return 0


def main() -> int:
    load_dotenv(override=True)
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument(
        "--data-dir",
        default="data",
        help="Directory to scan for fact files (default: data)",
    )
    parser.add_argument(
        "--files",
        nargs="*",
        default=None,
        help="Explicit fact file paths. If omitted, scans data-dir for "
        f"patterns {DEFAULT_FACT_PATTERNS}.",
    )
    parser.add_argument(
        "--db-path",
        default=DEFAULT_DB_PATH,
        help=f"LanceDB directory (default: {DEFAULT_DB_PATH})",
    )
    parser.add_argument(
        "--table",
        default=DEFAULT_TABLE,
        help=f"Table name (default: {DEFAULT_TABLE})",
    )
    parser.add_argument(
        "--min-chars",
        type=int,
        default=4,
        help="Drop lines shorter than this after cleaning (default: 4)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse and dedupe but skip embedding and writing.",
    )
    parser.add_argument(
        "--cache-path",
        default=DEFAULT_EMBED_CACHE_PATH,
        help=(
            "SQLite file used to cache embedding vectors so a crashed/re-run "
            f"ingest skips work that already succeeded (default: {DEFAULT_EMBED_CACHE_PATH}). "
            "Cache key is (model, dim, text); changing EMBED_MODEL or EMBED_DIM "
            "auto-invalidates entries."
        ),
    )
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="Skip the embedding cache entirely (always re-embed).",
    )
    parser.add_argument(
        "--clear-cache",
        action="store_true",
        help="Delete the embedding cache file before this run.",
    )
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
