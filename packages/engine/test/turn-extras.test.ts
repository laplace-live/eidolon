// What a caller hands one turn beyond her parts (`TurnExtras`), as the local app hands her task
// tools and its status block: request tools, offered after hers and her background tools and
// settled within the turn, and request providers, run after hers, in a chat and in a call alike.
import "../../config/test/isolated-guard.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
  viewOf,
} from "@eidolon/chat";
import { dataHome, resetSettings } from "@eidolon/config";
import type { ContextProvider, LlmTool, ToolResult } from "@eidolon/core";
import { ASYNC_TOOL_INSTRUCTIONS } from "../src/async_tool.ts";
import { type ChatDeps, type ChatOutput, runChat } from "../src/chat.ts";
import { runTurn } from "../src/turn.ts";
import type {
  BackgroundTool,
  CallHooks,
  CallTurnOutput,
  EngineDeps,
  LateTools,
  Mind,
  MindChunk,
  MindRequest,
  PersonaParts,
  TurnOutput,
  TurnRequest,
} from "../src/types.ts";

const PERSONA = "erin";
const HEADER: ChatHeader = {
  format: CHAT_FORMAT,
  id: "0190f5c8-0000-7000-8000-0000000000ee",
  createdAt: 0,
  participants: [PERSONA],
};
const VIEWER: UserContext = { mid: 0, uname: "Ken", face: null, isLoggedIn: true };
const DONE: MindChunk = { type: "done", finishReason: "stop" };
const ROUND_ENDS: MindChunk = { type: "done", finishReason: "tool_calls" };
const HINT = "你可以用这台电脑";
const BLOCK = "后台的活：";

beforeAll(() => {
  const dir = join(dataHome(), "personas", PERSONA);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "persona.yaml"), "identity:\n  name: Erin\n");
});
afterAll(() => {
  rmSync(join(dataHome(), "personas", PERSONA), { recursive: true, force: true });
  resetSettings();
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

/** A mind that answers its nth call with `rounds[n]`, and with nothing after them. */
function fakeMind(...rounds: (readonly MindChunk[])[]): { mind: Mind; requests: MindRequest[] } {
  const requests: MindRequest[] = [];
  const mind: Mind = {
    async *stream(request) {
      requests.push(request);
      yield* rounds[requests.length - 1] ?? [DONE];
    },
  };
  return { mind, requests };
}

function tool(name: string, run: LlmTool["run"], cancelOnInterruption = true): LlmTool {
  return {
    schema: { name, description: name, properties: {}, required: [] },
    cancelOnInterruption,
    timeoutSecs: null,
    run,
  };
}

const selfie = tool("take_selfie", async () => ({ ok: true }), false);

const startTask: BackgroundTool = {
  schema: { name: "start_task", description: "start", properties: {}, required: [] },
  cancelOnInterruption: false,
  timeoutSecs: null,
  run: async () => ({ task: "t1", status: "running" }),
};

/** A round that calls `name` as call `id`. */
const calls = (id: string, name: string, args: Record<string, unknown> = {}): MindChunk[] => [
  { type: "tool-calls", calls: [{ id, name, arguments: args }] },
  ROUND_ENDS,
];

function deps(mind: Mind, persona: Partial<PersonaParts> = {}): EngineDeps {
  let n = 0;
  const parts: PersonaParts = {
    systemInstruction: "SYSTEM",
    providers: [],
    gate: null,
    tools: [],
    memories: async () => [],
    ...persona,
  };
  return {
    createMind: () => mind,
    parts: async () => parts,
    saveAttachment: async () => {
      throw new Error("no files here");
    },
    fetchImage: async () => {
      throw new Error("no images here");
    },
    newId: () => `id-${++n}`,
    speech: {
      canSpeak: () => false,
      synthesize: () => Promise.reject(new Error("no voice here")),
      transcribe: () => Promise.reject(new Error("no ears here")),
    },
  };
}

/** One of her own providers, which only notes that it ran. */
function hers(order: string[]): { label: string; provider: ContextProvider } {
  return {
    label: "Mem0",
    provider: {
      onContext: async () => {
        order.push("hers");
      },
      errorMessage: () => "",
    },
  };
}

/**
 * As the local app's status block: its earlier block out, and `status()`'s just before the last
 * user message, or none when it is empty.
 */
function statusBlock(
  status: () => string,
  order: string[] = [],
): { label: string; provider: ContextProvider } {
  return {
    label: "Tasks status",
    provider: {
      onContext: async ({ context }) => {
        order.push("status");
        const messages = context
          .getMessages()
          .filter(
            (message) => !String((message as { content?: unknown }).content).startsWith(BLOCK),
          );
        const text = status();
        if (text !== "") {
          const last = messages.findLastIndex(
            (message) => (message as { role?: unknown }).role === "user",
          );
          messages.splice(last === -1 ? messages.length : last, 0, {
            role: "developer",
            content: `${BLOCK}${text}`,
          });
        }
        context.setMessages(messages);
      },
      errorMessage: () => "",
    },
  };
}

/** A call's hooks, its async results collecting in `results`; she was heard saying `heard`. */
function callHooks(heard = ""): { hooks: CallHooks; results: (readonly ChatEventDraft[])[] } {
  const results: (readonly ChatEventDraft[])[] = [];
  return {
    results,
    hooks: {
      mode: "call",
      effects: { switchVoice: async () => {}, sendServerMessage: async () => {} },
      heard: async () => ({ text: heard, complete: true }),
      onAsyncResult: (events) => {
        results.push(events);
      },
    },
  };
}

async function collect<T>(outputs: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const output of outputs) all.push(output);
  return all;
}

function eventsOf(
  outputs: readonly (TurnOutput | ChatOutput | CallTurnOutput)[],
): ChatEventDraft[] {
  return outputs.flatMap((output) => (output.type === "events" ? [...output.events] : []));
}

const toolNames = (request: MindRequest | undefined) =>
  (request?.tools ?? []).map((schema) => schema.name);

/** Each tool line's name, call id, kind and state, as a call's turn streams them. */
const callToolLines = (outputs: readonly CallTurnOutput[]): string[] =>
  outputs.flatMap((output) =>
    output.type === "tool"
      ? [`${output.name}:${output.callId}:${output.async ? "async" : "sync"}:${output.state}`]
      : [],
  );

function viewAfter(log: readonly ChatEvent[], drafts: readonly ChatEventDraft[]) {
  const events = [...log, ...stampEvents(drafts, log.length, 2000)];
  return viewOf(HEADER, events, PERSONA, {
    windowMessages: CHAT_WINDOW_MESSAGES,
    nameOf: (id) => id,
  });
}

/** Resolves once `fn` holds, or rejects after a second. */
async function until(fn: () => boolean): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 1000) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

