// A turn's background tools, as Assistant Mode's start_task is one: offered after hers with their
// hint, their result stored as `started` while the work goes on outside the turn, and her next
// round reading what they started, in a chat and in a call alike.
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
import type { LlmTool, ToolResult } from "@eidolon/core";
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
  PartsOptions,
  PersonaParts,
  TurnOutput,
  TurnRequest,
} from "../src/types.ts";

const PERSONA = "alice";
const HEADER: ChatHeader = {
  format: CHAT_FORMAT,
  id: "0190f5c8-0000-7000-8000-0000000000bb",
  createdAt: 0,
  participants: [PERSONA],
};
const VIEWER: UserContext = { mid: 0, uname: "Ken", face: null, isLoggedIn: true };
const DONE: MindChunk = { type: "done", finishReason: "stop" };
const HINT = "你可以用这台电脑";
const ARGS = { goal: "写个网页", folder: "~/site" };

beforeAll(() => {
  const dir = join(dataHome(), "personas", PERSONA);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "persona.yaml"), "identity:\n  name: Alice\n");
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

const selfie: LlmTool = {
  schema: { name: "take_selfie", description: "selfie", properties: {}, required: [] },
  cancelOnInterruption: false,
  timeoutSecs: null,
  run: async () => ({ ok: true }),
};

/** Her parts, with a selfie unless `tools` says otherwise, and the options each turn asked for. */
function deps(
  mind: Mind,
  tools: readonly LlmTool[] = [selfie],
): { engine: EngineDeps; asked: PartsOptions[] } {
  const asked: PartsOptions[] = [];
  let n = 0;
  const parts: PersonaParts = {
    systemInstruction: "SYSTEM",
    providers: [],
    gate: null,
    tools,
    memories: async () => [],
  };
  const engine: EngineDeps = {
    createMind: () => mind,
    parts: async (_persona, _viewer, _chat, options = {}) => {
      asked.push(options);
      return parts;
    },
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
  return { engine, asked };
}

function startTask(run: BackgroundTool["run"]): BackgroundTool {
  return {
    schema: { name: "start_task", description: "start", properties: {}, required: [] },
    cancelOnInterruption: false,
    timeoutSecs: null,
    run,
  };
}

const callStart: MindChunk = {
  type: "tool-calls",
  calls: [{ id: "c1", name: "start_task", arguments: ARGS }],
};

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
  (request?.tools ?? []).map((tool) => tool.name);

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

/** Each tool line's name, call id, kind and state, as a call's turn streams them. */
const callToolLines = (outputs: readonly CallTurnOutput[]): string[] =>
  outputs.flatMap((output) =>
    output.type === "tool"
      ? [`${output.name}:${output.callId}:${output.async ? "async" : "sync"}:${output.state}`]
      : [],
  );

/** Resolves once `fn` holds, or rejects after a second. */
async function until(fn: () => boolean): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 1000) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

function viewAfter(log: readonly ChatEvent[], drafts: readonly ChatEventDraft[]) {
  const events = [...log, ...stampEvents(drafts, log.length, 2000)];
  return viewOf(HEADER, events, PERSONA, {
    windowMessages: CHAT_WINDOW_MESSAGES,
    nameOf: (id) => id,
  });
}

