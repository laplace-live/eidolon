"""Ingest persona-fact .txt files into a local LanceDB index.

Reads fan-compiled atomic facts (one per line, optional date prefix) from
``data/*设定集.txt`` / ``data/*事件集.txt`` into the ``persona_facts`` table.
Sister module to ``ingest_streams.py``, which fills ``stream_chunks`` in the
same LanceDB instance; both are read at runtime by their own FrameProcessor.
The table is dropped and rebuilt on every run — facts are small and
embeddings are cheap, so reproducibility beats incrementalism.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import os
import re
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

DEFAULT_TABLE = "persona_facts"

# Narrow on purpose: a broader glob sweeps in unrelated .txt artefacts
# (video-full.txt, etc.).
DEFAULT_FACT_PATTERNS = ("*设定集.txt", "*事件集.txt")

# Two date forms: "2022年10月3日" and "2025-12-29" with an optional
# " HH:MM[:SS]" tail. The trailing 日 is required so "2022年圣诞节" doesn't
# match; the non-digit lookahead stops the ISO time from eating into a
# following number. Curator timestamps and the separator that follows the
# date are both consumed so they never reach the fact body.
DATE_RE = re.compile(
    r"^\s*(?:"
    r"(\d{4})年(\d{1,2})月(\d{1,2})日"
    r"|"
    r"(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?(?=\D|$)"
    r")\s*[/、,，]?\s*"
)

# A leading "BV1em4y187Nc / " is a video citation, not part of the fact.
BV_RE = re.compile(r"^\s*BV[0-9A-Za-z]+\s*[/、,，]\s*")

# 贴吧 floor markers ("第2705楼: ") are the curator's scrape-resume
# annotations. The captured integer rides along on the row, but must never
# reach ``text``, ``embed_input``, or ``tokens`` — it is high-cardinality
# noise that would poison both the embedding space and the BM25 index.
FLOOR_RE = re.compile(r"^\s*第(\d+)楼\s*[:：]\s*")

# ~95% of the fan-compiled facts open with "明前奶绿声称…" / "明前奶绿强调…",
# and that shared prefix dominates every vector — facts about cat weight,
# glasses, and dreams all collapse into one cluster, so pure-vector
# retrieval ranks the wrong fact at top-1. Stripping the name and the
# reporting verb from ``embed_input`` (never from ``text``, which is what
# gets displayed) lifts vector-only MRR 0.833 → 0.925 (+11% relative) on
# the eval set, rescuing "你梦想是什么" from a total miss. With the Cohere
# reranker on the gap closes to zero, so this mainly buys defense-in-depth
# for the no-Cohere fallback path (key rotation, rate limits, offline dev).
#
# The verb alternation omits negations (不/没) and aux verbs (是/在/有/会) so
# "明前奶绿不喜欢XX" keeps its negation. Longer alternates come first
# ("声称是" before "声称") so leftmost-longest matching picks the right one.
_PERSONA_PREFIX_RE = re.compile(
    r"^明前奶[绿黑]"  # 奶绿 the persona, 奶黑 the alter ego
    r"(?:声称是|声称|声明|强调|认为|觉得|说过|说|解释|讨论"
    r"|吐槽|抱怨|提到|表示|回应|喜欢|讨厌|希望|担心|模仿"
    r"|询问|评价|介绍|分享|多次)?"
    r"[，。、,.;；:：\s]*"
)


def _strip_persona_prefix(text: str) -> str:
    """Strip the leading "明前奶绿声称…" boilerplate from a fact line.

    Idempotent, and a no-op on lines that don't match, so it is safe to
    call unconditionally. See ``_PERSONA_PREFIX_RE`` for why.
    """
    return _PERSONA_PREFIX_RE.sub("", text, count=1) or text


def _parse_line(line: str) -> tuple[str, int, str]:
    """Extract (iso_date, floor, cleaned_text) from one raw fact line.

    ``floor`` is 0 when the line carries no ``第NNN楼: `` marker, which
    most don't. Strip order matters: the curator's floor markers sit
    outside every other prefix, so they go first, then the BV-id
    citation, then the date.
    """
    line = line.strip()
    if not line:
        return "", 0, ""

    floor = 0
    f = FLOOR_RE.match(line)
    if f:
        try:
            floor = int(f.group(1))
        except ValueError:
            floor = 0
        line = line[f.end() :].lstrip()

    line = BV_RE.sub("", line, count=1)

    m = DATE_RE.match(line)
    if not m:
        return "", floor, line
    # The CJK branch of DATE_RE fills groups (1,2,3), the ISO branch
    # (4,5,6); exactly one of the two matches.
    parts = m.group(1, 2, 3) if m.group(1) is not None else m.group(4, 5, 6)
    try:
        year, month, day = (int(g) for g in parts)
        iso = f"{year:04d}-{month:02d}-{day:02d}"
    except (TypeError, ValueError):
        return "", floor, line
    return iso, floor, line[m.end() :].lstrip()


def load_facts(
    files: list[Path],
    *,
    min_chars: int = 4,
    strip_prefix: bool = True,
) -> list[dict[str, Any]]:
    """Read fact files and return one row per non-empty line.

    Duplicate cleaned lines collapse to their first occurrence, which
    keeps the earliest reported date for facts that evolve (cat weight).
    Lines shorter than ``min_chars`` after cleaning are dropped as parse
    artefacts.

    Args:
        strip_prefix: applies to ``embed_input`` only. ``False`` builds a
            parallel unstripped index for A/B benchmarking; display text
            and FTS tokens keep the original wording either way.
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
            iso_date, floor, cleaned = _parse_line(raw_line)
            if not cleaned or len(cleaned) < min_chars:
                if cleaned:
                    total_skipped_short += 1
                continue

            key = cleaned
            if key in seen_keys:
                skipped += 1
                continue
            seen_keys.add(key)

            # Hash of the cleaned text, so re-editing a file doesn't churn
            # the ids of rows it didn't touch.
            row_id = hashlib.sha1(cleaned.encode("utf-8")).hexdigest()[:16]

            # The date is prepended so a query that mentions one can match
            # semantically; the structured ``date`` column does filtering.
            embed_body = _strip_persona_prefix(cleaned) if strip_prefix else cleaned
            if iso_date:
                embed_input = f"{iso_date}：{embed_body}"
            else:
                embed_input = embed_body

            # Tokenize the display text, not embed_body: BM25 wants the
            # persona name indexed so "奶绿对xx说什么" matches lexically.
            # The embedding-side strip and FTS-side keep are both deliberate.
            tokens = tokenize_zh(cleaned)

            rows.append(
                {
                    "id": row_id,
                    "source": fp.name,
                    "date": iso_date,
                    "floor": floor,  # 0 when line has no 第NNN楼: marker
                    "text": cleaned,
                    "tokens": tokens,
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

    ``tokens`` holds jieba-tokenized text for the FTS half of hybrid
    retrieval; query-side code must run through the same
    ``retrieval.tokenize_zh`` or BM25 lookups won't match. Vector dim
    follows ``DEFAULT_EMBED_DIM`` and picks up a model swap on the next
    run, since the table is dropped and recreated.
    """
    return pa.schema(
        [
            pa.field("id", pa.string()),
            pa.field("source", pa.string()),
            pa.field("date", pa.string()),  # "YYYY-MM-DD" or ""
            pa.field("floor", pa.int32()),  # 贴吧 floor number, 0 = unannotated
            pa.field("text", pa.string()),
            pa.field("tokens", pa.string()),  # jieba-tokenized for FTS
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

    Batches are larger than the streams ingest (96 vs 64) because facts
    average ~30 chars. Cache behavior matches ingest_streams; the two
    scripts share one on-disk cache keyed by (model, dim, text).
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
        if usage.cost_source in ("openrouter", "estimate"):
            suffix = "" if usage.cost_source == "openrouter" else " est."
            cost_str = f", ${usage.cost_usd:.6f}{suffix}"
        else:
            cost_str = ""
        logger.info(
            f"Embedded {progress}/{len(misses)} facts ({usage.total_tokens} tokens{cost_str})"
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
    projected = [{k: row[k] for k in schema.names} for row in rows]
    table = db.create_table(table_name, data=projected, schema=schema)
    logger.info(f"Wrote {len(rows)} rows to {db_path}/{table_name}.lance")

    # Indexing after the write sees every row at once — much faster than
    # incremental, and negligible next to the embedding spend.
    build_fts_index(table, field="tokens")
    logger.info(f"Built FTS index on 'tokens' for {table_name}")


def _resolve_files(files: list[str] | None, data_dir: Path) -> list[Path]:
    """Resolve the file list: explicit args, else default patterns under data/."""
    if files:
        return [Path(f).resolve() for f in files]
    matches: list[Path] = []
    for pattern in DEFAULT_FACT_PATTERNS:
        matches.extend(sorted(data_dir.glob(pattern)))
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
    rows = load_facts(
        files,
        min_chars=args.min_chars,
        strip_prefix=not args.no_strip_prefix,
    )
    if not rows:
        logger.warning("No facts to ingest. Files were empty or filtered out.")
        return 0

    if args.dry_run:
        logger.info(f"Dry run: {len(rows)} facts would be embedded and written.")
        # text vs embed_input side by side is the fastest way to spot a
        # prefix-strip regression.
        for r in rows[:5]:
            floor_str = f"第{r['floor']}楼" if r['floor'] else "no-floor"
            logger.info(
                f"  - {r['id']} [{r['date'] or 'undated'}, {floor_str}, {r['source']}]"
            )
            logger.info(f"      text:        {r['text'][:80]}")
            logger.info(f"      embed_input: {r['embed_input'][:80]}")
            logger.info(f"      tokens:      {r['tokens'][:80]}")
        return 0

    db_path.mkdir(parents=True, exist_ok=True)

    cache: EmbedCache | None = None
    if not args.no_cache:
        cache_path = Path(args.cache_path).resolve()
        if args.clear_cache and cache_path.exists():
            cache_path.unlink()
            logger.info(f"Cleared embedding cache at {cache_path}")
        cache = EmbedCache(cache_path)
        logger.info(f"Embedding cache: {cache_path} ({cache.count()} vectors on disk)")

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
            f"Embedding totals: {len(rows)} facts, "
            f"{usage.total_tokens} tokens, ${usage.cost_usd:.6f} USD{note}"
        )
    else:
        logger.info(
            f"Embedding totals: {len(rows)} facts, {usage.total_tokens} tokens "
            "(provider did not report cost and no local price entry — "
            "add the model to embeddings.EMBED_PRICING_USD_PER_1M to fix)"
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
        default=default_db_path(),
        help=f"LanceDB directory (default: {default_db_path()})",
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
        "--no-strip-prefix",
        action="store_true",
        help=(
            "Disable persona-prefix stripping for embed_input. The vector "
            "will then encode '明前奶绿声称…' as part of every fact, which "
            "tends to compress the embedding space (the prefix repeats on "
            "~95%% of rows). Use with --table persona_facts_unstripped to "
            "build a parallel index for A/B benchmarking against the "
            "stripped default."
        ),
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
