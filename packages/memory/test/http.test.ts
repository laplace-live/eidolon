import { describe, expect, test } from "bun:test";
import {
  extractionRequestBody,
  isReasoningModel,
  OpenAICompatibleChat,
  OpenAICompatibleEmbedder,
} from "../src/openai.ts";
import { OpenAIClient } from "../src/openai-http.ts";

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

type Reply = Response | Error | ((seen: Seen) => Response);

function fakeFetch(replies: Reply[]) {
  const seen: Seen[] = [];
  const respond = (async (url: string, init: RequestInit) => {
    const entry = {
      url,
      headers: new Headers(init.headers),
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    };
    seen.push(entry);
    const reply = replies.shift();
    if (reply === undefined) throw new Error("no reply queued");
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply(entry) : reply;
  }) as unknown as typeof globalThis.fetch;
  return { fetch: respond, seen };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function embeddings(seen: Seen): Response {
  const input = seen.body.input as string[];
  return json({ data: input.map((text, index) => ({ index, embedding: [text.length] })) });
}

function client(replies: Reply[], options: { random?: () => number } = {}) {
  const { fetch, seen } = fakeFetch(replies);
  const sleeps: number[] = [];
  const http = new OpenAIClient(
    { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-test" },
    {
      fetch,
      random: options.random ?? (() => 0),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  return { http, seen, sleeps };
}

async function failure(promise: Promise<unknown>): Promise<[string, string]> {
  try {
    await promise;
  } catch (error) {
    return [(error as Error).name, (error as Error).message];
  }
  throw new Error("expected a rejection");
}

describe("embedder over the OpenAI SDK's wire format", () => {
  test("one text: newlines (only \\n) become spaces, float encoding, dimensions, bearer key", async () => {
    const { http, seen } = client([embeddings]);
    const embedder = new OpenAICompatibleEmbedder(
      { model: "google/gemini-embedding-2-preview", dims: 3072 },
      http,
    );
    expect(await embedder.embed("a\nb\rc")).toEqual([5]);
    expect(seen[0]?.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(JSON.stringify(seen[0]?.body)).toBe(
      '{"input":["a b\\rc"],"model":"google/gemini-embedding-2-preview","encoding_format":"float","dimensions":3072}',
    );
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk-test");
    expect(seen[0]?.headers.get("content-type")).toBe("application/json");
    expect(seen[0]?.headers.has("http-referer")).toBe(false);
  });

  test("a base URL ending in / is not doubled", async () => {
    const { fetch, seen } = fakeFetch([embeddings]);
    const http = new OpenAIClient({ baseUrl: "https://example.test/v1/", apiKey: "k" }, { fetch });
    await new OpenAICompatibleEmbedder({ model: "m", dims: 1 }, http).embed("x");
    expect(seen[0]?.url).toBe("https://example.test/v1/embeddings");
  });

  test("batches go out 100 at a time and come back in index order", async () => {
    const reversed = (seen: Seen) => {
      const input = seen.body.input as string[];
      return json({
        data: input.map((text, index) => ({ index, embedding: [Number(text)] })).reverse(),
      });
    };
    const { http, seen } = client([reversed, reversed, reversed]);
    const embedder = new OpenAICompatibleEmbedder({ model: "m", dims: 1 }, http);
    const texts = Array.from({ length: 250 }, (_, i) => String(i));
    const vectors = await embedder.embedBatch(texts);
    expect(seen.map((s) => (s.body.input as string[]).length)).toEqual([100, 100, 50]);
    expect(vectors).toEqual(texts.map((t) => [Number(t)]));
  });

  test("a short batch raises mem0's count error", async () => {
    const { http } = client([json({ data: [{ index: 0, embedding: [1] }] })]);
    const embedder = new OpenAICompatibleEmbedder({ model: "m", dims: 1 }, http);
    expect(await failure(embedder.embedBatch(["a", "b"]))).toEqual([
      "ValueError",
      "OpenAI embed_batch() returned 1 embeddings for 2 texts using model 'm'",
    ]);
  });

  test("a non-string text raises before any request", async () => {
    const { http, seen } = client([]);
    const embedder = new OpenAICompatibleEmbedder({ model: "m", dims: 1 }, http);
    expect(await failure(embedder.embedBatch(["a", 5]))).toEqual([
      "AttributeError",
      "'int' object has no attribute 'replace'",
    ]);
    expect(seen).toHaveLength(0);
  });

  test("a response without data reads as the SDK's attribute error", async () => {
    const { http } = client([json({ object: "list" })]);
    const embedder = new OpenAICompatibleEmbedder({ model: "m", dims: 1 }, http);
    expect(await failure(embedder.embed("x"))).toEqual([
      "AttributeError",
      "'CreateEmbeddingResponse' object has no attribute 'data'",
    ]);
  });
});

describe("the SDK's retry policy", () => {
  test("429 then 200 retries once after the jittered backoff", async () => {
    const { http, seen, sleeps } = client([json({ error: "slow down" }, 429), embeddings], {
      random: () => 1,
    });
    await new OpenAICompatibleEmbedder({ model: "m", dims: 1 }, http).embed("x");
    expect(seen).toHaveLength(2);
    expect(sleeps).toEqual([375]);
  });

  test("backoff doubles per retry, then the last error is raised", async () => {
    const { http, seen, sleeps } = client([
      json({}, 503),
      json({}, 503),
      json({ error: { message: "down" } }, 503),
    ]);
    expect(await failure(http.post("embeddings", {}))).toEqual([
      "InternalServerError",
      "Error code: 503 - {'error': {'message': 'down'}}",
    ]);
    expect(seen).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  test("retry-after and retry-after-ms are honoured up to two minutes", async () => {
    const { http, sleeps } = client([
      json({}, 429, { "retry-after": "1" }),
      json({}, 429, { "retry-after-ms": "1500" }),
      json({ ok: true }),
    ]);
    expect(await http.post("chat/completions", {})).toEqual({ ok: true });
    expect(sleeps).toEqual([1000, 1500]);
  });

  test("a retry-after beyond two minutes stops retrying", async () => {
    const { http, seen } = client([json({ error: "later" }, 429, { "retry-after": "121" })]);
    expect(await failure(http.post("embeddings", {}))).toEqual([
      "RateLimitError",
      "Error code: 429 - {'error': 'later'}",
    ]);
    expect(seen).toHaveLength(1);
  });

  test("x-should-retry overrides the status", async () => {
    const no = client([json({}, 500, { "x-should-retry": "false" })]);
    expect((await failure(no.http.post("embeddings", {})))[0]).toBe("InternalServerError");
    expect(no.seen).toHaveLength(1);
    const yes = client([json({}, 400, { "x-should-retry": "true" }), json({ ok: 1 })]);
    expect(await yes.http.post("embeddings", {})).toEqual({ ok: 1 });
  });

  test("400 is not retried; non-JSON and empty bodies read as the SDK's message", async () => {
    const a = client([json({ error: { message: "bad" } }, 400)]);
    expect(await failure(a.http.post("x", {}))).toEqual([
      "BadRequestError",
      "Error code: 400 - {'error': {'message': 'bad'}}",
    ]);
    expect(a.seen).toHaveLength(1);
    const b = client([new Response(" upstream exploded \n", { status: 404 })]);
    expect(await failure(b.http.post("x", {}))).toEqual(["NotFoundError", "upstream exploded"]);
    const c = client([new Response("", { status: 401 })]);
    expect(await failure(c.http.post("x", {}))).toEqual(["AuthenticationError", "Error code: 401"]);
  });

  test("a body that fails mid-read retries like a connection error", async () => {
    const reset = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError("socket reset"));
        },
      }),
      { status: 200 },
    );
    const { http, seen } = client([reset, json({ ok: true })]);
    expect(await http.post("x", {})).toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    const errorReset = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError("socket reset"));
        },
      }),
      { status: 400 },
    );
    const second = client([errorReset, json({ ok: 2 })]);
    expect(await second.http.post("x", {})).toEqual({ ok: 2 });
    expect(second.seen).toHaveLength(2);
  });

  test("connection errors and timeouts retry twice, then raise the SDK's errors", async () => {
    const down = client([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    ]);
    expect(await failure(down.http.post("x", {}))).toEqual([
      "APIConnectionError",
      "Connection error.",
    ]);
    expect(down.seen).toHaveLength(3);
    const timeout = () => new DOMException("The operation timed out.", "TimeoutError");
    const slow = client([timeout(), timeout(), timeout()]);
    expect(await failure(slow.http.post("x", {}))).toEqual([
      "APITimeoutError",
      "Request timed out.",
    ]);
  });
});