describe("a text turn's background tools", () => {
  test("are offered after hers, their hint going to her persona prefix", async () => {
    const { mind, requests } = fakeMind([{ type: "text", text: "嗯" }, DONE]);
    const { engine, asked } = deps(mind);
    const tool = startTask(async () => ({ task: "t1", status: "running" }));
    await collect(
      runTurn(
        {
          chat: chat(user("你好")),
          persona: PERSONA,
          viewer: VIEWER,
          signal: new AbortController().signal,
          background: { tools: [tool], hint: HINT },
        },
        engine,
      ),
    );
    expect(toolNames(requests[0])).toEqual(["take_selfie", "start_task"]);
    expect(asked).toEqual([{ others: [], voice: false, assistantHint: HINT }]);
  });

  test("store a result as started, and her turn goes on, reading its started result", async () => {
    const { mind, requests } = fakeMind(
      [callStart, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text", text: "好，我去弄啦" }, DONE],
    );
    const { engine } = deps(mind);
    const runs: unknown[] = [];
    const tool = startTask(async ({ arguments: args, callId }) => {
      runs.push([callId, args]);
      return { task: "t1", status: "awaiting-approval" };
    });
    const log = chat(user("帮我写个网页"));
    const outputs = await collect(
      runTurn(
        {
          chat: log,
          persona: PERSONA,
          viewer: VIEWER,
          signal: new AbortController().signal,
          background: { tools: [tool], hint: HINT },
        },
        engine,
      ),
    );
    expect(runs).toEqual([["c1", ARGS]]);
    const events = eventsOf(outputs);
    expect(events).toEqual([
      {
        type: "tool-call",
        persona: PERSONA,
        turn: "id-1",
        callId: "c1",
        name: "start_task",
        arguments: ARGS,
      },
      {
        type: "tool-result",
        persona: PERSONA,
        turn: "id-1",
        callId: "c1",
        result: { task: "t1", status: "awaiting-approval" },
        stage: "started",
      },
      {
        type: "message",
        id: "id-2",
        speaker: { kind: "persona", id: PERSONA },
        text: "好，我去弄啦",
      },
    ]);
    expect(
      outputs.flatMap((output) =>
        output.type === "tool" ? [`${output.name}:${output.state}`] : [],
      ),
    ).toEqual(["start_task:running", "start_task:done"]);
    // Her second round reads what her next turn's view will: what the tool started.
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: '{"task": "t1", "status": "awaiting-approval"}',
    });
    expect<unknown[]>(viewAfter(log.events, events)).toEqual([
      ...(requests[1]?.messages ?? []),
      { role: "assistant", content: "好，我去弄啦" },
    ]);
  });

  test("store a refusal as it is, settled, for her to tell", async () => {
    const { mind, requests } = fakeMind(
      [callStart, DONE],
      [{ type: "text", text: "那边有活" }, DONE],
    );
    const { engine } = deps(mind);
    const busy = { error: "A task is already working in /site: 写个网页." };
    const tool = startTask(async () => busy);
    const outputs = await collect(
      runTurn(
        {
          chat: chat(user("帮我写个网页")),
          persona: PERSONA,
          viewer: VIEWER,
          signal: new AbortController().signal,
          background: { tools: [tool], hint: HINT },
        },
        engine,
      ),
    );
    expect(eventsOf(outputs)[1]).toEqual({
      type: "tool-result",
      persona: PERSONA,
      turn: "id-1",
      callId: "c1",
      result: busy,
    });
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: '{"error": "A task is already working in /site: 写个网页."}',
    });
  });

  test("run on past her interrupted turn, their started result coming late", async () => {
    const controller = new AbortController();
    const starting = Promise.withResolvers<ToolResult>();
    let toolSignal: AbortSignal | undefined;
    const tool = startTask(({ signal }) => {
      toolSignal = signal;
      controller.abort();
      return starting.promise;
    });
    const added: { name: string; events: Promise<readonly ChatEventDraft[]> }[] = [];
    const late: LateTools = {
      signal: new AbortController().signal,
      add: (name, events) => {
        added.push({ name, events });
      },
    };
    const { mind, requests } = fakeMind([callStart, DONE]);
    const { engine } = deps(mind);
    const outputs = await collect(
      runTurn(
        {
          chat: chat(user("帮我写个网页")),
          persona: PERSONA,
          viewer: VIEWER,
          signal: controller.signal,
          late,
          background: { tools: [tool], hint: HINT },
        },
        engine,
      ),
    );
    expect(eventsOf(outputs).map((event) => event.type)).toEqual(["tool-call"]);
    expect(requests).toHaveLength(1);
    expect(toolSignal?.aborted).toBe(false);
    expect(added.map((entry) => entry.name)).toEqual(["start_task"]);
    starting.resolve({ task: "t1", status: "running" });
    expect(await added[0]?.events).toEqual([
      {
        type: "tool-result",
        persona: PERSONA,
        turn: "id-1",
        callId: "c1",
        result: { task: "t1", status: "running" },
        stage: "started",
      },
    ]);
  });
});

