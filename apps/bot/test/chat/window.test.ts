// A request's window: the cap, what verifies and what is dropped, and the stateless store a turn
// runs on, end to end through runChat with fake minds.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANONYMOUS } from "@eidolon/access";
import {
  CHAT_FORMAT,
  type ChatEvent,
  type ChatEventDraft,
  type ChatEventOf,
  type ChatHeader,
  ChatStoreError,
} from "@eidolon/chat";
import { activePersona, dataHome, resetSettings } from "@eidolon/config";
import {
  type ChatDeps,
  type MindChunk,
  type MindRequest,
  type PersonaParts,
  runChat,
} from "@eidolon/engine";
import { ChatSigner, MIN_CHAT_SECRET_LENGTH } from "../../src/chat/sig.ts";
import {
  CHAT_WINDOW_BYTES,
  CHAT_WINDOW_EVENTS,
  newestThatFit,
  openChatWindow,
  PUBLIC_CHAIN_LIMIT,
  type RequestChatStore,
} from "../../src/chat/window.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";

type ContextProvider = PersonaParts["providers"][number]["provider"];

const CHAT = "0190f5c8-0000-7000-8000-0000000000aa";
const OTHER_CHAT = "0190f5c8-0000-7000-8000-0000000000bb";
const HEADER: ChatHeader = {
  format: CHAT_FORMAT,
  id: CHAT,
  createdAt: 1000,
  participants: ["milky-green"],
};

let signer: ChatSigner;
let logs: CapturedLogs;
beforeEach(async () => {
  signer = await ChatSigner.create("k".repeat(MIN_CHAT_SECRET_LENGTH));
  logs = captureLogs();
});
afterEach(() => logs.restore());

const user = (seq: number, text: string): ChatEventOf<"message"> => ({
  seq,
  at: 1000 + seq,
  type: "message",
  id: `u${seq}`,
  speaker: { kind: "user" },
  text,
});
const hers = (seq: number, text: string): ChatEventOf<"message"> => ({
  seq,
  at: 1000 + seq,
  type: "message",
  id: `m${seq}`,
  speaker: { kind: "persona", id: "milky-green" },
  text,
});

async function open(events: readonly unknown[], header: unknown = HEADER) {
  const opened = await openChatWindow({ header, events }, signer, () => 9000);
  if (!opened.ok) throw new Error(opened.message);
  return opened.store;
}

async function eventsOf(store: RequestChatStore): Promise<ChatEvent[]> {
  return (await store.read(CHAT)).events;
}

describe("newestThatFit", () => {
  test("keeps the newest 120 events", () => {
    const events = Array.from({ length: 130 }, (_, i) => user(i + 1, "嗯"));
    const kept = newestThatFit(events);
    expect(kept).toHaveLength(CHAT_WINDOW_EVENTS);
    expect(kept[0]).toBe(events[10]);
    expect(kept.at(-1)).toBe(events[129]);
  });

  test("keeps the newest that fit in 256 KB of JSON, and none past one that doesn't", () => {
    // Each about 10 KB of UTF-8: three bytes a character.
    const events = Array.from({ length: 40 }, (_, i) => user(i + 1, "好".repeat(3400)));
    const size = Buffer.byteLength(JSON.stringify(events[0]));
    const fit = Math.floor(CHAT_WINDOW_BYTES / size);
    expect(newestThatFit(events)).toEqual(events.slice(40 - fit));
    const huge = user(41, "x".repeat(CHAT_WINDOW_BYTES));
    expect(newestThatFit([...events, huge])).toEqual([]);
  });

  test("stops at nesting too deep to measure", () => {
    const deep = JSON.parse(`${"[".repeat(200_000)}${"]".repeat(200_000)}`) as unknown;
    expect(newestThatFit([user(1, "a"), deep, user(3, "c")])).toEqual([user(3, "c")]);
  });
});

