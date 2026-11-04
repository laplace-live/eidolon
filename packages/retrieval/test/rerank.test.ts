import { describe, expect, spyOn, test } from "bun:test";
import {
  DEFAULT_RERANK_BASE_URL,
  DEFAULT_RERANK_MODEL,
  makeReranker,
  OpenRouterReranker,
  RERANK_TIMEOUT_SEC,
} from "../src/index.ts";
import { captureLogs, fakeFetch, isolateEnv, messages } from "./helpers.ts";

const records = captureLogs();
const env = isolateEnv();

const ok = (results: unknown) => Response.json({ results, meta: { billed_units: 1 } });
const tooMany = () => new Response("{}", { status: 429, statusText: "Too Many Requests" });

describe("OpenRouterReranker", () => {
  test("posts the Cohere body with OpenRouter attribution", async () => {
    const { fetch, calls } = fakeFetch([ok([{ index: 1, relevance_score: 0.9 }])]);
    const reranker = new OpenRouterReranker({
      apiKey: "sk-1",
      baseUrl: "https://openrouter.ai/api/v1/",
      fetch,
    });
    expect(await reranker.rerank("坚果 体重 斤 ？", ["a", "b"])).toEqual([
      { index: 1, relevanceScore: 0.9 },
    ]);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/rerank");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({
      "HTTP-Referer": "https://laplace.live/ai",
      "X-Title": "LAPLACE Live!",
      "X-OpenRouter-Title": "LAPLACE Live!",
      "X-OpenRouter-Categories": "roleplay",
      Authorization: "Bearer sk-1",
      "Content-Type": "application/json",
    });
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({
        model: "cohere/rerank-4-fast",
        query: "坚果 体重 斤 ？",
        documents: ["a", "b"],
      }),
    );
  });

  test("sends top_n only when set", async () => {
    const { fetch, calls } = fakeFetch([ok([])]);
    await new OpenRouterReranker({ apiKey: "k", topN: 2, fetch }).rerank("q", ["a"]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: DEFAULT_RERANK_MODEL,
      query: "q",
      documents: ["a"],
      top_n: 2,
    });
  });

  test("no documents, no request", async () => {
    const { fetch, calls } = fakeFetch([]);
    expect(await new OpenRouterReranker({ apiKey: "k", fetch }).rerank("q", [])).toEqual([]);
    expect(calls.length).toBe(0);
  });

  test("429 is retried immediately, at most three attempts", async () => {
    const { fetch, calls } = fakeFetch([
      tooMany(),
      tooMany(),
      ok([{ index: 0, relevance_score: 1 }]),
    ]);
    const results = await new OpenRouterReranker({ apiKey: "k", fetch }).rerank("q", ["a"]);
    expect(results).toEqual([{ index: 0, relevanceScore: 1 }]);
    expect(calls.length).toBe(3);
    expect(messages(records, "DEBUG")).toEqual([
      "Rerank 429 on attempt 1; retrying immediately",
      "Rerank 429 on attempt 2; retrying immediately",
    ]);
  });

  test("three 429s raise as httpx would", async () => {
    const { fetch, calls } = fakeFetch([tooMany(), tooMany(), tooMany()]);
    const reranker = new OpenRouterReranker({ apiKey: "k", fetch });
    await expect(reranker.rerank("q", ["a"])).rejects.toThrow(
      "Client error '429 Too Many Requests' for url 'https://openrouter.ai/api/v1/rerank'\n" +
        "For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429",
    );
    expect(calls.length).toBe(3);
  });

  test("any other error status raises after one call", async () => {
    const { fetch, calls } = fakeFetch([new Response("boom", { status: 500 })]);
    await expect(new OpenRouterReranker({ apiKey: "k", fetch }).rerank("q", ["a"])).rejects.toThrow(
      "Server error '500",
    );
    expect(calls.length).toBe(1);
  });

  test("a redirect is a failure, as httpx doesn't follow it", async () => {
    const redirect = new Response(null, { status: 307, headers: { location: "https://x/" } });
    const { fetch, calls } = fakeFetch([redirect]);
    await expect(new OpenRouterReranker({ apiKey: "k", fetch }).rerank("q", ["a"])).rejects.toThrow(
      "Redirect location: 'https://x/'",
    );
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  test("missing results or a bad index raise", async () => {
    const reranker = (reply: Response) =>
      new OpenRouterReranker({ apiKey: "k", fetch: fakeFetch([reply]).fetch });
    await expect(reranker(Response.json({})).rerank("q", ["a"])).rejects.toThrow("'results'");
    await expect(
      reranker(ok([{ index: 1, relevance_score: 0.5 }])).rerank("q", ["a"]),
    ).rejects.toThrow("out of bounds");
    await expect(reranker(ok([{ index: 0 }])).rerank("q", ["a"])).rejects.toThrow("float32");
  });

  test("the 10 s timeout covers each attempt and reads as httpx's", async () => {
    const timer = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => timer.signal);
    try {
      const { fetch } = fakeFetch([
        (init) =>
          new Promise<Response>((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            timer.abort(new DOMException("The operation timed out.", "TimeoutError"));
          }),
      ]);
      await expect(
        new OpenRouterReranker({ apiKey: "k", fetch }).rerank("q", ["a"]),
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
    const reranker = new OpenRouterReranker({ apiKey: "k", fetch });
    await expect(reranker.rerank("q", ["a"], { signal: controller.signal })).rejects.toBe(reason);
  });
});

describe("makeReranker", () => {
  test.each(["false", "0", "no", "off", " OFF "])("RERANK_ENABLED=%p switches it off", (value) => {
    process.env.RERANK_ENABLED = value;
    process.env.OPENROUTER_API_KEY = "k";
    expect(makeReranker()).toBeNull();
    expect(messages(records, "INFO")).toEqual([
      "RERANK_ENABLED is off — hybrid retrieval will use RRF fusion",
    ]);
  });

  test.each(["true", "", "maybe"])("RERANK_ENABLED=%p leaves it on", (value) => {
    process.env.RERANK_ENABLED = value;
    process.env.OPENROUTER_API_KEY = "k";
    expect(makeReranker()).toBeInstanceOf(OpenRouterReranker);
  });

  test("no key means RRF", () => {
    expect(makeReranker()).toBeNull();
    expect(messages(records, "INFO")[0]).toStartWith(
      "Neither RERANK_API_KEY nor OPENROUTER_API_KEY is set",
    );
  });

  test("RERANK_API_KEY wins, and blank model and base URL take the defaults", async () => {
    process.env.RERANK_API_KEY = "rerank-key";
    process.env.OPENROUTER_API_KEY = "router-key";
    process.env.RERANK_MODEL = "";
    process.env.RERANK_BASE_URL = "";
    const reranker = makeReranker() as OpenRouterReranker;
    expect(reranker.modelName).toBe(DEFAULT_RERANK_MODEL);
    expect(reranker.baseUrl).toBe(DEFAULT_RERANK_BASE_URL);
    expect(messages(records, "INFO")).toEqual([
      "Reranker enabled: model='cohere/rerank-4-fast' via https://openrouter.ai/api/v1",
    ]);
    const network = env
      .network()
      .mockImplementation((async () => ok([])) as unknown as typeof fetch);
    await reranker.rerank("q", ["a"]);
    const init = network.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer rerank-key");
  });

  test("the first call fixes the reranker", () => {
    process.env.OPENROUTER_API_KEY = "k";
    const first = makeReranker("model-a");
    expect(first?.modelName).toBe("model-a");
    process.env.RERANK_ENABLED = "off";
    expect(makeReranker("model-b")).toBe(first);
  });
});
