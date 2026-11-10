// runChat over fake minds and a fake director: who answers in which order, the decisions it gives
// to store, the chain and its limit, and interruption.
import "../../config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UserContext } from "@eidolon/access";
import {
  CHAT_FORMAT,
  type ChatEvent,
  type ChatEventDraft,
  type ChatHeader,
  type ParticipantId,
  stampEvents,
} from "@eidolon/chat";
import { activePersona, consoleSink, dataHome, logger, resetSettings } from "@eidolon/config";
import { Director, type DirectorDecision, type DirectorInput } from "@eidolon/context";
import { type UsageRecord, usageRecord } from "@eidolon/providers";
import { type ChatDeps, type ChatOutput, runChat } from "../src/chat.ts";
import type { MindChunk, MindRequest, PersonaParts } from "../src/types.ts";

const PERSONAS: Record<string, string> = {
  ann: "identity:\n  name: 安妮\n  shortName: 安安\nchat:\n  talkativeness: 0.4\n",
  bea: "identity:\n  name: 露比\n  shortName: 小露\nchat:\n  interests: 唱歌、猫\n",
  ken: "identity:\n  name: Ken\nchat:\n  talkativeness: 0.9\n",
};
const VIEWER: UserContext = { mid: 0, uname: "小明", face: null, isLoggedIn: true };
const DONE: MindChunk = { type: "done", finishReason: "stop" };

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

function header(...participants: ParticipantId[]): ChatHeader {
  return {
    format: CHAT_FORMAT,
    id: "0190f5c8-0000-7000-8000-0000000000cc",
    createdAt: 0,
    participants,
  };
}

const user = (text: string): ChatEventDraft => ({
  type: "message",
  id: `u-${text}`,
  speaker: { kind: "user" },
  text,
});

type Reply = (request: MindRequest) => AsyncIterable<MindChunk>;

/** Each persona's mind says `<name>说<n>` on her nth turn, unless `replies` says otherwise. */
function minds(replies: Record<string, Reply> = {}) {
  const requests: { persona: string; request: MindRequest }[] = [];
  const turns = new Map<string, number>();
  const createMind = () => ({
    async *stream(request: MindRequest): AsyncGenerator<MindChunk> {
      const persona = activePersona().id;
      requests.push({ persona, request });
      const reply = replies[persona];
      if (reply !== undefined) {
        yield* reply(request);
        return;
      }
      const n = (turns.get(persona) ?? 0) + 1;
      turns.set(persona, n);
      yield { type: "text", text: `${activePersona().identity.name}说${n}` };
      yield DONE;
    },
  });
  return { createMind, requests };
}

type Decide = (input: DirectorInput, signal?: AbortSignal) => Promise<DirectorDecision>;

/** Answers with `ids` in order, one list per decision, and no one after them. */
function scripted(...rounds: (readonly string[])[]): { decide: Decide; inputs: DirectorInput[] } {
  const inputs: DirectorInput[] = [];
  return {
    inputs,
    decide: async (input) => {
      inputs.push(input);
      const ids = rounds[inputs.length - 1] ?? [];
      return {
        replies: ids.map((persona) => ({ persona, mode: "text" })),
        source: "model",
        scores: { invites_reply: 0.75 },
      };
    },
  };
}

const PARTS: PersonaParts = {
  systemInstruction: "SYSTEM",
  providers: [],
  gate: null,
  tools: [],
  memories: async () => [],
};

function deps(createMind: ChatDeps["createMind"], decide: Decide): ChatDeps {
  let n = 0;
  return {
    createMind,
    parts: async () => PARTS,
    saveAttachment: async () => {
      throw new Error("no files here");
    },
    fetchImage: async () => {
      throw new Error("no images here");
    },
    newId: () => `id-${++n}`,
    director: { decide },
  };
}

/** A chat as the runner keeps it: each output's events stored before the next is taken. */
function chatOf(head: ChatHeader, ...drafts: ChatEventDraft[]) {
  const events: ChatEvent[] = stampEvents(drafts, 0, 1000);
  const read = async () => ({ header: head, events: [...events] });
  async function drive(
    outputs: AsyncIterable<ChatOutput>,
    onOutput: (output: ChatOutput) => void = () => {},
  ): Promise<ChatOutput[]> {
    const all: ChatOutput[] = [];
    for await (const output of outputs) {
      all.push(output);
      onOutput(output);
      const stored =
        output.type === "events" ? output.events : output.type === "decision" ? [output] : [];
      events.push(...stampEvents(stored, events.length, 2000));
    }
    return all;
  }
  return { header: head, events, read, drive };
}

