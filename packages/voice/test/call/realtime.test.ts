// A realtime persona's call on a scripted session: what it opens the session with, how its greeting
// and a bound call's history go in, what the client is told for each server event (§9 of the
// contract), barge-ins truncated where the cursor stood, typed text answered (E2), her recall
// mirrored (E1), bot-output held for the caller's transcript (E4), her tools, and a fatal error
// ending the call (E8). The real prepareTurn and runTool run on fake parts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChatEvent, finalEnvelope, stampEvents, startedEnvelope } from "@eidolon/chat";
import { AsyncQueue, consoleSink, logger, resetSettings } from "@eidolon/config";
import { buildGreetingKickoff } from "@eidolon/context";
import type { ContextProvider, LlmTool } from "@eidolon/core";
import { ASYNC_TOOL_INSTRUCTIONS, type EngineDeps } from "@eidolon/engine";
import { reportUsage, setUsageSink, type UsageRecord } from "@eidolon/providers";
import type { RealtimeEvent, RealtimeOptions, RealtimeSession } from "@eidolon/providers/realtime";
import { callLog, memoryCallLog } from "../../src/call/log.ts";
import { packHistory, runRealtimeCall } from "../../src/call/realtime.ts";
import { runVoiceCall } from "../../src/index.ts";
import type { RtviMessage } from "../../src/rtvi/codec.ts";
import type { CallDeps, CallPlan } from "../../src/types.ts";
import { FakeClock } from "../input/clock.ts";
import { ABOUT, FakeTransport, HEADER, HOST, line, settle, VIEWER } from "./harness.ts";

let logs: string[];
const saved = process.env.REALTIME_PROVIDER;
beforeEach(() => {
  logs = [];
  logger.setSink((record) => logs.push(record.message));
});
afterEach(() => {
  logger.setSink(consoleSink);
  if (saved === undefined) delete process.env.REALTIME_PROVIDER;
  else process.env.REALTIME_PROVIDER = saved;
  resetSettings();
});

type Dialect = "openai" | "xai";

/** A realtime session the test plays the server of: it records what the call asked of it. */
class FakeSession implements RealtimeSession {
  readonly inputRate: number;
  readonly outputRate = 24_000 as const;
  readonly events = new AsyncQueue<RealtimeEvent>();
  /** What the call asked, in order, as short lines. */
  readonly asked: string[] = [];
  samples = 0;
  closed = false;
  #items = 0;

  constructor(inputRate: number) {
    this.inputRate = inputRate;
  }

  /** Bills what it hears, as an hour-priced model's meter does. */
  appendAudio(pcm: Int16Array): void {
    this.samples += pcm.length;
    reportUsage({
      role: "realtime",
      provider: "xai",
      model: "grok-voice-latest",
      units: { audioSeconds: pcm.length / this.inputRate },
    });
  }

  async addItem(item: { readonly role: "user" | "system"; readonly text: string }) {
    const id = `item-${++this.#items}`;
    this.asked.push(`add ${id} ${item.role} ${item.text}`);
    return id;
  }

  deleteItem(itemId: string): void {
    this.asked.push(`delete ${itemId}`);
  }

  createResponse(): void {
    this.asked.push("create");
  }

  cancelResponse(): void {
    this.asked.push("cancel");
  }

  truncate(itemId: string, contentIndex: number, audioEndMs: number): void {
    this.asked.push(`truncate ${itemId} ${contentIndex} ${audioEndMs}`);
  }

  sendToolOutput(callId: string, output: string): void {
    this.asked.push(`output ${callId} ${output}`);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.events.close();
  }
}

/**
 * A provider that puts the next of `blocks` in as her archive's block at position 1, replacing the
 * last, as the archive's setBlock does.
 */
function archive(blocks: (string | null)[]): ContextProvider {
  return {
    async onContext({ context }) {
      const next = blocks.shift();
      if (next === undefined || next === null) return;
      const kept = context
        .getMessages()
        .filter((m) => !String((m as { content?: unknown }).content).startsWith("档案："));
      kept.splice(Math.min(1, kept.length), 0, { role: "system", content: `档案：${next}` });
      context.setMessages(kept);
    },
    errorMessage: (error) => String(error),
  };
}

const recallTool = (gate?: Promise<void>): LlmTool => ({
  schema: { name: "recall_streams", description: "", properties: {}, required: [] },
  cancelOnInterruption: true,
  timeoutSecs: null,
  async run({ signal }) {
    if (gate !== undefined) {
      await Promise.race([
        gate,
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      ]);
    }
    return { streams: ["花店"] };
  },
});

