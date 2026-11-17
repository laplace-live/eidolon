import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { consoleSink, type LogRecord, logger, openrouterHeaders } from "@eidolon/config";
import type { ToolSchema } from "@eidolon/core";
import {
  ANTHROPIC_VERSION,
  ProviderHttpError,
  setUsageSink,
  type UsageRecord,
  withUsageScope,
} from "@eidolon/providers";
import type { Server } from "bun";
import { createMind } from "../src/mind/index.ts";
import type { Mind, MindChunk, MindRequest } from "../src/types.ts";

interface Seen {
  readonly path: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

let server: Server<undefined>;
let seen: Seen[] = [];
let reply: () => Response = () => new Response("{}");

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: (await request.json()) as Record<string, unknown>,
      });
      return reply();
    },
  });
});

afterAll(() => server.stop(true));

const base = () => `http://127.0.0.1:${server.port}/v1`;

const ENV = [
  "LLM_PROVIDER",
  "LLM_MODEL",
  "OPENROUTER_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_API_BASE",
  "OPENROUTER_APP_NAME",
  "OPENROUTER_APP_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "XAI_API_KEY",
  "XAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_BASE_URL",
  "ASSISTANT_PROVIDER",
  "ASSISTANT_MODEL",
];

let saved: (readonly [string, string | undefined])[] = [];
let records: UsageRecord[] = [];
let logs: LogRecord[] = [];

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

beforeEach(() => {
  saved = ENV.map((name) => [name, process.env[name]] as const);
  setEnv(Object.fromEntries(ENV.map((name) => [name, undefined])));
  setEnv({ OPENROUTER_API_KEY: "or-key", OPENROUTER_API_BASE: base() });
  seen = [];
  records = [];
  logs = [];
  setUsageSink((record) => records.push(record));
  logger.setSink((record) => logs.push(record));
});

afterEach(() => {
  setEnv(Object.fromEntries(saved));
  setUsageSink(null);
  logger.setSink(consoleSink);
});

const encoder = new TextEncoder();