describe("a turn's request tools", () => {
  test("come after hers and her background tools, and settle within the turn as hers do", async () => {
    const passed = { task: 1, status: "running", note: "Passed on." };
    const steer = tool("steer_task", async () => passed, false);
    const { mind, requests } = fakeMind(calls("c1", "steer_task", { text: "改标题" }), [
      { type: "text", text: "转告它了" },
      DONE,
    ]);
    const log = chat(user("标题改一下"));
    const outputs = await collect(
      runTurn(
        {
          chat: log,
          persona: PERSONA,
          viewer: VIEWER,
          signal: new AbortController().signal,
          background: { tools: [startTask], hint: HINT },
          tools: [steer],
        },
        deps(mind, { tools: [selfie] }),
      ),
    );
    expect(toolNames(requests[0])).toEqual(["take_selfie", "start_task", "steer_task"]);
    const events = eventsOf(outputs);
    expect(events).toEqual([
      {
        type: "tool-call",
        persona: PERSONA,
        turn: "id-1",
        callId: "c1",
        name: "steer_task",
        arguments: { text: "改标题" },
      },
      { type: "tool-result", persona: PERSONA, turn: "id-1", callId: "c1", result: passed },
      {
        type: "message",
        id: "id-2",
        speaker: { kind: "persona", id: PERSONA },
        text: "转告它了",
      },
    ]);
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: '{"task": 1, "status": "running", "note": "Passed on."}',
    });
    expect<unknown[]>(viewAfter(log.events, events)).toEqual([
      ...(requests[1]?.messages ?? []),
      { role: "assistant", content: "转告它了" },
    ]);
  });

  test("one that runs on past an interruption is stored late, with no stage", async () => {
    const controller = new AbortController();
    const passing = Promise.withResolvers<ToolResult>();
    const steer = tool(
      "steer_task",
      () => {
        controller.abort();
        return passing.promise;
      },
      false,
    );
    const added: { name: string; events: Promise<readonly ChatEventDraft[]> }[] = [];
    const late: LateTools = {
      signal: new AbortController().signal,
      add: (name, events) => {
        added.push({ name, events });
      },
    };
    const { mind } = fakeMind(calls("c1", "steer_task", { text: "改标题" }));
    const outputs = await collect(
      runTurn(
        {
          chat: chat(user("标题改一下")),
          persona: PERSONA,
          viewer: VIEWER,
          signal: controller.signal,
          late,
          tools: [steer],
        },
        deps(mind),
      ),
    );
    expect(eventsOf(outputs).map((event) => event.type)).toEqual(["tool-call"]);
    passing.resolve({ task: 1, status: "running" });
    expect(added.map((entry) => entry.name)).toEqual(["steer_task"]);
    expect(await added[0]?.events).toEqual([
      {
        type: "tool-result",
        persona: PERSONA,
        turn: "id-1",
        callId: "c1",
        result: { task: 1, status: "running" },
      },
    ]);
  });
});

