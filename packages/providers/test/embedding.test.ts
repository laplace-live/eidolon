import { join } from "node:path";
import {
  consoleSink,
  DEFAULT_EMBED_MODEL,
  type LogRecord,
  logger,
  openrouterHeaders,
  spawnProcess,
} from "@eidolon/config";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EmbeddingClient, EmbeddingUsage, isQuotaError } from "../src/embedding/openai.ts";
import {
  embeddingModel,
  missingKey,
  reportEmbedding,
  select,
  setUsageSink,
  type UsageRecord,
} from "../src/index.ts";

const records: LogRecord[] = [];
beforeEach(() => {
  records.length = 0;
  logger.setSink((record) => records.push(record));
});
afterEach(() => {
  logger.setSink(consoleSink);
});

const warnings = () => records.filter((r) => r.level === "WARNING").map((r) => r.message);

const reader =
  (values: Readonly<Record<string, string>>) =>
  (name: string): string | undefined =>
    values[name] || undefined;

/** A fetch that answers from `replies` in order and records every request. */
function fakeFetch(
  replies: ReadonlyArray<Response | ((init: RequestInit) => Response | Promise<Response>)>,
): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...replies];
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (next === undefined) throw new Error("fakeFetch: no reply left");
    return typeof next === "function" ? next(init) : next;
  };
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

const R = 0.5;
const vectors = (...rows: number[][]) => ({
  data: rows.map((embedding, index) => ({ embedding, index, object: "embedding" })),
  model: "m",
  object: "list",
  usage: { prompt_tokens: 7, total_tokens: 7 },
});

function client(
  replies: Parameters<typeof fakeFetch>[0],
  baseUrl = "https://openrouter.ai/api/v1",
) {
  const { fetch, calls } = fakeFetch(replies);
  const sleeps: number[] = [];
  const embeddings = new EmbeddingClient({
    baseUrl,
    apiKey: "sk-test",
    headers: { "X-Title": "LAPLACE Live!" },
    fetch,
    sleep: async (seconds) => {
      sleeps.push(seconds);
    },
    random: () => R,
  });
  return { embeddings, calls, sleeps };
}

const opts = { model: "google/gemini-embedding-2-preview", dimensions: 3072 };

