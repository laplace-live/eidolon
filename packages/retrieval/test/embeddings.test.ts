import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EMBED_MODEL,
  defaultEmbeddingClient,
  EmbeddingClient,
  EmbeddingUsage,
  embedTexts,
  embedTextsWithUsage,
  isQuotaError,
} from "../src/index.ts";
import { captureLogs, fakeFetch, isolateEnv, messages } from "./helpers.ts";

const records = captureLogs();
const env = isolateEnv();

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

  test("vectors keep response order, whatever their index", async () => {
    const body = vectors([1], [2]);
    body.data.reverse();
    const { embeddings } = client([Response.json(body)]);
    expect((await embeddings.embedWithUsage(["a", "b"], opts))[0]).toEqual([[2], [1]]);
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
    expect(messages(records, "WARNING")[0]).toBe(
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
    expect(messages(records, "WARNING")[0]).toBe(
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
    expect(messages(records, "WARNING")).toEqual([
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

describe("default client from env", () => {
  test("without a key, every call throws and nothing is cached", async () => {
    const message =
      "Embeddings need an API key. Set OPENROUTER_API_KEY (reused from the LLM config) or EMBED_API_KEY for a different provider.";
    expect(() => defaultEmbeddingClient()).toThrow(message);
    await expect(embedTexts(["a"])).rejects.toThrow(message);
    process.env.OPENROUTER_API_KEY = "k";
    expect(defaultEmbeddingClient()).toBeInstanceOf(EmbeddingClient);
  });

  test("empty input never builds the client", async () => {
    expect(await embedTextsWithUsage([])).toEqual([[], new EmbeddingUsage()]);
  });

  test("blank EMBED_* values fall back to the defaults; EMBED_API_KEY wins", async () => {
    process.env.EMBED_API_KEY = "embed-key";
    process.env.OPENROUTER_API_KEY = "router-key";
    process.env.EMBED_MODEL = "";
    process.env.EMBED_BASE_URL = "";
    process.env.EMBED_DIM = "";
    const network = env
      .network()
      .mockImplementation((async () => Response.json(vectors([9]))) as unknown as typeof fetch);
    expect(await embedTexts(["q"])).toEqual([[9]]);
    const [url, init] = network.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer embed-key");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: DEFAULT_EMBED_MODEL,
      dimensions: 3072,
    });
  });
});
