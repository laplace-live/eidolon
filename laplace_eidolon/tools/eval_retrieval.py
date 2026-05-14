"""Score retrieval quality for both LanceDB tables.

Runs a curated query set through every retrieval mode (vector-only,
hybrid no-rerank, hybrid+rerank) and reports recall@k + MRR per query
and aggregated. Pair with ``data/eval/queries.toml`` to extend the
test set.

Why: the bot's answer quality is bounded by what it retrieves. After
30k+ chunks, "feels worse" became hard to debug from log inspection
alone. This harness gives a single number to optimize against and
makes A/B testing tokenizers, rerankers, and top_k values trivial.

Usage::

    # Run all queries through every mode (default).
    uv run laplace-eval-retrieval

    # Single mode for fast iteration.
    uv run laplace-eval-retrieval --modes hybrid_rerank

    # Specific table (e.g. while iterating on facts only).
    uv run laplace-eval-retrieval --table persona_facts

    # Save baseline to compare against later runs.
    uv run laplace-eval-retrieval --save data/eval/baseline.json

    # Compare against a saved baseline.
    uv run laplace-eval-retrieval --compare data/eval/baseline.json

    # Benchmark several Cohere reranker models head-to-head — quality
    # AND latency. Useful when picking between fast/pro/legacy models.
    uv run laplace-eval-retrieval --rerank-models \\
        rerank-multilingual-v3.0 rerank-v4.0-fast rerank-v4.0-pro
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import lancedb
from dotenv import load_dotenv
from loguru import logger

from ..embeddings import DEFAULT_DB_PATH, embed_texts
from ..retrieval import (
    extract_date_filter,
    hybrid_search,
    make_reranker,
    tokenize_zh,
)

# Use stdlib tomllib (Python 3.11+) — project requires >=3.10 but the
# eval harness specifically can require 3.11. Fall back gracefully.
if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover — runtime constraint, not test-covered
    raise RuntimeError("eval_retrieval requires Python 3.11+ for tomllib")

DEFAULT_QUERIES = "data/eval/queries.toml"
DEFAULT_K_VALUES = (1, 3, 5, 10)
ALL_MODES = ("vector_only", "hybrid", "hybrid_rerank")


# ---------------------------------------------------------------------------
# Data shapes
# ---------------------------------------------------------------------------


@dataclass
class EvalQuery:
    """One test case loaded from queries.toml."""

    table: str
    text: str
    expect_substrings: list[str]
    notes: str = ""


@dataclass
class QueryResult:
    """How one (query, mode) pair scored."""

    query: EvalQuery
    mode: str
    rank: int | None  # 1-indexed rank of the first hit, or None if missed
    top_k_hits: dict[int, bool] = field(default_factory=dict)
    top_text: str = ""  # text of the rank-1 result, for human eyeballing


@dataclass
class ModeReport:
    """Aggregate metrics for one mode across the whole query set."""

    mode: str
    table: str
    n_queries: int
    recall_at: dict[int, float]
    mrr: float
    misses: list[str]  # query texts that returned no hit anywhere in top-10


@dataclass
class RerankerBenchmark:
    """Latency + quality for one reranker model across the query set.

    Built by ``benchmark_reranker_models``. Differs from ``ModeReport``
    in that it tracks per-query rerank wall-clock latencies — quality
    alone doesn't tell you whether a model fits in a voice-bot turn.
    """

    model: str
    table: str
    n_queries: int
    recall_at: dict[int, float]
    mrr: float
    # Wall-clock latencies for the rerank-only portion of each query,
    # in milliseconds. Excludes embed + vector/FTS scan so the numbers
    # isolate the reranker's contribution.
    rerank_ms: list[float] = field(default_factory=list)

    @property
    def median_ms(self) -> float:
        return statistics.median(self.rerank_ms) if self.rerank_ms else 0.0

    @property
    def p95_ms(self) -> float:
        if not self.rerank_ms:
            return 0.0
        # Use exclusive interpolation; fine for our small N because
        # we're comparing models on the same query set, not setting SLOs.
        sorted_ms = sorted(self.rerank_ms)
        idx = max(0, min(len(sorted_ms) - 1, int(0.95 * len(sorted_ms))))
        return sorted_ms[idx]

    @property
    def mean_ms(self) -> float:
        return statistics.mean(self.rerank_ms) if self.rerank_ms else 0.0


# ---------------------------------------------------------------------------
# Query loading
# ---------------------------------------------------------------------------


def load_queries(path: Path) -> list[EvalQuery]:
    """Parse queries.toml into EvalQuery objects."""
    if not path.exists():
        raise FileNotFoundError(f"Queries file not found: {path}")

    with path.open("rb") as f:
        data = tomllib.load(f)

    raw_queries = data.get("query", [])
    if not raw_queries:
        raise ValueError(f"No [[query]] entries in {path}")

    queries: list[EvalQuery] = []
    for i, q in enumerate(raw_queries):
        try:
            queries.append(
                EvalQuery(
                    table=str(q["table"]),
                    text=str(q["text"]),
                    expect_substrings=[str(s) for s in q["expect_substrings"]],
                    notes=str(q.get("notes", "")),
                )
            )
        except KeyError as e:
            raise ValueError(f"Query #{i} in {path} missing required field {e}") from None
    return queries


# ---------------------------------------------------------------------------
# Retrieval modes
# ---------------------------------------------------------------------------


def _row_text_for_match(row: dict[str, Any]) -> str:
    """Build the text blob a substring expectation matches against.

    For persona_facts the canonical field is ``text``. For stream_chunks
    we union heading + summary + details + raw text so a substring can
    hit anywhere meaningful. Empty fields stringify to ``""`` so this
    is safe across both schemas without per-table branching.
    """
    parts = [
        str(row.get("text") or ""),
        str(row.get("summary") or ""),
        str(row.get("details") or ""),
        str(row.get("heading") or ""),
    ]
    return " ".join(parts)


def _matches(row_blob: str, expects: list[str]) -> bool:
    """True if any expected substring appears in the row's text."""
    return any(s in row_blob for s in expects)


