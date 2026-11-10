import "../../config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UserContext } from "@eidolon/access";
import {
  CHAT_FORMAT,
  CHAT_WINDOW_MESSAGES,
  type ChatEvent,
  type ChatEventDraft,
  type ChatHeader,
  stampEvents,
  type ViewMessage,
  viewOf,
} from "@eidolon/chat";
import {
  activePersona,
  consoleSink,
  dataHome,
  errorText,
  type LogLevel,
  type LogRecord,
  logger,
} from "@eidolon/config";
import {
  buildGreetingKickoff,
  GATE_FRAME_KEY,
  GATE_QUESTIONS,
  type GateDecision,
  GREETING_KICKOFF,
  RECALL_TOOL_NAME,
  RetrievalGate,
  StreamArchive,
  TIMELINE_QUESTIONS,
} from "@eidolon/context";
import type { ContextProvider, LlmTool, ToolResult, TurnGate } from "@eidolon/core";
import { usageRecord } from "@eidolon/providers";
import { broadcast, FakeRetriever, MemoryCatalog, TODAY } from "../../context/test/helpers.ts";
import { type PartsDeps, personaParts } from "../src/parts.ts";
import { MAX_ROUNDS, runTurn } from "../src/turn.ts";
import type {
  EngineDeps,
  LateTools,
  Mind,
  MindChunk,
  MindRequest,
  PersonaParts,
  TurnOutput,
  TurnRequest,
} from "../src/types.ts";

const PERSONA = "alice";
const HEADER: ChatHeader = {
  format: CHAT_FORMAT,
  id: "0190f5c8-0000-7000-8000-000000000000",
  createdAt: 0,
  participants: [PERSONA],
};
const VIEWER: UserContext = { mid: 0, uname: "Ken", face: null, isLoggedIn: true };
const DONE: MindChunk = { type: "done", finishReason: "stop" };

beforeAll(() => {
  const dir = join(dataHome(), "personas", PERSONA);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "persona.yaml"), "identity:\n  name: Alice\n");
});
afterAll(() => {
  rmSync(join(dataHome(), "personas", PERSONA), { recursive: true, force: true });
});

const logs: LogRecord[] = [];
function messages(level: LogLevel): string[] {
  return logs.filter((record) => record.level === level).map((record) => record.message);
}
beforeEach(() => {
  logger.setSink((record) => logs.push(record));
});
afterEach(() => {
  logs.length = 0;
  logger.setSink(consoleSink);
});

const user = (text: string): ChatEventDraft => ({
  type: "message",
  id: `u-${text}`,
  speaker: { kind: "user" },
  text,
});
const alice = (text: string): ChatEventDraft => ({
  type: "message",
  id: `a-${text}`,
  speaker: { kind: "persona", id: PERSONA },
  text,
});

function chat(...drafts: ChatEventDraft[]): TurnRequest["chat"] {
  return { header: HEADER, events: stampEvents(drafts, 0, 1000) };
}

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    chat: chat(user("你好")),
    persona: PERSONA,
    viewer: VIEWER,
    signal: new AbortController().signal,
    ...overrides,
  };
}

type Round = readonly MindChunk[] | ((request: MindRequest) => AsyncIterable<MindChunk>);

/** A mind that answers its nth call with `rounds[n]`, and with nothing after them. */
function fakeMind(...rounds: Round[]): { mind: Mind; requests: MindRequest[] } {
  const requests: MindRequest[] = [];
  const mind: Mind = {
    async *stream(request) {
      requests.push(request);
      const round = rounds[requests.length - 1] ?? [DONE];
      if (typeof round === "function") yield* round(request);
      else yield* round;
    },
  };
  return { mind, requests };
}

function parts(overrides: Partial<PersonaParts> = {}): PersonaParts {
  return {
    systemInstruction: "SYSTEM",
    providers: [],
    gate: null,
    tools: [],
    memories: async () => [],
    ...overrides,
  };
}

function deps(mind: Mind, persona: PersonaParts, overrides: Partial<EngineDeps> = {}): EngineDeps {
  let n = 0;
  return {
    createMind: () => mind,
    parts: async () => persona,
    saveAttachment: async (bytes, mime) => ({
      kind: "image",
      name: `${new TextDecoder().decode(bytes)}.png`,
      mime,
    }),
    fetchImage: async (url) => ({
      bytes: new TextEncoder().encode(url.slice(-1)),
      mime: "image/png",
    }),
    newId: () => `id-${++n}`,
    speech: {
      canSpeak: () => false,
      synthesize: () => Promise.reject(new Error("no voice here")),
      transcribe: () => Promise.reject(new Error("no ears here")),
    },
    ...overrides,
  };
}

async function collect(outputs: AsyncIterable<TurnOutput>): Promise<TurnOutput[]> {
  const all: TurnOutput[] = [];
  for await (const output of outputs) all.push(output);
  return all;
}

