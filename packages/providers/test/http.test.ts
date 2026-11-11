import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  AnthropicClient,
  chatPoster,
  forOpenAI,
  fromAnthropicResponse,
  OpenAIChatClient,
  ProviderHttpError,
  select,
  sseEvents,
  toAnthropicRequest,
  type Units,
} from "../src/index.ts";

interface Seen {
  readonly path: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

let server: Server<undefined>;
const seen: Seen[] = [];
let reply: (request: Seen) => Response = () => new Response("{}");

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const entry = {
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: (await request.json()) as Record<string, unknown>,
      };
      seen.push(entry);
      return reply(entry);
    },
  });
});

afterAll(() => server.stop(true));

const base = () => `http://127.0.0.1:${server.port}/v1`;

function sse(lines: readonly string[]): Response {
  return new Response(lines.join(""), { headers: { "Content-Type": "text/event-stream" } });
}

async function drain(stream: unknown): Promise<unknown[]> {
  const items: unknown[] = [];
  for await (const item of stream as AsyncIterable<unknown>) items.push(item);
  return items;
}

test("sseEvents joins data lines, keeps event names, and skips comments", async () => {
  const body = new Response(
    ': keep-alive\r\nevent: a\r\ndata: 1\r\ndata: 2\r\n\r\ndata: {"x":3}\n\n',
  ).body;
  if (body === null) throw new Error("no body");
  expect(await drain(sseEvents(body))).toEqual([
    { event: "a", data: "1\n2" },
    { event: null, data: '{"x":3}' },
  ]);
});

describe("OpenAIChatClient", () => {
  test("streams chunks, then reports the last usage once with OpenRouter's cost", async () => {
    seen.length = 0;
    reply = () =>
      sse([
        ": OPENROUTER PROCESSING\n\n",
        'data: {"model":"served","choices":[{"delta":{"content":"嗨"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"cost":0.001,"prompt_tokens_details":{"cached_tokens":4}}}\n\n',
        "data: [DONE]\n\n",
      ]);
    const usage: [Units, string, number | null, string][] = [];
    const client = new OpenAIChatClient({
      provider: "OpenRouter",
      baseUrl: base(),
      apiKey: "k",
      extraBody: { usage: { include: true } },
      reportsCost: true,
      onUsage: (...args) => usage.push(args),
    });
    const stream = await client.chat.completions.create({ model: "m", stream: true });
    const chunks = await drain(stream);
    expect(chunks).toHaveLength(2);
    expect(seen[0]?.path).toBe("/v1/chat/completions");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer k");
    expect(seen[0]?.body).toEqual({ usage: { include: true }, model: "m", stream: true });
    expect(usage).toEqual([
      [{ inputTokens: 6, cachedTokens: 4, cacheWriteTokens: 0, outputTokens: 2 }, "m", 0.001, "m"],
    ]);
  });

  test("retries a busy or failing answer, and a dropped connection, as the SDKs did", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const client = new OpenAIChatClient({ provider: "P", baseUrl: base(), apiKey: "k", sleep });
    seen.length = 0;
    let answers = [
      new Response("busy", { status: 429, headers: { "retry-after": "1" } }),
      new Response("down", { status: 503 }),
    ];
    reply = () => answers.shift() ?? Response.json({ choices: [] });
    expect(await client.chat.completions.create({ model: "m" })).toEqual({ choices: [] });
    expect(seen).toHaveLength(3);
    expect(waits[0]).toBe(1000);

    seen.length = 0;
    answers = [];
    reply = () => new Response('{"error":{"message":"no such model"}}', { status: 400 });
    await expect(client.chat.completions.create({ model: "m" })).rejects.toThrow("answered 400");
    expect(seen).toHaveLength(1);

    seen.length = 0;
    reply = () => new Response("down", { status: 502 });
    await expect(client.chat.completions.create({ model: "m" })).rejects.toThrow("answered 502");
    expect(seen).toHaveLength(3);

    let dropped = 1;
    const flaky = new OpenAIChatClient({
      provider: "P",
      baseUrl: base(),
      sleep,
      fetch: (async (url: string, init: RequestInit) => {
        if (dropped-- > 0) throw new TypeError("fetch failed");
        return fetch(url, init);
      }) as typeof fetch,
    });
    reply = () => Response.json({ ok: true });
    expect(await flaky.chat.completions.create({ model: "m" })).toEqual({ ok: true });
  });

  test("an error status or an error event throws ProviderHttpError", async () => {
    const client = new OpenAIChatClient({ provider: "P", baseUrl: base(), apiKey: "k" });
    reply = () => new Response('{"error":{"message":"bad key"}}', { status: 401 });
    const refused = client.chat.completions.create({ model: "m", stream: true });
    await expect(refused).rejects.toThrow("P answered 401: bad key");
    reply = () => sse(['data: {"error":{"message":"upstream down","code":502}}\n\n']);
    const stream = await client.chat.completions.create({ model: "m", stream: true });
    const failed = drain(stream);
    await expect(failed).rejects.toBeInstanceOf(ProviderHttpError);
  });
});

