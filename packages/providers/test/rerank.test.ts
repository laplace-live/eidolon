import { consoleSink, type LogRecord, logger } from "@eidolon/config";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  openRouterRerank,
  rerankModel,
  select,
  setUsageSink,
  type UsageRecord,
} from "../src/index.ts";
import { RERANK_TIMEOUT_SEC } from "../src/rerank/cohere.ts";

const ATTRIBUTION = ["OPENROUTER_APP_NAME", "OPENROUTER_APP_URL"] as const;
const saved = new Map(ATTRIBUTION.map((name) => [name, process.env[name]]));
const logs: LogRecord[] = [];

beforeEach(() => {
  for (const name of ATTRIBUTION) delete process.env[name];
  logs.length = 0;
  logger.setSink((record) => logs.push(record));
});
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  logger.setSink(consoleSink);
  setUsageSink(null);
});

const MODEL = "cohere/rerank-4-fast";
const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://laplace.live/ai",
  "X-Title": "LAPLACE Live!",
  "X-OpenRouter-Title": "LAPLACE Live!",
  "X-OpenRouter-Categories": "roleplay",
};

const ok = (results: unknown) => Response.json({ results, meta: { billed_units: 1 } });
const tooMany = () => new Response("{}", { status: 429, statusText: "Too Many Requests" });

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

function recording(): UsageRecord[] {
  const records: UsageRecord[] = [];
  setUsageSink((record) => records.push(record));
  return records;
}

describe("OpenRouter's reranker", () => {
  test("posts the Cohere body with OpenRouter attribution", async () => {
    const { fetch, calls } = fakeFetch([ok([{ index: 1, relevance_score: 0.9 }])]);
    const reranker = openRouterRerank({
      apiKey: "sk-1",
      model: MODEL,
      baseUrl: "https://openrouter.ai/api/v1/",
      fetch,
    });
    expect(await reranker.rerank("坚果 体重 斤 ？", ["a", "b"])).toEqual([
      { index: 1, relevanceScore: 0.9 },
    ]);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/rerank");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({
      ...OPENROUTER_HEADERS,
      Authorization: "Bearer sk-1",
      "Content-Type": "application/json",
    });
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ model: MODEL, query: "坚果 体重 斤 ？", documents: ["a", "b"] }),
    );
  });

  test("sends top_n only when set", async () => {
    const { fetch, calls } = fakeFetch([ok([])]);
    await openRouterRerank({ apiKey: "k", model: MODEL, topN: 2, fetch }).rerank("q", ["a"]);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/rerank");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: MODEL,
      query: "q",
      documents: ["a"],
      top_n: 2,
    });
  });

  test("no documents, no request", async () => {
    const { fetch, calls } = fakeFetch([]);
    expect(await openRouterRerank({ apiKey: "k", model: MODEL, fetch }).rerank("q", [])).toEqual(
      [],
    );
    expect(calls.length).toBe(0);
  });

  test("429 is retried immediately, at most three attempts", async () => {
    const { fetch, calls } = fakeFetch([
      tooMany(),
      tooMany(),
      ok([{ index: 0, relevance_score: 1 }]),
    ]);
    const results = await openRouterRerank({ apiKey: "k", model: MODEL, fetch }).rerank("q", ["a"]);
    expect(results).toEqual([{ index: 0, relevanceScore: 1 }]);
    expect(calls.length).toBe(3);
    expect(logs.filter((r) => r.level === "DEBUG").map((r) => r.message)).toEqual([
      "Rerank 429 on attempt 1; retrying immediately",
      "Rerank 429 on attempt 2; retrying immediately",
    ]);
  });

  test("three 429s raise as httpx would", async () => {
    const { fetch, calls } = fakeFetch([tooMany(), tooMany(), tooMany()]);
    const reranker = openRouterRerank({ apiKey: "k", model: MODEL, fetch });
    await expect(reranker.rerank("q", ["a"])).rejects.toThrow(
      "Client error '429 Too Many Requests' for url 'https://openrouter.ai/api/v1/rerank'\n" +
        "For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429",
    );
    expect(calls.length).toBe(3);
  });

  test("any other error status raises after one call", async () => {
    const { fetch, calls } = fakeFetch([new Response("boom", { status: 500 })]);
    const reranker = openRouterRerank({ apiKey: "k", model: MODEL, fetch });
    await expect(reranker.rerank("q", ["a"])).rejects.toThrow("Server error '500");
    expect(calls.length).toBe(1);
  });

  test("a redirect is a failure, as httpx doesn't follow it", async () => {
    const redirect = new Response(null, { status: 307, headers: { location: "https://x/" } });
    const { fetch, calls } = fakeFetch([redirect]);
    const reranker = openRouterRerank({ apiKey: "k", model: MODEL, fetch });
    await expect(reranker.rerank("q", ["a"])).rejects.toThrow("Redirect location: 'https://x/'");
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  test("missing results or a bad index raise, and report nothing", async () => {
    const records = recording();
    const reranker = (reply: Response) =>
      openRouterRerank({ apiKey: "k", model: MODEL, fetch: fakeFetch([reply]).fetch });
    await expect(reranker(Response.json({})).rerank("q", ["a"])).rejects.toThrow("'results'");
    await expect(
      reranker(ok([{ index: 1, relevance_score: 0.5 }])).rerank("q", ["a"]),
    ).rejects.toThrow("out of bounds");
    await expect(reranker(ok([{ index: 0 }])).rerank("q", ["a"])).rejects.toThrow("float32");
    expect(records).toEqual([]);
  });

  test("the 10 s timeout covers each attempt and reads as httpx's", async () => {
    const timer = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timer.signal);
    try {
      const { fetch } = fakeFetch([
        (init) =>
          new Promise<Response>((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            timer.abort(new DOMException("The operation timed out.", "TimeoutError"));
          }),
      ]);
      await expect(
        openRouterRerank({ apiKey: "k", model: MODEL, fetch }).rerank("q", ["a"]),
      ).rejects.toThrow("timed out");
      expect(timeout).toHaveBeenCalledWith(RERANK_TIMEOUT_SEC * 1000);
    } finally {
      timeout.mockRestore();
    }
  });

  test("an abort rejects with the signal's reason", async () => {
    const controller = new AbortController();
    const reason = new Error("interrupted");
    const { fetch } = fakeFetch([
      (init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          controller.abort(reason);
        }),
    ]);
    const reranker = openRouterRerank({ apiKey: "k", model: MODEL, fetch });
    await expect(reranker.rerank("q", ["a"], { signal: controller.signal })).rejects.toBe(reason);
  });
});

