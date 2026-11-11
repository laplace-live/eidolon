// A call's turns over fake minds, tools and speech: each mind request bracketed, what was heard
// kept as her line, notices, the nudge, the call's usage scope, the async-tool guidance, sync and
// async tools, a realtime turn's preparation, runTool, and a group call's runChat.
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
  finalEnvelope,
  type ParticipantId,
  stampEvents,
  viewOf,
} from "@eidolon/chat";
import { activePersona, consoleSink, dataHome, logger, resetSettings } from "@eidolon/config";
import type { DirectorDecision, DirectorInput } from "@eidolon/context";
import type { ContextProvider, LlmTool, ToolEffects } from "@eidolon/core";
import { usageRecord } from "@eidolon/providers";
import { ASYNC_TOOL_INSTRUCTIONS } from "../src/async_tool.ts";
import { type CallChatOutput, runChat } from "../src/chat.ts";
import { prepareTurn, runTool, runTurn } from "../src/turn.ts";
import type {
  CallHooks,
  CallTurnOutput,
  CallTurnRequest,
  EngineDeps,
  Mind,
  MindChunk,
  MindRequest,
  PartsOptions,
  PersonaParts,
  TurnOutput,
  TurnRequest,
} from "../src/types.ts";

const PERSONA = "callie";
const PERSONAS: Record<string, string> = {
  callie: "identity:\n  name: 卡莉\n",
  cora: "identity:\n  name: 珂拉\nchat:\n  replyMode: auto\n",
  dana: "identity:\n  name: 丹娜\n",
};
const HEADER: ChatHeader = {
  format: CHAT_FORMAT,
  id: "0190f5c8-0000-7000-8000-0000000000ca",
  createdAt: 0,
  participants: [PERSONA],
};
const VIEWER: UserContext = { mid: 0, uname: "Ken", face: null, isLoggedIn: true };
const DONE: MindChunk = { type: "done", finishReason: "stop" };
const CALL_USAGE = { source: "call", session: "call-1" } as const;

beforeAll(() => {
  for (const [id, yaml] of Object.entries(PERSONAS)) {
    const dir = join(dataHome(), "personas", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "persona.yaml"), yaml);
  }
});
afterAll(() => {
  for (const id of Object.keys(PERSONAS)) {
    rmSync(join(dataHome(), "personas", id), { recursive: true, force: true });
  }
  resetSettings();
});
beforeEach(() => {
  logger.setSink(() => {});
});
afterEach(() => {
  logger.setSink(consoleSink);
});

const user = (text: string): ChatEventDraft => ({
  type: "message",
  id: `u-${text}`,
  speaker: { kind: "user" },
  text,
});

function chat(...drafts: ChatEventDraft[]): TurnRequest["chat"] {
  return { header: HEADER, events: stampEvents(drafts, 0, 1000) };
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

function deps(
  mind: Mind,
  persona: PersonaParts,
  overrides: Partial<EngineDeps> = {},
): EngineDeps & { options: PartsOptions[] } {
  let n = 0;
  const options: PartsOptions[] = [];
  return {
    options,
    createMind: () => mind,
    parts: async (_persona, _viewer, _chat, given = {}) => {
      options.push(given);
      return persona;
    },
    saveAttachment: async () => {
      throw new Error("a call saves no files");
    },
    fetchImage: async () => {
      throw new Error("a call fetches no images");
    },
    newId: () => `id-${++n}`,
    speech: {
      canSpeak: () => false,
      synthesize: () => Promise.reject(new Error("a call speaks no voice messages")),
      transcribe: () => Promise.reject(new Error("a call hears no voice messages")),
    },
    ...overrides,
  };
}

interface Effects extends ToolEffects {
  readonly voices: string[];
  readonly messages: Readonly<Record<string, unknown>>[];
}

function effects(): Effects {
  const voices: string[] = [];
  const messages: Readonly<Record<string, unknown>>[] = [];
  return {
    voices,
    messages,
    switchVoice: async (voice) => {
      voices.push(voice);
    },
    sendServerMessage: async (data) => {
      messages.push(data);
    },
  };
}

/** A call's hooks: heard says `heard`, and async results collect in `results`. */
function hooks(heard: { text: string; complete: boolean } = { text: "", complete: true }) {
  const results: (readonly ChatEventDraft[])[] = [];
  const calls = { heard: 0 };
  const made: CallHooks & { results: typeof results; calls: typeof calls; effects: Effects } = {
    mode: "call",
    effects: effects(),
    heard: async () => {
      calls.heard++;
      return heard;
    },
    onAsyncResult: (events) => {
      results.push(events);
    },
    usage: CALL_USAGE,
    results,
    calls,
  };
  return made;
}

function request(call: CallHooks, overrides: Partial<CallTurnRequest> = {}): CallTurnRequest {
  return {
    chat: chat(user("你好")),
    persona: PERSONA,
    viewer: VIEWER,
    signal: new AbortController().signal,
    ...call,
    ...overrides,
  };
}

async function collect<T>(outputs: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const output of outputs) all.push(output);
  return all;
}