/** An OpenAI-compatible stream of `chunks`, then `[DONE]`. */
function completions(chunks: readonly unknown[]): Response {
  const body = [...chunks.map((chunk) => JSON.stringify(chunk)), "[DONE]"]
    .map((data) => `data: ${data}\n\n`)
    .join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

/** A Messages API stream of `events`. */
function messages(events: readonly Record<string, unknown>[]): Response {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  return new Response(body.join(""), { headers: { "Content-Type": "text/event-stream" } });
}

function ask(fields: Partial<MindRequest> = {}): MindRequest {
  return {
    system: "persona",
    messages: [{ role: "user", content: "早" }],
    tools: [],
    signal: new AbortController().signal,
    ...fields,
  };
}

async function drain(mind: Mind, request: MindRequest): Promise<MindChunk[]> {
  const chunks: MindChunk[] = [];
  for await (const chunk of mind.stream(request)) chunks.push(chunk);
  return chunks;
}

const SELFIE: ToolSchema = {
  name: "take_selfie",
  description: "拍一张自拍",
  properties: { scene: { type: "string" } },
  required: ["scene"],
};

describe("an OpenAI-compatible mind", () => {
  test("OpenRouter: her persona first, attribution headers, usage asked for and reported", async () => {
    reply = () =>
      completions([
        { choices: [{ delta: { role: "assistant", content: "在" } }] },
        { choices: [{ delta: { content: "的" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, cost: 0.0003 } },
      ]);
    const request = ask({
      messages: [
        { role: "user", content: "早" },
        { role: "developer", content: "memories" },
        { role: "system", content: "archive" },
        { role: "assistant", content: "早呀" },
        { role: "user", content: "在吗" },
      ],
    });
    const chunks = await withUsageScope({ source: "chat", session: "chat-1" }, () =>
      drain(createMind(), request),
    );
    expect(chunks).toEqual([
      { type: "text", text: "在" },
      { type: "text", text: "的" },
      { type: "done", finishReason: "stop" },
    ]);
    expect(seen[0]?.path).toBe("/v1/chat/completions");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer or-key");
    expect(seen[0]?.headers.get("x-title")).toBe(openrouterHeaders()["X-Title"]);
    // The default model is a Gemini route: one system message, the rest as user ones.
    expect(seen[0]?.body).toEqual({
      usage: { include: true },
      model: "~google/gemini-flash-latest",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "persona" },
        { role: "user", content: "早" },
        { role: "user", content: "memories" },
        { role: "user", content: "archive" },
        { role: "assistant", content: "早呀" },
        { role: "user", content: "在吗" },
      ],
    });
    expect(records).toEqual([
      expect.objectContaining({
        role: "mind",
        provider: "openrouter",
        model: "~google/gemini-flash-latest",
        costUsd: 0.0003,
        costSource: "reported",
        source: "chat",
        session: "chat-1",
      }),
    ]);
    // The request messages are the caller's view: none of them is rewritten in place.
    expect(request.messages[1]).toEqual({ role: "developer", content: "memories" });
  });

  test("OpenRouter's other routes keep later system messages, and no persona sends none", async () => {
    setEnv({ OPENROUTER_MODEL: "anthropic/claude-haiku-5.5" });
    reply = () => completions([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    await drain(
      createMind(),
      ask({
        system: "",
        messages: [
          { role: "user", content: "早" },
          { role: "system", content: "archive" },
          { role: "developer", content: "memories" },
        ],
      }),
    );
    expect(seen[0]?.body.messages).toEqual([
      { role: "user", content: "早" },
      { role: "system", content: "archive" },
      { role: "user", content: "memories" },
    ]);
  });

  test("OpenAI's own API: developer messages, its tools and live fields", async () => {
    setEnv({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk", OPENAI_BASE_URL: base() });
    reply = () => completions([{ choices: [{ delta: { content: "嗯" }, finish_reason: "stop" }] }]);
    await drain(
      createMind(),
      ask({
        messages: [
          { role: "user", content: "早" },
          { role: "developer", content: "memories" },
        ],
        tools: [SELFIE],
      }),
    );
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk");
    expect(seen[0]?.headers.get("x-title")).toBeNull();
    expect(seen[0]?.body).toEqual({
      model: "gpt-6-luna",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "persona" },
        { role: "user", content: "早" },
        { role: "developer", content: "memories" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "take_selfie",
            description: "拍一张自拍",
            parameters: {
              type: "object",
              properties: { scene: { type: "string" } },
              required: ["scene"],
            },
          },
        },
      ],
      reasoning_effort: "none",
    });
  });

  test("each provider's dialect, as its pipedog service sends it", async () => {
    reply = () => completions([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    const view = [
      { role: "user", content: "早" },
      { role: "developer", content: "memories" },
      { role: "system", content: "archive" },
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "recall_streams", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "COMPLETED" },
      { role: "assistant", content: "嗯" },
    ];
    const cases = [
      {
        env: { LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "dk", DEEPSEEK_BASE_URL: base() },
        roles: ["system", "user", "user", "system", "assistant", "tool", "assistant"],
        extra: { model: "deepseek-flash", thinking: { type: "disabled" } },
        reasoning: true,
      },
      {
        env: {
          LLM_PROVIDER: "google",
          GEMINI_API_KEY: "gk",
          GEMINI_BASE_URL: base(),
          LLM_MODEL: "gemini-3.1-flash-lite",
        },
        roles: ["system", "user", "user", "user", "assistant", "tool", "assistant"],
        extra: { model: "gemini-3.1-flash-lite", reasoning_effort: "minimal" },
        reasoning: false,
      },
      {
        env: {
          LLM_PROVIDER: "xai",
          XAI_API_KEY: "xk",
          XAI_BASE_URL: base(),
          LLM_MODEL: "grok-4.3",
        },
        roles: ["system", "user", "user", "system", "assistant", "tool", "assistant"],
        extra: { model: "grok-4.3", reasoning_effort: "none" },
        reasoning: false,
      },
      {
        env: {
          LLM_PROVIDER: "openai-compatible",
          OPENAI_COMPATIBLE_BASE_URL: base(),
          LLM_MODEL: "local-model",
        },
        roles: ["system", "user", "user", "system", "assistant", "tool", "assistant"],
        extra: { model: "local-model" },
        reasoning: false,
      },
    ];
    for (const { env, roles, extra, reasoning } of cases) {
      seen = [];
      setEnv({ LLM_MODEL: undefined, ...env });
      await drain(createMind(), ask({ messages: view }));
      const body = seen[0]?.body ?? {};
      const sent = body.messages as Record<string, unknown>[];
      expect([env.LLM_PROVIDER, sent.map((message) => message.role)]).toEqual([
        env.LLM_PROVIDER,
        roles,
      ]);
      expect(body).toMatchObject(extra);
      expect(
        sent.filter((message) => message.role === "assistant").map((m) => "reasoning_content" in m),
      ).toEqual([reasoning, reasoning]);
      expect(sent[4]?.tool_calls).toEqual(view[3]?.tool_calls);
    }
    expect(seen[0]?.headers.get("authorization")).toBeNull();
  });

  /** A chunk carrying a fragment of call `index`. */
  const call = (index: number, fn: Record<string, string>, id?: string) => ({
    choices: [
      {
        delta: { tool_calls: [{ index, ...(id ? { id, type: "function" } : {}), function: fn }] },
      },
    ],
  });

  test("tool calls are assembled from their fragments, by index, one that won't parse unparsed", async () => {
    setEnv({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk", OPENAI_BASE_URL: base() });
    reply = () =>
      completions([
        { choices: [{ delta: { content: "我拍一张" } }] },
        call(0, { name: "take_selfie", arguments: "" }, "call_a"),
        call(0, { arguments: '{"sce' }),
        call(1, { name: "recall_streams", arguments: '{"query":' }, "call_b"),
        call(0, { arguments: 'ne":"海边"}' }),
        call(1, { arguments: '"猫"}' }),
        call(2, { name: "broken", arguments: "{oops" }, "call_c"),
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);
    const chunks = await drain(createMind(), ask({ tools: [SELFIE] }));
    expect(chunks).toEqual([
      { type: "text", text: "我拍一张" },
      {
        type: "tool-calls",
        calls: [
          { id: "call_a", name: "take_selfie", arguments: { scene: "海边" } },
          { id: "call_b", name: "recall_streams", arguments: { query: "猫" } },
          { id: "call_c", name: "broken", arguments: {}, unparsed: "{oops" },
        ],
      },
      { type: "done", finishReason: "tool_calls" },
    ]);
    expect(logs.map((record) => record.message)).toContain(
      'Failed to parse broken\'s arguments: "{oops"',
    );
  });

  test("arguments that don't parse are logged as a short, escaped head", async () => {
    setEnv({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk", OPENAI_BASE_URL: base() });
    const cut = `{"path":"a.txt","content":"${"第一行\n".repeat(20_000)}`;
    reply = () =>
      completions([
        call(0, { name: "write", arguments: cut }, "call_w"),
        { choices: [{ delta: {}, finish_reason: "length" }] },
      ]);
    await drain(createMind(), ask({ tools: [SELFIE] }));
    const warning = logs.find((record) => record.message.startsWith("Failed to parse"));
    expect(warning?.message).toStartWith(
      'Failed to parse write\'s arguments: "{\\"path\\":\\"a.txt\\",\\"content\\":\\"第一行\\n',
    );
    expect(warning?.message).toEndWith(`… (${cut.length} characters)`);
    expect(warning?.message).not.toContain("\n");
    expect(warning?.message.length).toBeLessThan(400);
  });

  test("a missing key fails before any request", () => {
    for (const value of ["", undefined]) {
      setEnv({ OPENROUTER_API_KEY: value });
      expect(() => createMind()).toThrow("OpenRouter needs an API key: set OPENROUTER_API_KEY");
    }
    expect(seen).toEqual([]);
  });

  test("stop sequences go as `stop`, but not to OpenAI or xAI, whose reasoning models reject it", async () => {
    reply = () => completions([{ choices: [{ delta: { content: "好" }, finish_reason: "stop" }] }]);
    const stop = ["\n露比：", "\n露比:", "\nKen：", "\nKen:"];
    const providers: Record<string, Record<string, string>> = {
      openrouter: {},
      deepseek: { DEEPSEEK_API_KEY: "dk", DEEPSEEK_BASE_URL: base() },
      google: { GEMINI_API_KEY: "gk", GEMINI_BASE_URL: base() },
      "openai-compatible": { OPENAI_COMPATIBLE_BASE_URL: base(), LLM_MODEL: "local-model" },
      openai: { OPENAI_API_KEY: "sk", OPENAI_BASE_URL: base() },
      xai: { XAI_API_KEY: "xk", XAI_BASE_URL: base(), LLM_MODEL: "grok-4.3" },
    };
    const sent: Record<string, unknown> = {};
    for (const [provider, env] of Object.entries(providers)) {
      seen = [];
      setEnv({ LLM_PROVIDER: provider, LLM_MODEL: undefined, ...env });
      await drain(createMind(), ask({ stop }));
      const body = seen[0]?.body ?? {};
      sent[provider] = "stop" in body ? body.stop : "none";
    }
    expect(sent).toEqual({
      openrouter: stop,
      deepseek: stop,
      google: stop,
      "openai-compatible": stop,
      openai: "none",
      xai: "none",
    });
    seen = [];
    setEnv({ LLM_PROVIDER: "deepseek", LLM_MODEL: undefined });
    await drain(createMind(), ask({ stop: [] }));
    expect("stop" in (seen[0]?.body ?? {})).toBe(false);
  });

  test("a provider's refusal rejects the stream with its message", async () => {
    reply = () => Response.json({ error: { message: "no such model" } }, { status: 400 });
    const error = await drain(createMind(), ask()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as Error).message).toContain("no such model");
  });
});

describe("an Anthropic mind", () => {
  beforeEach(() => {
    setEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "ak", ANTHROPIC_BASE_URL: base() });
  });

  const start = { type: "message_start", message: { model: "claude-opus-5-5", usage: {} } };

  test("caching, refusal fallbacks, her lowest effort, and the call's message conversion", async () => {
    reply = () =>
      messages([
        {
          type: "message_start",
          message: {
            model: "claude-opus-5-5",
            usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "的" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ]);
    const chunks = await withUsageScope({ source: "chat", session: "chat-2" }, () =>
      drain(
        createMind(),
        ask({
          messages: [
            { role: "user", content: "早" },
            { role: "system", content: "archive" },
            { role: "assistant", content: "早呀" },
            { role: "developer", content: "memories" },
            { role: "user", content: "拍张照？" },
            {
              role: "assistant",
              tool_calls: [
                {
                  id: "toolu_1",
                  type: "function",
                  function: { name: "take_selfie", arguments: '{"scene":"海边"}' },
                },
              ],
            },
            { role: "tool", tool_call_id: "toolu_1", content: '{"status":"sent"}' },
          ],
          tools: [SELFIE],
        }),
      ),
    );
    expect(chunks).toEqual([
      { type: "text", text: "好" },
      { type: "text", text: "的" },
      { type: "done", finishReason: "end_turn" },
    ]);
    expect(seen[0]?.path).toBe("/v1/messages");
    expect(seen[0]?.headers.get("x-api-key")).toBe("ak");
    expect(seen[0]?.headers.get("anthropic-version")).toBe(ANTHROPIC_VERSION);
    expect(seen[0]?.headers.get("anthropic-beta")).toBe(
      "interleaved-thinking-2025-05-14,server-side-fallback-2026-07-01",
    );
    const marked = { cache_control: { type: "ephemeral" } };
    expect(seen[0]?.body).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 4096,
      stream: true,
      system: [{ type: "text", text: "persona", ...marked }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "早" },
            { type: "text", text: "archive" },
          ],
        },
        { role: "assistant", content: "早呀" },
        {
          role: "user",
          content: [
            { type: "text", text: "memories" },
            { type: "text", text: "拍张照？", ...marked },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "take_selfie", input: { scene: "海边" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: '{"status":"sent"}',
              ...marked,
            },
          ],
        },
      ],
      tools: [
        {
          name: "take_selfie",
          description: "拍一张自拍",
          input_schema: {
            type: "object",
            properties: { scene: { type: "string" } },
            required: ["scene"],
          },
        },
      ],
      fallbacks: "default",
      output_config: { effort: "low" },
    });
    expect(records).toEqual([
      expect.objectContaining({
        role: "mind",
        provider: "anthropic",
        model: "claude-opus-5-5",
        units: { inputTokens: 10, cachedTokens: 5, cacheWriteTokens: 0, outputTokens: 3 },
        source: "chat",
        session: "chat-2",
      }),
    ]);
  });

  test("a model without fallbacks thinks not at all, and never ends a request on her", async () => {
    setEnv({ LLM_MODEL: "claude-haiku-5-5" });
    reply = () => messages([start, { type: "message_delta", delta: { stop_reason: "end_turn" } }]);
    const mind = createMind();
    await drain(
      mind,
      ask({
        system: "",
        messages: [
          { role: "system", content: "archive" },
          { role: "user", content: "早" },
          { role: "assistant", content: "" },
        ],
      }),
    );
    await drain(mind, ask({ messages: [{ role: "system", content: "alone" }] }));
    expect(seen[0]?.headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
    const marked = { cache_control: { type: "ephemeral" } };
    expect(seen[0]?.body).toMatchObject({
      model: "claude-haiku-5-5",
      // With no persona prompt, the first system message is the prompt.
      system: [{ type: "text", text: "archive", ...marked }],
      messages: [
        { role: "user", content: [{ type: "text", text: "早", ...marked }] },
        { role: "assistant", content: "(empty)" },
        { role: "user", content: [{ type: "text", text: ".", ...marked }] },
      ],
      thinking: { type: "disabled" },
    });
    expect(seen[0]?.body.fallbacks).toBeUndefined();
    expect(seen[1]?.body).toMatchObject({
      system: [{ type: "text", text: "persona", ...marked }],
      messages: [{ role: "user", content: [{ type: "text", text: "alone", ...marked }] }],
    });
  });

  test("tool calls are assembled from input deltas, and the next round gets her thinking back", async () => {
    reply = () =>
      messages([
        start,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "她想要照片" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig-1" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "等我" } },
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "toolu_9", name: "take_selfie", input: {} },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"sce' },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: 'ne": "海边"}' },
        },
        {
          type: "content_block_start",
          index: 3,
          content_block: { type: "tool_use", id: "toolu_10", name: "recall_streams", input: {} },
        },
        { type: "message_delta", delta: { stop_reason: "tool_use" } },
      ]);
    const mind = createMind();
    const asked = [{ role: "user", content: "拍张照" }];
    expect(await drain(mind, ask({ messages: asked, tools: [SELFIE] }))).toEqual([
      { type: "text", text: "等我" },
      {
        type: "tool-calls",
        calls: [
          { id: "toolu_9", name: "take_selfie", arguments: { scene: "海边" } },
          { id: "toolu_10", name: "recall_streams", arguments: {} },
        ],
      },
      { type: "done", finishReason: "tool_use" },
    ]);
    const round = [
      ...asked,
      {
        role: "assistant",
        tool_calls: [
          {
            id: "toolu_9",
            type: "function",
            function: { name: "take_selfie", arguments: '{"scene":"海边"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "toolu_9", content: "COMPLETED" },
    ];
    reply = () => messages([start, { type: "message_delta", delta: { stop_reason: "end_turn" } }]);
    await drain(mind, ask({ messages: round, tools: [SELFIE] }));
    await drain(createMind(), ask({ messages: round, tools: [SELFIE] }));
    const toolUse = {
      type: "tool_use",
      id: "toolu_9",
      name: "take_selfie",
      input: { scene: "海边" },
    };
    const call = (request: number) => (seen[request]?.body.messages as unknown[] | undefined)?.[1];
    expect(call(1)).toEqual({
      role: "assistant",
      content: [{ type: "thinking", thinking: "她想要照片", signature: "sig-1" }, toolUse],
    });
    expect(call(2)).toEqual({ role: "assistant", content: [toolUse] });
  });

  describe("thinking sent back", () => {
    const RECALL: ToolSchema = {
      name: "recall_streams",
      description: "回忆直播",
      properties: {},
      required: [],
    };

    const thought = (index: number, thinking: string, signature: string) => [
      {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking } },
      { type: "content_block_delta", index, delta: { type: "signature_delta", signature } },
      { type: "content_block_stop", index },
    ];
    const said = (index: number, text: string) => [
      { type: "content_block_start", index, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index },
    ];
    const called = (index: number, id: string, json: string) => [
      {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id, name: "take_selfie", input: {} },
      },
      {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: json },
      },
      { type: "content_block_stop", index },
    ];
    const stopped = (reason: string) => ({ type: "message_delta", delta: { stop_reason: reason } });

    /** Each request gets the next of `replies`, then a plain end. */
    function replying(...replies: (readonly Record<string, unknown>[])[]): void {
      reply = () => messages([start, ...(replies.shift() ?? [stopped("end_turn")])]);
    }

    const calls = (...ids: string[]) => ({
      role: "assistant",
      tool_calls: ids.map((id) => ({
        id,
        type: "function",
        function: { name: "take_selfie", arguments: `{"scene":"${id}"}` },
      })),
    });
    const result = (id: string, content: string) => ({ role: "tool", tool_call_id: id, content });
    const sent = (request: number) => seen[request]?.body.messages as Record<string, unknown>[];
    const use = (id: string) => ({
      type: "tool_use",
      id,
      name: "take_selfie",
      input: { scene: id },
    });
    const signed = (thinking: string, signature: string) => ({
      type: "thinking",
      thinking,
      signature,
    });

    test("goes back only while everything before it is as it was", async () => {
      replying(
        [
          ...thought(0, "先拍一张", "sig-1"),
          ...called(1, "t1", '{"scene":"t1"}'),
          stopped("tool_use"),
        ],
        [
          ...thought(0, "再拍一张", "sig-2"),
          ...called(1, "t2", '{"scene":"t2"}'),
          stopped("tool_use"),
        ],
      );
      const mind = createMind();
      const asked = [{ role: "user", content: "拍两张" }];
      const first = [...asked, calls("t1"), result("t1", "海边那张")];
      const both = [...first, calls("t2"), result("t2", "山上那张")];
      await drain(mind, ask({ messages: asked, tools: [SELFIE] }));
      await drain(mind, ask({ messages: first, tools: [SELFIE] }));
      await drain(mind, ask({ messages: both, tools: [SELFIE] }));
      expect(sent(2)?.[1]?.content).toEqual([signed("先拍一张", "sig-1"), use("t1")]);
      expect(sent(2)?.[3]?.content).toEqual([signed("再拍一张", "sig-2"), use("t2")]);

      // An earlier result changed, as masking stubs one: only the thinking before it stays valid.
      const masked = [...asked, calls("t1"), result("t1", "[elided]"), calls("t2")];
      await drain(mind, ask({ messages: [...masked, result("t2", "山上那张")], tools: [SELFIE] }));
      expect(sent(3)?.[1]?.content).toEqual([signed("先拍一张", "sig-1"), use("t1")]);
      expect(sent(3)?.[3]?.content).toEqual([use("t2")]);

      // The tools changed, and with them everything after.
      await drain(mind, ask({ messages: both, tools: [SELFIE, RECALL] }));
      expect(sent(4)?.[1]?.content).toEqual([use("t1")]);
      expect(sent(4)?.[3]?.content).toEqual([use("t2")]);
    });

    test("goes back where Claude put it, between its calls too, when the turn says the same", async () => {
      replying([
        ...thought(0, "先看看", "sig-a"),
        ...said(1, "我"),
        ...said(2, "先拍"),
        ...called(3, "t1", '{"scene":"t1"}'),
        ...thought(4, "再来一张", "sig-b"),
        ...called(5, "t2", '{"scene":"t2"}'),
        stopped("tool_use"),
      ]);
      const mind = createMind();
      const asked = [{ role: "user", content: "拍两张" }];
      await drain(mind, ask({ messages: asked, tools: [SELFIE] }));
      const answered = [result("t1", "海边"), result("t2", "山上")];
      // A task sends the reply's text, then its calls: the turn Claude wrote.
      const task = [...asked, { role: "assistant", content: "我先拍" }, calls("t1", "t2")];
      await drain(mind, ask({ messages: [...task, ...answered], tools: [SELFIE] }));
      expect(sent(1)?.[1]?.content).toEqual([
        signed("先看看", "sig-a"),
        { type: "text", text: "我" },
        { type: "text", text: "先拍" },
        use("t1"),
        signed("再来一张", "sig-b"),
        use("t2"),
      ]);
      // Her chat sends the calls alone: thinking between them can't go back without what was
      // before it, so none does.
      await drain(
        mind,
        ask({ messages: [...asked, calls("t1", "t2"), ...answered], tools: [SELFIE] }),
      );
      expect(sent(2)?.[1]?.content).toEqual([use("t1"), use("t2")]);
    });

    test("redacted thinking goes back with the rest", async () => {
      replying([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "redacted_thinking", data: "enc-1" },
        },
        { type: "content_block_stop", index: 0 },
        ...thought(1, "", "sig-2"),
        ...called(2, "t1", '{"scene":"t1"}'),
        stopped("tool_use"),
      ]);
      const mind = createMind();
      const asked = [{ role: "user", content: "拍一张" }];
      await drain(mind, ask({ messages: asked, tools: [SELFIE] }));
      await drain(
        mind,
        ask({ messages: [...asked, calls("t1"), result("t1", "好")], tools: [SELFIE] }),
      );
      expect(sent(1)?.[1]?.content).toEqual([
        { type: "redacted_thinking", data: "enc-1" },
        signed("", "sig-2"),
        use("t1"),
      ]);
    });

    test("a reply the output limit cut off sends its thinking ahead of the calls as answered", async () => {
      replying([...thought(0, "拍", "sig-1"), ...called(1, "t1", '{"sce'), stopped("max_tokens")]);
      const mind = createMind();
      const asked = [{ role: "user", content: "拍一张" }];
      await drain(mind, ask({ messages: asked, tools: [SELFIE] }));
      const unparsed = {
        role: "assistant",
        tool_calls: [
          { id: "t1", type: "function", function: { name: "take_selfie", arguments: "{}" } },
        ],
      };
      await drain(
        mind,
        ask({ messages: [...asked, unparsed, result("t1", "cut off")], tools: [SELFIE] }),
      );
      expect(sent(1)?.[1]?.content).toEqual([
        signed("拍", "sig-1"),
        { type: "tool_use", id: "t1", name: "take_selfie", input: {} },
      ]);
      expect(logs.some((record) => record.message.startsWith("Failed to parse"))).toBe(false);
    });
  });

  test("with no tools offered, her earlier calls and results go as notes in the user's turns", async () => {
    reply = () => messages([start, { type: "message_delta", delta: { stop_reason: "end_turn" } }]);
    const view = [
      { role: "user", content: "温柔一点" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "toolu_1",
            type: "function",
            function: { name: "change_voice_style", arguments: '{"style":"温柔"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "COMPLETED" },
      { role: "assistant", content: "好呀" },
      { role: "user", content: "在干嘛" },
    ];
    await drain(createMind(), ask({ messages: view }));
    const marked = { cache_control: { type: "ephemeral" } };
    expect(seen[0]?.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "温柔一点" },
          { type: "text", text: '（你调用了 change_voice_style {"style":"温柔"}）' },
          { type: "text", text: "（change_voice_style 返回：COMPLETED）", ...marked },
        ],
      },
      { role: "assistant", content: "好呀" },
      { role: "user", content: [{ type: "text", text: "在干嘛", ...marked }] },
    ]);
    expect(seen[0]?.body.tools).toEqual([]);
  });

  test("tools run only when Claude stopped to call them", async () => {
    reply = () =>
      messages([
        start,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "take_selfie", input: {} },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "refusal", stop_details: { category: "cyber" } },
        },
      ]);
    expect(await drain(createMind(), ask())).toEqual([{ type: "done", finishReason: "refusal" }]);
    expect(logs.map((record) => record.message)).toContain(
      "Anthropic's response is incomplete: the model stopped for refusal (cyber)",
    );
  });

  test("a reply the output limit cut off reports its calls unparsed", async () => {
    reply = () =>
      messages([
        start,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "take_selfie", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"scene":"海' },
        },
        { type: "message_delta", delta: { stop_reason: "max_tokens" } },
      ]);
    expect(await drain(createMind(), ask({ tools: [SELFIE] }))).toEqual([
      {
        type: "tool-calls",
        calls: [{ id: "toolu_1", name: "take_selfie", arguments: {}, unparsed: '{"scene":"海' }],
      },
      { type: "done", finishReason: "max_tokens" },
    ]);
  });

  test("stop sequences go as stop_sequences, and stopping at one is no cut", async () => {
    reply = () =>
      messages([
        start,
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好呀" } },
        {
          type: "message_delta",
          delta: { stop_reason: "stop_sequence", stop_sequence: "\n露比：" },
        },
      ]);
    const chunks = await drain(createMind(), ask({ stop: ["\n露比：", "\n露比:"] }));
    await drain(createMind(), ask({ stop: [] }));
    expect(seen[0]?.body.stop_sequences).toEqual(["\n露比：", "\n露比:"]);
    expect("stop_sequences" in (seen[1]?.body ?? {})).toBe(false);
    expect(chunks).toEqual([
      { type: "text", text: "好呀" },
      { type: "done", finishReason: "stop_sequence" },
    ]);
    expect(logs.filter((record) => record.level === "WARNING")).toEqual([]);
  });
});

