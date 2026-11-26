// Vector + FTS hybrid search over one Zvec table. The vector and BM25 legs run concurrently and
// fuse through RRF(K=60) in float32 unless a cross-encoder reranker is active.
import { errorText, logger, raceAbort } from "@eidolon/config";
import type { RerankModel } from "@eidolon/providers";
import { ZVecIndexType } from "@zvec/zvec";
import { makeReranker } from "./rerank.ts";
import { materializeRow, type ZvecTable } from "./tables.ts";
import { tokenizeZhQuery } from "./tokenize.ts";

/** Table columns (never `vector`), plus `_relevance_score` or, for vectorSearch, `_distance`. */
export type SearchRow = Record<string, unknown>;

export const RRF_K = 60;

const VECTOR_COLUMN = "vector";
const MIN_HNSW_EF = 128;

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
  /** Overrides makeReranker(), so a benchmark can compare models. */
  reranker?: RerankModel | null;
  ftsField?: string;
  signal?: AbortSignal;
}

function asFloat32(vector: readonly number[] | Float32Array): Float32Array {
  return vector instanceof Float32Array ? vector : Float32Array.from(vector);
}

async function runLegs(
  table: ZvecTable,
  vector: readonly number[] | Float32Array,
  tokens: string,
  candidates: number,
  where: string | null,
  ftsField: string,
): Promise<[SearchRow[], SearchRow[]]> {
  if (candidates <= 0) return [[], []];
  const outputFields = [...table.columnNames];
  const filter = where ? { filter: where } : {};
  const [vectorDocs, ftsDocs] = await Promise.all([
    table.collection.query({
      fieldName: VECTOR_COLUMN,
      vector: asFloat32(vector),
      topk: candidates,
      params: { indexType: ZVecIndexType.HNSW, ef: Math.max(candidates * 4, MIN_HNSW_EF) },
      outputFields,
      ...filter,
    }),
    table.collection.query({
      fieldName: ftsField,
      fts: { matchString: tokens },
      topk: candidates,
      outputFields,
      ...filter,
    }),
  ]);
  const vectorRows = vectorDocs.map((doc) => {
    const row = materializeRow(table.columnNames, doc);
    row._distance = doc.score;
    row._rowid = doc.id;
    return row;
  });
  const ftsRows = ftsDocs.map((doc) => {
    const row = materializeRow(table.columnNames, doc);
    row._score = doc.score;
    row._rowid = doc.id;
    return row;
  });
  return [vectorRows, ftsRows];
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
 * Reciprocal rank fusion (`K=60`): ranks count from 1, the vector leg accumulates first, merged
 * rows keep their first (vector-leg) occurrence, and a stable sort orders them by the float32
 * score. Rows need `_rowid`.
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

/** The first `candidates` rows, or all of them when it is <= 0, then the first `finalK`. */
function window(rows: SearchRow[], candidates: number, finalK: number): SearchRow[] {
  return (candidates > 0 ? rows.slice(0, candidates) : rows).slice(0, finalK);
}

/**
 * Vector + FTS over the `tokens` column, fused by the reranker when one is active and by RRF
 * otherwise or when the rerank fails. Rows come best first and omit `vector`.
 */
export async function hybridSearch(
  table: ZvecTable,
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
  if (candidates <= 0 || finalK <= 0) return [];
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
      // The query is the jieba token string; documents are the raw text column.
      const results = await reranker.rerank(
        tokens,
        merged.map((row) => row.text ?? null),
        signal,
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
  table: ZvecTable,
  options: { vector: readonly number[] | Float32Array; limit: number; where?: string | null },
): Promise<SearchRow[]> {
  if (options.limit <= 0) throw new Error("Limit is required for ANN/KNN queries");
  const docs = await table.collection.query({
    fieldName: VECTOR_COLUMN,
    vector: asFloat32(options.vector),
    topk: options.limit,
    params: { indexType: ZVecIndexType.HNSW, ef: Math.max(options.limit * 4, MIN_HNSW_EF) },
    outputFields: [...table.columnNames],
    ...(options.where ? { filter: options.where } : {}),
  });
  return docs.map((doc) => {
    const row = materializeRow(table.columnNames, doc);
    row._distance = doc.score;
    return row;
  });
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