describe("EmbeddingClient", () => {
  test("posts the float body to {base}/embeddings", async () => {
    for (const base of ["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1/"]) {
      const { embeddings, calls } = client([Response.json(vectors([1, 2]))], base);
      const [out] = await embeddings.embedWithUsage(["坚果"], opts);
      expect(out).toEqual([[1, 2]]);
      expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/embeddings");
      expect(calls[0]?.init.headers).toEqual({
        "X-Title": "LAPLACE Live!",
        Authorization: "Bearer sk-test",
        "Content-Type": "application/json",
      });
      expect(calls[0]?.init.body).toBe(
        JSON.stringify({
          input: ["坚果"],
          model: "google/gemini-embedding-2-preview",
          dimensions: 3072,
          encoding_format: "float",
          usage: { include: true },
        }),
      );
    }
  });

  test("vectors come back in input order, by each one's index", async () => {
    const body = vectors([1], [2], [3]);
    body.data.reverse();
    const { embeddings } = client([Response.json(body)]);
    expect((await embeddings.embedWithUsage(["a", "b", "c"], opts))[0]).toEqual([[1], [2], [3]]);
  });

  test("an item without a vector fails the call", async () => {
    const body = vectors([1], [2]);
    delete (body.data[1] as { embedding?: number[] }).embedding;
    const { embeddings } = client([Response.json(body)]);
    await expect(embeddings.embedWithUsage(["a", "b"], opts)).rejects.toThrow(
      "an embedding in the response has no vector",
    );
  });

  test("empty input makes no request", async () => {
    const { embeddings, calls } = client([]);
    expect(await embeddings.embedWithUsage([], opts)).toEqual([[], new EmbeddingUsage()]);
    expect(calls.length).toBe(0);
  });

  test("a sustained 200 quota error waits out ten 60 s windows, then gives up", async () => {
    const quota = () => Response.json({ error: { message: "Rate limit exceeded: 429" } });
    const { embeddings, calls, sleeps } = client(Array.from({ length: 11 }, quota));
    const error = await embeddings.embedWithUsage(["a"], opts).catch((e: Error) => e);
    expect(calls.length).toBe(11);
    expect(sleeps).toEqual(Array(10).fill(60 + 10 * R));
    expect((error as Error).message).toBe(
      "Embedding provider returned no data after 11 attempts (0 data, 11 quota). " +
        "Last error: Rate limit exceeded: 429" +
        "\n  Sustained quota error — options:" +
        "\n    - Wait and re-run (cached batches will be skipped)" +
        "\n    - Switch to a less rate-limited model: set EMBED_MODEL=openai/text-embedding-3-large (also 3072-dim)" +
        "\n    - Submit a quota increase with the upstream provider",
    );
    expect(warnings()[0]).toBe(
      "Embedding quota retry 1/10 got no data (Rate limit exceeded: 429). Retrying in 65.0s...",
    );
  });

  test("data failures back off exponentially, five times", async () => {
    const { embeddings, sleeps } = client(Array.from({ length: 6 }, () => Response.json({})));
    await expect(embeddings.embedWithUsage(["a"], opts)).rejects.toThrow(
      "Embedding provider returned no data after 6 attempts (6 data, 0 quota). " +
        "Last error: provider returned no embedding data",
    );
    expect(sleeps).toEqual([1 + R, 2 + R, 4 + R, 8 + R, 16 + R]);
    expect(warnings()[0]).toBe(
      "Embedding retry 1/5 got no data (provider returned no embedding data). Retrying in 1.5s...",
    );
  });

  test("an error without a message reports the dict, collapsed onto one line", async () => {
    const { embeddings } = client([
      Response.json({ error: { code: 503 } }),
      Response.json({ error: { message: "multi\n   line\terror" } }),
      Response.json(vectors([3])),
    ]);
    expect((await embeddings.embedWithUsage(["a"], opts))[0]).toEqual([[3]]);
    expect(warnings()).toEqual([
      "Embedding retry 1/5 got no data ({'code': 503}). Retrying in 1.5s...",
      "Embedding retry 2/5 got no data (multi line error). Retrying in 2.5s...",
    ]);
  });

  test("429 and 5xx are retried with the SDK's backoff and Retry-After", async () => {
    const { embeddings, calls, sleeps } = client([
      new Response("", { status: 429 }),
      new Response("", { status: 503 }),
      new Response("", { status: 429, headers: { "retry-after-ms": "250" } }),
      new Response("", { status: 429, headers: { "retry-after": "3" } }),
      Response.json(vectors([4])),
    ]);
    expect((await embeddings.embedWithUsage(["a"], opts))[0]).toEqual([[4]]);
    expect(calls.length).toBe(5);
    expect(sleeps).toEqual([0.5 * (1 - 0.25 * R), 1 * (1 - 0.25 * R), 0.25, 3]);
  });

  test("the SDK's retry budget is five", async () => {
    const { embeddings, calls } = client(
      Array.from({ length: 6 }, () => Response.json({ error: { message: "x" } }, { status: 500 })),
    );
    await expect(embeddings.embedWithUsage(["a"], opts)).rejects.toThrow(
      "Error code: 500 - {'error': {'message': 'x'}}",
    );
    expect(calls.length).toBe(6);
  });

  test("no retry on 400, x-should-retry: false, or a Retry-After over 120 s", async () => {
    for (const reply of [
      new Response("bad request", { status: 400 }),
      new Response("", { status: 503, headers: { "x-should-retry": "false" } }),
      new Response("", { status: 429, headers: { "retry-after": "121" } }),
    ]) {
      const { embeddings, calls } = client([reply]);
      await expect(embeddings.embedWithUsage(["a"], opts)).rejects.toThrow("");
      expect(calls.length).toBe(1);
    }
  });

  test("connection errors are retried, then reported as the SDK's", async () => {
    const down = () => Promise.reject(new TypeError("fetch failed"));
    const { embeddings, sleeps } = client(Array.from({ length: 6 }, () => down));
    await expect(embeddings.embedWithUsage(["a"], opts)).rejects.toThrow("Connection error.");
    expect(sleeps.length).toBe(5);
  });

  test("a body that fails mid-read is retried, an error status's included", async () => {
    const reset = (status: number) => () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("socket reset"));
          },
        }),
        { status },
      );
    const { embeddings, calls } = client([reset(200), reset(503), Response.json(vectors([1]))]);
    const [out] = await embeddings.embedWithUsage(["a"], opts);
    expect(out).toEqual([[1]]);
    expect(calls.length).toBe(3);
  });

  test("an abort rejects with the signal's reason, even mid-backoff", async () => {
    const controller = new AbortController();
    const reason = new Error("interrupted");
    const embeddings = new EmbeddingClient({
      baseUrl: "https://x/v1",
      apiKey: "k",
      fetch: fakeFetch([Response.json({})]).fetch,
      sleep: () => {
        controller.abort(reason);
        return new Promise(() => {});
      },
    });
    await expect(
      embeddings.embedWithUsage(["a"], { ...opts, signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  test("a cancel during the default backoff clears its timer, so the process exits at once", async () => {
    const module = join(import.meta.dirname, "../src/embedding/openai.ts");
    const child = spawnProcess(
      [
        process.execPath,
        "-e",
        `const { EmbeddingClient } = await import(${JSON.stringify(module)});
         const controller = new AbortController();
         const client = new EmbeddingClient({
           baseUrl: "https://example.test/v1",
           apiKey: "k",
           fetch: async () => {
             setTimeout(() => controller.abort(new Error("cancelled")), 20);
             return Response.json({ error: { message: "Rate limit exceeded: 429" } });
           },
         });
         await client
           .embedWithUsage(["a"], { model: "m", dimensions: 1, signal: controller.signal })
           .catch((error) => console.log(error.message));`,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    try {
      const started = performance.now();
      expect(await child.exited).toBe(0);
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(await new Response(child.stdout).text()).toBe("cancelled\n");
    } finally {
      child.kill("SIGKILL");
    }
  }, 90_000);

  test("usage: reported cost, BYOK estimate, unknown", async () => {
    const usage = async (model: string, block: unknown) => {
      const { embeddings } = client([Response.json({ data: [{ embedding: [1] }], usage: block })]);
      return (await embeddings.embedWithUsage(["a"], { model, dimensions: 8 }))[1];
    };
    expect(await usage("any", { prompt_tokens: 5, total_tokens: 6, cost: 0.0001 })).toEqual(
      new EmbeddingUsage({
        promptTokens: 5,
        totalTokens: 6,
        costUsd: 0.0001,
        costSource: "openrouter",
      }),
    );
    expect(
      await usage(DEFAULT_EMBED_MODEL, { prompt_tokens: 1000, total_tokens: 1000, cost: 0 }),
    ).toEqual(
      new EmbeddingUsage({
        promptTokens: 1000,
        totalTokens: 1000,
        costUsd: (1000 * 0.15) / 1_000_000,
        costSource: "estimate",
      }),
    );
    expect(await usage("unpriced/model", { prompt_tokens: 3, cost: 0 })).toEqual(
      new EmbeddingUsage({ promptTokens: 3, totalTokens: 3 }),
    );
    expect(await usage(DEFAULT_EMBED_MODEL, null)).toEqual(new EmbeddingUsage());
  });

  test("the catalog estimates what the old price table did, to the bit", async () => {
    const usd = async (model: string) => {
      const { embeddings } = client([
        Response.json({ data: [{ embedding: [1] }], usage: { total_tokens: 123_457, cost: 0 } }),
      ]);
      return (await embeddings.embedWithUsage(["a"], { model, dimensions: 8 }))[1].costUsd;
    };
    for (const [model, perMillion] of [
      ["google/gemini-embedding-2-preview", 0.15],
      ["~google/gemini-embedding-2-preview", 0.15],
      ["openai/text-embedding-3-small", 0.02],
      ["openai/text-embedding-3-large", 0.13],
    ] as const) {
      expect([model, await usd(model)]).toEqual([model, (123_457 * perMillion) / 1_000_000]);
    }
  });

  test("a caller's budgets replace the ingest's, one by one", async () => {
    const once = (reply: Response, retries: object) => {
      const { fetch, calls } = fakeFetch([reply]);
      const embeddings = new EmbeddingClient({
        baseUrl: "https://x/v1",
        apiKey: "k",
        fetch,
        retries,
      });
      return { run: embeddings.embedWithUsage(["a"], opts), calls };
    };
    const empty = once(Response.json({}), { empty: 0 });
    await expect(empty.run).rejects.toThrow("after 1 attempts (1 data, 0 quota)");
    const quota = once(Response.json({ error: { message: "RESOURCE_EXHAUSTED" } }), { quota: 0 });
    await expect(quota.run).rejects.toThrow(
      /after 1 attempts \(0 data, 1 quota\)\. Last error: RESOURCE_EXHAUSTED$/,
    );
    const down = once(Response.json({ error: { message: "x" } }, { status: 503 }), { http: 0 });
    await expect(down.run).rejects.toThrow("Error code: 503");
    expect([empty.calls.length, quota.calls.length, down.calls.length]).toEqual([1, 1, 1]);
    expect(warnings()).toEqual([]);
  });
});

describe("EmbeddingUsage.add", () => {
  test.each([
    ["unknown", "openrouter", "openrouter"],
    ["unknown", "unknown", "unknown"],
    ["openrouter", "estimate", "mixed"],
    ["mixed", "openrouter", "mixed"],
    ["openrouter", "unknown", "openrouter"],
    ["estimate", "estimate", "estimate"],
  ] as const)("%s + %s = %s", (a, b, expected) => {
    const total = new EmbeddingUsage({
      promptTokens: 1,
      totalTokens: 2,
      costUsd: 0.5,
      costSource: a,
    });
    total.add(
      new EmbeddingUsage({ promptTokens: 3, totalTokens: 4, costUsd: 0.25, costSource: b }),
    );
    expect(total).toEqual(
      new EmbeddingUsage({ promptTokens: 4, totalTokens: 6, costUsd: 0.75, costSource: expected }),
    );
  });
});

test("isQuotaError", () => {
  expect(
    ["429", "RESOURCE_EXHAUSTED", "Quota exceeded", "rate limit", "Rate-Limit"].map(isQuotaError),
  ).toEqual([true, true, true, true, true]);
  expect(isQuotaError("")).toBe(false);
  expect(isQuotaError("upstream 503")).toBe(false);
});

describe("embedding models", () => {
  const embeddings = (values: Readonly<Record<string, string>>) => {
    const selection = select("embeddings", reader(values));
    if (selection === null) throw new Error("the embeddings role is on by default");
    return selection;
  };

  async function sent(values: Readonly<Record<string, string>>) {
    const { fetch, calls } = fakeFetch([Response.json(vectors([1, 2]))]);
    const model = embeddingModel(embeddings(values), { fetch });
    const [out] = await model.embed(["坚果"], 2);
    expect(out).toEqual([[1, 2]]);
    const call = calls[0] as { url: string; init: RequestInit };
    return {
      provider: model.provider,
      model: model.model,
      url: call.url,
      headers: call.init.headers,
      body: JSON.parse(String(call.init.body)),
    };
  }

  test("the role's OpenRouter account asks for each request's cost and attributes it", async () => {
    expect(await sent({ OPENROUTER_API_KEY: "or" })).toEqual({
      provider: "openrouter",
      model: DEFAULT_EMBED_MODEL,
      url: "https://openrouter.ai/api/v1/embeddings",
      headers: {
        ...openrouterHeaders(),
        Authorization: "Bearer or",
        "Content-Type": "application/json",
      },
      body: {
        input: ["坚果"],
        model: DEFAULT_EMBED_MODEL,
        dimensions: 2,
        encoding_format: "float",
        usage: { include: true },
      },
    });
  });

  test("OpenAI's, Gemini's and a compatible server's take OpenAI's body alone", async () => {
    const plain = (key: string, url: string, model: string) => ({
      url,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: { input: ["坚果"], model, dimensions: 2, encoding_format: "float" },
    });
    expect(await sent({ EMBED_PROVIDER: "openai", OPENAI_API_KEY: "oa" })).toEqual({
      provider: "openai",
      model: "text-embedding-3-large",
      ...plain("oa", "https://api.openai.com/v1/embeddings", "text-embedding-3-large"),
    });
    expect(await sent({ EMBED_PROVIDER: "google", GEMINI_API_KEY: "gm" })).toEqual({
      provider: "google",
      model: "gemini-embedding-2",
      ...plain(
        "gm",
        "https://generativelanguage.googleapis.com/v1beta/openai/embeddings",
        "gemini-embedding-2",
      ),
    });
    const own = await sent({
      EMBED_PROVIDER: "openai-compatible",
      EMBED_MODEL: "bge-m3",
      OPENAI_COMPATIBLE_BASE_URL: "http://localhost:8080/v1",
    });
    expect(own).toEqual({
      provider: "openai-compatible",
      model: "bge-m3",
      ...plain("", "http://localhost:8080/v1/embeddings", "bge-m3"),
    });
  });

  test("an OpenRouter account at another provider's API is that provider's spend", async () => {
    const model = embeddingModel(
      embeddings({ EMBED_API_KEY: "sk-oa", EMBED_BASE_URL: "https://api.openai.com/v1" }),
    );
    expect([model.provider, model.model]).toEqual(["openai", DEFAULT_EMBED_MODEL]);
  });

  test("a role without its key asks nothing", () => {
    const keyless = embeddings({});
    expect(() => embeddingModel(keyless)).toThrow(missingKey(keyless).message);
  });

  test("reportEmbedding: a reported cost, an estimate, or the catalog's price", () => {
    const records: UsageRecord[] = [];
    setUsageSink((record) => records.push(record));
    try {
      const model = { provider: "openrouter", model: DEFAULT_EMBED_MODEL };
      const report = (usage: EmbeddingUsage) =>
        reportEmbedding({ ...model, embed: async () => [[], usage] }, usage);
      report(new EmbeddingUsage({ totalTokens: 9, costUsd: 0.25, costSource: "openrouter" }));
      report(new EmbeddingUsage({ totalTokens: 10, costUsd: 0.5, costSource: "estimate" }));
      report(new EmbeddingUsage({ totalTokens: 1_000_000 }));
    } finally {
      setUsageSink(null);
    }
    expect(
      records.map(({ role, provider, model, units, costUsd, costSource }) => ({
        role,
        provider,
        model,
        units,
        costUsd,
        costSource,
      })),
    ).toEqual([
      {
        role: "embeddings",
        provider: "openrouter",
        model: DEFAULT_EMBED_MODEL,
        units: { inputTokens: 9 },
        costUsd: 0.25,
        costSource: "reported",
      },
      {
        role: "embeddings",
        provider: "openrouter",
        model: DEFAULT_EMBED_MODEL,
        units: { inputTokens: 10 },
        costUsd: (10 * 0.15) / 1_000_000,
        costSource: "estimated",
      },
      {
        role: "embeddings",
        provider: "openrouter",
        model: DEFAULT_EMBED_MODEL,
        units: { inputTokens: 1_000_000 },
        costUsd: 0.15,
        costSource: "estimated",
      },
    ]);
  });
});