function selfieTool() {
  const shot = Promise.withResolvers<void>();
  const tool: LlmTool = {
    schema: { name: "take_selfie", description: "", properties: {}, required: [] },
    cancelOnInterruption: false,
    timeoutSecs: 120,
    async run(_call, effects) {
      await shot.promise;
      await effects.sendServerMessage({ type: "selfie", urls: ["https://x/1.png"] });
      return { ok: true };
    },
  };
  return { tool, shoot: () => shot.resolve() };
}

function engine(
  tools: readonly LlmTool[],
  blocks: (string | null)[],
  provider: ContextProvider = archive(blocks),
): EngineDeps {
  let n = 0;
  return {
    createMind: () => {
      throw new Error("a realtime model is her mind");
    },
    parts: async () => ({
      systemInstruction: "SYSTEM",
      providers: [{ label: "StreamArchiveService", provider }],
      gate: null,
      tools,
      memories: async () => [],
    }),
    saveAttachment: async () => {
      throw new Error("a call saves no files");
    },
    fetchImage: async () => {
      throw new Error("a call fetches no images");
    },
    newId: () => `e-${++n}`,
    speech: {
      canSpeak: () => false,
      synthesize: () => Promise.reject(new Error("no voice messages")),
      transcribe: () => Promise.reject(new Error("no voice messages")),
    },
  };
}

interface Options {
  readonly dialect?: Dialect;
  readonly greet?: boolean;
  /** The chat a bound call opens on. */
  readonly chat?: readonly ChatEvent[];
  readonly tools?: readonly LlmTool[];
  readonly blocks?: (string | null)[];
  /** Her one context provider, the scripted archive by default. */
  readonly provider?: ContextProvider;
  /** Started as production starts it, through runVoiceCall and its usage scope. */
  readonly scoped?: boolean;
}

let serial = 0;
const s = (n: number) => new Int16Array(n).fill(9);

async function startRealtime(o: Options = {}) {
  const dialect = o.dialect ?? "openai";
  process.env.REALTIME_PROVIDER = dialect;
  resetSettings();
  const transport = new FakeTransport();
  const clock = new FakeClock(0);
  const session = new FakeSession(dialect === "xai" ? 16_000 : 24_000);
  let opened: RealtimeOptions | null = null;
  const deps: CallDeps = {
    engine: engine(o.tools ?? [], o.blocks ?? [], o.provider),
    runTurn: (() => {
      throw new Error("a realtime call runs no turns");
    }) as unknown as CallDeps["runTurn"],
    openStt: async () => {
      throw new Error("no hearing role");
    },
    openSpeech: () => {
      throw new Error("no voice role");
    },
    openRealtime: async (options) => {
      opened = options;
      return session;
    },
    models: { silero: "", smartTurn: "" },
    about: ABOUT,
    clock,
  };
  const log =
    o.chat === undefined
      ? memoryCallLog(HEADER)
      : callLog({ header: HEADER, events: o.chat }, async () => {});
  const plan: CallPlan = {
    id: `call-${++serial}`,
    host: HOST,
    viewer: VIEWER,
    log,
    greet: o.greet ?? false,
    realtime: true,
  };
  const shutdown = new AbortController();
  let ids = 0;
  const running = o.scoped
    ? runVoiceCall(transport, plan, deps, shutdown.signal)
    : runRealtimeCall(transport, plan, deps, shutdown.signal, { newId: () => `id-${++ids}` });
  for (let i = 0; i < 50 && !transport.connected; i++) await Bun.sleep(1);
  await settle();
  let mark = 0;
  let asked = 0;

  const call = {
    transport,
    session,
    clock,
    log,
    plan,
    shutdown,
    running,
    get opened(): RealtimeOptions {
      if (opened === null) throw new Error("the session wasn't opened");
      return opened;
    },
    /** The client's messages since the last `news`, as lines. */
    news(): string[] {
      const lines = transport.sent.slice(mark).map((m) => line(m as RtviMessage));
      mark = transport.sent.length;
      return lines;
    },
    /** What the call asked of the session since the last `asks`. */
    asks(): string[] {
      const lines = session.asked.slice(asked);
      asked = session.asked.length;
      return lines;
    },
    events(): ChatEvent[] {
      return [...log.snapshot().events];
    },
    async server(...events: RealtimeEvent[]): Promise<void> {
      for (const event of events) session.events.push(event);
      await settle();
    },
    async rtvi(type: string, data?: Record<string, unknown>): Promise<void> {
      transport.rtvi(type, data);
      await settle();
    },
    async ready(): Promise<void> {
      await call.rtvi("client-ready", { version: "2.3.0" });
    },
    /** Pulls `samples` in the transport's 10 ms frames. */
    async play(samples: number): Promise<void> {
      const source = transport.source;
      if (source === null) throw new Error("no speaker attached");
      for (let left = samples; left > 0; left -= 240) source.pull(Math.min(240, left));
      await settle();
    },
    async advance(ms: number): Promise<void> {
      clock.advance(ms);
      await settle();
    },
  };
  return call;
}