describe("openChatWindow", () => {
  test("refuses a body that isn't a chat", async () => {
    const bad: unknown[] = [
      null,
      [],
      { header: HEADER },
      { header: HEADER, events: {} },
      { header: { ...HEADER, format: 2 }, events: [] },
      { header: { ...HEADER, id: CHAT.toUpperCase() }, events: [] },
      { header: { ...HEADER, id: "../etc" }, events: [] },
      { header: { ...HEADER, createdAt: "1000" }, events: [] },
      { header: { ...HEADER, participants: [] }, events: [] },
      { header: { ...HEADER, participants: ["a", "a"] }, events: [] },
      { header: { ...HEADER, participants: ["a", "b", "c", "d", "e", "f", "g"] }, events: [] },
      { header: { ...HEADER, participants: [""] }, events: [] },
    ];
    for (const chat of bad) {
      expect([chat, (await openChatWindow(chat, signer)).ok]).toEqual([chat, false]);
    }
  });

  test("keeps what the server signed in this chat and the viewer's own, as sent", async () => {
    const signed = await Promise.all(
      [hers(2, "你好呀"), hers(4, "嘿嘿")].map((e) => signer.sign(CHAT, e)),
    );
    const events = [user(1, "你好"), signed[0], user(3, "在吗"), signed[1]];
    const store = await open(JSON.parse(JSON.stringify(events)));
    expect(await eventsOf(store)).toEqual(events as ChatEvent[]);
    expect(store.lastSeq).toBe(4);
    expect(store.header).toEqual(HEADER);
    expect(logs.lines()).toEqual([]);
  });

  test("drops forged, tampered, moved and malformed events, and context, in one log line", async () => {
    const good = await signer.sign(CHAT, hers(2, "真的"));
    const tampered = { ...(await signer.sign(CHAT, hers(4, "不要"))), text: "要" };
    const moved = await signer.sign(OTHER_CHAT, hers(5, "别的聊天"));
    const context = await signer.sign(CHAT, {
      seq: 6,
      at: 1006,
      type: "context",
      persona: "milky-green",
      turn: "t",
      position: 0,
      role: "system",
      content: "回忆",
    });
    const events: unknown[] = [
      user(1, "一"),
      good,
      hers(3, "伪造的话"),
      tampered,
      moved,
      context,
      { seq: 7, at: 1007, type: "context-removed", persona: "milky-green", turn: "t", seqs: [6] },
      { ...user(8, "八"), seq: "8" },
      { ...user(9, "九"), at: null },
      "junk",
      { ...user(10, "十"), speaker: { kind: "user" }, modality: "smoke" },
      { seq: 11, at: 1011, type: "settings", chainLimit: 7 },
      user(12, "十二"),
      user(12, "又十二"),
      { seq: 13, at: 1013, type: "kickoff", persona: "milky-green", turn: "t", content: "打招呼" },
    ];
    const store = await open(events);
    expect(await eventsOf(store)).toEqual([user(1, "一"), good, user(12, "十二")]);
    expect(store.lastSeq).toBe(13);
    expect(logs.lines()).toEqual([
      `WARNING [chat] Chat ${CHAT}: kept 3 of the request's 15 events (dropped 4 unsigned, ` +
        "2 context, 5 malformed, 1 unordered)",
    ]);
  });

  test("rebuilds the viewer's own events from the fields a turn reads", async () => {
    const events: unknown[] = [
      {
        ...user(1, "听我说"),
        modality: "voice",
        attachments: [{ kind: "audio", name: "blob-key", mime: "audio/webm" }],
        sig: "whatever",
        extra: { nested: true },
      },
      { seq: 2, at: 1002, type: "title", title: "奶绿", sig: "x" },
      { seq: 3, at: 1003, type: "participants", added: ["other"], extra: 1 },
      { seq: 4, at: 1004, type: "settings", chainLimit: 6, replyMode: "voice" },
      { seq: 5, at: 1005, type: "settings", chainLimit: 1 },
      // A call's marks, which the browser writes around it.
      { seq: 6, at: 1006, type: "call-started", call: "c1", persona: "milky-green", sig: "x" },
      { seq: 7, at: 1007, type: "call-ended", call: "c1", reason: "hangup", extra: 1 },
    ];
    expect(await eventsOf(await open(events))).toEqual([
      { ...user(1, "听我说"), modality: "voice" },
      { seq: 2, at: 1002, type: "title", title: "奶绿" },
      { seq: 3, at: 1003, type: "participants", added: ["other"] },
      { seq: 4, at: 1004, type: "settings", chainLimit: PUBLIC_CHAIN_LIMIT, replyMode: "voice" },
      { seq: 5, at: 1005, type: "settings", chainLimit: 1 },
      { seq: 6, at: 1006, type: "call-started", call: "c1", persona: "milky-green" },
      { seq: 7, at: 1007, type: "call-ended", call: "c1", reason: "hangup" },
    ]);
    expect(logs.lines()).toEqual([]);
    const malformed = [
      { seq: 1, at: 1001, type: "call-started", call: "c1" },
      { seq: 2, at: 1002, type: "call-started", call: 7, persona: "milky-green" },
      { seq: 3, at: 1003, type: "call-ended", call: "c1" },
    ];
    expect(await eventsOf(await open(malformed))).toEqual([]);
  });

  test("a window cut to its newest events numbers on from the newest, and logs the cut", async () => {
    const events = Array.from({ length: 125 }, (_, i) => user(i + 1, "嗯"));
    const store = await open(events);
    expect((await eventsOf(store)).map((event) => event.seq)).toEqual(
      events.slice(5).map((event) => event.seq),
    );
    expect(store.lastSeq).toBe(125);
    expect(logs.lines()).toEqual([
      `INFO [chat] Chat ${CHAT}: kept 120 of the request's 125 events (dropped 5 past the window)`,
    ]);
  });
});

