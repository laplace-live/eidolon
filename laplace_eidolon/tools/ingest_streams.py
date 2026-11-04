"""Ingest streams/*.md into a local LanceDB index.

Parses ``streams/*.md`` (frontmatter + H2-delimited scenes) into the
``stream_chunks`` table, one row per H2 section, with frontmatter carried
onto every row as filterable metadata. Sister module to
``ingest_facts.py``, which fills ``persona_facts`` in the same LanceDB
instance. The table is dropped and rebuilt on each run.

Where a ``streams/<id>.refined.json`` sidecar exists (written by
``tools/refine.py``), the LLM-written summary is embedded instead of the
raw transcript — anime audio, song lyrics, and SC reads otherwise dominate
the vector — and chunks tagged ``anime_audio`` or ``karaoke`` are dropped
from the index (see ``--skip-types``). Unrefined chunks embed raw text.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Any

import lancedb
import pyarrow as pa
from dotenv import load_dotenv
from loguru import logger

from ..embeddings import (
    DEFAULT_EMBED_CACHE_PATH,
    DEFAULT_EMBED_DIM,
    DEFAULT_EMBED_MODEL,
    EmbedCache,
    EmbeddingUsage,
    default_db_path,
    embed_texts_with_usage,
)
from ..retrieval import build_fts_index, tokenize_zh
from ..stream_archive import DEFAULT_TABLE
from ._streams import iter_streams, load_sidecar

# Overridable via INGEST_SKIP_TYPES or --skip-types; empty string skips nothing.
DEFAULT_SKIP_TYPES = "anime_audio,karaoke"


def load_streams(
    streams_dir: Path,
    *,
    skip_types: set[str],
) -> list[dict[str, Any]]:
    """Parse all ``streams/*.md`` files into rows ready for embedding.

    One row per chunk, in deterministic order.

    Args:
        skip_types: matched against ``chunk_type``, which only refined
            chunks carry — unrefined chunks are always kept because there
            is no signal to filter them on.
    """
    streams = iter_streams(streams_dir)
    if not streams:
        logger.warning(f"Streams directory not found or empty: {streams_dir}")
        return []

    rows: list[dict[str, Any]] = []
    total_skipped = 0

    for parsed in streams:
        sidecar = load_sidecar(parsed)
        refined_map: dict[str, dict[str, Any]] = sidecar.get("chunks", {}) or {}
        meta = parsed.metadata
        stream_date = str(meta.get("stream_date", ""))
        rel_source = str(parsed.md_path.relative_to(streams_dir.parent))

        kept = 0
        skipped = 0

        for chunk in parsed.chunks:
            refined = refined_map.get(chunk.id) or {}
            chunk_type = str(refined.get("chunk_type", "")).strip()

            if chunk_type and chunk_type in skip_types:
                skipped += 1
                continue

            heading = str(refined.get("heading") or chunk.heading)
            summary = str(refined.get("summary") or "")

            # Heading and date go into the embedded text so "fire temple
            # boss" and "what did you stream last week" can both land on a
            # vector hit, without needing a metadata filter.
            base = summary if summary else chunk.text
            if stream_date:
                embed_input = f"On {stream_date}, {heading}.\n{base}"
            else:
                embed_input = f"{heading}.\n{base}"

            topics = refined.get("topics") or []
            mentions = refined.get("mentions") or []
            details = str(refined.get("details") or "")

            # The raw transcript is deliberately excluded from the FTS
            # text: Soniox filler words and mishears would dominate BM25
            # and pull ranking toward chunks that mention a term in
            # passing. Unrefined chunks have nothing better to fall back on.
            if summary or details or topics or mentions:
                fts_text = " ".join(
                    [
                        heading,
                        summary,
                        details,
                        " ".join(str(t) for t in topics),
                        " ".join(str(m) for m in mentions),
                    ]
                )
            else:
                fts_text = f"{heading} {chunk.text}"
            tokens = tokenize_zh(fts_text)

            extras = {
                "key_quotes": refined.get("key_quotes") or [],
                "sc_events": refined.get("sc_events") or [],
                "songs": refined.get("songs") or [],
                "events": refined.get("events") or [],
                "promises": refined.get("promises") or [],
            }

            rows.append(
                {
                    "id": chunk.id,
                    "stream_id": chunk.stream_id,
                    "stream_date": stream_date,
                    "heading": heading,
                    "text": chunk.text,
                    "summary": summary,
                    "details": details,
                    "chunk_type": chunk_type,
                    "topics": json.dumps(topics, ensure_ascii=False),
                    "mentions": json.dumps(mentions, ensure_ascii=False),
                    "extras_json": json.dumps(extras, ensure_ascii=False),
                    "refined": bool(refined),
                    "tokens": tokens,
                    "embed_input": embed_input,
                    "source_path": rel_source,
                }
            )
            kept += 1

        total_skipped += skipped
        refined_count = sum(1 for c in parsed.chunks if c.id in refined_map)
        logger.info(
            f"Loaded {parsed.md_path.name}: {kept} chunks kept "
            f"({refined_count} refined, {skipped} skipped by chunk_type)"
        )

    if total_skipped:
        logger.info(f"Filtered out {total_skipped} chunks total (skip_types={sorted(skip_types)})")

    return rows


def build_arrow_schema() -> pa.Schema:
    """Schema for the stream_chunks table.

    ``tokens`` holds jieba-tokenized text for the FTS half of hybrid
    retrieval; query-side code must run through the same
    ``retrieval.tokenize_zh`` or BM25 lookups won't match. Vector dim
    follows ``DEFAULT_EMBED_DIM`` and picks up a model swap on the next
    run, since the table is dropped and recreated.
    """
    return pa.schema(
        [
            pa.field("id", pa.string()),
            pa.field("stream_id", pa.string()),
            pa.field("stream_date", pa.string()),
            pa.field("heading", pa.string()),
            pa.field("text", pa.string()),
            # Refined fields. Empty strings / "[]" / "{}" / False when no
            # sidecar exists, so every column is always populated.
            pa.field("summary", pa.string()),
            pa.field("details", pa.string()),  # v2: long narrative for LLM
            pa.field("chunk_type", pa.string()),
            pa.field("topics", pa.string()),  # JSON-encoded list[str]
            pa.field("mentions", pa.string()),  # JSON-encoded list[str]
            # {key_quotes, sc_events, songs, events, promises} in one column
            # rather than five; stream_archive.py decodes it at render time.
            pa.field("extras_json", pa.string()),
            pa.field("refined", pa.bool_()),
            pa.field("tokens", pa.string()),  # jieba-tokenized for FTS
            pa.field("source_path", pa.string()),
            pa.field("vector", pa.list_(pa.float32(), DEFAULT_EMBED_DIM)),
        ]
    )


async def embed_in_batches(
    rows: list[dict[str, Any]],
    *,
    batch_size: int = 64,
    cache: EmbedCache | None = None,
) -> EmbeddingUsage:
    """Embed each row's ``embed_input`` and stash the vector on the row.

    A ``cache`` makes an aborted run only re-pay for what it didn't
    finish. Returns aggregate tokens + USD so the caller can report spend.
    """
    total = EmbeddingUsage()

    # Resolve once: the cache key has to match what goes to the API.
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
        # Write through per batch so a crash on the next one doesn't waste
        # this one's spend. SQLite commit-per-batch is cheap.
        if cache is not None:
            cache.put_many(model, dim, [(r["embed_input"], r["vector"]) for r in batch])
        total.add(usage)
        progress = min(start + batch_size, len(misses))
        # BYOK runs land in the ``estimate`` path because OpenRouter
        # withholds cost data on /v1/embeddings; showing the estimate is
        # the only signal a user gets that ingest isn't free.
        if usage.cost_source in ("openrouter", "estimate"):
            suffix = "" if usage.cost_source == "openrouter" else " est."
            cost_str = f", ${usage.cost_usd:.6f}{suffix}"
        else:
            cost_str = ""
        logger.info(
            f"Embedded {progress}/{len(misses)} chunks ({usage.total_tokens} tokens{cost_str})"
        )
    return total


def write_table(rows: list[dict[str, Any]], db_path: Path, table_name: str) -> None:
    """Drop and recreate the LanceDB table, then build the FTS index.

    ``retrieval.hybrid_search`` needs the FTS index; rebuilding the whole
    table each run keeps the two in sync.
    """
    db = lancedb.connect(str(db_path))
    if table_name in db.list_tables().tables:
        db.drop_table(table_name)
    schema = build_arrow_schema()
    # Projecting to schema.names drops ``embed_input`` — the vector
    # already carries it.
    projected = [{k: row[k] for k in schema.names} for row in rows]
    table = db.create_table(table_name, data=projected, schema=schema)
    logger.info(f"Wrote {len(rows)} rows to {db_path}/{table_name}.lance")

    # Indexing once at the end beats incremental updates: ~30k rows takes
    # a few seconds, negligible next to the embedding spend.
    build_fts_index(table, field="tokens")
    logger.info(f"Built FTS index on 'tokens' for {table_name}")


def _parse_skip_types(raw: str) -> set[str]:
    return {t.strip() for t in raw.split(",") if t.strip()}


async def main_async(args: argparse.Namespace) -> int:
    streams_dir = Path(args.streams_dir).resolve()
    db_path = Path(args.db_path).resolve()
    skip_types = _parse_skip_types(args.skip_types)

    rows = load_streams(streams_dir, skip_types=skip_types)
    if not rows:
        logger.warning(
            f"No chunks to ingest from {streams_dir}. "
            "Add markdown files (with H2 sections) and re-run."
        )
        return 0

    if args.dry_run:
        refined = sum(1 for r in rows if r["refined"])
        logger.info(
            f"Dry run: {len(rows)} chunks would be embedded and written "
            f"({refined} refined, {len(rows) - refined} raw)."
        )
        for r in rows[:5]:
            kind = "refined" if r["refined"] else "raw"
            embed_chars = len(r["embed_input"])
            logger.info(
                f"  - {r['id']} [{kind}, type={r['chunk_type'] or '?'}]: "
                f"{r['heading']!r} ({embed_chars} embed chars)"
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
    if usage.cost_source in ("openrouter", "estimate", "mixed"):
        note = {
            "openrouter": "",
            "estimate": " (client-side estimate; BYOK on /v1/embeddings"
            " — OpenRouter withholds cost data)",
            "mixed": " (mixed: some batches reported, some estimated)",
        }[usage.cost_source]
        logger.info(
            f"Embedding totals: {len(rows)} chunks, "
            f"{usage.total_tokens} tokens, ${usage.cost_usd:.6f} USD{note}"
        )
    else:
        logger.info(
            f"Embedding totals: {len(rows)} chunks, {usage.total_tokens} tokens "
            "(provider did not report cost and no local price entry — "
            "add the model to embeddings.EMBED_PRICING_USD_PER_1M to fix)"
        )
    return 0


def main() -> int:
    load_dotenv(override=True)
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument(
        "--streams-dir",
        default="streams",
        help="Directory of *.md transcripts (default: streams)",
    )
    parser.add_argument(
        "--db-path",
        default=default_db_path(),
        help=f"LanceDB directory (default: {default_db_path()})",
    )
    parser.add_argument(
        "--table",
        default=DEFAULT_TABLE,
        help=f"Table name (default: {DEFAULT_TABLE})",
    )
    parser.add_argument(
        "--skip-types",
        default=os.getenv("INGEST_SKIP_TYPES", DEFAULT_SKIP_TYPES),
        help=(
            "Comma-separated chunk_type values to drop from the index "
            f"(default: '{DEFAULT_SKIP_TYPES}'). Pass an empty string to "
            "disable filtering."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse and chunk but skip embedding and writing.",
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
