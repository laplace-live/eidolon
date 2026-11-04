// Vector + FTS hybrid search over one table, fused the way the Python bot fused it.
// LanceDB TS's native hybrid RRF ranks from 0 and breaks ties differently from the Python
// RRFReranker the index was tuned with, so the legs run separately and fuse here. Omitting
// _distance/_score from select() makes lance log a deprecation WARN per query.
import { logger } from "@eidolon/config";
import type { Table } from "@lancedb/lancedb";
import { errorText } from "./py.ts";
import { makeReranker, type Reranker } from "./rerank.ts";
import { tokenizeZhQuery } from "./tokenize.ts";

/** Table columns (never `vector`), plus `_relevance_score` or, for vectorSearch, `_distance`. */
export type SearchRow = Record<string, unknown>;

export const RRF_K = 60;

const VECTOR_COLUMN = "vector";

export interface HybridSearchOptions {
  vector: readonly number[] | Float32Array;
  /** The raw user text; the FTS leg tokenizes it. */
  queryText: string;
  /** Rows fetched per leg before fusion. More recall costs more reranker tokens. */
  candidates: number;
  /** A SQL prefilter for both legs; post-filtering silently returns fewer than top-k. */
  where?: string | null;
  /** Rows returned, capped at `candidates`. */
  finalK?: number | null;
  rerank?: boolean;
  /** Overrides makeReranker(), so a benchmark can compare models without the process cache. */
  reranker?: Reranker | null;
  ftsField?: string;
  signal?: AbortSignal;
}

const columnCache = new WeakMap<Table, Promise<string[]>>();

function rowColumns(table: Table): Promise<string[]> {
  let columns = columnCache.get(table);
  if (columns === undefined) {
    columns = table
      .schema()
      .then((schema) => schema.fields.map((f) => f.name).filter((n) => n !== VECTOR_COLUMN));
    columnCache.set(table, columns);
    columns.catch(() => columnCache.delete(table));
  }
  return columns;
}

function plainRows(rows: readonly unknown[]): SearchRow[] {
  return rows.map((row) => ({ ...(row as SearchRow) }));
}