describe("AnthropicClient", () => {
  test("sends the version, the key and the betas as headers, and streams events", async () => {
    seen.length = 0;
    reply = () =>
      sse([
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-x","usage":{"input_tokens":12,"cache_read_input_tokens":100,"output_tokens":1}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    const usage: [Units, string, number | null, string][] = [];
    const client = new AnthropicClient({
      provider: "Anthropic",
      baseUrl: base(),
      apiKey: "ak",
      onUsage: (...args) => usage.push(args),
    });
    const stream = await client.beta.messages.create({
      model: "claude-opus-5-5",
      stream: true,
      betas: ["interleaved-thinking-2025-05-14"],
      fallbacks: "default",
    });
    const events = await drain(stream);
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "message_start",
      "content_block_delta",
      "message_delta",
      "message_stop",
    ]);
    const request = seen[0];
    expect(request?.path).toBe("/v1/messages");
    expect(request?.headers.get("x-api-key")).toBe("ak");
    expect(request?.headers.get("anthropic-version")).toBe("2026-10-21");
    expect(request?.headers.get("anthropic-beta")).toBe(
      "interleaved-thinking-2025-05-14,server-side-fallback-2026-07-01",
    );
    expect(request?.body).toEqual({ model: "claude-opus-5-5", stream: true, fallbacks: "default" });
    expect(usage).toEqual([
      [
        { inputTokens: 12, cachedTokens: 100, cacheWriteTokens: 0, outputTokens: 7 },
        "claude-x",
        null,
        "claude-opus-5-5",
      ],
    ]);
  });
});

test("OpenAI's own API gets a completion cap, and its reasoning models no sampling settings", () => {
  const body = { model: "gpt-6-luna", max_tokens: 8192, temperature: 0.1, top_p: 0.1 };
  expect(forOpenAI(body)).toEqual({ model: "gpt-6-luna", max_completion_tokens: 8192 });
  expect(forOpenAI({ model: "gpt-4.1-mini", max_tokens: 10, temperature: 0 })).toEqual({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_completion_tokens: 10,
  });
  expect(forOpenAI({ model: "o4-mini", top_p: 1 })).toEqual({ model: "o4-mini" });
});

describe("chatPoster", () => {
  const reader = (values: Record<string, string>) => (name: string) => values[name];

  test("leaves OpenRouter's own fields out for other providers", async () => {
    seen.length = 0;
    reply = () =>
      Response.json({ model: "d", choices: [{ message: { content: "{}" } }], usage: {} });
    const selection = select(
      "refine",
      reader({ REFINE_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "dk", DEEPSEEK_BASE_URL: base() }),
    );
    if (selection === null) throw new Error("no selection");
    await chatPoster(selection).post("chat/completions", {
      model: "deepseek-flash",
      messages: [],
      usage: { include: true },
      provider: { require_parameters: true },
    });
    expect(seen[0]?.body).toEqual({ model: "deepseek-flash", messages: [] });
  });

  test("speaks the Messages API to Anthropic and answers in chat-completions shape", async () => {
    seen.length = 0;
    reply = () =>
      Response.json({
        model: "claude-opus-5-5",
        content: [{ type: "text", text: '{"a":1}' }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 3 },
      });
    const selection = select(
      "memory",
      reader({
        MEM0_LLM_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "ak",
        ANTHROPIC_BASE_URL: base(),
      }),
    );
    if (selection === null) throw new Error("no selection");
    const usage: Units[] = [];
    const answer = await chatPoster(selection, {}, (units) => usage.push(units)).post(
      "chat/completions",
      {
        model: "claude-opus-5-5",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" },
        ],
        max_tokens: 100,
        temperature: 0.1,
        response_format: { type: "json_object" },
      },
    );
    expect(seen[0]?.path).toBe("/v1/messages");
    expect(seen[0]?.headers.get("authorization")).toBeNull();
    expect(seen[0]?.headers.get("x-api-key")).toBe("ak");
    expect(seen[0]?.body).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      system: "be brief",
    });
    expect(answer).toMatchObject({
      choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
    expect(usage).toEqual([
      { inputTokens: 5, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 3 },
    ]);
  });

  test("a json_schema response format becomes structured output", () => {
    const schema = { type: "object", properties: {}, additionalProperties: false };
    expect(
      toAnthropicRequest({
        model: "m",
        messages: [],
        response_format: { type: "json_schema", json_schema: { name: "x", schema, strict: true } },
      }),
    ).toEqual({
      model: "m",
      max_tokens: 16000,
      messages: [],
      output_config: { format: { type: "json_schema", schema } },
    });
    expect(fromAnthropicResponse({ content: [], stop_reason: "max_tokens" })).toMatchObject({
      choices: [{ finish_reason: "length" }],
    });
  });

  test("refuses to build a client without the key", () => {
    const selection = select("mind", reader({}));
    if (selection === null) throw new Error("no selection");
    expect(() => chatPoster(selection)).toThrow("set OPENROUTER_API_KEY");
  });
});
