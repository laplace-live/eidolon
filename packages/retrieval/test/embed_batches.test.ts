// The scenarios, log lines and totals are Python's embed_in_batches and main_async with the
// embedding call stubbed (write_golden.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EMBED_MODEL,
  EmbedCache,
  EmbeddingClient,
  EmbeddingUsage,
  embeddingTotalsMessage,
  embedInBatches,
} from "../src/index.ts";
import { captureLogs, fakeFetch, isolateEnv, messages } from "./helpers.ts";
import { fakeVector, GOLDEN_DIM, rowsHex, WRITE_GOLDEN } from "./write_golden.ts";

const records = captureLogs();
isolateEnv();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrieval-batches-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Call = { texts: string[]; model: string; dimensions: number; signal?: AbortSignal };

/** A client answering each request with the golden's stub vectors and the next usage. */
function stubClient(usages: EmbeddingUsage[], vector: (text: string) => number[] = fakeVector) {
  const calls: Call[] = [];
  const client = {
    async embedWithUsage(
      texts: readonly string[],
      options: { model: string; dimensions: number; signal?: AbortSignal },
    ): Promise<[number[][], EmbeddingUsage]> {
      calls.push({ texts: [...texts], ...options });
      const usage = usages.shift();
      if (usage === undefined) throw new Error("stubClient: no usage left");
      return [texts.map(vector), usage];
    },
  };
  return { client, calls };
}

const usage = (tokens = 1) => new EmbeddingUsage({ promptTokens: tokens, totalTokens: tokens });

function cached(cache: EmbedCache, texts: string[], dim: number): string[] {
  const found = cache.getMany(DEFAULT_EMBED_MODEL, dim, texts);
  return texts.map((_, i) => {
    const vector = found.get(i);
    return vector === undefined ? "" : (rowsHex(vector, dim)[0] as string);
  });
}

describe("Python's embed_in_batches", () => {
  for (const s of WRITE_GOLDEN.scenarios) {
    test(`${s.name}: the log lines, requests, vectors, usage and cache`, async () => {
      const cache = s.use_cache ? new EmbedCache(join(dir, `${s.name}.db`)) : null;
      cache?.putMany(
        DEFAULT_EMBED_MODEL,
        GOLDEN_DIM,
        s.seeded.map((i) => [s.texts[i] as string, fakeVector(s.texts[i] as string)]),
      );
      const usages = s.usages.map(
        ([promptTokens, totalTokens, costUsd, costSource]) =>
          new EmbeddingUsage({ promptTokens, totalTokens, costUsd, costSource }),
      );
      const { client, calls } = stubClient(usages);
      const report = await embedInBatches(s.texts, {
        batchSize: s.batch_size,
        noun: s.noun,
        cache,
        dim: GOLDEN_DIM,
        client,
      });
      expect(messages(records, "INFO")).toEqual(s.messages);
      expect(calls.map(({ texts, model, dimensions }) => ({ texts, model, dimensions }))).toEqual(
        s.calls,
      );
      expect(rowsHex(report.vectors, GOLDEN_DIM)).toEqual(s.vectors_f32_hex);
      const { promptTokens, totalTokens, costUsd, costSource } = report.usage;
      expect([promptTokens, totalTokens, costUsd, costSource]).toEqual(s.total);
      expect(report.model).toBe(DEFAULT_EMBED_MODEL);
      expect(report.cacheHits).toBe(s.seeded.length);
      expect(report.embedded).toBe(calls.reduce((n, call) => n + call.texts.length, 0));
      if (cache !== null) {
        expect(cache.count()).toBe(s.cache_count as number);
        const texts = Object.keys(s.cache_blobs);
        expect(cached(cache, texts, GOLDEN_DIM)).toEqual(texts.map((t) => s.cache_blobs[t] ?? ""));
        cache.close();
      }
    });
  }
});