type Call = Awaited<ReturnType<typeof startRealtime>>;

const started = (responseId: string): RealtimeEvent => ({ type: "response-started", responseId });
const audio = (responseId: string, itemId: string, samples: number, contentIndex = 0) =>
  ({ type: "audio", responseId, itemId, contentIndex, pcm: s(samples) }) as const;
const said = (responseId: string, itemId: string, text: string): RealtimeEvent => ({
  type: "transcript-delta",
  responseId,
  itemId,
  text,
});
const done = (responseId: string, error?: string): RealtimeEvent =>
  error === undefined
    ? { type: "response-done", responseId }
    : { type: "response-done", responseId, error };
const heard = (text: string, final: boolean): RealtimeEvent => ({
  type: "user-transcript",
  itemId: "u1",
  text,
  final,
});

/** A whole response spoken through one item, played to its end. */
async function reply(call: Call, id: string, text: string[], samples = 2_400): Promise<void> {
  await call.server(started(id), audio(id, `${id}-item`, samples));
  for (const delta of text) await call.server(said(id, `${id}-item`, delta));
  await call.server(done(id));
  await call.play(samples);
}

/** The caller's turn as the server's VAD and transcription report it. */
async function turn(call: Call, text: string): Promise<void> {
  await call.server(
    { type: "speech-started" },
    { type: "speech-stopped" },
    heard(text.slice(0, 1), false),
    heard(text, true),
  );
}

const messages = (call: Call) =>
  call
    .events()
    .filter((e) => e.type === "message")
    .map((e) => [e.speaker.kind, e.text, e.modality, e.interrupted === true]);

describe("packHistory", () => {
  test("nothing, one user message as it is, or the whole history in one user item", () => {
    expect(packHistory([], "openai")).toEqual([]);
    expect(packHistory([{ role: "user", content: "你好" }], "openai")).toEqual(["你好"]);
    expect(packHistory([{ role: "system", content: "S" }], "openai")).toEqual([]);
    expect(
      packHistory(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
        "openai",
      ),
    ).toEqual([" a b"]);
    expect(
      packHistory(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
        "xai",
      ),
    ).toEqual(["a b"]);
    const history = [
      { role: "user", content: "在吗" },
      { role: "assistant", content: "在呀" },
      { role: "developer", content: "N" },
    ];
    const [openai] = packHistory(history, "openai");
    const [xai] = packHistory(history, "xai");
    const body = JSON.stringify(
      [
        { role: "user", content: "在吗" },
        { role: "assistant", content: "在呀" },
        { role: "user", content: "N" },
      ],
      null,
      2,
    );
    expect(openai).toContain(`starting point for the current conversation.\n\n${body}\n\n`);
    expect(openai).toEndWith(
      "simple say that you\n        are ready to continue the conversation.",
    );
    expect(xai).toEndWith("simply say that you\n        are ready to continue the conversation.");
    // A system message opening it gives way to the session's instructions.
    expect(packHistory([{ role: "system", content: "S" }, ...history], "openai")).toEqual([openai]);
    // The input is left as it was.
    expect(history[2]?.role).toBe("developer");
  });
});