describe("aborting", () => {
  const cases = [
    {
      family: "OpenAI-compatible",
      env: () => ({}),
      first: `data: ${JSON.stringify({ choices: [{ delta: { content: "嗨" } }] })}\n\n`,
    },
    {
      family: "Anthropic",
      env: () => ({
        LLM_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "ak",
        ANTHROPIC_BASE_URL: base(),
      }),
      first:
        `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "嗨" } })}\n\n`,
    },
  ];

  for (const { family, env, first } of cases) {
    test(`${family}: rejects with the signal's reason mid-stream and stops the response`, async () => {
      setEnv(env());
      let cancelled = false;
      reply = () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(first));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      const controller = new AbortController();
      const reason = new Error("stopped");
      const received: MindChunk[] = [];
      const run = async () => {
        for await (const chunk of createMind().stream(ask({ signal: controller.signal }))) {
          received.push(chunk);
          controller.abort(reason);
        }
      };
      expect(await run().catch((e: unknown) => e)).toBe(reason);
      expect(received).toEqual([{ type: "text", text: "嗨" }]);
      const deadline = performance.now() + 2000;
      while (!cancelled && performance.now() < deadline) await Bun.sleep(5);
      expect(cancelled).toBe(true);
    });
  }

  test("an aborted signal sends nothing", async () => {
    const controller = new AbortController();
    const reason = new Error("gone");
    controller.abort(reason);
    expect(await drain(createMind(), ask({ signal: controller.signal })).catch((e) => e)).toBe(
      reason,
    );
    expect(seen).toEqual([]);
  });
});