test("each batch is one float request with the run's model and dimension", async () => {
  const body = (vectors: number[][]) =>
    Response.json({
      data: vectors.map((embedding, index) => ({ embedding, index, object: "embedding" })),
      usage: { prompt_tokens: 3, total_tokens: 3 },
    });
  const { fetch, calls } = fakeFetch([
    body([
      [1, 2],
      [3, 4],
    ]),
    body([[5, 6]]),
  ]);
  const client = new EmbeddingClient({ baseUrl: "https://example.test/v1", apiKey: "k", fetch });
  const report = await embedInBatches(["a", "b", "c"], {
    batchSize: 2,
    noun: "facts",
    model: "openai/text-embedding-3-small",
    dim: 2,
    client,
  });
  expect(calls.map((c) => JSON.parse(String(c.init.body)))).toEqual([
    {
      input: ["a", "b"],
      model: "openai/text-embedding-3-small",
      dimensions: 2,
      encoding_format: "float",
      usage: { include: true },
    },
    {
      input: ["c"],
      model: "openai/text-embedding-3-small",
      dimensions: 2,
      encoding_format: "float",
      usage: { include: true },
    },
  ]);
  expect(Array.from(report.vectors)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(messages(records, "INFO")).toEqual([
    "Embedded 2/3 facts (3 tokens, $0.000000 est.)",
    "Embedded 3/3 facts (3 tokens, $0.000000 est.)",
  ]);
});

test("EMBED_MODEL and EMBED_DIM fill in for omitted options, blank as unset", async () => {
  process.env.EMBED_MODEL = "";
  process.env.EMBED_DIM = "2";
  const cache = new EmbedCache(join(dir, "embed_cache.db"));
  cache.putMany(DEFAULT_EMBED_MODEL, 2, [["a", [1, 2]]]);
  const { client, calls } = stubClient([usage()], () => [3, 4]);
  const report = await embedInBatches(["a", "b"], { batchSize: 64, noun: "chunks", cache, client });
  expect([report.model, report.dim]).toEqual([DEFAULT_EMBED_MODEL, 2]);
  expect(calls.map((c) => [c.model, c.dimensions])).toEqual([[DEFAULT_EMBED_MODEL, 2]]);
  expect(Array.from(report.vectors)).toEqual([1, 2, 3, 4]);
  process.env.EMBED_MODEL = "openai/text-embedding-3-large";
  const other = await embedInBatches(["a"], {
    batchSize: 64,
    noun: "chunks",
    cache,
    client: stubClient([usage()], () => [5, 6]).client,
  });
  expect([other.model, other.cacheHits]).toEqual(["openai/text-embedding-3-large", 0]);
  cache.close();
});

test("a fully cached run needs no key; a miss without one fails as Python did", async () => {
  const cache = new EmbedCache(join(dir, "embed_cache.db"));
  cache.putMany(DEFAULT_EMBED_MODEL, 2, [["a", [1, 2]]]);
  const report = await embedInBatches(["a"], { batchSize: 64, noun: "chunks", cache, dim: 2 });
  expect(report.cacheHits).toBe(1);
  await expect(
    embedInBatches(["a", "b"], { batchSize: 64, noun: "chunks", cache, dim: 2 }),
  ).rejects.toThrow(
    "OpenRouter needs an API key: set OPENROUTER_API_KEY in credentials.json or the " +
      "environment, or EMBED_API_KEY for embeddings alone",
  );
  cache.close();
});

test("reports progress after each batch", async () => {
  const progress: unknown[] = [];
  await embedInBatches(["a", "b", "c", "d", "e"], {
    batchSize: 2,
    noun: "chunks",
    dim: 4,
    client: stubClient([usage(), usage(), usage()]).client,
    onProgress: (p) => progress.push(p),
  });
  expect(progress).toEqual([
    { done: 2, total: 5 },
    { done: 4, total: 5 },
    { done: 5, total: 5 },
  ]);
});

describe("cancellation", () => {
  test("no batch starts once the signal aborts, and the finished ones stay cached", async () => {
    const cache = new EmbedCache(join(dir, "embed_cache.db"));
    const controller = new AbortController();
    const { client, calls } = stubClient([usage(), usage()]);
    const run = embedInBatches(["a", "b", "c"], {
      batchSize: 2,
      noun: "chunks",
      cache,
      dim: 4,
      client,
      signal: controller.signal,
      onProgress: () => controller.abort(new DOMException("stop", "AbortError")),
    });
    await expect(run).rejects.toThrow("stop");
    expect(calls.map((c) => c.texts)).toEqual([["a", "b"]]);
    expect(cache.getMany(DEFAULT_EMBED_MODEL, 4, ["a", "b", "c"]).size).toBe(2);
    cache.close();
  });

  test("the request in flight gets the signal, and its batch is not cached", async () => {
    const cache = new EmbedCache(join(dir, "embed_cache.db"));
    const controller = new AbortController();
    const { fetch } = fakeFetch([
      (init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          controller.abort(new DOMException("stop", "AbortError"));
        }),
    ]);
    const client = new EmbeddingClient({ baseUrl: "https://example.test/v1", apiKey: "k", fetch });
    const run = embedInBatches(["a"], {
      batchSize: 64,
      noun: "chunks",
      cache,
      dim: 2,
      client,
      signal: controller.signal,
    });
    await expect(run).rejects.toThrow("stop");
    expect(cache.count()).toBe(0);
    cache.close();
  });

  test("an aborted signal stops the run before the cache is read", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("stop", "AbortError"));
    const run = embedInBatches(["a"], {
      batchSize: 64,
      noun: "chunks",
      dim: 2,
      client: stubClient([]).client,
      signal: controller.signal,
    });
    await expect(run).rejects.toThrow("stop");
  });
});