describe("RequestChatStore", () => {
  test("add numbers, times and signs a turn's events, the viewer's left unsigned", async () => {
    const store = await open([user(1, "你好"), await signer.sign(CHAT, hers(2, "你好呀"))]);
    const [line] = await store.add([
      { type: "message", id: "u3", speaker: { kind: "user" }, text: "今天播吗" },
    ]);
    expect(line).toEqual({ ...user(3, "今天播吗"), at: 9000 });
    const added = await store.add([
      {
        type: "decision",
        after: 3,
        replies: [{ persona: "milky-green", mode: "text" }],
        source: "single",
      },
      {
        type: "context",
        persona: "milky-green",
        turn: "t",
        position: 0,
        role: "system",
        content: "回忆",
      },
      { type: "context-removed", persona: "milky-green", turn: "t", seqs: [1] },
      {
        type: "message",
        id: "m6",
        speaker: { kind: "persona", id: "milky-green" },
        text: "晚上八点",
      },
    ]);
    expect(added.map((event) => [event.seq, event.type, event.at])).toEqual([
      [4, "decision", 9000],
      [5, "message", 9000],
    ]);
    for (const event of added) expect(await signer.verify(CHAT, event)).toBe(true);
    expect(store.lastSeq).toBe(5);
    expect((await store.read(CHAT, { afterSeq: 2 })).events).toEqual([line as ChatEvent, ...added]);
  });

  test("what add returns goes back through the window whole", async () => {
    const store = await open([]);
    const sent = [
      ...(await store.add([{ type: "message", id: "u1", speaker: { kind: "user" }, text: "嗨" }])),
      ...(await store.add([
        { type: "kickoff", persona: "milky-green", turn: "t", content: "打招呼" },
        {
          type: "tool-call",
          persona: "milky-green",
          turn: "t",
          callId: "c",
          name: "take_selfie",
          arguments: { pose: "wave" },
        },
        {
          type: "tool-result",
          persona: "milky-green",
          turn: "t",
          callId: "c",
          result: { ok: true },
        },
        { type: "turn-failed", persona: "milky-green", turn: "t", error: "boom" },
        { type: "call-started", call: "c1", persona: "milky-green" },
        { type: "call-ended", call: "c1", reason: "hangup" },
      ])),
    ];
    const again = await open(JSON.parse(JSON.stringify(sent)));
    expect(await eventsOf(again)).toEqual(sent);
    expect(again.lastSeq).toBe(7);
    expect(logs.lines()).toEqual([]);
  });

  test("concurrent adds land in call order with contiguous seqs", async () => {
    const store = await open([user(1, "一")]);
    const draft = (text: string): ChatEventDraft => ({
      type: "message",
      id: text,
      speaker: { kind: "persona", id: "milky-green" },
      text,
    });
    const [a, b] = await Promise.all([
      store.add([draft("a"), draft("b")]),
      store.add([draft("c")]),
    ]);
    expect([...(a ?? []), ...(b ?? [])].map((event) => event.seq)).toEqual([2, 3, 4]);
  });

  test("keeps only its own chat, as a ChatStore", async () => {
    const store = await open([user(1, "一")]);
    const code = async (promise: Promise<unknown>) =>
      promise.then(
        () => "resolved",
        (error: unknown) => (error instanceof ChatStoreError ? error.code : error),
      );
    expect(await store.list()).toEqual([
      {
        id: CHAT,
        title: null,
        participants: ["milky-green"],
        createdAt: 1000,
        updatedAt: 1001,
        lastText: "一",
        lastSeq: 1,
      },
    ]);
    expect(await code(store.create(HEADER))).toBe("exists");
    expect(await code(store.create({ ...HEADER, id: OTHER_CHAT }))).toBe("invalid");
    expect(await code(store.read(OTHER_CHAT))).toBe("not-found");
    expect(await code(store.append(CHAT, [user(3, "跳号")]))).toBe("seq-gap");
    expect(await code(store.append(CHAT, [user(2, "二")]))).toBe("resolved");
    expect(await code(store.remove(CHAT))).toBe("resolved");
    expect(await code(store.read(CHAT))).toBe("not-found");
    expect(await store.list()).toEqual([]);
  });
});