describe("a call's background tools", () => {
  test("come after her own tools, with their hint in her prefix and pipedog's async guidance only for hers", async () => {
    for (const own of [[selfie], []]) {
      const { mind, requests } = fakeMind([{ type: "text", text: "喂" }, DONE]);
      const { engine, asked } = deps(mind, own);
      const tool = startTask(async () => ({ task: "t1", status: "running" }));
      await collect(
        runTurn(
          {
            chat: chat(user("你好")),
            persona: PERSONA,
            viewer: VIEWER,
            signal: new AbortController().signal,
            ...callHooks("喂").hooks,
            background: { tools: [tool], hint: HINT },
          },
          engine,
        ),
      );
      expect([toolNames(requests[0]), requests[0]?.system]).toEqual(
        own.length > 0
          ? [["take_selfie", "start_task"], `SYSTEM\n\n${ASYNC_TOOL_INSTRUCTIONS}`]
          : [["start_task"], "SYSTEM"],
      );
      expect(asked).toEqual([{ others: [], voice: true, assistantHint: HINT }]);
    }
  });

  test("store a result as started with its value, her next round reading it, and stream a sync tool's lines", async () => {
    const { mind, requests } = fakeMind(
      [callStart, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text", text: "交给我吧" }, DONE],
    );
    const { engine } = deps(mind);
    const runs: unknown[] = [];
    const tool = startTask(async ({ arguments: args, callId }) => {
      runs.push([callId, args]);
      return { task: "t1", status: "awaiting-approval" };
    });
    const { hooks, results } = callHooks("交给我吧");
    const log = chat(user("帮我写个网页"));
    const outputs = await collect(
      runTurn(
        {
          chat: log,
          persona: PERSONA,
          viewer: VIEWER,
          signal: new AbortController().signal,
          ...hooks,
          background: { tools: [tool], hint: HINT },
        },
        engine,
      ),
    );
    expect(runs).toEqual([["c1", ARGS]]);
    const events = eventsOf(outputs);
    expect(events).toEqual([
      {
        type: "tool-call",
        persona: PERSONA,
        turn: "id-1",
        callId: "c1",
        name: "start_task",
        arguments: ARGS,
      },
      {
        type: "tool-result",
        persona: PERSONA,
        turn: "id-1",
        callId: "c1",
        result: { task: "t1", status: "awaiting-approval" },
        stage: "started",
      },
      {
        type: "message",
        id: "id-2",
        speaker: { kind: "persona", id: PERSONA },
        text: "交给我吧",
        modality: "call",
      },
    ]);
    expect(callToolLines(outputs)).toEqual([
      "start_task:c1:sync:running",
      "start_task:c1:sync:done",
    ]);
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: '{"task": "t1", "status": "awaiting-approval"}',
    });
    expect<unknown[]>(viewAfter(log.events, events)).toEqual([
      ...(requests[1]?.messages ?? []),
      { role: "assistant", content: "交给我吧" },
    ]);
    // Its final comes from whoever does the work, never through the call's async results.
    expect(results).toEqual([]);
  });

  test("run on past a barge-in, their started result reaching onAsyncResult; one the call's end cuts off brings nothing", async () => {
    for (const ending of [false, true]) {
      const barge = new AbortController();
      const end = new AbortController();
      const starting = Promise.withResolvers<ToolResult>();
      let toolSignal: AbortSignal | undefined;
      const tool = startTask(({ signal }) => {
        toolSignal = signal;
        barge.abort();
        return starting.promise;
      });
      const { mind, requests } = fakeMind([callStart, DONE]);
      const { engine } = deps(mind);
      const { hooks, results } = callHooks();
      const outputs = await collect(
        runTurn(
          {
            chat: chat(user("帮我写个网页")),
            persona: PERSONA,
            viewer: VIEWER,
            signal: barge.signal,
            ...hooks,
            asyncSignal: end.signal,
            background: { tools: [tool], hint: HINT },
          },
          engine,
        ),
      );
      expect(outputs.at(-1)).toEqual({ type: "ended", turn: "id-1" });
      expect(eventsOf(outputs).map((event) => event.type)).toEqual(["tool-call"]);
      expect(requests).toHaveLength(1);
      expect(toolSignal?.aborted).toBe(false);
      if (ending) {
        end.abort();
        expect(toolSignal?.aborted).toBe(true);
      }
      starting.resolve({ task: "t1", status: "running" });
      if (ending) {
        await Bun.sleep(20);
        expect(results).toEqual([]);
        continue;
      }
      await until(() => results.length > 0);
      expect(results).toEqual([
        [
          {
            type: "tool-result",
            persona: PERSONA,
            turn: "id-1",
            callId: "c1",
            result: { task: "t1", status: "running" },
            stage: "started",
          },
        ],
      ]);
    }
  });
});

describe("runChat", () => {
  test("hands a chat of one's background tools to her turn, whether it waits for the director or not", async () => {
    for (const canSpeak of [false, true]) {
      const { mind, requests } = fakeMind([{ type: "text", text: "嗯" }, DONE]);
      const { engine, asked } = deps(mind);
      const director: ChatDeps["director"] = {
        decide: async () => ({
          replies: [{ persona: PERSONA, mode: "text" }],
          source: "single",
          scores: {},
        }),
      };
      const log = chat(user("你好"));
      const tool = startTask(async () => ({ task: "t1", status: "running" }));
      await collect(
        runChat(
          {
            chat: log,
            read: async () => log,
            viewer: VIEWER,
            after: 1,
            signal: new AbortController().signal,
            background: { tools: [tool], hint: HINT },
          },
          { ...engine, speech: { ...engine.speech, canSpeak: () => canSpeak }, director },
        ),
      );
      expect([canSpeak, toolNames(requests[0]), asked[0]?.assistantHint]).toEqual([
        canSpeak,
        ["take_selfie", "start_task"],
        HINT,
      ]);
    }
  });
});