async def run_vector_only(
    table: Any,
    query: str,
    *,
    k: int,
    where: str | None,
) -> list[dict[str, Any]]:
    """Vector-only search — what the bot did before this work."""
    vectors = await embed_texts([query])
    if not vectors:
        return []

    def _go():
        q = table.search(vectors[0]).limit(k)
        if where:
            q = q.where(where, prefilter=True)
        return q.to_list()

    return await asyncio.to_thread(_go)


async def run_hybrid(
    table: Any,
    query: str,
    *,
    k: int,
    candidates: int,
    where: str | None,
    rerank: bool,
) -> list[dict[str, Any]]:
    """Hybrid (vector + FTS) search, optionally reranked."""
    vectors = await embed_texts([query])
    if not vectors:
        return []
    return await hybrid_search(
        table,
        vector=vectors[0],
        query_text=query,
        candidates=candidates,
        where=where,
        final_k=k,
        rerank=rerank,
    )


# ---------------------------------------------------------------------------
# Per-mode evaluation
# ---------------------------------------------------------------------------


async def evaluate_query(
    query: EvalQuery,
    table: Any,
    mode: str,
    *,
    candidates: int,
    max_k: int,
    use_date_filter: bool,
) -> QueryResult:
    """Run one query in one mode and return its rank + per-k hits.

    Date filter is opt-in per mode — we want to measure its
    contribution separately from hybrid+rerank. The column name
    differs by table: persona_facts uses ``date``, stream_chunks uses
    ``stream_date`` — passing the wrong one fails with a Schema error
    from LanceDB, so we resolve it from the query's ``table`` field.
    """
    date_column = "stream_date" if query.table == "stream_chunks" else "date"
    where = (
        extract_date_filter(query.text, column=date_column) if use_date_filter else None
    )

    if mode == "vector_only":
        rows = await run_vector_only(table, query.text, k=max_k, where=where)
    elif mode == "hybrid":
        rows = await run_hybrid(
            table, query.text, k=max_k, candidates=candidates, where=where, rerank=False
        )
    elif mode == "hybrid_rerank":
        rows = await run_hybrid(
            table, query.text, k=max_k, candidates=candidates, where=where, rerank=True
        )
    else:
        raise ValueError(f"Unknown mode: {mode!r}")

    # Find the first rank where any expected substring appears.
    rank: int | None = None
    for i, row in enumerate(rows, start=1):
        if _matches(_row_text_for_match(row), query.expect_substrings):
            rank = i
            break

    top_k_hits: dict[int, bool] = {k: rank is not None and rank <= k for k in DEFAULT_K_VALUES}

    return QueryResult(
        query=query,
        mode=mode,
        rank=rank,
        top_k_hits=top_k_hits,
        top_text=(_row_text_for_match(rows[0])[:120] if rows else ""),
    )


