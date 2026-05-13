"""Ingest streams/*.md into a local LanceDB index.

Source of truth: ``server/streams/*.md`` (frontmatter + H2-delimited scenes).
Built artifact: ``server/data/lancedb/stream_chunks.lance/``.

Sister module: ``tools/ingest_facts.py`` writes the ``persona_facts`` table
into the same LanceDB instance from the line-per-fact ``data/*设定集.txt``
files. Both are read at runtime by separate FrameProcessors (see
``stream_archive.py`` and ``persona_facts.py``). Shared embedding +
LanceDB infra lives in ``embeddings.py``.

Each H2 section becomes one chunk. Frontmatter (``stream_date``, ``language``,
etc.) propagates onto every chunk as filterable metadata. The whole table
is dropped and rebuilt on each run; transcripts are small and embeddings
are cheap, so reproducibility beats incrementalism here.

Topics are per-chunk, not per-stream — produced by ``tools/refine.py`` and
stored on each row as a JSON-encoded list. A single VOD often spans chat,
gaming, karaoke, and watchalongs, so a single per-stream label would be
misleading.

Refinement-aware
----------------
If a stream has a ``streams/<id>.refined.json`` sidecar (produced by
``tools/refine.py``), each refined chunk is upgraded:

- The LLM-written ``summary`` is embedded instead of the raw transcript,
  which dramatically reduces noise from anime audio / song lyrics / SC
  reads polluting the embedding.
- The refined ``heading`` overrides the original placeholder.
- ``chunk_type`` is stored alongside; chunks tagged ``anime_audio`` or
  ``karaoke`` are skipped from the index by default (configurable via
  ``--skip-types`` or ``INGEST_SKIP_TYPES``).

Unrefined chunks fall back to the original behavior (embed the raw text).

Usage::

    cd server
    uv run python -m tools.ingest_streams                           # rebuild from streams/
    uv run python -m tools.ingest_streams --streams-dir custom/     # alt source dir
    uv run python -m tools.ingest_streams --dry-run                 # show what would be written
    uv run python -m tools.ingest_streams --skip-types ""           # don't filter any chunk_type
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

import lancedb
import pyarrow as pa
from dotenv import load_dotenv
from loguru import logger

# Allow running both as module (`python -m tools.ingest_streams`) and as a script.
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
from stream_archive import DEFAULT_TABLE  # noqa: E402
from tools._streams import iter_streams, load_sidecar  # noqa: E402

# chunk_types skipped from the index by default. Set INGEST_SKIP_TYPES (or
# pass --skip-types) to override. Empty string = skip nothing.
DEFAULT_SKIP_TYPES = "anime_audio,karaoke"


def load_streams(
    streams_dir: Path,
    *,
    skip_types: set[str],
) -> list[dict[str, Any]]:
    """Parse all ``streams/*.md`` files into rows ready for embedding.

    Each row is one chunk; rows are returned in deterministic order. If a
    sidecar refinement exists for a chunk, the refined fields are merged
    onto the row and the embedded text becomes the LLM-written summary.

    ``skip_types`` filters out refined chunks whose ``chunk_type`` matches.
    Unrefined chunks are always kept (we have no signal to filter on).
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

            # Prefer refined heading + summary if present; the summary is
            # what we want to retrieve on, since the raw text is noisy.
            heading = str(refined.get("heading") or chunk.heading)
            summary = str(refined.get("summary") or "")

            # The embedded text. Including the heading helps semantic
            # match for queries like "fire temple boss". Including the
            # date textually helps "what did you stream last week" surface
            # via embedding alone, not just metadata filtering.
            base = summary if summary else chunk.text
            if stream_date:
                embed_input = f"On {stream_date}, {heading}.\n{base}"
            else:
                embed_input = f"{heading}.\n{base}"

            topics = refined.get("topics") or []
            mentions = refined.get("mentions") or []
            details = str(refined.get("details") or "")

            # Pack the v2-only structured fields into a single JSON blob
            # rather than adding 5+ columns. stream_archive.py decodes this at
            # render time. Empty dict for v1 / unrefined chunks so the
            # column is always populated.
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

    Vector dim is fixed to ``DEFAULT_EMBED_DIM`` (3072 by default, matching
    ``google/gemini-embedding-2-preview``). If you swap embedding models
    or change ``EMBED_DIM``, this schema picks up the new dim on
    the next ingest run because we drop and recreate the table.
    """
    return pa.schema(
        [
            pa.field("id", pa.string()),
            pa.field("stream_id", pa.string()),
            pa.field("stream_date", pa.string()),
            pa.field("heading", pa.string()),
            pa.field("text", pa.string()),
            # Refined fields. Empty strings / "[]" / "{}" / False if no
            # sidecar exists or the chunk is still in v1 format.
            pa.field("summary", pa.string()),
            pa.field("details", pa.string()),  # v2: long narrative for LLM
            pa.field("chunk_type", pa.string()),
            pa.field("topics", pa.string()),  # JSON-encoded list[str]
            pa.field("mentions", pa.string()),  # JSON-encoded list[str]
            # JSON blob: {key_quotes, sc_events, songs, events, promises}.
            # Single column instead of 5 to keep the schema flexible —
            # stream_archive.py decodes whatever it needs at render time.
            pa.field("extras_json", pa.string()),
            pa.field("refined", pa.bool_()),
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

    Done in batches to keep request payloads small and progress visible.
    If ``cache`` is provided, vectors already on disk are reused (so a
    failed/aborted previous run only re-pays for what wasn't completed),
    and freshly-embedded batches are written through to the cache before
    the next batch starts. Returns the aggregate token + USD cost reported
    by OpenRouter so the caller can summarize spend at the end.
    """
    total = EmbeddingUsage()

    # Cache key has to match what we'll send to the API; resolve once.
    model = os.getenv("EMBED_MODEL", DEFAULT_EMBED_MODEL)
    dim = DEFAULT_EMBED_DIM

    # Hit pass: serve as many vectors from disk as we can before any API
    # call. Done in one shot rather than per-batch so the "loaded N from
    # cache" log line lands up front and the user knows what's coming.
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
        # Write through immediately so a crash on the *next* batch doesn't
        # waste this batch's spend. SQLite commit-per-batch is cheap.
        if cache is not None:
            cache.put_many(model, dim, [(r["embed_input"], r["vector"]) for r in batch])
        total.add(usage)
        progress = min(start + batch_size, len(misses))
        # Show cost for any source that produced one — BYOK runs hit the
        # ``estimate`` path because OpenRouter withholds cost data on
        # the embeddings endpoint, and hiding the estimate misled users
        # into thinking ingest was free.
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
    """Drop and recreate the LanceDB table with the embedded rows."""
    db = lancedb.connect(str(db_path))
    if table_name in db.list_tables().tables:
        db.drop_table(table_name)
    schema = build_arrow_schema()
    # Project only the fields that match the schema (drop ``embed_input``
    # since the vector now carries that information).
    projected = [{k: row[k] for k in schema.names} for row in rows]
    db.create_table(table_name, data=projected, schema=schema)
    logger.info(f"Wrote {len(rows)} rows to {db_path}/{table_name}.lance")


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
        default=DEFAULT_DB_PATH,
        help=f"LanceDB directory (default: {DEFAULT_DB_PATH})",
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