describe("a turn's request providers", () => {
  test("run after hers, and what they change is recorded as hers is", async () => {
    let events: ChatEvent[] = stampEvents([user("一")], 0, 1000);
    /** Her answer to the chat as it stands, with the status block reading `status`. */
    async function answer(status: string, said: string) {
      const order: string[] = [];
      const { mind, requests } = fakeMind([{ type: "text", text: said }, DONE]);
      const outputs = await collect(
        runTurn(
          {
            chat: { header: HEADER, events },
            persona: PERSONA,
            viewer: VIEWER,
            signal: new AbortController().signal,
            providers: [statusBlock(() => status, order)],
          },
          deps(mind, { providers: [hers(order)] }),
        ),
      );
      const recorded = eventsOf(outputs);
      events = [...events, ...stampEvents(recorded, events.length, 2000 + events.length)];
      return { order, recorded, sent: requests[0]?.messages };
    }
    const her = (text: string): ChatEventDraft => ({
      type: "message",
      id: "id-2",
      speaker: { kind: "persona", id: PERSONA },
      text,
    });
    const block = (content: string, position: number): ChatEventDraft => ({
      type: "context",
      persona: PERSONA,
      turn: "id-1",
      position,
      role: "developer",
      content: `${BLOCK}${content}`,
    });

    const first = await answer("任务1 正在做", "嗯");
    expect(first.order).toEqual(["hers", "status"]);
    expect(first.recorded).toEqual([block("任务1 正在做", 0), her("嗯")]);
    expect(first.sent).toEqual([
      { role: "developer", content: `${BLOCK}任务1 正在做` },
      { role: "user", content: "一" },
    ]);

    // Unchanged and in place, as in a turn no new line of the owner's started: nothing recorded.
    const again = await answer("任务1 正在做", "好");
    expect(again.recorded).toEqual([her("好")]);

    events = [...events, ...stampEvents([user("二")], events.length, 5000)];
    const moved = await answer("任务1 刚做完", "做完啦");
    expect(moved.recorded).toEqual([
      { type: "context-removed", persona: PERSONA, turn: "id-1", seqs: [2] },
      block("任务1 刚做完", 3),
      her("做完啦"),
    ]);
    expect(moved.sent).toEqual([
      { role: "user", content: "一" },
      { role: "assistant", content: "嗯" },
      { role: "assistant", content: "好" },
      { role: "developer", content: `${BLOCK}任务1 刚做完` },
      { role: "user", content: "二" },
    ]);

    const emptied = await answer("", "没有别的了");
    const seq = events.findLast((event) => event.type === "context")?.seq;
    expect(emptied.recorded).toEqual([
      { type: "context-removed", persona: PERSONA, turn: "id-1", seqs: [seq as number] },
      her("没有别的了"),
    ]);
    expect(viewAfter(events, [])).toEqual([
      { role: "user", content: "一" },
      { role: "assistant", content: "嗯" },
      { role: "assistant", content: "好" },
      { role: "user", content: "二" },
      { role: "assistant", content: "做完啦" },
      { role: "assistant", content: "没有别的了" },
    ]);
  });
});