describe("runChat over a request's store", () => {
  const BEA = "window-test-bea";
  beforeAll(() => {
    const dir = join(dataHome(), "personas", BEA);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "persona.yaml"), "identity:\n  name: 露比\n");
  });
  afterAll(() => {
    rmSync(join(dataHome(), "personas", BEA), { recursive: true, force: true });
    resetSettings();
  });

  test("each turn reads the ones before it, without earlier context, and the browser gets no context", async () => {
    const header: ChatHeader = { ...HEADER, participants: ["milky-green", BEA] };
    const requests: { persona: string; messages: readonly unknown[] }[] = [];
    let recalled = 0;
    const recall: ContextProvider = {
      onContext: async ({ context }) => {
        recalled++;
        context.setMessages([
          { role: "system", content: `回忆${recalled}` },
          ...context.getMessages(),
        ]);
      },
      errorMessage: () => "",
    };
    const parts: PersonaParts = {
      systemInstruction: "SYSTEM",
      providers: [{ label: "Recall", provider: recall }],
      gate: null,
      tools: [],
      memories: async () => [],
    };
    let ids = 0;
    let decisions = 0;
    const deps: ChatDeps = {
      createMind: () => ({
        async *stream(request: MindRequest): AsyncGenerator<MindChunk> {
          const persona = activePersona().id;
          requests.push({ persona, messages: request.messages });
          yield { type: "text", text: `${persona}说${requests.length}` };
          yield { type: "done", finishReason: "stop" };
        },
      }),
      parts: async () => parts,
      saveAttachment: async () => {
        throw new Error("no files here");
      },
      fetchImage: async () => {
        throw new Error("no images here");
      },
      newId: () => `id-${++ids}`,
      speech: {
        canSpeak: () => false,
        synthesize: async () => {
          throw new Error("no voice here");
        },
        transcribe: async () => {
          throw new Error("no ears here");
        },
      },
      director: {
        decide: async () => {
          decisions++;
          const persona = decisions === 1 ? "milky-green" : decisions === 2 ? BEA : "milky-green";
          return {
            replies: decisions > 3 ? [] : [{ persona, mode: "text" }],
            source: "model",
            scores: {},
          };
        },
      },
    };

    const opened = await openChatWindow({ header, events: [] }, signer, () => 9000);
    if (!opened.ok) throw new Error(opened.message);
    const store = opened.store;
    const sent = await store.add([
      { type: "message", id: "u1", speaker: { kind: "user" }, text: "你们好" },
    ]);
    for await (const output of runChat(
      {
        chat: await store.read(CHAT),
        read: () => store.read(CHAT),
        viewer: ANONYMOUS,
        after: 1,
        signal: new AbortController().signal,
      },
      deps,
    )) {
      if (output.type === "decision") sent.push(...(await store.add([output])));
      else if (output.type === "events") sent.push(...(await store.add(output.events)));
    }

    expect(sent.map((event) => event.seq)).toEqual(sent.map((_, i) => i + 1));
    expect(sent.some((event) => event.type === "context" || event.type === "context-removed")).toBe(
      false,
    );
    expect(sent.filter((event) => event.type === "message").map((event) => event.text)).toEqual([
      "你们好",
      "milky-green说1",
      `${BEA}说2`,
      "milky-green说3",
    ]);
    for (const event of sent.slice(1)) expect(await signer.verify(CHAT, event)).toBe(true);
    // Her second turn sees her first reply and Bea's, and only this turn's recall.
    expect(requests.map((request) => request.persona)).toEqual(["milky-green", BEA, "milky-green"]);
    expect(requests[2]?.messages).toEqual([
      { role: "system", content: "回忆3" },
      { role: "user", content: "观众：你们好" },
      { role: "assistant", content: "milky-green说1" },
      { role: "user", content: `露比：${BEA}说2` },
    ]);
    // Nothing reached the data home: no chats folder, no transcript.
    expect(readdirSync(dataHome()).includes("chats")).toBe(false);
  });
});