/** Rejects with `signal.reason` on abort; LanceDB can't cancel, so the query runs on unread. */
function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolveWork, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolveWork(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// Python LanceDB treats limit <= 0 as unset, which leaves each leg at its default of 10 rows.
function limited<Q extends { limit(n: number): Q }>(query: Q, candidates: number): Q {
  return candidates > 0 ? query.limit(candidates) : query;
}

async function runLegs(
  table: Table,
  vector: readonly number[] | Float32Array,
  tokens: string,
  candidates: number,
  where: string | null,
  ftsField: string,
): Promise<[SearchRow[], SearchRow[]]> {
  const columns = await rowColumns(table);
  let vectorQuery = limited(
    table
      .query()
      .nearestTo(vector as number[])
      .select([...columns, "_distance"])
      .withRowId(),
    candidates,
  );
  let ftsQuery = limited(
    table
      .query()
      .fullTextSearch(tokens, { columns: ftsField })
      .select([...columns, "_score"])
      .withRowId(),
    candidates,
  );
  if (where) {
    vectorQuery = vectorQuery.where(where);
    ftsQuery = ftsQuery.where(where);
  }
  const [vectorRows, ftsRows] = await Promise.all([vectorQuery.toArray(), ftsQuery.toArray()]);
  return [plainRows(vectorRows), plainRows(ftsRows)];
}

/** Vector rows, then FTS rows not already seen, deduplicated by `_rowid`. */
function mergeLegs(vectorRows: readonly SearchRow[], ftsRows: readonly SearchRow[]): SearchRow[] {
  const seen = new Set<unknown>();
  const merged: SearchRow[] = [];
  for (const row of [...vectorRows, ...ftsRows]) {
    if (seen.has(row._rowid)) continue;
    seen.add(row._rowid);
    merged.push(row);
  }
  return merged;
}

function scored(row: SearchRow, score: number | null): SearchRow {
  const { _distance, _score, _rowid, ...columns } = row;
  return { ...columns, _relevance_score: score };
}

/**
 * Python LanceDB's `RRFReranker(K=60)`: ranks count from 1, the vector leg accumulates first,
 * merged rows keep their first (vector-leg) occurrence, and a stable sort orders them by the
 * float32 score. Rows need `_rowid`.
 */
export function rrfFuse(
  vectorRows: readonly SearchRow[],
  ftsRows: readonly SearchRow[],
  k: number = RRF_K,
): SearchRow[] {
  const scores = new Map<unknown, number>();
  for (const rows of [vectorRows, ftsRows]) {
    rows.forEach((row, i) => {
      scores.set(row._rowid, (scores.get(row._rowid) ?? 0) + 1 / (i + 1 + k));
    });
  }
  return mergeLegs(vectorRows, ftsRows)
    .map((row) => ({ row, score: Math.fround(scores.get(row._rowid) ?? 0) }))
    .sort((a, b) => b.score - a.score)
    .map(({ row, score }) => scored(row, score));
}

/** Python's `results.slice(0, limit)[:final_k]`, where a limit <= 0 is no limit. */
function window(rows: SearchRow[], candidates: number, finalK: number): SearchRow[] {
  return (candidates > 0 ? rows.slice(0, candidates) : rows).slice(0, finalK);
}

/**
 * Vector + FTS over the `tokens` column, fused by the reranker when one is active and by RRF
 * otherwise or when the rerank fails. Rows come best first and omit `vector`.
 */
export async function hybridSearch(
  table: Table,
  options: HybridSearchOptions,
): Promise<SearchRow[]> {
  const { vector, queryText, candidates, signal } = options;
  const finalK =
    options.finalK === undefined || options.finalK === null || options.finalK > candidates
      ? candidates
      : options.finalK;
  const tokens = tokenizeZhQuery(queryText) || queryText;
  const reranker = (options.rerank ?? true) ? (options.reranker ?? makeReranker()) : null;
  if (!tokens) throw new Error("Text query must be provided for hybrid search.");
  signal?.throwIfAborted();
  const [vectorRows, ftsRows] = await raceAbort(
    runLegs(table, vector, tokens, candidates, options.where || null, options.ftsField ?? "tokens"),
    signal,
  );
  if (vectorRows.length === 0 && ftsRows.length === 0) return [];
  if (reranker !== null) {
    // The reranker is an optional tier, so a Cohere outage or a rejected
    // key must not take retrieval down with it: fall back to the same RRF
    // fusion we'd run with no reranker at all.
    try {
      const merged = mergeLegs(vectorRows, ftsRows);
      // The query is the jieba token string, as Python sent it; documents are the raw column.
      const results = await reranker.rerank(
        tokens,
        merged.map((row) => row[reranker.column] ?? null),
        signal ? { signal } : {},
      );
      const rows = results.map(({ index, relevanceScore }) => {
        const row = merged[index];
        if (row === undefined) throw new RangeError(`Index ${index} out of bounds`);
        return scored(row, relevanceScore === null ? null : Math.fround(relevanceScore));
      });
      return window(rows, candidates, finalK);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      logger.warning(`Rerank failed (${errorText(error)}); falling back to RRF fusion`);
    }
  }
  return window(rrfFuse(vectorRows, ftsRows), candidates, finalK);
}

/** Vector-only KNN with `_distance`, as the eval's vector_only mode runs it. */
export async function vectorSearch(
  table: Table,
  options: { vector: readonly number[] | Float32Array; limit: number; where?: string | null },
): Promise<SearchRow[]> {
  if (options.limit <= 0) throw new Error("Limit is required for ANN/KNN queries");
  const columns = await rowColumns(table);
  let query = table
    .query()
    .nearestTo(options.vector as number[])
    .select([...columns, "_distance"])
    .limit(options.limit);
  if (options.where) query = query.where(options.where);
  return plainRows(await query.toArray());
}

/**
 * The hit's score whichever path produced it: `_relevance_score` (higher is better) on hybrid
 * hits, `_distance` (lower is better) on vector-only ones, so it compares only within one result
 * set. 0 is a real score.
 */
export function scoreOf(hit: SearchRow): number | null {
  if (hit._relevance_score !== null && hit._relevance_score !== undefined) {
    return Number(hit._relevance_score);
  }
  if (hit._distance !== null && hit._distance !== undefined) return Number(hit._distance);
  return null;
}