def aggregate(results: list[QueryResult], table: str) -> ModeReport:
    """Compute recall@k and MRR across one mode's results."""
    if not results:
        return ModeReport(
            mode="(none)",
            table=table,
            n_queries=0,
            recall_at={k: 0.0 for k in DEFAULT_K_VALUES},
            mrr=0.0,
            misses=[],
        )
    n = len(results)
    mode = results[0].mode
    recall = {
        k: sum(1 for r in results if r.top_k_hits.get(k, False)) / n
        for k in DEFAULT_K_VALUES
    }
    # MRR: 1/rank when found, 0 when missed. Rank is 1-indexed.
    mrr = sum((1.0 / r.rank) if r.rank else 0.0 for r in results) / n
    misses = [r.query.text for r in results if r.rank is None]
    return ModeReport(
        mode=mode,
        table=table,
        n_queries=n,
        recall_at=recall,
        mrr=mrr,
        misses=misses,
    )


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def _fmt_pct(x: float) -> str:
    return f"{x * 100:5.1f}%"


def print_table_report(per_mode: dict[str, ModeReport]) -> None:
    """Print a side-by-side comparison of modes for one table."""
    if not per_mode:
        return
    table_name = next(iter(per_mode.values())).table
    n = next(iter(per_mode.values())).n_queries

    print(f"\n{'=' * 78}")
    print(f"  Table: {table_name}  ({n} queries)")
    print("=" * 78)

    header = f"  {'mode':<22}" + "".join(f" {'R@'+str(k):>7}" for k in DEFAULT_K_VALUES) + f" {'MRR':>7}"
    print(header)
    print("  " + "-" * (len(header) - 2))

    for mode_key in ALL_MODES:
        r = per_mode.get(mode_key)
        if r is None:
            continue
        cells = [_fmt_pct(r.recall_at[k]) for k in DEFAULT_K_VALUES]
        print(f"  {mode_key:<22}" + "".join(f" {c:>7}" for c in cells) + f" {r.mrr:7.3f}")

    print()
    # Show miss list for the best mode (most adversarial cases).
    best = max(per_mode.values(), key=lambda r: r.mrr)
    if best.misses:
        print(f"  Misses (best mode = {best.mode}, {len(best.misses)} of {best.n_queries}):")
        for m in best.misses:
            print(f"    · {m}")


def print_per_query_breakdown(
    all_results: list[QueryResult], table_name: str
) -> None:
    """Show ranks per query for visual A/B comparison."""
    queries_in_table = {
        r.query.text: r.query
        for r in all_results
        if r.query.table == table_name
    }
    if not queries_in_table:
        return

    print(f"\n  {'─' * 76}")
    print(f"  Per-query ranks for {table_name} (lower = better, ✗ = miss):")
    print(f"  {'─' * 76}")
    header = f"  {'query':<40}" + "".join(f" {m:>14}" for m in ALL_MODES)
    print(header)
    for qtext in queries_in_table:
        line = f"  {qtext[:38]:<40}"
        for mode in ALL_MODES:
            match = next(
                (r for r in all_results if r.query.text == qtext and r.mode == mode),
                None,
            )
            cell = "—" if match is None else (f"#{match.rank}" if match.rank else "✗")
            line += f" {cell:>14}"
        print(line)


def to_json_blob(per_table: dict[str, dict[str, ModeReport]]) -> dict[str, Any]:
    """Flatten reports for serialisation."""
    out: dict[str, Any] = {}
    for table_name, modes in per_table.items():
        out[table_name] = {
            mode: {
                "recall_at": rep.recall_at,
                "mrr": rep.mrr,
                "n_queries": rep.n_queries,
                "miss_count": len(rep.misses),
            }
            for mode, rep in modes.items()
        }
    return out


# ---------------------------------------------------------------------------
# Reranker model benchmark (--rerank-models)
# ---------------------------------------------------------------------------