describe("the rerank role's reranker", () => {
  test("OpenRouter's account reports each rerank with its cost", async () => {
    const selection = select("rerank", reader({ OPENROUTER_API_KEY: "or" }));
    if (selection === null) throw new Error("the rerank role is on by default");
    const records = recording();
    const reply = Response.json({ results: [], usage: { search_units: 1, cost: 0.002 } });
    const { fetch, calls } = fakeFetch([reply]);
    const reranker = rerankModel(selection, { fetch });
    expect([reranker.provider, reranker.model]).toEqual(["openrouter", MODEL]);
    await reranker.rerank("q", ["a"]);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/rerank");
    expect(
      records.map(({ role, provider, model, units, costUsd }) => [
        role,
        provider,
        model,
        units,
        costUsd,
      ]),
    ).toEqual([["rerank", "openrouter", MODEL, { searches: 1 }, 0.002]]);
  });

  test("RERANK_BASE_URL at Cohere's API keeps OpenRouter's headers, and bills Cohere", async () => {
    const read = reader({
      OPENROUTER_API_KEY: "or",
      RERANK_API_KEY: "co",
      RERANK_BASE_URL: "https://api.cohere.com/v1/",
      RERANK_MODEL: "rerank-v4.0-fast",
    });
    const selection = select("rerank", read);
    if (selection === null) throw new Error("the rerank role is on by default");
    const records = recording();
    const reply = Response.json({ results: [], meta: { billed_units: { search_units: 1 } } });
    const { fetch, calls } = fakeFetch([reply]);
    const reranker = rerankModel(selection, { fetch });
    expect(reranker.provider).toBe("cohere");
    await reranker.rerank("q", ["a"]);
    expect(calls[0]?.url).toBe("https://api.cohere.com/v1/rerank");
    expect(calls[0]?.init.headers).toEqual({
      ...OPENROUTER_HEADERS,
      Authorization: "Bearer co",
      "Content-Type": "application/json",
    });
    expect(records.map(({ provider, model }) => [provider, model])).toEqual([
      ["cohere", "rerank-v4.0-fast"],
    ]);
  });

  test("a Cohere account reranks on Cohere's own API, without OpenRouter's headers", async () => {
    const read = reader({ RERANK_PROVIDER: "cohere", COHERE_API_KEY: "co" });
    const selection = select("rerank", read);
    if (selection === null) throw new Error("a provider is named");
    const records = recording();
    const reply = Response.json({
      results: [{ index: 0, relevance_score: 0.5 }],
      meta: { billed_units: { search_units: 1 } },
    });
    const { fetch, calls } = fakeFetch([reply]);
    const reranker = rerankModel(selection, { fetch });
    expect(await reranker.rerank("q", ["a"])).toEqual([{ index: 0, relevanceScore: 0.5 }]);
    expect(calls[0]?.url).toBe("https://api.cohere.com/v2/rerank");
    expect(calls[0]?.init.headers).toEqual({
      Authorization: "Bearer co",
      "Content-Type": "application/json",
    });
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ model: "rerank-v4.0-fast", query: "q", documents: ["a"] }),
    );
    expect(records.map(({ role, provider, model }) => [role, provider, model])).toEqual([
      ["rerank", "cohere", "rerank-v4.0-fast"],
    ]);
  });

  test("a role without its key asks nothing", () => {
    const keyless = select("rerank", reader({}));
    if (keyless === null) throw new Error("the rerank role is on by default");
    expect(() => rerankModel(keyless)).toThrow("OpenRouter needs an API key");
  });
});