describe("vectors the table can't take", () => {
  test("a short response throws before any of its batch is cached", async () => {
    const cache = new EmbedCache(join(dir, "embed_cache.db"));
    const client = {
      embedWithUsage: async (): Promise<[number[][], EmbeddingUsage]> => [[[1, 2]], usage()],
    };
    const run = embedInBatches(["a", "b"], {
      batchSize: 64,
      noun: "chunks",
      cache,
      dim: 2,
      client,
    });
    await expect(run).rejects.toThrow("Embedding provider returned 1 vectors for 2 texts");
    expect(cache.count()).toBe(0);
    cache.close();
  });

  test("a vector of another size throws and is never cached", async () => {
    const cache = new EmbedCache(join(dir, "embed_cache.db"));
    const { client } = stubClient([usage()], () => [1, 2, 3]);
    const run = embedInBatches(["a"], { batchSize: 64, noun: "chunks", cache, dim: 2, client });
    await expect(run).rejects.toThrow(
      `Embedding model ${DEFAULT_EMBED_MODEL} returned 3 dimensions, not the 2 requested`,
    );
    expect(cache.count()).toBe(0);
    cache.close();
  });

  test("a cached vector of another size is embedded again and replaced", async () => {
    const cache = new EmbedCache(join(dir, "embed_cache.db"));
    cache.putMany(DEFAULT_EMBED_MODEL, 2, [["a", [1, 2, 3]]]);
    const { client, calls } = stubClient([usage()], () => [4, 5]);
    const report = await embedInBatches(["a"], {
      batchSize: 64,
      noun: "chunks",
      cache,
      dim: 2,
      client,
    });
    expect([report.cacheHits, report.embedded, calls.length]).toEqual([0, 1, 1]);
    expect(cache.getMany(DEFAULT_EMBED_MODEL, 2, ["a"]).get(0)).toEqual(new Float32Array([4, 5]));
    cache.close();
  });
});

test("embeddingTotalsMessage is the line Python's ingests logged after writing", () => {
  const sources = {
    openrouter: new EmbeddingUsage({
      totalTokens: 11,
      costUsd: 0.0000123,
      costSource: "openrouter",
    }),
    estimate: new EmbeddingUsage({
      totalTokens: 12,
      costUsd: (12 * 0.15) / 1e6,
      costSource: "estimate",
    }),
    mixed: new EmbeddingUsage({ totalTokens: 13, costUsd: 0.000002, costSource: "mixed" }),
    unknown: new EmbeddingUsage({ totalTokens: 14 }),
  };
  for (const noun of ["chunks", "facts"]) {
    for (const [source, u] of Object.entries(sources)) {
      expect(embeddingTotalsMessage(2, noun, u)).toBe(
        WRITE_GOLDEN.totals[`${noun}/${source}`] as string,
      );
    }
  }
});