function eventsOf(outputs: readonly (TurnOutput | CallTurnOutput)[]): ChatEventDraft[] {
  return outputs.flatMap((output) => (output.type === "events" ? [...output.events] : []));
}

/** The outputs but their events, as `type:detail` strings, to read their order at a glance. */
function lines(outputs: readonly CallTurnOutput[]): string[] {
  return outputs.map((output) => {
    switch (output.type) {
      case "mind":
        return `mind:${output.state}${output.error ? `:${output.error}` : ""}`;
      case "tool":
        return `tool:${output.name}:${output.callId}:${output.async ? "async" : "sync"}:${output.state}`;
      case "events":
        return `events:${output.events.map((event) => event.type).join(",")}`;
      case "delta":
        return `delta:${output.text}`;
      case "notice":
        return `notice:${output.text}`;
      default:
        return output.type;
    }
  });
}

function tool(
  name: string,
  run: LlmTool["run"],
  options: { async?: boolean; timeoutSecs?: number | null } = {},
): LlmTool {
  return {
    schema: { name, description: name, properties: {}, required: [] },
    cancelOnInterruption: !options.async,
    timeoutSecs: options.timeoutSecs ?? null,
    run,
  };
}

const toolCall = (id: string, name: string, args: Record<string, unknown> = {}): MindChunk => ({
  type: "tool-calls",
  calls: [{ id, name, arguments: args }],
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Resolves once `fn` holds or rejects after a second. */
async function until(fn: () => boolean): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 1000) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

/** The usage scope a report made now would be billed in. */
function billed(): readonly [string | null, string | null] {
  const record = usageRecord({ role: "mind", provider: "openrouter", model: "m", units: {} });
  return [record.source, record.session];
}

describe("a call's turn", () => {
  test("brackets her mind request, and keeps what was heard as her call line", async () => {
    const { mind } = fakeMind([
      { type: "text", text: "你好呀，" },
      { type: "text", text: "Ken" },
      DONE,
    ]);
    const call = hooks({ text: "你好呀，", complete: false });
    const engine = deps(mind, parts());
    const outputs = await collect(runTurn(request(call), engine));
    expect(lines(outputs)).toEqual([
      "started",
      "mind:started",
      "delta:你好呀，",
      "delta:Ken",
      "mind:ended",
      "events:message",
      "ended",
    ]);
    expect(eventsOf(outputs)).toEqual([
      {
        type: "message",
        id: "id-2",
        speaker: { kind: "persona", id: PERSONA },
        text: "你好呀，",
        modality: "call",
        interrupted: true,
      },
    ]);
    // Her parts' voice variant: a call speaks.
    expect(engine.options).toEqual([{ others: [], voice: true }]);
    expect(call.calls.heard).toBe(1);
  });

  test("stores no line when nothing was heard, even one cut off", async () => {
    const { mind } = fakeMind([
      { type: "text", text: "嗯" },
      { type: "done", finishReason: "length" },
    ]);
    const outputs = await collect(runTurn(request(hooks()), deps(mind, parts())));
    expect(eventsOf(outputs)).toEqual([]);
  });

  test("keeps a whole reply that was heard to its end, and her cut-off with it", async () => {
    const { mind } = fakeMind([
      { type: "text", text: "说完了" },
      { type: "done", finishReason: "length" },
    ]);
    const outputs = await collect(
      runTurn(request(hooks({ text: "说完了", complete: true })), deps(mind, parts())),
    );
    expect(eventsOf(outputs)).toEqual([
      {
        type: "message",
        id: "id-2",
        speaker: { kind: "persona", id: PERSONA },
        text: "说完了",
        modality: "call",
        cutOff: "length",
      },
    ]);
  });

  test("asks what was heard only once her last round is done", async () => {
    const order: string[] = [];
    const { mind } = fakeMind(async function* () {
      order.push("mind");
      yield { type: "text", text: "好" };
      yield DONE;
    });
    const call: CallHooks = {
      ...hooks(),
      heard: async () => {
        order.push("heard");
        return { text: "好", complete: true };
      },
    };
    await collect(runTurn(request(call), deps(mind, parts())));
    expect(order).toEqual(["mind", "heard"]);
  });

  test("calls her hooks only once a slow reader has handled every line before them", async () => {
    const read: string[] = [];
    const order: string[] = [];
    const voice = tool("change_voice_style", async (_call, effects) => {
      await effects.switchVoice("whisper");
      return { ok: true };
    });
    const { mind } = fakeMind(
      [{ type: "text", text: "好的。" }, toolCall("c1", "change_voice_style"), DONE],
      [{ type: "text", text: "换好了。" }, DONE],
    );
    const call: CallHooks = {
      ...hooks(),
      effects: {
        ...effects(),
        switchVoice: async () => {
          order.push(`switch after ${read.at(-1)}`);
        },
      },
      heard: async () => {
        order.push(`heard after ${read.filter((line) => line === "mind:ended").length} rounds`);
        return { text: "好的。换好了。", complete: true };
      },
    };
    for await (const output of runTurn(request(call), deps(mind, parts({ tools: [voice] })))) {
      await Bun.sleep(1);
      read.push(lines([output])[0] as string);
    }
    expect(order).toEqual(["switch after mind:ended", "heard after 2 rounds"]);
  });

  test("an interruption closes her mind request with no error, and keeps what was heard", async () => {
    const abort = new AbortController();
    const { mind } = fakeMind(async function* (req) {
      yield { type: "text", text: "我想" };
      abort.abort();
      req.signal.throwIfAborted();
      yield { type: "text", text: "说" };
    });
    const outputs = await collect(
      runTurn(
        request(hooks({ text: "我", complete: false }), { signal: abort.signal }),
        deps(mind, parts()),
      ),
    );
    expect(lines(outputs)).toEqual([
      "started",
      "mind:started",
      "delta:我想",
      "mind:ended",
      "events:message",
      "ended",
    ]);
    expect(eventsOf(outputs)).toEqual([
      {
        type: "message",
        id: "id-2",
        speaker: { kind: "persona", id: PERSONA },
        text: "我",
        modality: "call",
        interrupted: true,
      },
    ]);
  });

  test("a failed mind request ends with pipedog's error text, and the turn fails", async () => {
    const { mind } = fakeMind(async function* () {
      yield { type: "text", text: "我" };
      throw new Error("502 Bad Gateway");
    });
    const outputs = await collect(
      runTurn(request(hooks({ text: "我", complete: true })), deps(mind, parts())),
    );
    expect(lines(outputs)).toEqual([
      "started",
      "mind:started",
      "delta:我",
      "mind:ended:Error during completion: 502 Bad Gateway",
      "events:message,turn-failed",
      "ended",
    ]);
    expect(eventsOf(outputs)).toEqual([
      {
        type: "message",
        id: "id-2",
        speaker: { kind: "persona", id: PERSONA },
        text: "我",
        modality: "call",
      },
      { type: "turn-failed", persona: PERSONA, turn: "id-1", error: "502 Bad Gateway" },
    ]);
  });

  test("a provider that fails is a notice in a call, and only a log line in a chat", async () => {
    const failing: ContextProvider = {
      onContext: async () => {
        throw new Error("down");
      },
      errorMessage: (error) => `PersonaFactsService error: ${(error as Error).message}`,
    };
    const persona = parts({ providers: [{ label: "PersonaFactsService", provider: failing }] });
    const called = await collect(runTurn(request(hooks()), deps(fakeMind([DONE]).mind, persona)));
    expect(called).toContainEqual({
      type: "notice",
      turn: "id-1",
      text: "PersonaFactsService error: down",
    });
    const chatted = await collect(
      runTurn(
        {
          chat: chat(user("你好")),
          persona: PERSONA,
          viewer: VIEWER,
          signal: new AbortController().signal,
        },
        deps(fakeMind([DONE]).mind, persona),
      ),
    );
    expect(chatted.map((output) => output.type)).toEqual(["started", "ended"]);
  });

  test("a nudge ends her view as a developer block, stored before her providers run", async () => {
    const seen: unknown[][] = [];
    const watching: ContextProvider = {
      onContext: async ({ context }) => {
        seen.push(context.getMessages());
      },
      errorMessage: () => "",
    };
    const { mind, requests } = fakeMind([DONE]);
    const log = chat(user("你好"));
    const outputs = await collect(
      runTurn(
        request(hooks(), { chat: log, nudge: "刚才没听清，接着说吧" }),
        deps(mind, parts({ providers: [{ label: "Watch", provider: watching }] })),
      ),
    );
    const nudge = { role: "developer", content: "刚才没听清，接着说吧" } as const;
    expect(seen).toEqual([[{ role: "user", content: "你好" }, nudge]]);
    expect(requests[0]?.messages.at(-1)).toEqual(nudge);
    expect(eventsOf(outputs)).toEqual([
      {
        type: "context",
        persona: PERSONA,
        turn: "id-1",
        position: 1,
        role: "developer",
        content: "刚才没听清，接着说吧",
      },
    ]);
    const stored = [...log.events, ...stampEvents(eventsOf(outputs), log.events.length, 2000)];
    expect(
      viewOf(HEADER, stored, PERSONA, { windowMessages: CHAT_WINDOW_MESSAGES, nameOf: (id) => id }),
    ).toEqual([{ role: "user", content: "你好" }, nudge]);
  });

  test("runs in the call's usage scope, as her", async () => {
    const scopes: unknown[] = [];
    const { mind } = fakeMind(async function* () {
      scopes.push([activePersona().id, ...billed()]);
      yield DONE;
    });
    await collect(runTurn(request(hooks()), deps(mind, parts())));
    expect(scopes).toEqual([[PERSONA, "call", "call-1"]]);
  });

  test("a call's system instruction carries the async-tool guidance while an async tool is registered", async () => {
    const selfie = tool("take_selfie", async () => ({}), { async: true });
    const recall = tool("recall_streams", async () => ({}));
    const systems = async (persona: PersonaParts, called: boolean): Promise<string | undefined> => {
      const { mind, requests } = fakeMind([DONE]);
      const base = {
        chat: chat(user("你好")),
        persona: PERSONA,
        viewer: VIEWER,
        signal: new AbortController().signal,
      };
      await collect<TurnOutput | CallTurnOutput>(
        called
          ? runTurn({ ...base, ...hooks() }, deps(mind, persona))
          : runTurn(base, deps(mind, persona)),
      );
      return requests[0]?.system;
    };
    expect(await systems(parts({ tools: [recall, selfie] }), true)).toBe(
      `SYSTEM\n\n${ASYNC_TOOL_INSTRUCTIONS}`,
    );
    expect(await systems(parts({ tools: [recall] }), true)).toBe("SYSTEM");
    expect(await systems(parts({ systemInstruction: "", tools: [selfie] }), true)).toBe(
      ASYNC_TOOL_INSTRUCTIONS,
    );
    // A chat runs the selfie while she waits, so its prompt never mentions async tools.
    expect(await systems(parts({ tools: [recall, selfie] }), false)).toBe("SYSTEM");
  });
});

describe("a call's tools", () => {
  test("a sync tool reports its call id, acts on the call, and her next round sees its result", async () => {
    const call = hooks({ text: "换个声音。好了", complete: true });
    const style = tool("change_voice_style", async ({ arguments: args }, effects) => {
      await effects.switchVoice(String(args.style));
      return { ok: true };
    });
    const { mind, requests } = fakeMind(
      [
        { type: "text", text: "换个声音。" },
        toolCall("c1", "change_voice_style", { style: "soft" }),
        DONE,
      ],
      [{ type: "text", text: "好了" }, DONE],
    );
    const outputs = await collect(runTurn(request(call), deps(mind, parts({ tools: [style] }))));
    expect(lines(outputs)).toEqual([
      "started",
      "mind:started",
      "delta:换个声音。",
      "events:tool-call",
      "tool:change_voice_style:c1:sync:running",
      "mind:ended",
      "events:tool-result",
      "tool:change_voice_style:c1:sync:done",
      "mind:started",
      "delta:好了",
      "mind:ended",
      "events:message",
      "ended",
    ]);
    expect(call.effects.voices).toEqual(["soft"]);
    expect(requests[1]?.messages.slice(-3)).toEqual([
      {
        role: "assistant",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "change_voice_style", arguments: '{"style": "soft"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: '{"ok": true}' },
      { role: "assistant", content: "换个声音。" },
    ]);
  });

  test("a sync tool that times out is cancelled, and her next round reads CANCELLED", async () => {
    const slow = tool(
      "recall_streams",
      ({ signal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      { timeoutSecs: 0.02 },
    );
    const { mind, requests } = fakeMind([toolCall("c1", "recall_streams"), DONE], [DONE]);
    const outputs = await collect(runTurn(request(hooks()), deps(mind, parts({ tools: [slow] }))));
    expect(lines(outputs)).toContain("tool:recall_streams:c1:sync:cancelled");
    expect(eventsOf(outputs).map((event) => event.type)).toEqual(["tool-call"]);
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "CANCELLED",
    });
  });

  test("a sync tool running when she is interrupted ends cancelled before her turn does", async () => {
    const abort = new AbortController();
    const waiting = tool("recall_streams", ({ signal }) => {
      abort.abort();
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    });
    const { mind, requests } = fakeMind([toolCall("c1", "recall_streams"), DONE]);
    const outputs = await collect(
      runTurn(request(hooks(), { signal: abort.signal }), deps(mind, parts({ tools: [waiting] }))),
    );
    expect(lines(outputs)).toEqual([
      "started",
      "mind:started",
      "events:tool-call",
      "tool:recall_streams:c1:sync:running",
      "mind:ended",
      "tool:recall_streams:c1:sync:cancelled",
      "ended",
    ]);
    expect(requests).toHaveLength(1);
  });

  test("an async tool starts, ends her turn with its round, and reports its result later", async () => {
    const render = deferred<void>();
    const inside: unknown[] = [];
    const selfie = tool(
      "take_selfie",
      async (_call, effects) => {
        await render.promise;
        inside.push([activePersona().id, ...billed()]);
        await effects.sendServerMessage({ type: "selfie", urls: ["/api/selfie/a.png"] });
        return { ok: true };
      },
      { async: true },
    );
    const call = hooks({ text: "等我一下", complete: true });
    const { mind, requests } = fakeMind([
      { type: "text", text: "等我一下" },
      toolCall("s1", "take_selfie"),
      DONE,
    ]);
    const log = chat(user("拍张照"));
    const outputs = await collect(
      runTurn(request(call, { chat: log }), deps(mind, parts({ tools: [selfie] }))),
    );
    expect(lines(outputs)).toEqual([
      "started",
      "mind:started",
      "delta:等我一下",
      "events:tool-call",
      "tool:take_selfie:s1:async:running",
      "events:tool-result",
      "mind:ended",
      "events:message",
      "ended",
    ]);
    expect(requests).toHaveLength(1);
    expect(eventsOf(outputs)).toContainEqual({
      type: "tool-result",
      persona: PERSONA,
      turn: "id-1",
      callId: "s1",
      result: {},
      stage: "started",
    });
    expect(call.results).toEqual([]);

    render.resolve();
    await until(() => call.results.length > 0);
    const final = {
      type: "tool-result",
      persona: PERSONA,
      turn: "id-1",
      callId: "s1",
      result: { ok: true },
      stage: "final",
    } as const;
    expect(call.results).toEqual([[final]]);
    expect(inside).toEqual([[PERSONA, "call", "call-1"]]);
    expect(call.effects.messages).toEqual([{ type: "selfie", urls: ["/api/selfie/a.png"] }]);

    // Her next view settles the placeholder in place, or tells her later once the talk moved on.
    const view = (...more: ChatEventDraft[]) => {
      const stored = [...log.events, ...stampEvents(eventsOf(outputs), log.events.length, 2000)];
      const all = [...stored, ...stampEvents(more, stored.length, 3000)];
      return viewOf(HEADER, all, PERSONA, {
        windowMessages: CHAT_WINDOW_MESSAGES,
        nameOf: (id) => id,
      });
    };
    expect(view(final)).toContainEqual({
      role: "tool",
      tool_call_id: "s1",
      content: '{"ok": true}',
    });
    expect(view(user("还没好吗"), final).at(-1)).toEqual({
      role: "developer",
      content: finalEnvelope("s1", '{"ok": true}'),
    });
  });

  test("an async tool runs on past her interrupted turn", async () => {
    const abort = new AbortController();
    const render = deferred<void>();
    const selfie = tool(
      "take_selfie",
      async () => {
        await render.promise;
        return { ok: true };
      },
      { async: true },
    );
    const call = hooks();
    const { mind } = fakeMind([toolCall("s1", "take_selfie"), DONE]);
    const engine = deps(mind, parts({ tools: [selfie] }));
    const turn = runTurn(request(call, { signal: abort.signal }), engine);
    const outputs: CallTurnOutput[] = [];
    for await (const output of turn) {
      outputs.push(output);
      // A barge-in while what she said with the call is still playing.
      if (output.type === "mind" && output.state === "ended") abort.abort();
    }
    expect(outputs.at(-1)).toEqual({ type: "ended", turn: "id-1" });
    render.resolve();
    await until(() => call.results.length > 0);
    expect(call.results[0]?.[0]).toMatchObject({
      callId: "s1",
      stage: "final",
      result: { ok: true },
    });
  });

  test("an async tool that times out, or whose call ends, reports itself cancelled", async () => {
    const never = tool(
      "take_selfie",
      ({ signal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      { async: true, timeoutSecs: 0.02 },
    );
    const cancelled = {
      type: "tool-result",
      persona: PERSONA,
      turn: "id-1",
      callId: "s1",
      result: {},
      stage: "cancelled",
    } as const;

    const timedOut = hooks();
    await collect(
      runTurn(
        request(timedOut),
        deps(fakeMind([toolCall("s1", "take_selfie"), DONE]).mind, parts({ tools: [never] })),
      ),
    );
    await until(() => timedOut.results.length > 0);
    expect(timedOut.results).toEqual([[cancelled]]);

    const end = new AbortController();
    const ended = { ...hooks(), asyncSignal: end.signal };
    const results: (readonly ChatEventDraft[])[] = [];
    await collect(
      runTurn(
        request({ ...ended, onAsyncResult: (events) => results.push(events) }),
        deps(
          fakeMind([toolCall("s1", "take_selfie"), DONE]).mind,
          parts({ tools: [{ ...never, timeoutSecs: null }] }),
        ),
      ),
    );
    expect(results).toEqual([]);
    end.abort();
    await until(() => results.length > 0);
    expect(results).toEqual([[cancelled]]);
  });
});

describe("prepareTurn", () => {
  test("readies a realtime turn's parts and recall, without her mind", async () => {
    const selfie = tool("take_selfie", async () => ({}), { async: true });
    const recall: ContextProvider = {
      onContext: async ({ context }) => {
        context.setMessages([
          { role: "user", content: "【直播回放】……" },
          ...context.getMessages(),
        ]);
      },
      errorMessage: () => "",
    };
    const persona = parts({
      tools: [selfie],
      providers: [{ label: "StreamArchiveService", provider: recall }],
      memories: async () => [{ memory: "喜欢猫" }],
    });
    const engine = deps(fakeMind().mind, persona, {
      createMind: () => {
        throw new Error("a realtime model is its own mind");
      },
    });
    const prepared = await prepareTurn(
      {
        chat: chat(),
        persona: PERSONA,
        viewer: VIEWER,
        kickoff: true,
        usage: CALL_USAGE,
        signal: new AbortController().signal,
      },
      engine,
    );
    expect(engine.options).toEqual([{ others: [], realtime: true }]);
    expect(prepared.parts.systemInstruction).toBe(`SYSTEM\n\n${ASYNC_TOOL_INSTRUCTIONS}`);
    expect(prepared.parts.tools).toEqual([selfie]);
    expect(prepared.events.map((event) => event.type)).toEqual(["kickoff", "context"]);
    expect(prepared.events[1]).toMatchObject({
      type: "context",
      position: 0,
      role: "user",
      content: "【直播回放】……",
    });
    expect(prepared.context.getMessages()[0]).toEqual({ role: "user", content: "【直播回放】……" });
  });

  test("rejects with the signal's reason when it is aborted", async () => {
    const abort = new AbortController();
    abort.abort(new Error("speech started"));
    await expect(
      prepareTurn(
        { chat: chat(user("你好")), persona: PERSONA, viewer: VIEWER, signal: abort.signal },
        deps(fakeMind().mind, parts()),
      ),
    ).rejects.toThrow("speech started");
  });
});

describe("runTool", () => {
  const context = { getMessages: () => [], setMessages: () => {}, setHiddenTools: () => {} };
  const signal = new AbortController().signal;

  test("runs her tool to its result, with the effects it is given", async () => {
    const seen = effects();
    const style = tool("change_voice_style", async (_call, given) => {
      await given.switchVoice("soft");
      return { ok: true };
    });
    expect(
      await runTool(
        { id: "c1", name: "change_voice_style", arguments: {} },
        parts({ tools: [style] }),
        seen,
        signal,
        context,
      ),
    ).toEqual({ ok: true });
    expect(seen.voices).toEqual(["soft"]);
  });

  test("answers a tool she doesn't have, or one that threw, with pipedog's texts", async () => {
    const broken = tool("recall_streams", async () => {
      throw new Error("boom");
    });
    const run = (name: string) =>
      runTool(
        { id: "c1", name, arguments: {} },
        parts({ tools: [broken] }),
        effects(),
        signal,
        context,
      );
    expect(await run("take_selfie")).toEqual({
      error: "The function `take_selfie` is not currently available.",
    });
    expect(await run("recall_streams")).toEqual({
      error: "The function `recall_streams` failed and returned no result.",
    });
  });

  test("gives null for a tool that timed out, and rejects when aborted", async () => {
    const never = tool(
      "recall_streams",
      ({ signal: own }) =>
        new Promise((_, reject) => own.addEventListener("abort", () => reject(own.reason))),
      { timeoutSecs: 0.02 },
    );
    const callOf = { id: "c1", name: "recall_streams", arguments: {} };
    expect(await runTool(callOf, parts({ tools: [never] }), effects(), signal, context)).toBeNull();
    const abort = new AbortController();
    const running = runTool(
      callOf,
      parts({ tools: [{ ...never, timeoutSecs: null }] }),
      effects(),
      abort.signal,
      context,
    );
    abort.abort(new Error("barge-in"));
    await expect(running).rejects.toThrow("barge-in");
  });
});

describe("runChat in a call", () => {
  const GROUP: ChatHeader = { ...HEADER, participants: ["cora", "dana"] };

  test("each persona's turn is a call's with her own hooks, and the director never weighs voice", async () => {
    const inputs: DirectorInput[] = [];
    const scopes: unknown[] = [];
    const decide = async (input: DirectorInput): Promise<DirectorDecision> => {
      inputs.push(input);
      scopes.push(billed());
      return inputs.length === 1
        ? {
            replies: [
              { persona: "cora", mode: "text" },
              { persona: "dana", mode: "text" },
            ],
            source: "model",
            scores: {},
          }
        : { replies: [], source: "model", scores: {} };
    };
    const mind: Mind = {
      async *stream() {
        yield { type: "text", text: `${activePersona().identity.name}在` };
        yield DONE;
      },
    };
    const asked: ParticipantId[] = [];
    let log: ChatEvent[] = stampEvents([user("大家好")], 0, 1000);
    const outputs: CallChatOutput[] = [];
    for await (const output of runChat(
      {
        chat: { header: GROUP, events: log },
        read: async () => ({ header: GROUP, events: log }),
        viewer: VIEWER,
        after: 1,
        signal: new AbortController().signal,
        usage: CALL_USAGE,
        hooks: (persona) => {
          asked.push(persona);
          return hooks({ text: `${persona} heard`, complete: true });
        },
      },
      { ...deps(mind, parts()), director: { decide } },
    )) {
      outputs.push(output);
      const drafts =
        output.type === "events" ? output.events : output.type === "decision" ? [output] : [];
      log = [...log, ...stampEvents(drafts, log.length, 2000)];
    }
    expect(asked).toEqual(["cora", "dana"]);
    expect(inputs[0]?.participants.map((p) => [p.id, p.replyMode])).toEqual([
      ["cora", "text"],
      ["dana", "text"],
    ]);
    expect(scopes[0]).toEqual(["call", "call-1"]);
    expect(outputs.filter((output) => output.type === "mind")).toHaveLength(4);
    expect(
      log.flatMap((event) =>
        event.type === "message" && event.speaker.kind === "persona"
          ? [[event.speaker.id, event.text, event.modality]]
          : [],
      ),
    ).toEqual([
      ["cora", "cora heard", "call"],
      ["dana", "dana heard", "call"],
    ]);
  });
});