def _build_named_reranker(model_name: str) -> Any:
    """Build a fresh ``CohereReranker`` for a specific model name.

    Bypasses ``make_reranker``'s singleton cache so each model is
    measured independently. Raises if Cohere isn't installed or the
    API key is missing — bench mode requires real reranker calls.
    """
    api_key = os.getenv("COHERE_API_KEY")
    if not api_key:
        raise RuntimeError(
            "--rerank-models requires COHERE_API_KEY in .env "
            "(no key = nothing to benchmark, since the fallback path is "
            "the same RRF for every 'model')."
        )
    from lancedb.rerankers import CohereReranker

    return CohereReranker(api_key=api_key, model_name=model_name)


async def _evaluate_query_with_reranker(
    query: EvalQuery,
    table: Any,
    *,
    candidates: int,
    max_k: int,
    use_date_filter: bool,
    reranker: Any,
) -> tuple[QueryResult, float]:
    """Run one query with a specific reranker, return (result, rerank_ms).

    Latency is measured around the *whole* hybrid_search call (embed
    is shared across models so it's done once outside this function;
    everything inside is the rerank-affected path: vector + FTS scan +
    reranker call). For very large candidate pools the vector + FTS
    portion would dominate, but at our default candidates (15-30) the
    reranker round-trip is the lion's share so the number is honest.
    """
    date_column = "stream_date" if query.table == "stream_chunks" else "date"
    where = (
        extract_date_filter(query.text, column=date_column) if use_date_filter else None
    )

    vectors = await embed_texts([query.text])
    if not vectors:
        return (
            QueryResult(query=query, mode=f"rerank:{reranker.model_name}", rank=None),
            0.0,
        )

    t0 = time.perf_counter()
    rows = await hybrid_search(
        table,
        vector=vectors[0],
        query_text=query.text,
        candidates=candidates,
        where=where,
        final_k=max_k,
        rerank=True,
        reranker=reranker,
    )
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    rank: int | None = None
    for i, row in enumerate(rows, start=1):
        if _matches(_row_text_for_match(row), query.expect_substrings):
            rank = i
            break

    top_k_hits = {k: rank is not None and rank <= k for k in DEFAULT_K_VALUES}
    result = QueryResult(
        query=query,
        mode=f"rerank:{reranker.model_name}",
        rank=rank,
        top_k_hits=top_k_hits,
        top_text=(_row_text_for_match(rows[0])[:120] if rows else ""),
    )
    return result, elapsed_ms


async def benchmark_reranker_models(
    queries: list[EvalQuery],
    table: Any,
    table_name: str,
    *,
    candidates: int,
    max_k: int,
    use_date_filter: bool,
    models: list[str],
    warmup: bool = True,
) -> list[RerankerBenchmark]:
    """Run the same queries through each reranker model and compare.

    Order of operations per model:

    1. Build a fresh reranker (no shared singleton state).
    2. If ``warmup``, fire one throwaway query so the first real
       measurement isn't dominated by HTTP/2 connection setup, DNS,
       and Cohere model cold-start. Without this, the first model
       always looks slower than it is.
    3. Run every eval query, recording (rank, latency).

    Returns one ``RerankerBenchmark`` per model.
    """
    out: list[RerankerBenchmark] = []
    for model in models:
        try:
            reranker = _build_named_reranker(model)
        except Exception as e:  # noqa: BLE001
            logger.error(f"Skipping {model}: {e}")
            continue

        if warmup and queries:
            try:
                await _evaluate_query_with_reranker(
                    queries[0],
                    table,
                    candidates=candidates,
                    max_k=max_k,
                    use_date_filter=use_date_filter,
                    reranker=reranker,
                )
            except Exception as e:  # noqa: BLE001
                logger.warning(f"Warmup failed for {model} ({e}); proceeding")

        results: list[QueryResult] = []
        latencies: list[float] = []
        for q in queries:
            try:
                r, ms = await _evaluate_query_with_reranker(
                    q,
                    table,
                    candidates=candidates,
                    max_k=max_k,
                    use_date_filter=use_date_filter,
                    reranker=reranker,
                )
            except Exception as e:  # noqa: BLE001
                logger.error(f"{model} failed on query {q.text!r}: {e}")
                continue
            results.append(r)
            latencies.append(ms)

        if not results:
            continue
        n = len(results)
        recall = {
            k: sum(1 for r in results if r.top_k_hits.get(k, False)) / n
            for k in DEFAULT_K_VALUES
        }
        mrr = sum((1.0 / r.rank) if r.rank else 0.0 for r in results) / n
        out.append(
            RerankerBenchmark(
                model=model,
                table=table_name,
                n_queries=n,
                recall_at=recall,
                mrr=mrr,
                rerank_ms=latencies,
            )
        )
    return out


