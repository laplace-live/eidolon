// Embeds a run's texts as Python's embed_in_batches did for both ingests: cache hits first, then
// the misses one request at a time, each batch written through to the cache, with its log lines.
import { embedDim, logger, pyFixed } from "@eidolon/config";
import type { EmbedCache } from "./embed_cache.ts";
import {
  type CostSource,
  defaultEmbeddingClient,
  type EmbeddingClient,
  EmbeddingUsage,
  embeddingSelection,
  reportEmbedding,
} from "./embeddings.ts";

// Cache hits are read a window at a time and copied straight into the result, so a whole stream
// ingest's vectors (44k rows, 545 MB at 3072 dimensions) are never held twice.
const LOOKUP_WINDOW = 4096;

export interface EmbedProgress {
  /** Cache misses embedded so far. */
  readonly done: number;
  /** Every cache miss. */
  readonly total: number;
}

export interface EmbedInBatchesOptions {
  /** Texts per request: Python sent 64 stream chunks or 96 facts. */
  readonly batchSize: number;
  /** What the log lines count: "chunks" or "facts". */
  readonly noun: string;
  readonly cache?: EmbedCache | null;
  /** EMBED_MODEL when omitted. Resolved once, so the cache key matches what the API is sent. */
  readonly model?: string;
  /** EMBED_DIM when omitted. */
  readonly dim?: number;
  /** The default client is built at the first miss, so a fully cached run needs no key. */
  readonly client?: Pick<EmbeddingClient, "embedWithUsage">;
  /** Called after each batch. */
  readonly onProgress?: (progress: EmbedProgress) => void;
  readonly signal?: AbortSignal;
}

export interface EmbedReport {
  readonly model: string;
  readonly dim: number;
  /** Text i's vector at `[i * dim, (i + 1) * dim)`, the layout writeTable takes. */
  readonly vectors: Float32Array;
  readonly cacheHits: number;
  /** Texts the provider embedded: every miss. */
  readonly embedded: number;
  readonly usage: EmbeddingUsage;
}

// BYOK runs land in "estimate": OpenRouter withholds cost on embeddings, so the estimate is the
// only sign an ingest isn't free.
function batchCost(usage: EmbeddingUsage): string {
  if (usage.costSource === "openrouter") return `, $${pyFixed(usage.costUsd, 6)}`;
  if (usage.costSource === "estimate") return `, $${pyFixed(usage.costUsd, 6)} est.`;
  return "";
}

/**
 * Every text's vector, from the cache where it has one, else from the provider in batches of
 * `batchSize`, one request at a time. Fresh vectors reach the cache after each batch, so an
 * interrupted run pays again only for the batch in flight; a vector of the wrong size throws
 * before it is cached.
 */
export async function embedInBatches(
  texts: readonly string[],
  options: EmbedInBatchesOptions,
): Promise<EmbedReport> {
  const { batchSize, noun, cache, signal } = options;
  const model = options.model ?? embeddingSelection().model;
  const dim = options.dim ?? embedDim();
  signal?.throwIfAborted();
  const vectors = new Float32Array(texts.length * dim);
  const usage = new EmbeddingUsage();

  const hit = new Uint8Array(texts.length);
  let cacheHits = 0;
  if (cache) {
    for (let start = 0; start < texts.length; start += LOOKUP_WINDOW) {
      const window = texts.slice(start, start + LOOKUP_WINDOW);
      for (const [i, vector] of cache.getMany(model, dim, window)) {
        // Python cached a provider's wrong-size vectors before its table write failed on them.
        if (vector.length !== dim) continue;
        vectors.set(vector, (start + i) * dim);
        hit[start + i] = 1;
        cacheHits++;
      }
    }
  }
  const misses: number[] = [];
  hit.forEach((h, i) => {
    if (!h) misses.push(i);
  });
  if (cacheHits > 0) {
    logger.info(
      `Cache: ${cacheHits}/${texts.length} embeddings reused, ` +
        `${misses.length} need fresh embedding`,
    );
  }
  if (misses.length === 0) {
    logger.info("All embeddings served from cache; nothing to embed.");
    return { model, dim, vectors, cacheHits, embedded: 0, usage };
  }

  const client = options.client ?? defaultEmbeddingClient();
  for (let start = 0; start < misses.length; start += batchSize) {
    signal?.throwIfAborted();
    const batch = misses.slice(start, start + batchSize);
    const [fresh, batchUsage] = await client.embedWithUsage(
      batch.map((row) => texts[row] as string),
      { model, dimensions: dim, ...(signal ? { signal } : {}) },
    );
    if (fresh.length < batch.length) {
      throw new Error(
        `Embedding provider returned ${fresh.length} vectors for ${batch.length} texts`,
      );
    }
    batch.forEach((row, j) => {
      const vector = fresh[j] as number[];
      if (vector.length !== dim) {
        throw new Error(
          `Embedding model ${model} returned ${vector.length} dimensions, not the ${dim} requested`,
        );
      }
      vectors.set(vector, row * dim);
    });
    cache?.putMany(
      model,
      dim,
      batch.map((row) => [texts[row] as string, vectors.subarray(row * dim, (row + 1) * dim)]),
    );
    usage.add(batchUsage);
    reportEmbedding(model, batchUsage);
    const done = Math.min(start + batchSize, misses.length);
    logger.info(
      `Embedded ${done}/${misses.length} ${noun} (${batchUsage.totalTokens} tokens` +
        `${batchCost(batchUsage)})`,
    );
    options.onProgress?.({ done, total: misses.length });
  }
  return { model, dim, vectors, cacheHits, embedded: misses.length, usage };
}

const TOTALS_NOTES: Partial<Record<CostSource, string>> = {
  openrouter: "",
  estimate: " (client-side estimate; BYOK on /v1/embeddings — OpenRouter withholds cost data)",
  mixed: " (mixed: some batches reported, some estimated)",
};

/** The line both ingests log once the table is written: the run's tokens and their cost. */
export function embeddingTotalsMessage(rows: number, noun: string, usage: EmbeddingUsage): string {
  const note = TOTALS_NOTES[usage.costSource];
  if (note === undefined) {
    return (
      `Embedding totals: ${rows} ${noun}, ${usage.totalTokens} tokens ` +
      "(provider did not report cost and no local price entry — " +
      "add the model to embeddings.EMBED_PRICING_USD_PER_1M to fix)"
    );
  }
  return (
    `Embedding totals: ${rows} ${noun}, ${usage.totalTokens} tokens, ` +
    `$${pyFixed(usage.costUsd, 6)} USD${note}`
  );
}