describe("extraction chat", () => {
  const messages = [
    { role: "system" as const, content: "S" },
    { role: "user" as const, content: "U" },
  ];

  test("the default model gets mem0's sampling params, in mem0's key order", () => {
    expect(JSON.stringify(extractionRequestBody("~google/gemini-flash-latest", messages))).toBe(
      '{"temperature":0.1,"top_p":0.1,"max_tokens":2000,"messages":[{"role":"system","content":"S"},{"role":"user","content":"U"}],"model":"~google/gemini-flash-latest","response_format":{"type":"json_object"}}',
    );
  });

  test("reasoning models get no sampling params; gpt-5 models a completion cap", () => {
    expect(Object.keys(extractionRequestBody("openai/o3-mini", messages))).toEqual([
      "messages",
      "model",
      "response_format",
    ]);
    expect(extractionRequestBody("openai/gpt-5.4-mini", messages)).toMatchObject({
      max_completion_tokens: 2000,
    });
    expect(extractionRequestBody("openai/gpt-5.4-mini", messages)).not.toHaveProperty("max_tokens");
    for (const model of ["o1", "O3", "x/o1-2024-12-17", "o3.5", "gpt-5", "openai/gpt-5o-mini"]) {
      expect(isReasoningModel(model)).toBe(true);
    }
    for (const model of ["gpt-5.4-mini", "o4-mini", "~google/gemini-flash-latest", "o1x"]) {
      expect(isReasoningModel(model)).toBe(false);
    }
  });

  test("resolves to the first choice's content, null included", async () => {
    const { http, seen } = client([
      json({ choices: [{ message: { content: '{"memory": []}' } }] }),
      json({ choices: [{ message: { content: null } }] }),
    ]);
    const chat = new OpenAICompatibleChat("m", http);
    expect(await chat.complete(messages)).toBe('{"memory": []}');
    expect(await chat.complete(messages)).toBeNull();
    expect(seen[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  test("missing or empty choices raise as the SDK's objects would", async () => {
    const { http } = client([json({ error: "x" }), json({ choices: [] })]);
    const chat = new OpenAICompatibleChat("m", http);
    expect(await failure(chat.complete(messages))).toEqual([
      "AttributeError",
      "'ChatCompletion' object has no attribute 'choices'",
    ]);
    expect(await failure(chat.complete(messages))).toEqual([
      "IndexError",
      "list index out of range",
    ]);
  });
});