def print_benchmark_report(benches: list[RerankerBenchmark]) -> None:
    """Print a quality + latency comparison table for one DB table."""
    if not benches:
        return
    table_name = benches[0].table
    n = benches[0].n_queries

    print(f"\n{'=' * 88}")
    print(f"  Reranker model benchmark — {table_name}  ({n} queries)")
    print("=" * 88)

    header = (
        f"  {'model':<28}"
        + "".join(f" {'R@'+str(k):>6}" for k in DEFAULT_K_VALUES)
        + f" {'MRR':>6}"
        + f" {'mean':>7}"
        + f" {'p50':>7}"
        + f" {'p95':>7}"
    )
    print(header)
    print("  " + "-" * (len(header) - 2))

    # Sort by MRR descending so the eye lands on the quality winner first.
    for b in sorted(benches, key=lambda x: -x.mrr):
        cells = [_fmt_pct(b.recall_at[k]) for k in DEFAULT_K_VALUES]
        print(
            f"  {b.model:<28}"
            + "".join(f" {c:>6}" for c in cells)
            + f" {b.mrr:6.3f}"
            + f" {b.mean_ms:6.0f}m"
            + f" {b.median_ms:6.0f}m"
            + f" {b.p95_ms:6.0f}m"
        )
    print("  (latency is end-to-end hybrid_search wall-clock in ms; lower is better)")