function eventsOf(outputs: readonly TurnOutput[]): ChatEventDraft[] {
  return outputs.flatMap((output) => (output.type === "events" ? [...output.events] : []));
}

function viewAfter(log: readonly ChatEvent[], outputs: readonly TurnOutput[]) {
  const events = [...log, ...stampEvents(eventsOf(outputs), log.length, 2000)];
  return viewOf(HEADER, events, PERSONA, {
    windowMessages: CHAT_WINDOW_MESSAGES,
    nameOf: (id) => id,
  });
}

function tool(name: string, run: LlmTool["run"], timeoutSecs: number | null = null): LlmTool {
  return {
    schema: { name, description: name, properties: {}, required: [] },
    cancelOnInterruption: true,
    timeoutSecs,
    run,
  };
}

const call = (id: string, name: string, args: Record<string, unknown> = {}): MindChunk => ({
  type: "tool-calls",
  calls: [{ id, name, arguments: args }],
});

describe("runTurn", () => {
  test("streams her reply and records it as one message", async () => {
    const { mind, requests } = fakeMind([
      { type: "text", text: "你" },
      { type: "text", text: "好呀" },
      DONE,
    ]);
    const outputs = await collect(runTurn(request(), deps(mind, parts())));
    expect(outputs).toEqual([
      { type: "started", turn: "id-1", persona: PERSONA },
      { type: "delta", turn: "id-1", text: "你" },
      { type: "delta", turn: "id-1", text: "好呀" },
      {
        type: "events",
        events: [
          {
            type: "message",
            id: "id-2",
            speaker: { kind: "persona", id: PERSONA },
            text: "你好呀",
          },
        ],
      },
      { type: "ended", turn: "id-1" },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.system).toBe("SYSTEM");
    expect(requests[0]?.messages).toEqual([{ role: "user", content: "你好" }]);
    expect(requests[0]?.tools).toEqual([]);
  });

  test("marks a reply the provider stopped short as cut off, and why", async () => {
    for (const [finishReason, cutOff] of [
      ["length", "length"],
      ["max_tokens", "length"],
      ["content_filter", "refusal"],
      ["refusal", "refusal"],
      ["stop", undefined],
      ["end_turn", undefined],
      [null, undefined],
    ] as const) {
      const { mind } = fakeMind([
        { type: "text", text: "说到一半" },
        { type: "done", finishReason },
      ]);
      const [message] = eventsOf(await collect(runTurn(request(), deps(mind, parts()))));
      expect([finishReason, message]).toEqual([
        finishReason,
        {
          type: "message",
          id: "id-2",
          speaker: { kind: "persona", id: PERSONA },
          text: "说到一半",
          ...(cutOff === undefined ? {} : { cutOff }),
        },
      ]);
    }
  });

  test("keeps a refusal with no words as an empty message, cut off", async () => {
    const { mind } = fakeMind([{ type: "done", finishReason: "refusal" }]);
    const outputs = await collect(runTurn(request(), deps(mind, parts())));
    expect(eventsOf(outputs)).toEqual([
      {
        type: "message",
        id: "id-2",
        speaker: { kind: "persona", id: PERSONA },
        text: "",
        cutOff: "refusal",
      },
    ]);
  });

  test("a block a provider replaces leaves the next turn only the new one", async () => {
    let turns = 0;
    // As the stream archive's setBlock: every block with its prefix out, the new one in.
    const replacing: ContextProvider = {
      onContext: async ({ context }) => {
        turns++;
        const kept = context
          .getMessages()
          .filter(
            (message) => !String((message as { content?: unknown }).content).startsWith("概览："),
          );
        kept.splice(1, 0, { role: "system", content: `概览：${turns}` });
        context.setMessages(kept);
      },
      errorMessage: () => "",
    };
    const persona = parts({ providers: [{ label: "Archive", provider: replacing }] });
    const log = chat(user("一"));
    const first = fakeMind([{ type: "text", text: "嗯" }, DONE]);
    const answered = await collect(runTurn(request({ chat: log }), deps(first.mind, persona)));
    let events = [...log.events, ...stampEvents(eventsOf(answered), log.events.length, 2000)];
    events = [...events, ...stampEvents([user("二")], events.length, 3000)];

    const second = fakeMind([{ type: "text", text: "好" }, DONE]);
    const outputs = await collect(
      runTurn(request({ chat: { header: HEADER, events } }), deps(second.mind, persona)),
    );
    const seen: ViewMessage[] = [
      { role: "user", content: "一" },
      { role: "system", content: "概览：2" },
      { role: "assistant", content: "嗯" },
      { role: "user", content: "二" },
    ];
    expect(second.requests[0]?.messages).toEqual(seen);
    expect(eventsOf(outputs)[0]).toEqual({
      type: "context-removed",
      persona: PERSONA,
      turn: "id-1",
      seqs: [2],
    });
    expect(viewAfter(events, outputs)).toEqual([...seen, { role: "assistant", content: "好" }]);
  });

  test("hands the mind her view of the chat", async () => {
    const log = chat(user("早"), alice("早呀"), user("今天播吗"));
    const { mind, requests } = fakeMind([DONE]);
    await collect(runTurn(request({ chat: log }), deps(mind, parts())));
    expect(requests[0]?.messages).toEqual(
      viewOf(HEADER, log.events, PERSONA, {
        windowMessages: CHAT_WINDOW_MESSAGES,
        nameOf: (id) => id,
      }),
    );
  });

  test("runs as her, in the chat's usage scope, spawned jobs included", async () => {
    const seen: Record<string, unknown> = {};
    const { promise: stored, resolve } = Promise.withResolvers<string>();
    const mind: Mind = {
      async *stream() {
        seen.mind = activePersona().id;
        const record = usageRecord({ role: "mind", provider: "openrouter", model: "m", units: {} });
        seen.usage = [record.source, record.session];
        yield DONE;
      },
    };
    const memory: ContextProvider = {
      onContext: async (turn) => {
        turn.spawn("mem0_store", async () => resolve(activePersona().id));
      },
      errorMessage: () => "",
    };
    await collect(
      runTurn(
        request(),
        deps(mind, parts(), {
          parts: async (_persona, _viewer, chat) => {
            seen.parts = [activePersona().id, chat.header.id];
            return parts({ providers: [{ label: "Mem0", provider: memory }] });
          },
        }),
      ),
    );
    expect(activePersona().id).not.toBe(PERSONA);
    expect(seen).toEqual({
      parts: [PERSONA, HEADER.id],
      mind: PERSONA,
      usage: ["chat", HEADER.id],
    });
    expect(await stored).toBe(PERSONA);
  });

  test("attaches the gate, runs each provider and records what they insert", async () => {
    const order: string[] = [];
    const gate: TurnGate = {
      attach: (messages, metadata) => {
        order.push(`gate:${messages.length}`);
        metadata.decision = "search";
      },
    };
    const insert = (label: string, at: number, message: object): ContextProvider => ({
      onContext: async ({ context, metadata }) => {
        order.push(`${label}:${metadata.decision}`);
        const list = context.getMessages();
        list.splice(at, 0, message);
        context.setMessages(list);
      },
      errorMessage: () => "",
    });
    const broken: ContextProvider = {
      onContext: async () => {
        throw new Error("boom");
      },
      errorMessage: (e) => `Broken error: ${errorText(e)}`,
    };
    const log = chat(user("你好"));
    const { mind, requests } = fakeMind([{ type: "text", text: "嗨" }, DONE]);
    const outputs = await collect(
      runTurn(
        request({ chat: log }),
        deps(
          mind,
          parts({
            gate,
            providers: [
              {
                label: "Mem0",
                provider: insert("mem0", 1, { role: "developer", content: "记得" }),
              },
              { label: "Broken", provider: broken },
              {
                label: "Archive",
                provider: insert("archive", 2, { role: "system", content: "片段" }),
              },
            ],
          }),
        ),
      ),
    );
    expect(order).toEqual(["gate:1", "mem0:search", "archive:search"]);
    expect(messages("ERROR")).toEqual(["Broken: Broken error: boom"]);
    expect(eventsOf(outputs)).toEqual([
      {
        type: "context",
        persona: PERSONA,
        turn: "id-1",
        position: 1,
        role: "developer",
        content: "记得",
      },
      {
        type: "context",
        persona: PERSONA,
        turn: "id-1",
        position: 2,
        role: "system",
        content: "片段",
      },
      { type: "message", id: "id-2", speaker: { kind: "persona", id: PERSONA }, text: "嗨" },
    ]);
    expect(requests[0]?.messages).toEqual([
      { role: "user", content: "你好" },
      { role: "developer", content: "记得" },
      { role: "system", content: "片段" },
    ]);
    // The next turn's view is what this one saw, then her reply.
    expect(viewAfter(log.events, outputs)).toEqual([
      ...((requests[0]?.messages ?? []) as never[]),
      { role: "assistant", content: "嗨" },
    ]);
  });

  test("greets with the kickoff prompt, mentioning what she remembers", async () => {
    const { mind, requests } = fakeMind([{ type: "text", text: "又见面啦" }, DONE]);
    const memories = [{ memory: "喜欢猫" }];
    const seenByProvider: unknown[] = [];
    const provider: ContextProvider = {
      onContext: async ({ context }) => {
        seenByProvider.push(...context.getMessages());
      },
      errorMessage: () => "",
    };
    const outputs = await collect(
      runTurn(
        request({ chat: chat(), kickoff: true }),
        deps(
          mind,
          parts({ memories: async () => memories, providers: [{ label: "p", provider }] }),
        ),
      ),
    );
    const content = buildGreetingKickoff(memories);
    expect(content).not.toBe(GREETING_KICKOFF);
    expect(eventsOf(outputs)).toEqual([
      { type: "kickoff", persona: PERSONA, turn: "id-1", content },
      { type: "message", id: "id-2", speaker: { kind: "persona", id: PERSONA }, text: "又见面啦" },
    ]);
    expect(requests[0]?.messages).toEqual([{ role: "user", content }]);
    expect(seenByProvider).toEqual([{ role: "user", content }]);
  });

  test("greets plainly when her memories can't be read", async () => {
    const { mind } = fakeMind([DONE]);
    const outputs = await collect(
      runTurn(
        request({ chat: chat(), kickoff: true }),
        deps(
          mind,
          parts({
            memories: async () => {
              throw new Error("qdrant down");
            },
          }),
        ),
      ),
    );
    expect(eventsOf(outputs)).toEqual([
      { type: "kickoff", persona: PERSONA, turn: "id-1", content: GREETING_KICKOFF },
    ]);
    expect(messages("WARNING")).toEqual(["Could not load Mem0 memories for greeting: qdrant down"]);
  });

  test("runs a tool, keeps its selfie and calls the mind again", async () => {
    const fetched: string[] = [];
    const selfie = tool("take_selfie", async (_call, effects) => {
      await effects.sendServerMessage({ type: "selfie", urls: ["/api/selfie/a.png"] });
      return { ok: true, count: 1 };
    });
    const { mind, requests } = fakeMind(
      [{ type: "text", text: "等我一下" }, call("call-1", "take_selfie"), DONE],
      [{ type: "text", text: "拍好啦" }, DONE],
    );
    const log = chat(user("发张自拍"));
    const outputs = await collect(
      runTurn(
        request({ chat: log }),
        deps(mind, parts({ tools: [selfie] }), {
          fetchImage: async (url) => {
            fetched.push(url);
            return { bytes: new TextEncoder().encode("a"), mime: "image/png" };
          },
        }),
      ),
    );
    expect(fetched).toEqual(["/api/selfie/a.png"]);
    expect(outputs).toEqual([
      { type: "started", turn: "id-1", persona: PERSONA },
      { type: "delta", turn: "id-1", text: "等我一下" },
      {
        type: "events",
        events: [
          {
            type: "tool-call",
            persona: PERSONA,
            turn: "id-1",
            callId: "call-1",
            name: "take_selfie",
            arguments: {},
          },
        ],
      },
      { type: "tool", turn: "id-1", name: "take_selfie", state: "running" },
      {
        type: "events",
        events: [
          {
            type: "tool-result",
            persona: PERSONA,
            turn: "id-1",
            callId: "call-1",
            result: { ok: true, count: 1 },
          },
        ],
      },
      { type: "tool", turn: "id-1", name: "take_selfie", state: "done" },
      { type: "delta", turn: "id-1", text: "拍好啦" },
      {
        type: "events",
        events: [
          {
            type: "message",
            id: "id-2",
            speaker: { kind: "persona", id: PERSONA },
            text: "等我一下拍好啦",
            attachments: [{ kind: "image", name: "a.png", mime: "image/png" }],
          },
        ],
      },
      { type: "ended", turn: "id-1" },
    ]);
    expect(requests.map((r) => r.tools)).toEqual([[selfie.schema], [selfie.schema]]);
    const toolCall = {
      role: "assistant",
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "take_selfie", arguments: "{}" } },
      ],
    };
    expect(requests[1]?.messages).toEqual([
      { role: "user", content: "发张自拍" },
      toolCall,
      { role: "tool", tool_call_id: "call-1", content: '{"ok": true, "count": 1}' },
      { role: "assistant", content: "等我一下" },
    ]);
    expect(viewAfter(log.events, outputs)).toEqual([
      { role: "user", content: "发张自拍" },
      toolCall,
      { role: "tool", tool_call_id: "call-1", content: '{"ok": true, "count": 1}' },
      { role: "assistant", content: "等我一下拍好啦" },
    ] as never);
  });

  test(`stops calling the mind after ${MAX_ROUNDS} rounds`, async () => {
    let runs = 0;
    const recall = tool("recall_streams", async () => {
      runs++;
      return {};
    });
    const always = (): AsyncIterable<MindChunk> =>
      (async function* () {
        yield call(`call-${runs}`, "recall_streams");
        yield DONE;
      })();
    const { mind, requests } = fakeMind(always, always, always, always, always);
    const outputs = await collect(runTurn(request(), deps(mind, parts({ tools: [recall] }))));
    expect(requests).toHaveLength(MAX_ROUNDS);
    expect(runs).toBe(MAX_ROUNDS - 1);
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call-0",
      content: "COMPLETED",
    });
    expect(messages("WARNING")).toEqual([
      `[chat] ${PERSONA} called recall_streams after ${MAX_ROUNDS} rounds; not run`,
    ]);
    expect(outputs.at(-1)).toEqual({ type: "ended", turn: "id-1" });
  });

  test("answers a missing, a failing and a timed-out tool as pipedog does", async () => {
    const thrower = tool("thrower", async () => {
      throw new Error("kaput");
    });
    const sleeper = tool(
      "sleeper",
      ({ signal }) =>
        new Promise<ToolResult>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
      0.02,
    );
    const { mind, requests } = fakeMind(
      [
        {
          type: "tool-calls",
          calls: [
            { id: "c1", name: "ghost", arguments: {} },
            { id: "c2", name: "thrower", arguments: { x: 1 } },
            { id: "c3", name: "sleeper", arguments: {} },
          ],
        },
        DONE,
      ],
      [{ type: "text", text: "嗯" }, DONE],
    );
    const outputs = await collect(
      runTurn(request(), deps(mind, parts({ tools: [thrower, sleeper] }))),
    );
    const missing = { error: "The function `ghost` is not currently available." };
    const failed = { error: "The function `thrower` failed and returned no result." };
    expect(requests[1]?.messages.filter((m) => (m as { role: string }).role === "tool")).toEqual([
      { role: "tool", tool_call_id: "c1", content: `{"error": "${missing.error}"}` },
      { role: "tool", tool_call_id: "c2", content: `{"error": "${failed.error}"}` },
      { role: "tool", tool_call_id: "c3", content: "CANCELLED" },
    ]);
    const results = eventsOf(outputs).filter((event) => event.type === "tool-result");
    expect(results.map((event) => [event.callId, event.result])).toEqual([
      ["c1", missing],
      ["c2", failed],
    ]);
    expect(
      outputs
        .filter((output) => output.type === "tool")
        .map((output) => [output.name, output.state]),
    ).toEqual([
      ["ghost", "running"],
      ["ghost", "failed"],
      ["thrower", "running"],
      ["sleeper", "running"],
      ["thrower", "failed"],
      ["sleeper", "failed"],
    ]);
    expect(messages("ERROR")).toEqual(["[chat] thrower failed: kaput"]);
    expect(messages("WARNING")).toEqual([
      `[chat] ${PERSONA} called ghost, which she doesn't have`,
      "[chat] sleeper timed out after 0.02 seconds and was cancelled",
    ]);
  });

  test("advertises only the tools a provider left visible", async () => {
    const recall = tool("recall_streams", async () => ({}));
    const selfie = tool("take_selfie", async () => ({}));
    const hider: ContextProvider = {
      onContext: async ({ context }) => context.setHiddenTools(["recall_streams"]),
      errorMessage: () => "",
    };
    const { mind, requests } = fakeMind([DONE]);
    await collect(
      runTurn(
        request(),
        deps(
          mind,
          parts({ tools: [selfie, recall], providers: [{ label: "h", provider: hider }] }),
        ),
      ),
    );
    expect(requests[0]?.tools).toEqual([selfie.schema]);
  });

  test("keeps what was streamed when the turn is aborted", async () => {
    const controller = new AbortController();
    const { mind } = fakeMind(async function* () {
      yield { type: "text", text: "说到一半" };
      controller.abort();
      yield { type: "text", text: "不该有" };
    });
    const outputs = await collect(
      runTurn(request({ signal: controller.signal }), deps(mind, parts())),
    );
    expect(eventsOf(outputs)).toEqual([
      {
        type: "message",
        id: "id-2",
        speaker: { kind: "persona", id: PERSONA },
        text: "说到一半",
        interrupted: true,
      },
    ]);
    expect(outputs.at(-1)).toEqual({ type: "ended", turn: "id-1" });
  });

  test("stores nothing for an aborted turn that said nothing", async () => {
    const controller = new AbortController();
    const recall = tool(
      "recall_streams",
      ({ signal }) =>
        new Promise<ToolResult>((_, reject) => {
          controller.abort();
          reject(signal.reason);
        }),
    );
    const { mind } = fakeMind([call("c1", "recall_streams"), DONE]);
    const outputs = await collect(
      runTurn(request({ signal: controller.signal }), deps(mind, parts({ tools: [recall] }))),
    );
    expect(eventsOf(outputs).map((event) => event.type)).toEqual(["tool-call"]);
    expect(outputs.at(-1)).toEqual({ type: "ended", turn: "id-1" });
  });

  test("records a failure, keeping what was streamed before it", async () => {
    const { mind } = fakeMind(async function* () {
      yield { type: "text", text: "半句" };
      throw new Error("upstream 500");
    });
    const outputs = await collect(runTurn(request(), deps(mind, parts())));
    expect(eventsOf(outputs)).toEqual([
      {
        type: "message",
        id: "id-2",
        speaker: { kind: "persona", id: PERSONA },
        text: "半句",
        interrupted: true,
      },
      { type: "turn-failed", persona: PERSONA, turn: "id-1", error: "upstream 500" },
    ]);
    expect(messages("ERROR")).toEqual([`[chat] ${PERSONA}'s turn id-1 failed: upstream 500`]);
  });

  test("records a turn that can't start as failed", async () => {
    const { mind } = fakeMind([DONE]);
    const outputs = await collect(
      runTurn(
        request(),
        deps(mind, parts(), {
          createMind: () => {
            throw new Error("Set OPENROUTER_API_KEY");
          },
        }),
      ),
    );
    expect(outputs).toEqual([
      { type: "started", turn: "id-1", persona: PERSONA },
      {
        type: "events",
        events: [
          { type: "turn-failed", persona: PERSONA, turn: "id-1", error: "Set OPENROUTER_API_KEY" },
        ],
      },
      { type: "ended", turn: "id-1" },
    ]);
  });

  test("aborts the turn when its reader stops reading", async () => {
    const { promise: aborted, resolve } = Promise.withResolvers<void>();
    const { mind } = fakeMind(async function* (request) {
      request.signal.addEventListener("abort", () => resolve());
      yield { type: "text", text: "嗨" };
      await aborted;
    });
    for await (const output of runTurn(request(), deps(mind, parts()))) {
      if (output.type === "delta") break;
    }
    await aborted;
  });
});