describe("a call's request tools and providers", () => {
  test("its request tools run as sync tools after hers and her background tools, and its providers after hers", async () => {
    const stopped = { task: 1, status: "cancelled", written: 0 };
    const stop = tool("stop_task", async () => stopped, false);
    const order: string[] = [];
    const { mind, requests } = fakeMind(calls("s1", "stop_task"), [
      { type: "text", text: "停掉了" },
      DONE,
    ]);
    const { hooks, results } = callHooks("停掉了");
    const outputs = await collect(
      runTurn(
        {
          chat: chat(user("算了别做了")),
          persona: PERSONA,
          viewer: VIEWER,
          signal: new AbortController().signal,
          ...hooks,
          background: { tools: [startTask], hint: HINT },
          tools: [stop],
          providers: [statusBlock(() => "任务1 正在做", order)],
        },
        deps(mind, { tools: [selfie], providers: [hers(order)] }),
      ),
    );
    expect([toolNames(requests[0]), requests[0]?.system]).toEqual([
      ["take_selfie", "start_task", "stop_task"],
      `SYSTEM\n\n${ASYNC_TOOL_INSTRUCTIONS}`,
    ]);
    expect(order).toEqual(["hers", "status"]);
    expect(callToolLines(outputs)).toEqual(["stop_task:s1:sync:running", "stop_task:s1:sync:done"]);
    expect(eventsOf(outputs)).toEqual([
      {
        type: "context",
        persona: PERSONA,
        turn: "id-1",
        position: 0,
        role: "developer",
        content: `${BLOCK}任务1 正在做`,
      },
      {
        type: "tool-call",
        persona: PERSONA,
        turn: "id-1",
        callId: "s1",
        name: "stop_task",
        arguments: {},
      },
      { type: "tool-result", persona: PERSONA, turn: "id-1", callId: "s1", result: stopped },
      {
        type: "message",
        id: "id-2",
        speaker: { kind: "persona", id: PERSONA },
        text: "停掉了",
        modality: "call",
      },
    ]);
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "s1",
      content: '{"task": 1, "status": "cancelled", "written": 0}',
    });
    expect(results).toEqual([]);
  });

  test("a request tool that runs on past a barge-in hands its result to onAsyncResult; one cancelled on interruption brings nothing", async () => {
    const barge = new AbortController();
    const stopping = Promise.withResolvers<ToolResult>();
    let checking: AbortSignal | undefined;
    const stop = tool("stop_task", () => stopping.promise, false);
    const check = tool("check_task", ({ signal }) => {
      checking = signal;
      barge.abort();
      return new Promise<ToolResult>(() => {});
    });
    const { mind, requests } = fakeMind([
      {
        type: "tool-calls",
        calls: [
          { id: "s1", name: "stop_task", arguments: {} },
          { id: "k1", name: "check_task", arguments: {} },
        ],
      },
      ROUND_ENDS,
    ]);
    const { hooks, results } = callHooks();
    const outputs = await collect(
      runTurn(
        {
          chat: chat(user("别做了，做到哪了")),
          persona: PERSONA,
          viewer: VIEWER,
          signal: barge.signal,
          ...hooks,
          tools: [stop, check],
        },
        deps(mind),
      ),
    );
    expect(outputs.at(-1)).toEqual({ type: "ended", turn: "id-1" });
    expect(requests).toHaveLength(1);
    expect(eventsOf(outputs).map((event) => event.type)).toEqual(["tool-call", "tool-call"]);
    expect(callToolLines(outputs).toSorted()).toEqual([
      "check_task:k1:sync:cancelled",
      "check_task:k1:sync:running",
      "stop_task:s1:sync:cancelled",
      "stop_task:s1:sync:running",
    ]);
    expect(checking?.aborted).toBe(true);
    stopping.resolve({ task: 1, status: "cancelled", written: 2 });
    await until(() => results.length > 0);
    await Bun.sleep(10);
    expect(results).toEqual([
      [
        {
          type: "tool-result",
          persona: PERSONA,
          turn: "id-1",
          callId: "s1",
          result: { task: 1, status: "cancelled", written: 2 },
        },
      ],
    ]);
  });
});

describe("runChat", () => {
  test("hands a chat of one's request tools and providers to her turn, whether it waits for the director or not", async () => {
    for (const canSpeak of [false, true]) {
      const order: string[] = [];
      const { mind, requests } = fakeMind([{ type: "text", text: "嗯" }, DONE]);
      const engine = deps(mind);
      const director: ChatDeps["director"] = {
        decide: async () => ({
          replies: [{ persona: PERSONA, mode: "text" }],
          source: "single",
          scores: {},
        }),
      };
      const log = chat(user("弄好了吗"));
      const check = tool("check_task", async () => ({ task: 1, status: "running" }));
      await collect(
        runChat(
          {
            chat: log,
            read: async () => log,
            viewer: VIEWER,
            after: 1,
            signal: new AbortController().signal,
            tools: [check],
            providers: [statusBlock(() => "任务1 正在做", order)],
          },
          { ...engine, speech: { ...engine.speech, canSpeak: () => canSpeak }, director },
        ),
      );
      expect([canSpeak, toolNames(requests[0]), order]).toEqual([
        canSpeak,
        ["check_task"],
        ["status"],
      ]);
    }
  });
});