describe("a task's mind", () => {
  const done = (usage: Record<string, unknown>) => () =>
    completions([
      { choices: [{ delta: { content: "好" }, finish_reason: "stop" }] },
      { choices: [], usage },
    ]);

  test("fills the assistant role, which nothing fills by default: no provider, then no model", () => {
    setEnv({ LLM_MODEL: "a/b", OPENROUTER_MODEL: "c/d" });
    expect(() => createMind("assistant")).toThrow("No provider fills ASSISTANT_PROVIDER");
    setEnv({ ASSISTANT_PROVIDER: "openrouter" });
    expect(() => createMind("assistant")).toThrow("OpenRouter needs a model: set ASSISTANT_MODEL");
    expect(seen).toEqual([]);
  });

  test("bills as the assistant in its task's scope, and its tap hears each record the ledger does", async () => {
    setEnv({ ASSISTANT_PROVIDER: "openrouter", ASSISTANT_MODEL: "x/task-model" });
    reply = done({ prompt_tokens: 12, completion_tokens: 2, cost: 0.0003 });
    const tapped: UsageRecord[] = [];
    const mind = createMind("assistant", { tap: (record) => tapped.push(record) });
    await withUsageScope({ source: "task", session: "task-1" }, () => drain(mind, ask()));
    expect(seen[0]?.body.model).toBe("x/task-model");
    expect(records).toEqual([
      expect.objectContaining({
        role: "assistant",
        category: "llm",
        provider: "openrouter",
        model: "x/task-model",
        costUsd: 0.0003,
        costSource: "reported",
        source: "task",
        session: "task-1",
      }),
    ]);
    expect(tapped).toEqual(records);
  });

  test("an estimated cost reaches the tap as the ledger records it", async () => {
    setEnv({
      ASSISTANT_PROVIDER: "deepseek",
      ASSISTANT_MODEL: "deepseek-v4-pro",
      DEEPSEEK_API_KEY: "dk",
      DEEPSEEK_BASE_URL: base(),
    });
    reply = done({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    const tapped: UsageRecord[] = [];
    await drain(createMind("assistant", { tap: (record) => tapped.push(record) }), ask());
    expect(records).toEqual([
      expect.objectContaining({ role: "assistant", costSource: "estimated" }),
    ]);
    expect(records[0]?.costUsd).toBeCloseTo(1.32 + 3.96, 10);
    expect(tapped).toEqual(records);
  });

  test("an account and a model for this mind alone take the role's place", async () => {
    setEnv({
      ASSISTANT_PROVIDER: "openrouter",
      ASSISTANT_MODEL: "x/task-model",
      DEEPSEEK_API_KEY: "dk",
      DEEPSEEK_BASE_URL: base(),
    });
    reply = done({ prompt_tokens: 1, completion_tokens: 1 });
    await drain(createMind("assistant", { model: "x/other" }), ask());
    await drain(createMind("assistant", { account: "DeepSeek", model: "deepseek-flash" }), ask());
    expect(
      seen.map((request) => [request.body.model, request.headers.get("authorization")]),
    ).toEqual([
      ["x/other", "Bearer or-key"],
      ["deepseek-flash", "Bearer dk"],
    ]);
    expect(records.map((record) => [record.role, record.provider])).toEqual([
      ["assistant", "openrouter"],
      ["assistant", "deepseek"],
    ]);
    // The role's model belongs to its own provider, so another account brings none.
    expect(() => createMind("assistant", { account: "deepseek" })).toThrow(
      "DeepSeek needs a model: set ASSISTANT_MODEL",
    );
    expect(createMind("assistant", { account: "openrouter" })).toBeDefined();
  });

  test("a task can pick its account and model while the settings name none", async () => {
    reply = done({ prompt_tokens: 1, completion_tokens: 1 });
    await drain(createMind("assistant", { account: "openrouter", model: "x/picked" }), ask());
    expect(seen[0]?.body.model).toBe("x/picked");
    expect(records.map((record) => record.role)).toEqual(["assistant"]);
  });

  test("an override fails as the settings would: an unknown account, a missing key", () => {
    setEnv({ ASSISTANT_PROVIDER: "openrouter", ASSISTANT_MODEL: "x/task-model" });
    expect(() => createMind("assistant", { account: "nope" })).toThrow(
      "ASSISTANT_PROVIDER=nope is no provider or account Eidolon knows",
    );
    expect(() =>
      createMind("assistant", { account: "anthropic", model: "claude-sonnet-5-5" }),
    ).toThrow("Anthropic needs an API key: set ANTHROPIC_API_KEY");
    expect(seen).toEqual([]);
  });

  test("on Anthropic, a task's reply may run to 64,000 tokens, while hers stays at 4,096", async () => {
    setEnv({ ANTHROPIC_API_KEY: "ak", ANTHROPIC_BASE_URL: base(), LLM_PROVIDER: "anthropic" });
    reply = () =>
      messages([
        { type: "message_start", message: { model: "claude-sonnet-4-5", usage: {} } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
      ]);
    const task = createMind("assistant", { account: "anthropic", model: "claude-sonnet-4-5" });
    await drain(task, ask());
    await drain(createMind("mind", { model: "claude-sonnet-4-5" }), ask());
    expect(seen.map((request) => request.body.max_tokens)).toEqual([64_000, 4096]);
  });

  test("her mind takes the same overrides, and still bills as her mind", async () => {
    reply = done({ prompt_tokens: 1, completion_tokens: 1, cost: 0 });
    const tapped: UsageRecord[] = [];
    await drain(createMind("mind", { model: "x/hers", tap: (r) => tapped.push(r) }), ask());
    expect(seen[0]?.body.model).toBe("x/hers");
    expect(tapped.map((record) => [record.role, record.model])).toEqual([["mind", "x/hers"]]);
  });
});