def print_comparison(
    current: dict[str, dict[str, ModeReport]],
    baseline_blob: dict[str, Any],
) -> None:
    """Diff current run against a saved baseline."""
    print(f"\n{'=' * 78}")
    print("  Comparison vs baseline")
    print("=" * 78)
    for table_name, modes in current.items():
        base_modes = baseline_blob.get(table_name, {})
        if not base_modes:
            continue
        print(f"\n  {table_name}:")
        for mode_key, rep in modes.items():
            base = base_modes.get(mode_key)
            if not base:
                continue
            base_mrr = base.get("mrr", 0.0)
            delta_mrr = rep.mrr - base_mrr
            arrow = "↑" if delta_mrr > 0 else ("↓" if delta_mrr < 0 else "·")
            print(
                f"    {mode_key:<20}  MRR {base_mrr:.3f} → {rep.mrr:.3f}  "
                f"{arrow}{abs(delta_mrr):.3f}"
            )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def main_async(args: argparse.Namespace) -> int:
    queries = load_queries(Path(args.queries))
    if args.table:
        queries = [q for q in queries if q.table == args.table]
    if not queries:
        logger.error("No queries to evaluate (post-filter).")
        return 1

    db = lancedb.connect(args.db_path)
    table_names = sorted({q.table for q in queries})

    # candidates per table — facts are small so we can afford a wider net;
    # stream chunks are big so 15 is the sweet spot.
    candidates_for = {
        "persona_facts": args.facts_candidates,
        "stream_chunks": args.stream_candidates,
    }

    # Branch: --rerank-models triggers the head-to-head benchmark mode
    # (different output shape, no recall@k vs vector_only — just the
    # named models compared on the same query set).
    if args.rerank_models:
        for table_name in table_names:
            if table_name not in db.list_tables().tables:
                logger.warning(
                    f"Table {table_name} not found in {args.db_path}; skipping."
                )
                continue
            table = db.open_table(table_name)
            table_queries = [q for q in queries if q.table == table_name]
            candidates = candidates_for.get(table_name, 30)
            logger.info(
                f"Benchmarking {len(args.rerank_models)} reranker(s) on "
                f"{table_name} — {len(table_queries)} queries × {len(args.rerank_models)} models "
                f"(candidates={candidates})"
            )
            benches = await benchmark_reranker_models(
                table_queries,
                table,
                table_name,
                candidates=candidates,
                max_k=max(DEFAULT_K_VALUES),
                use_date_filter=args.date_filter,
                models=args.rerank_models,
            )
            print_benchmark_report(benches)
        return 0

    modes = args.modes or list(ALL_MODES)

    # Sanity: warn if hybrid_rerank is asked for but no Cohere key is set.
    # The retrieval module falls back to LinearCombinationReranker, so
    # 'hybrid_rerank' mode still does something useful — but it's NOT
    # the cross-encoder result the user is presumably after.
    if "hybrid_rerank" in modes and not os.getenv("COHERE_API_KEY"):
        logger.warning(
            "hybrid_rerank requested but COHERE_API_KEY is unset — that mode "
            "will use LinearCombinationReranker (vector-weighted) as fallback. "
            "Set COHERE_API_KEY for the actual cross-encoder eval."
        )
        # Bake the reranker decision now so the inner search doesn't
        # repeatedly init.
        make_reranker()

    per_table: dict[str, dict[str, ModeReport]] = {}
    all_results: list[QueryResult] = []

    for table_name in table_names:
        if table_name not in db.list_tables().tables:
            logger.warning(f"Table {table_name} not found in {args.db_path}; skipping.")
            continue
        table = db.open_table(table_name)
        per_table[table_name] = {}
        candidates = candidates_for.get(table_name, 30)
        table_queries = [q for q in queries if q.table == table_name]

        logger.info(
            f"Evaluating {table_name} — {len(table_queries)} queries × "
            f"{len(modes)} modes (candidates={candidates}, k≤{max(DEFAULT_K_VALUES)})"
        )

        for mode in modes:
            results: list[QueryResult] = []
            for q in table_queries:
                r = await evaluate_query(
                    q,
                    table,
                    mode,
                    candidates=candidates,
                    max_k=max(DEFAULT_K_VALUES),
                    use_date_filter=args.date_filter,
                )
                results.append(r)
                all_results.append(r)
            per_table[table_name][mode] = aggregate(results, table_name)

    # Output
    for table_name in table_names:
        if table_name in per_table:
            print_table_report(per_table[table_name])
            if args.verbose:
                print_per_query_breakdown(all_results, table_name)

    # Save / compare
    if args.save:
        Path(args.save).parent.mkdir(parents=True, exist_ok=True)
        Path(args.save).write_text(
            json.dumps(to_json_blob(per_table), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        logger.info(f"Saved metrics to {args.save}")

    if args.compare:
        baseline_path = Path(args.compare)
        if not baseline_path.exists():
            logger.error(f"Baseline file not found: {baseline_path}")
            return 1
        baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
        print_comparison(per_table, baseline)

    return 0


def main() -> int:
    load_dotenv(override=True)
    # Quiet the embedding/index init log noise so the report is the
    # main signal. Keep WARNING+ so real problems still surface.
    logger.remove()
    logger.add(sys.stderr, level="WARNING")

    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument(
        "--queries",
        default=DEFAULT_QUERIES,
        help=f"TOML file of [[query]] entries (default: {DEFAULT_QUERIES})",
    )
    parser.add_argument(
        "--db-path",
        default=DEFAULT_DB_PATH,
        help=f"LanceDB directory (default: {DEFAULT_DB_PATH})",
    )
    parser.add_argument(
        "--table",
        default=None,
        choices=("persona_facts", "stream_chunks"),
        help="Restrict eval to one table. Default: both.",
    )
    parser.add_argument(
        "--modes",
        nargs="+",
        choices=ALL_MODES,
        default=None,
        help=f"Subset of retrieval modes to test. Default: all of {ALL_MODES}.",
    )
    parser.add_argument(
        "--facts-candidates",
        type=int,
        default=30,
        help="Hybrid-search candidate pool size for persona_facts (default: 30).",
    )
    parser.add_argument(
        "--stream-candidates",
        type=int,
        default=15,
        help="Hybrid-search candidate pool size for stream_chunks (default: 15).",
    )
    parser.add_argument(
        "--date-filter",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Apply date pre-filter when query mentions a date (default: on).",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print per-query rank breakdown after the summary table.",
    )
    parser.add_argument(
        "--save",
        default=None,
        help="Save metrics to a JSON file for later --compare.",
    )
    parser.add_argument(
        "--compare",
        default=None,
        help="Compare current run against a previously saved metrics JSON.",
    )
    parser.add_argument(
        "--rerank-models",
        nargs="+",
        default=None,
        metavar="MODEL",
        help=(
            "Benchmark mode: run the query set through each named Cohere "
            "reranker model and report quality + latency side-by-side. "
            "Requires COHERE_API_KEY. Example: "
            "--rerank-models rerank-multilingual-v3.0 rerank-v4.0-fast "
            "rerank-v4.0-pro. When set, the regular --modes path is "
            "skipped — output is the model-comparison table instead."
        ),
    )
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