describe("a tool that runs on past an interruption", () => {
  function takeLate() {
    const added: { name: string; events: Promise<readonly ChatEventDraft[]> }[] = [];
    const cancel = new AbortController();
    const late: LateTools = {
      signal: cancel.signal,
      add: (name, events) => {
        added.push({ name, events });
      },
    };
    return { added, cancel, late };
  }

  const runsOn = (tool: LlmTool): LlmTool => ({ ...tool, cancelOnInterruption: false });

  const photoDeps = (mind: Mind, persona: PersonaParts): EngineDeps =>
    deps(mind, persona, {
      fetchImage: async () => ({ bytes: new TextEncoder().encode("a"), mime: "image/png" }),
    });

  test("keeps running when its turn is interrupted, and its photos come later from her", async () => {
    const controller = new AbortController();
    const rendered = Promise.withResolvers<void>();
    let toolSignal: AbortSignal | undefined;
    const selfie = runsOn(
      tool(
        "take_selfie",
        async ({ signal }, effects) => {
          toolSignal = signal;
          controller.abort();
          await rendered.promise;
          await effects.sendServerMessage({ type: "selfie", urls: ["/api/selfie/a.png"] });
          return { ok: true, count: 1 };
        },
        120,
      ),
    );
    const { mind, requests } = fakeMind([
      { type: "text", text: "等我一下" },
      call("call-1", "take_selfie"),
      DONE,
    ]);
    const { added, late } = takeLate();
    const log = chat(user("发张自拍"));
    const outputs = await collect(
      runTurn(
        request({ chat: log, signal: controller.signal, late }),
        photoDeps(mind, parts({ tools: [selfie] })),
      ),
    );
    const speaker = { kind: "persona", id: PERSONA } as const;
    expect(eventsOf(outputs)).toEqual([
      {
        type: "tool-call",
        persona: PERSONA,
        turn: "id-1",
        callId: "call-1",
        name: "take_selfie",
        arguments: {},
      },
      { type: "message", id: "id-2", speaker, text: "等我一下", interrupted: true },
    ]);
    expect(outputs.at(-1)).toEqual({ type: "ended", turn: "id-1" });
    expect(requests).toHaveLength(1);
    expect(added.map((entry) => entry.name)).toEqual(["take_selfie"]);
    expect(toolSignal?.aborted).toBe(false);

    rendered.resolve();
    const brought = await (added[0] as (typeof added)[number]).events;
    expect(brought).toEqual([
      {
        type: "tool-result",
        persona: PERSONA,
        turn: "id-1",
        callId: "call-1",
        result: { ok: true, count: 1 },
      },
      {
        type: "message",
        id: "id-3",
        speaker,
        text: "",
        attachments: [{ kind: "image", name: "a.png", mime: "image/png" }],
      },
    ]);

    // Stored after the viewer's next line, it answers her call; the photo adds no line to her view.
    const stored = [...log.events, ...stampEvents(eventsOf(outputs), log.events.length, 2000)];
    const next = [...stored, ...stampEvents([user("好了吗")], stored.length, 3000)];
    const events = [...next, ...stampEvents(brought, next.length, 4000)];
    expect(
      viewOf(HEADER, events, PERSONA, { windowMessages: CHAT_WINDOW_MESSAGES, nameOf: (id) => id }),
    ).toEqual([
      { role: "user", content: "发张自拍" },
      {
        role: "assistant",
        tool_calls: [
          { id: "call-1", type: "function", function: { name: "take_selfie", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: '{"ok": true, "count": 1}' },
      { role: "assistant", content: "等我一下" },
      { role: "user", content: "好了吗" },
    ]);
  });

  test("is cancelled with its turn when nothing takes it, as a cancellable tool always is", async () => {
    for (const [cancelOnInterruption, taken] of [
      [false, false],
      [true, true],
    ] as const) {
      const controller = new AbortController();
      let toolSignal: AbortSignal | undefined;
      const selfie: LlmTool = {
        ...tool("take_selfie", ({ signal }) => {
          toolSignal = signal;
          controller.abort();
          return new Promise<ToolResult>(() => {});
        }),
        cancelOnInterruption,
      };
      const { mind } = fakeMind([call("c1", "take_selfie"), DONE]);
      const { added, late } = takeLate();
      const outputs = await collect(
        runTurn(
          request({ signal: controller.signal, ...(taken ? { late } : {}) }),
          deps(mind, parts({ tools: [selfie] })),
        ),
      );
      expect([cancelOnInterruption, toolSignal?.aborted, added]).toEqual([
        cancelOnInterruption,
        true,
        [],
      ]);
      expect(eventsOf(outputs).map((event) => event.type)).toEqual(["tool-call"]);
    }
  });

  test("stops at its own timeout, keeping only the photos it took", async () => {
    const controller = new AbortController();
    const ended = Promise.withResolvers<void>();
    const selfie = runsOn(
      tool(
        "take_selfie",
        async (_call, effects) => {
          controller.abort();
          await ended.promise;
          await effects.sendServerMessage({ type: "selfie", urls: ["/api/selfie/a.png"] });
          return new Promise<ToolResult>(() => {});
        },
        0.2,
      ),
    );
    const { mind } = fakeMind([call("c1", "take_selfie"), DONE]);
    const { added, late } = takeLate();
    await collect(
      runTurn(
        request({ signal: controller.signal, late }),
        photoDeps(mind, parts({ tools: [selfie] })),
      ),
    );
    ended.resolve();
    expect(await (added[0] as (typeof added)[number]).events).toEqual([
      {
        type: "message",
        id: "id-2",
        speaker: { kind: "persona", id: PERSONA },
        text: "",
        attachments: [{ kind: "image", name: "a.png", mime: "image/png" }],
      },
    ]);
    expect(messages("WARNING")).toEqual([
      "[chat] take_selfie timed out after 0.2 seconds and was cancelled",
    ]);
  });

  test("stops when the chat cancels it, bringing nothing", async () => {
    const controller = new AbortController();
    let toolSignal: AbortSignal | undefined;
    const selfie = runsOn(
      tool("take_selfie", ({ signal }) => {
        toolSignal = signal;
        controller.abort();
        return new Promise<ToolResult>(() => {});
      }),
    );
    const { mind } = fakeMind([call("c1", "take_selfie"), DONE]);
    const { added, cancel, late } = takeLate();
    await collect(
      runTurn(request({ signal: controller.signal, late }), deps(mind, parts({ tools: [selfie] }))),
    );
    expect(toolSignal?.aborted).toBe(false);
    cancel.abort();
    expect(toolSignal?.aborted).toBe(true);
    expect(await (added[0] as (typeof added)[number]).events).toEqual([]);
  });
});

describe("the stream archive across a chat's turns", () => {
  test("gives a line repeated in a full window a new recall_streams budget", async () => {
    const archive = new StreamArchive({
      retriever: new FakeRetriever([]),
      catalog: new MemoryCatalog([broadcast("2026-09-08")]),
      timeZone: "UTC",
      today: () => TODAY,
    });
    const recall = (await archive.recallTool()) as LlmTool;
    const persona = parts({
      providers: [{ label: "StreamArchiveService", provider: archive }],
      tools: [recall],
    });
    const args = { query: "recap", mode: "overview", period: "latest" };
    const line = "还记得上次直播吗";
    // Past the window, each view holds as many of the viewer's lines as the last one did.
    const earlier = Array.from({ length: CHAT_WINDOW_MESSAGES }, (_, i) => [
      user(`问${i}`),
      alice(`答${i}`),
    ]).flat();
    const log = chat(...earlier, user(line));
    // Both turns spend the budget: two calls, then her answer.
    const turn: Round[] = [
      [call("c1", RECALL_TOOL_NAME, args), DONE],
      [call("c2", RECALL_TOOL_NAME, args), DONE],
      [{ type: "text", text: "记得" }, DONE],
    ];
    const { mind } = fakeMind(...turn, ...turn);
    const engine = deps(mind, persona);
    const results = (outputs: readonly TurnOutput[]) =>
      eventsOf(outputs).flatMap((event) => (event.type === "tool-result" ? [event.result] : []));
    const answered = await collect(runTurn(request({ chat: log }), engine));
    expect(results(answered).map((result) => "content" in result)).toEqual([true, true]);

    let events = [...log.events, ...stampEvents(eventsOf(answered), log.events.length, 2000)];
    const again: ChatEventDraft = {
      type: "message",
      id: "u-again",
      speaker: { kind: "user" },
      text: line,
    };
    events = [...events, ...stampEvents([again], events.length, 3000)];
    const outputs = await collect(runTurn(request({ chat: { header: HEADER, events } }), engine));
    expect(results(outputs).map((result) => "content" in result)).toEqual([true, true]);
  });

  test("an archive opened on a chat under way takes up her last recall_streams selection", async () => {
    const catalog = new MemoryCatalog([broadcast("2026-09-01"), broadcast("2026-09-08")]);
    const quiet: ContextProvider = { onContext: async () => {}, errorMessage: () => "" };
    const partsDeps: PartsDeps = {
      createSelfieTool: () => null,
      selfiePromptHint: () => "",
      loadVoiceStyles: () => new Map(),
      createVoiceTool: () => null,
      voicePromptHint: () => "",
      buildSystemInstruction: async () => "SYSTEM",
      dbPath: () => "/index",
      dbPathExists: async () => true,
      openArchive: async () =>
        new StreamArchive({
          retriever: new FakeRetriever([]),
          catalog,
          timeZone: "UTC",
          today: () => TODAY,
        }),
      openFacts: async () => quiet,
      retrievalGateFromEnv: () => null,
      isMemoryConfigured: () => false,
      createMemoryProvider: async () => {
        throw new Error("no Mem0 here");
      },
      settingsGeneration: () => 0,
    };
    const pick = {
      query: "那天",
      mode: "overview",
      period: "date_range",
      start_date: "2026-09-01",
    };
    const again = { query: "那天还聊了什么", mode: "overview", period: "selected" };
    const results = (outputs: readonly TurnOutput[]) =>
      eventsOf(outputs).flatMap((event) => (event.type === "tool-result" ? [event.result] : []));
    // Lines too short for the archive's own recall, so only her calls select.
    const log = chat(user("嗯"));
    const first = fakeMind([call("c1", RECALL_TOOL_NAME, pick), DONE]);
    const answered = await collect(
      runTurn(
        request({ chat: log }),
        deps(first.mind, parts(), { parts: personaParts(partsDeps) }),
      ),
    );
    expect(results(answered)[0]?.broadcast_ids).toEqual(["2026-09-01-BV1abc"]);

    let events = [...log.events, ...stampEvents(eventsOf(answered), log.events.length, 2000)];
    events = [...events, ...stampEvents([user("哦")], events.length, 3000)];
    // A restart: the same log, her parts opened afresh.
    const second = fakeMind([call("c2", RECALL_TOOL_NAME, again), DONE]);
    const outputs = await collect(
      runTurn(
        request({ chat: { header: HEADER, events } }),
        deps(second.mind, parts(), { parts: personaParts(partsDeps) }),
      ),
    );
    expect(results(outputs)[0]).toMatchObject({ broadcast_ids: ["2026-09-01-BV1abc"] });
  });
});

describe("the retrieval gate across a chat's turns", () => {
  test("asks again about a line repeated in a full window", async () => {
    const scores = [0.1, 0.9];
    let asked = 0;
    const gate = new RetrievalGate({
      apiKey: "test",
      fetch: (async () => {
        const noul = scores[asked++];
        const names = [...Object.keys(GATE_QUESTIONS), ...Object.keys(TIMELINE_QUESTIONS)];
        return Response.json({
          answers: Object.fromEntries(names.map((name) => [name, { noul }])),
        });
      }) as unknown as typeof fetch,
    });
    const verdicts: unknown[] = [];
    const reader: ContextProvider = {
      onContext: async ({ metadata }) => {
        verdicts.push(await (metadata[GATE_FRAME_KEY] as GateDecision).value());
      },
      errorMessage: () => "",
    };
    const answer: Round = [{ type: "text", text: "因为呀" }, DONE];
    const persona = parts({ gate, providers: [{ label: "R", provider: reader }] });
    const engine = deps(fakeMind(answer, answer).mind, persona);
    const line = "为什么呀";
    const earlier = Array.from({ length: CHAT_WINDOW_MESSAGES }, (_, i) => [
      user(`问${i}`),
      alice(`答${i}`),
    ]).flat();
    const log = chat(...earlier, user(line));
    const answered = await collect(runTurn(request({ chat: log }), engine));
    let events = [...log.events, ...stampEvents(eventsOf(answered), log.events.length, 2000)];
    const again: ChatEventDraft = {
      type: "message",
      id: "u-again",
      speaker: { kind: "user" },
      text: line,
    };
    events = [...events, ...stampEvents([again], events.length, 3000)];
    await collect(runTurn(request({ chat: { header: HEADER, events } }), engine));
    expect(asked).toBe(2);
    expect(verdicts).toEqual([
      { retrieve: false, timeline: false },
      { retrieve: true, timeline: true },
    ]);
  });
});