describe("runRealtimeCall", () => {
  test("opens OpenAI's session with her instructions, tools and voice, hearing at 24 kHz", async () => {
    const selfie = selfieTool();
    const call = await startRealtime({ tools: [recallTool(), selfie.tool] });
    expect(call.opened).toMatchObject({
      instructions: `SYSTEM\n\n${ASYNC_TOOL_INSTRUCTIONS}`,
      tools: [{ name: "recall_streams" }, { name: "take_selfie" }],
      voice: "marin",
      transcription: { model: "gpt-realtime-whisper", language: "zh" },
    });
    expect(logs).toContain("Client connected");
    call.transport.audioIn.push(new Int16Array(320));
    await settle();
    expect(call.session.samples).toBeGreaterThan(0);
    call.transport.leave();
    expect(await call.running).toBe("client");
    expect(call.session.closed).toBe(true);
    expect(logs.at(-1)).toBe("Client disconnected");
  });

  test("the caller's audio, delivered outside the call's scope, is billed to the call", async () => {
    const records: UsageRecord[] = [];
    setUsageSink((record) => records.push(record));
    try {
      const call = await startRealtime({ dialect: "xai", scoped: true });
      // A transport's callback runs outside the call's scope.
      setTimeout(() => call.transport.audioIn.push(new Int16Array(320)), 0);
      for (let i = 0; i < 50 && call.session.samples === 0; i++) await Bun.sleep(2);
      expect(records).toMatchObject([
        { role: "realtime", source: "call", session: call.plan.id, units: { audioSeconds: 0.02 } },
      ]);
      call.transport.leave();
      await call.running;
    } finally {
      setUsageSink(null);
    }
  });

  test("xAI's transcribes on its own, takes 16 kHz as it comes, and needs no async guidance", async () => {
    const call = await startRealtime({ dialect: "xai", tools: [recallTool()] });
    expect(call.opened).toMatchObject({
      instructions: "SYSTEM",
      voice: "eve",
      transcription: null,
    });
    call.transport.audioIn.push(new Int16Array(320));
    await settle();
    expect(call.session.samples).toBe(320);
    call.transport.leave();
    await call.running;
  });

  test("the greeting: the kickoff goes in as the conversation, then her response", async () => {
    const call = await startRealtime({ greet: true });
    expect(call.asks()).toEqual([]);
    await call.ready();
    const kickoff = buildGreetingKickoff([]);
    expect(call.asks()).toEqual([`add item-1 user ${kickoff}`, "create"]);
    expect(call.events().map((e) => e.type)).toEqual(["kickoff"]);
    expect(call.news()).toEqual(["bot-ready"]);

    await reply(call, "r1", ["你好呀。", "欢迎来花店"]);
    expect(call.news()).toEqual([
      "bot-llm-started",
      "bot-tts-started",
      "bot-llm-text 你好呀。",
      // A sentence ends once the next character shows it does (D7); her last once the response has.
      "bot-llm-text 欢迎来花店",
      "bot-transcription 你好呀。",
      "bot-tts-stopped",
      "bot-llm-stopped",
      "bot-transcription 欢迎来花店",
      "bot-started-speaking",
      "bot-output new 你好呀。",
      "bot-output completed 你好呀。",
      "bot-tts-text 你好呀。",
      "bot-output new 欢迎来花店",
      "bot-output completed 欢迎来花店",
      "bot-tts-text 欢迎来花店",
      "bot-stopped-speaking",
    ]);
    expect(messages(call)).toEqual([["persona", "你好呀。欢迎来花店", "call", false]]);
    call.transport.leave();
    await call.running;
  });

  test("a call bound to a chat opens on its history, packed into one item with the kickoff", async () => {
    const chat = stampEvents(
      [
        { type: "message", id: "m1", speaker: { kind: "user" }, text: "我喜欢向日葵" },
        { type: "message", id: "m2", speaker: { kind: "persona", id: HOST }, text: "记住啦" },
        {
          type: "tool-call",
          persona: HOST,
          turn: "t",
          callId: "c0",
          name: "recall_streams",
          arguments: {},
        },
        { type: "tool-result", persona: HOST, turn: "t", callId: "c0", result: { ok: true } },
      ],
      0,
      1,
    );
    const call = await startRealtime({ greet: true, chat, blocks: ["上次聊了花"] });
    await call.ready();
    const kickoff = buildGreetingKickoff([]);
    const [packed, create] = call.asks();
    expect(create).toBe("create");
    // Her tool calls stay out of it, and her recall goes in at its place.
    expect(packed).toBe(
      `add item-1 user ${
        packHistory(
          [
            { role: "user", content: "我喜欢向日葵" },
            { role: "system", content: "档案：上次聊了花" },
            { role: "assistant", content: "记住啦" },
            { role: "user", content: kickoff },
          ],
          "openai",
        )[0]
      }`,
    );
    call.transport.leave();
    await call.running;
  });

  test("without a greeting, the history goes in as the session opens, and no response is asked", async () => {
    const chat = stampEvents(
      [{ type: "message", id: "m1", speaker: { kind: "user" }, text: "晚上好" }],
      0,
      1,
    );
    const call = await startRealtime({ chat });
    expect(call.asks()).toEqual(["add item-1 user 晚上好"]);
    await call.ready();
    expect(call.asks()).toEqual([]);
    call.transport.leave();
    await call.running;
  });

  test("one bot-llm-started per response, however many items it speaks through (E5)", async () => {
    const call = await startRealtime();
    await call.ready();
    call.news();
    await call.server(
      started("r1"),
      audio("r1", "a", 480),
      said("r1", "a", "第一句。"),
      audio("r1", "b", 480, 1),
      said("r1", "b", "第二句。"),
      done("r1"),
    );
    await call.play(960);
    expect(call.news().filter((l) => l === "bot-llm-started")).toHaveLength(1);
    expect(messages(call)).toEqual([["persona", "第一句。第二句。", "call", false]]);
    call.transport.leave();
    await call.running;
  });

  test("the caller's turn: transcripts cumulative, her line stored, then her recall (E1)", async () => {
    const call = await startRealtime({ blocks: ["一", "二", "三"] });
    await call.ready();
    call.news();
    await turn(call, "你好");
    expect(call.news()).toEqual([
      "user-started-speaking",
      "bot-interrupted",
      "user-stopped-speaking",
      "user-input transcription 你",
      "user-transcription 你",
      "user-input transcription 你好",
      "user-transcription 你好",
      // No reply is answering it: her context takes it at once.
      "user-llm-text 你好",
    ]);
    // The first block goes in as an item; each one after replaces the one before it.
    expect(call.asks()).toEqual(["add item-1 system 档案：一"]);
    await turn(call, "再见");
    expect(call.asks()).toEqual(["add item-2 system 档案：二", "delete item-1"]);
    expect(
      call
        .events()
        .map((e) => (e.type === "message" ? `${e.speaker.kind} ${e.text} ${e.modality}` : e.type)),
    ).toEqual(["user 你好 call", "context", "user 再见 call", "context-removed", "context"]);
    call.transport.leave();
    await call.running;
  });

  test("her recall stops when the caller speaks again, storing and sending nothing", async () => {
    const aborted: unknown[] = [];
    const slow: ContextProvider = {
      onContext: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted.push(signal.reason);
            reject(signal.reason);
          });
        }),
      errorMessage: String,
    };
    const call = await startRealtime({ provider: slow });
    await call.ready();
    await turn(call, "你好");
    expect(aborted).toEqual([]);
    await call.server({ type: "speech-started" });
    expect(aborted).toEqual(["interrupted"]);
    expect(call.asks()).toEqual([]);
    expect(call.events().map((e) => e.type)).toEqual(["message"]);
    expect(logs.some((l) => l.includes("recall failed"))).toBe(false);
    call.transport.leave();
    await call.running;
  });

  test("a barge-in truncates the item where the cursor stood, and keeps what was heard", async () => {
    const call = await startRealtime();
    await call.ready();
    await call.server(
      started("r1"),
      audio("r1", "it1", 4_800, 0),
      said("r1", "it1", "今天来了玫瑰，"),
      audio("r1", "it1", 4_800, 0),
      said("r1", "it1", "还有向日葵。"),
    );
    await call.play(6_000);
    call.news();
    call.asks();
    await call.server({ type: "speech-started" });
    // OpenAI's server cancels its own response; the client only truncates.
    expect(call.asks()).toEqual(["truncate it1 0 250"]);
    expect(call.news()).toEqual([
      "user-started-speaking",
      "bot-interrupted",
      "bot-llm-stopped",
      "bot-tts-stopped",
      "bot-stopped-speaking",
    ]);
    expect(messages(call)).toEqual([["persona", "今天来了玫瑰，", "call", true]]);
    // What the cut response still sends is dropped.
    await call.server(said("r1", "it1", "要看看吗？"), audio("r1", "it1", 480), done("r1"));
    await call.play(480);
    expect(call.news()).toEqual([]);
    call.transport.leave();
    await call.running;
  });

  test("xAI's client also cancels the response on every barge-in", async () => {
    const call = await startRealtime({ dialect: "xai" });
    await call.ready();
    await call.server({ type: "speech-started" });
    expect(call.asks()).toEqual(["cancel"]);
    call.transport.leave();
    await call.running;
  });

  test("a barge-in before her first audio cuts the response and stores nothing", async () => {
    const call = await startRealtime();
    await call.ready();
    await call.server(started("r1"), said("r1", "it1", "嗯，"));
    call.news();
    await call.server({ type: "speech-started" });
    expect(call.asks()).toEqual([]);
    expect(call.news()).toEqual(["user-started-speaking", "bot-interrupted", "bot-llm-stopped"]);
    expect(messages(call)).toEqual([]);
    call.transport.leave();
    await call.running;
  });

  test("the caller's user-llm-text goes out once the reply answering it has played, or is cut", async () => {
    const call = await startRealtime();
    await call.ready();
    await call.server({ type: "speech-started" }, { type: "speech-stopped" });
    await call.server(started("r1"), audio("r1", "it1", 2_400), heard("在吗", true));
    expect(call.news()).not.toContain("user-llm-text 在吗");
    await call.server(said("r1", "it1", "在呀。"), done("r1"));
    await call.play(2_400);
    expect(call.news().slice(-2)).toEqual(["user-llm-text 在吗", "bot-stopped-speaking"]);

    await call.server({ type: "speech-started" }, { type: "speech-stopped" });
    await call.server(started("r2"), audio("r2", "it2", 4_800), heard("你好", true));
    await call.play(1_200);
    call.news();
    await call.server({ type: "speech-started" });
    expect(call.news()).toEqual([
      "user-started-speaking",
      "bot-interrupted",
      "bot-llm-stopped",
      "bot-tts-stopped",
      "bot-stopped-speaking",
      "user-llm-text 你好",
    ]);
    call.transport.leave();
    await call.running;
  });

  test("her bot-output waits for the caller's final transcript, a second at most (E4)", async () => {
    const call = await startRealtime();
    await call.ready();
    await call.server({ type: "speech-started" }, { type: "speech-stopped" });
    await reply(call, "r1", ["好呀。"]);
    const before = call.news();
    expect(before).not.toContain("bot-output new 好呀。");
    expect(before).toContain("bot-stopped-speaking");
    // Her line waits too, so the caller's comes first.
    expect(messages(call)).toEqual([]);
    await call.server(heard("在吗", true));
    expect(call.news()).toEqual([
      "user-input transcription 在吗",
      "user-transcription 在吗",
      "bot-output new 好呀。",
      "bot-output completed 好呀。",
      "bot-tts-text 好呀。",
      "user-llm-text 在吗",
    ]);
    expect(messages(call)).toEqual([
      ["user", "在吗", "call", false],
      ["persona", "好呀。", "call", false],
    ]);

    await call.server({ type: "speech-started" }, { type: "speech-stopped" });
    await reply(call, "r2", ["嗯。"]);
    expect(call.news()).not.toContain("bot-output new 嗯。");
    await call.advance(1_000);
    expect(call.news()).toEqual([
      "bot-output new 嗯。",
      "bot-output completed 嗯。",
      "bot-tts-text 嗯。",
    ]);
    call.transport.leave();
    await call.running;
  });

  test("typed text cuts her off and is answered as the caller's line (E2)", async () => {
    const call = await startRealtime();
    await call.ready();
    await call.server(
      started("r1"),
      audio("r1", "it1", 4_800),
      said("r1", "it1", "我在说话。"),
      audio("r1", "it1", 4_800),
    );
    await call.play(6_000);
    call.news();
    call.asks();
    await call.rtvi("send-text", {
      content: "等一下",
      options: { run_immediately: true, audio_response: true },
    });
    expect(call.asks()).toEqual([
      // Cancelled first, as pipedog's xAI service cancels an interruption before it truncates.
      "cancel",
      "truncate it1 0 250",
      "add item-1 user 等一下",
      "create",
    ]);
    expect(call.news()).toEqual([
      "bot-interrupted",
      "bot-llm-stopped",
      "bot-tts-stopped",
      "bot-stopped-speaking",
      "user-input chat 等一下",
      "user-llm-text 等一下",
    ]);
    expect(messages(call)).toEqual([
      ["persona", "我在说话。", "call", true],
      ["user", "等一下", "text", false],
    ]);

    await call.rtvi("send-text", {
      content: "顺便说一句",
      options: { run_immediately: false, audio_response: true },
    });
    expect(call.asks()).toEqual(["add item-2 user 顺便说一句"]);
    expect(call.news()).toEqual(["user-input chat 顺便说一句"]);
    call.transport.leave();
    await call.running;
  });

  test("a line typed to run now runs her recall, as a spoken one does (E1)", async () => {
    const call = await startRealtime({ blocks: ["一", "二"] });
    await call.ready();
    const typed = (content: string, now: boolean) =>
      call.rtvi("send-text", { content, options: { run_immediately: now, audio_response: true } });
    await typed("给我讲讲花店", true);
    await settle();
    expect(call.asks()).toEqual([
      "add item-1 user 给我讲讲花店",
      "create",
      "add item-2 system 档案：一",
    ]);
    expect(call.events().map((e) => e.type)).toEqual(["message", "context"]);
    // A blank line, and one left for her next response, run none.
    await typed("  ", true);
    await typed("顺便说一句", false);
    await settle();
    expect(call.asks()).toEqual(["add item-3 user   ", "create", "add item-4 user 顺便说一句"]);
    expect(call.events().map((e) => e.type)).toEqual(["message", "context", "message", "message"]);
    call.transport.leave();
    await call.running;
  });

  test("a sync tool's result is answered once her response has played out, then she goes on", async () => {
    const gate = Promise.withResolvers<void>();
    const call = await startRealtime({ tools: [recallTool(gate.promise)] });
    await call.ready();
    await call.server(started("r1"), audio("r1", "it1", 480), said("r1", "it1", "我查一下。"));
    await call.server({
      type: "tool-call",
      callId: "c1",
      name: "recall_streams",
      arguments: { period: "recent" },
    });
    await call.server(done("r1"));
    call.news();
    gate.resolve();
    await settle();
    expect(call.news()).toEqual(["llm-function-call-stopped c1"]);
    // Her audio is still playing: the answer waits.
    expect(call.asks()).toEqual([]);
    await call.play(480);
    expect(call.asks()).toEqual([`output c1 {"streams": ["花店"]}`, "create"]);
    expect(
      call.events().map((e) => (e.type === "tool-result" ? `${e.type} ${e.callId}` : e.type)),
    ).toEqual(["tool-call", "tool-result c1", "message"]);
    call.transport.leave();
    await call.running;
  });

  test("a sync tool the caller cuts off is cancelled and answered CANCELLED", async () => {
    const gate = Promise.withResolvers<void>();
    const call = await startRealtime({ tools: [recallTool(gate.promise)] });
    await call.ready();
    await call.server(started("r1"), {
      type: "tool-call",
      callId: "c1",
      name: "recall_streams",
      arguments: {},
    });
    expect(call.news()).toContain("llm-function-call-in-progress c1");
    call.asks();
    await call.server({ type: "speech-started" });
    expect(call.asks()).toEqual(["output c1 CANCELLED"]);
    expect(call.news()).toContain("llm-function-call-stopped c1 cancelled");
    gate.resolve();
    await call.server(done("r1"));
    await settle();
    expect(call.asks()).toEqual([]);
    expect(call.events().map((e) => e.type)).toEqual(["tool-call"]);
    call.transport.leave();
    await call.running;
  });

  test("a sync tool still running after its response ended is cancelled by a barge-in, and asks nothing more", async () => {
    const gate = Promise.withResolvers<void>();
    const call = await startRealtime({ tools: [recallTool(gate.promise)] });
    await call.ready();
    await call.server(
      started("r1"),
      { type: "tool-call", callId: "c1", name: "recall_streams", arguments: {} },
      done("r1"),
    );
    call.asks();
    call.news();
    await call.server({ type: "speech-started" });
    expect(call.asks()).toEqual(["output c1 CANCELLED"]);
    expect(call.news()).toContain("llm-function-call-stopped c1 cancelled");
    gate.resolve();
    // The server answers the caller's turn on its own; nothing else is asked for.
    await call.server({ type: "speech-stopped" }, heard("还在吗", true));
    await reply(call, "r2", ["在呀。"]);
    await settle();
    expect(call.asks()).toEqual([]);
    expect(call.events().map((e) => e.type)).toEqual(["tool-call", "message", "message"]);
    call.transport.leave();
    await call.running;
  });

  test("a line typed to run now cancels it too, and only the line is answered", async () => {
    const gate = Promise.withResolvers<void>();
    const call = await startRealtime({ tools: [recallTool(gate.promise)] });
    await call.ready();
    await call.server(
      started("r1"),
      { type: "tool-call", callId: "c1", name: "recall_streams", arguments: {} },
      done("r1"),
    );
    call.asks();
    await call.rtvi("send-text", {
      content: "等等",
      options: { run_immediately: true, audio_response: true },
    });
    expect(call.asks()).toEqual(["output c1 CANCELLED", "add item-1 user 等等", "create"]);
    gate.resolve();
    await settle();
    expect(call.asks()).toEqual([]);
    call.transport.leave();
    await call.running;
  });

  test("an async tool is answered with its placeholder, and its late result goes in as a system item", async () => {
    const selfie = selfieTool();
    const call = await startRealtime({ tools: [selfie.tool] });
    await call.ready();
    await call.server(started("r1"), {
      type: "tool-call",
      callId: "c1",
      name: "take_selfie",
      arguments: {},
    });
    await call.server(done("r1"));
    expect(call.asks()).toEqual([`output c1 ${startedEnvelope("c1")}`, "create"]);
    await reply(call, "r2", ["拍好了等一下哦。"]);
    call.news();
    // The caller speaks while it renders; it isn't cancelled.
    await turn(call, "好的");
    call.news();
    selfie.shoot();
    await settle();
    await settle();
    expect(call.news()).toEqual(["server-message", "llm-function-call-stopped c1"]);
    // The floor is free: the result is owed a reply at once.
    const result = finalEnvelope("c1", '{"ok": true}');
    expect(call.asks()).toEqual([`add item-1 system ${result}`, "create"]);
    expect(
      call
        .events()
        .filter((e) => e.type === "tool-result")
        .map((e) => (e.type === "tool-result" ? e.stage : null)),
    ).toEqual(["started", "final"]);
    call.transport.leave();
    await call.running;
  });

  test("a late async result that comes while she speaks is owed its reply until she has played", async () => {
    const selfie = selfieTool();
    const call = await startRealtime({ tools: [selfie.tool] });
    await call.ready();
    await call.server(started("r1"), {
      type: "tool-call",
      callId: "c1",
      name: "take_selfie",
      arguments: {},
    });
    await call.server(done("r1"));
    await call.server(started("r2"), audio("r2", "it2", 2_400), said("r2", "it2", "等我一下。"));
    await call.server(done("r2"));
    call.asks();
    selfie.shoot();
    await settle();
    await settle();
    expect(call.asks()).toEqual([`add item-1 system ${finalEnvelope("c1", '{"ok": true}')}`]);
    await call.play(2_400);
    expect(call.asks()).toEqual(["create"]);
    call.transport.leave();
    await call.running;
  });

  test("a fatal error is reported and ends the call (E8)", async () => {
    const call = await startRealtime();
    await call.ready();
    call.news();
    await call.server({ type: "error", message: "Error: boom", fatal: true });
    expect(await call.running).toBe("error");
    expect(call.news()).toEqual(["error Error: boom"]);
    expect(call.transport.disconnects).toBe(1);
    expect(call.session.closed).toBe(true);
    expect(logs.at(-1)).toBe("Call ended: error");
  });

  test("a response that fails is reported, and the call goes on", async () => {
    const call = await startRealtime();
    await call.ready();
    call.news();
    await call.server(started("r1"), done("r1", "Response failed"));
    expect(call.news()).toEqual(["bot-llm-started", "bot-llm-stopped", "error Response failed"]);
    call.transport.leave();
    expect(await call.running).toBe("client");
  });

  test("a hang-up mid-reply stores what was heard", async () => {
    const call = await startRealtime();
    await call.ready();
    await call.server(
      started("r1"),
      audio("r1", "it1", 2_400),
      said("r1", "it1", "第一句。"),
      audio("r1", "it1", 2_400),
      said("r1", "it1", "第二句。"),
    );
    await call.play(2_400);
    call.shutdown.abort();
    expect(await call.running).toBe("shutdown");
    expect(messages(call)).toEqual([["persona", "第一句。", "call", true]]);
  });
});

describe("runVoiceCall", () => {
  test("runs a realtime plan on the realtime call, and a failed start disconnects", async () => {
    process.env.REALTIME_PROVIDER = "openai";
    resetSettings();
    const transport = new FakeTransport();
    const deps = {
      engine: engine([], []),
      openRealtime: async () => {
        throw new Error("OpenAI Realtime needs a key");
      },
      clock: new FakeClock(0),
      about: ABOUT,
    } as unknown as CallDeps;
    const plan: CallPlan = {
      id: "call-x",
      host: HOST,
      viewer: VIEWER,
      log: memoryCallLog(HEADER),
      greet: true,
      realtime: true,
    };
    expect(await runVoiceCall(transport, plan, deps, new AbortController().signal)).toBe("error");
    expect(logs).toContain("Bot session failed: OpenAI Realtime needs a key");
    expect(transport.disconnects).toBe(1);
  });
});