const messages = (events: readonly ChatEvent[]) =>
  events.flatMap((event) =>
    event.type === "message"
      ? [`${event.speaker.kind === "user" ? "viewer" : event.speaker.id}: ${event.text}`]
      : [],
  );
const decisions = (events: readonly ChatEvent[]) =>
  events.filter((event) => event.type === "decision");

function request(chat: ReturnType<typeof chatOf>, signal = new AbortController().signal) {
  const last = chat.events.at(-1) as ChatEvent;
  return {
    chat: { header: chat.header, events: [...chat.events] },
    read: chat.read,
    viewer: VIEWER,
    after: last.seq,
    signal,
  };
}

describe("runChat", () => {
  test("a chat of one asks no model, and she answers as in a chat of one before", async () => {
    let posted = 0;
    const director = new Director({
      apiKey: "k",
      fetch: (async () => {
        posted++;
        return Response.json({});
      }) as unknown as typeof fetch,
    });
    const chat = chatOf(header("ann"), user("你好"));
    const { createMind } = minds();
    const outputs = await chat.drive(
      runChat(request(chat), { ...deps(createMind, async () => ({}) as never), director }),
    );
    expect(posted).toBe(0);
    expect(outputs.map((output) => output.type)).toEqual([
      "decision",
      "started",
      "delta",
      "events",
      "ended",
    ]);
    expect(outputs[0]).toEqual({
      type: "decision",
      after: 1,
      replies: [{ persona: "ann", mode: "text" }],
      source: "single",
    });
    expect(messages(chat.events)).toEqual(["viewer: 你好", "ann: 安妮说1"]);
  });

  test("runs the chosen turns in order, each seeing the last, then asks about the last line", async () => {
    const { createMind, requests } = minds();
    const director = scripted(["bea", "ken"], []);
    const chat = chatOf(header("ann", "bea", "ken"), user("@Ken 大家好"));
    await chat.drive(runChat(request(chat), deps(createMind, director.decide)));
    expect(messages(chat.events)).toEqual(["viewer: @Ken 大家好", "bea: 露比说1", "ken: Ken说1"]);
    expect(requests.find(({ persona }) => persona === "ken")?.request.messages).toEqual([
      { role: "user", content: "小明：@Ken 大家好" },
      { role: "user", content: "露比：露比说1" },
    ]);
    expect(director.inputs.map(({ hop, lines, mentions }) => ({ hop, lines, mentions }))).toEqual([
      { hop: 0, lines: [{ speaker: { kind: "user" }, text: "@Ken 大家好" }], mentions: ["ken"] },
      {
        hop: 1,
        lines: [
          { speaker: { kind: "user" }, text: "@Ken 大家好" },
          { speaker: { kind: "persona", id: "bea" }, text: "露比说1" },
          { speaker: { kind: "persona", id: "ken" }, text: "Ken说1" },
        ],
        mentions: [],
      },
    ]);
    expect(director.inputs[0]?.participants).toEqual([
      {
        id: "ann",
        name: "安妮",
        shortName: "安安",
        summary: "",
        interests: [],
        talkativeness: 0.4,
      },
      {
        id: "bea",
        name: "露比",
        shortName: "小露",
        summary: "",
        interests: ["唱歌", "猫"],
        talkativeness: 0.5,
      },
      { id: "ken", name: "Ken", shortName: "Ken", summary: "", interests: [], talkativeness: 0.9 },
    ]);
    expect(decisions(chat.events).map(({ seq: _, at: __, ...decision }) => decision)).toEqual([
      {
        type: "decision",
        after: 1,
        replies: [
          { persona: "bea", mode: "text" },
          { persona: "ken", mode: "text" },
        ],
        source: "model",
        scores: { invites_reply: 0.75 },
      },
      {
        type: "decision",
        after: 4,
        replies: [],
        source: "model",
        scores: { invites_reply: 0.75 },
      },
    ]);
  });

  test("chains up to the chat's limit, the default 3 hops after the viewer's line", async () => {
    const { createMind } = minds();
    const run = async (...settings: ChatEventDraft[]) => {
      const director = scripted(["ann"], ["bea"], ["ann"], ["bea"], ["ann"]);
      const chat = chatOf(header("ann", "bea"), ...settings, user("聊吧"));
      await chat.drive(runChat(request(chat), deps(createMind, director.decide)));
      return { hops: director.inputs.map(({ hop }) => hop), lines: messages(chat.events).length };
    };
    expect(await run()).toEqual({ hops: [0, 1, 2, 3], lines: 5 });
    expect(await run({ type: "settings", chainLimit: 1 })).toEqual({ hops: [0, 1], lines: 3 });
    expect(
      await run({ type: "settings", chainLimit: 5 }, { type: "settings", chainLimit: 0 }),
    ).toEqual({ hops: [0], lines: 2 });
  });

  test("a round in which no one says anything ends the chain", async () => {
    const { createMind } = minds({
      bea: async function* () {
        yield DONE;
      },
    });
    const director = scripted(["bea"], ["ann"]);
    const chat = chatOf(header("ann", "bea"), user("在吗"));
    await chat.drive(runChat(request(chat), deps(createMind, director.decide)));
    expect(director.inputs).toHaveLength(1);
    expect(messages(chat.events)).toEqual(["viewer: 在吗"]);
  });

  test("an interruption stores what was said and drops the turns and hops to come", async () => {
    const controller = new AbortController();
    const { createMind, requests } = minds({
      bea: async function* (request) {
        yield { type: "text", text: "我想想" };
        if (!request.signal.aborted) {
          await new Promise((resolve) => request.signal.addEventListener("abort", resolve));
        }
        request.signal.throwIfAborted();
      },
    });
    const director = scripted(["bea", "ken"], ["ann"]);
    const chat = chatOf(header("ann", "bea", "ken"), user("你们呢"));
    await chat.drive(
      runChat(request(chat, controller.signal), deps(createMind, director.decide)),
      (output) => {
        if (output.type === "delta") controller.abort();
      },
    );
    expect(requests.map(({ persona }) => persona)).toEqual(["bea"]);
    expect(director.inputs).toHaveLength(1);
    expect(chat.events.at(-1)).toMatchObject({
      type: "message",
      speaker: { kind: "persona", id: "bea" },
      text: "我想想",
      interrupted: true,
    });
  });

  test("an interruption while the director decides ends it quietly, with nothing to store", async () => {
    const controller = new AbortController();
    const chat = chatOf(header("ann", "bea"), user("嗨"));
    const decide: Decide = (_input, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
        controller.abort();
      });
    const outputs = await chat.drive(
      runChat(request(chat, controller.signal), deps(minds().createMind, decide)),
    );
    expect(outputs).toEqual([]);
  });

  test("the director's request is billed to the chat", async () => {
    const chat = chatOf(header("ann", "bea"), user("嗨"));
    let billed: UsageRecord | null = null;
    const decide: Decide = async () => {
      billed = usageRecord({ role: "gate", provider: "openrouter", model: "m", units: {} });
      return { replies: [], source: "model", scores: {} };
    };
    await chat.drive(runChat(request(chat), deps(minds().createMind, decide)));
    expect(billed).toMatchObject({ source: "chat", session: chat.header.id });
  });

  test("without a decision model, the rules choose: whoever the line names, then no hop", async () => {
    const chat = chatOf(header("ann", "bea", "ken"), user("小露你觉得呢"));
    const { createMind } = minds();
    await chat.drive(
      runChat(request(chat), {
        ...deps(createMind, async () => ({}) as never),
        director: new Director(null),
      }),
    );
    expect(messages(chat.events)).toEqual(["viewer: 小露你觉得呢", "bea: 露比说1"]);
    expect(decisions(chat.events).map(({ replies, source }) => ({ replies, source }))).toEqual([
      { replies: [{ persona: "bea", mode: "text" }], source: "fallback" },
      { replies: [], source: "fallback" },
    ]);
  });
});
