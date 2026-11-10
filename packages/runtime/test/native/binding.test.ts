// A call bound to a chat on the native engine: the binding pipedog's sessions take
// (../binding.test.ts), run on the native loop over a fake transport (and once a real peer), a fake
// recognizer and voice, the real hearing models and the real engine on a scripted mind. It opens on
// the chat and reports the same lines, photos and end, in the same order, as her.
import "../../../config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AllowedOffer, UserContext } from "@eidolon/access";
import { AsyncQueue, activePersona, dataHome, resetSettings } from "@eidolon/config";
import { buildGreetingKickoff } from "@eidolon/context";
import type { ContextProvider, LlmTool } from "@eidolon/core";
import { type EngineDeps, type MindChunk, type MindRequest, runTurn } from "@eidolon/engine";
import { MEM0_STORE_KEY } from "@eidolon/memory";
import type { RealtimeEvent, RealtimeSession } from "@eidolon/providers/realtime";
import type { CallDeps } from "@eidolon/voice";
import { RTCPeerConnection } from "@pipedog/transport-smallwebrtc/rtc";
import { packHistory } from "../../../voice/src/call/realtime.ts";
import { FakeSpeech, FakeStt, FakeTransport, settle } from "../../../voice/test/call/harness.ts";
import { FakeClock } from "../../../voice/test/input/clock.ts";
import { voiceModels } from "../../src/audio.ts";
import { nativeCanRun, runNativeSafely, sessionStarter } from "../../src/native/engine.ts";
import { pipedogCallTransport } from "../../src/native/transport_pipedog.ts";
import { BOT_ABOUT } from "../../src/rtvi.ts";
import type { CallBinding, CallClient, TranscriptLine } from "../../src/session/session.ts";
import { createSignallingServerWith } from "../../src/webrtc/signalling.ts";
import {
  admission,
  CAN_DIAL,
  captureLogs,
  deferred,
  type LogCapture,
  PASS_THROUGH_RULES,
  setEnv,
  until,
} from "../support.ts";

const VIEWER: UserContext = { mid: 7, uname: "看客", face: null, isLoggedIn: true };
const ADMISSION: Pick<AllowedOffer, "user" | "token" | "requestData"> = {
  user: VIEWER,
  token: null,
  requestData: null,
};
const SEED = [
  { role: "user", content: "我养了一只叫团子的猫" },
  { role: "assistant", content: "团子这名字好可爱！" },
];
const DONE: MindChunk = { type: "done", finishReason: "stop" };
const KICKOFF = { role: "user", content: buildGreetingKickoff([]) };

let logs: LogCapture;
let restoreEnv: () => void;
beforeEach(() => {
  logs = captureLogs();
  // A voice that marks where each segment's audio ends, as the pipedog tests' scripted one does.
  restoreEnv = setEnv({ TTS_PROVIDER: "minimax", REALTIME_PROVIDER: undefined });
});
afterEach(() => {
  restoreEnv();
  logs.restore();
  rmSync(join(dataHome(), "personas", "bob"), { recursive: true, force: true });
  resetSettings();
});

type Line = TranscriptLine & { readonly persona: string };

/** A server message the binding was handed, as whom, after how many lines, and with which browser. */
interface Sent {
  readonly data: unknown;
  readonly persona: string;
  readonly afterLines: number;
  readonly client: CallClient | undefined;
}

/** Her replies, one per mind request, as text or a raw chunk such as a tool call. */
type Reply = readonly (string | MindChunk)[];

function engine(
  replies: Reply[],
  record: {
    readonly requests: MindRequest[];
    readonly stored: unknown[];
    readonly minds?: string[];
  },
  tools: readonly LlmTool[],
): EngineDeps {
  const memory: ContextProvider = {
    onContext: async (turn) => {
      record.stored.push({ persona: activePersona().id, messages: turn.metadata[MEM0_STORE_KEY] });
    },
    errorMessage: () => "memory error",
  };
  return {
    createMind: () => ({
      async *stream(request) {
        record.requests.push(request);
        record.minds?.push(activePersona().id);
        for (const part of replies[record.requests.length - 1] ?? []) {
          yield typeof part === "string" ? { type: "text", text: part } : part;
        }
        yield DONE;
      },
    }),
    parts: async () => ({
      systemInstruction: "persona prompt",
      providers: [{ label: "LaplaceMem0MemoryService", provider: memory }],
      gate: null,
      tools,
      memories: async () => [],
    }),
    saveAttachment: () => Promise.reject(new Error("a call keeps no files")),
    fetchImage: () => Promise.reject(new Error("a call fetches no images")),
    newId: () => Bun.randomUUIDv7(),
    speech: {
      canSpeak: () => false,
      synthesize: () => Promise.reject(new Error("a call speaks no voice messages")),
      transcribe: () => Promise.reject(new Error("a call hears no voice messages")),
    },
  };
}

/** A native call bound to a chat, its client ready. */
async function call(
  options: { readonly seedMessages?: readonly unknown[]; readonly failing?: string } = {},
  script: { readonly replies?: Reply[]; readonly tools?: readonly LlmTool[] } = {},
) {
  const transport = new FakeTransport();
  const stt = new FakeStt();
  const speech = new FakeSpeech();
  const clock = new FakeClock(0);
  const record = { requests: [] as MindRequest[], stored: [] as unknown[], minds: [] as string[] };
  const replies = script.replies ?? [
    ["你好呀，", "又见面了。"],
    ["第一句。", "第二句。"],
    ["好的。"],
    ["收到。"],
  ];
  const deps: CallDeps = {
    engine: engine(replies, record, script.tools ?? []),
    runTurn,
    openStt: async () => stt,
    openSpeech: () => speech,
    openRealtime: () => Promise.reject(new Error("no realtime here")),
    models: voiceModels(),
    about: BOT_ABOUT,
    clock,
  };
  const lines: Line[] = [];
  const clients: CallClient[] = [];
  const sent: Sent[] = [];
  const ends: { end: string; after: number }[] = [];
  const binding: CallBinding = {
    persona: "bob",
    seedMessages: options.seedMessages ?? [],
    onTranscript: (line, client) => {
      if (client) clients.push(client);
      if (line.text === options.failing) throw new Error("the chat is gone");
      lines.push({ ...line, persona: activePersona().id });
    },
    onServerMessage: (data, client) => {
      sent.push({ data, persona: activePersona().id, afterLines: lines.length, client });
    },
    onEnded: (end) => ends.push({ end, after: lines.length }),
  };
  const done = runNativeSafely(transport, ADMISSION, deps, binding);
  await until(() => transport.connected, 10_000);
  transport.rtvi("client-ready", { version: "2.3.0" });
  await until(() => record.requests.length === 1);

  /** How many transcripts of the caller's have reached the client. */
  const transcribed = () => transport.types.filter((t) => t === "user-transcription").length;
  /** Pulls `samples` of her audio in the transport's 10 ms frames. */
  const play = async (samples: number) => {
    for (let left = samples; left > 0; left -= 240) transport.source?.pull(Math.min(240, left));
    await settle();
  };
  return {
    ...record,
    transport,
    lines,
    clients,
    sent,
    ends,
    play,
    /** Her latest reply's `segments`, voiced and played whole once all of them are said. */
    async speaks(segments: number): Promise<void> {
      await until(() => (speech.utterances.at(-1)?.said.length ?? 0) === segments);
      const utterance = speech.utterances.at(-1);
      for (let seg = 1; seg <= segments; seg++) {
        utterance?.pcm(seg, 240);
        utterance?.segEnd(seg);
      }
      utterance?.finish();
      await settle();
      await play(240 * segments);
    },
    /** Her latest utterance, said up to `segments`, voiced up to `seg`. */
    async voiced(segments: number, seg: number): Promise<void> {
      await until(() => (speech.utterances.at(-1)?.said.length ?? 0) === segments);
      const utterance = speech.utterances.at(-1);
      for (let s = 1; s <= seg; s++) {
        utterance?.pcm(s, 480);
        if (s < seg) utterance?.segEnd(s);
      }
      await settle();
    },
    /** The caller's turn, heard as `text`, its end timed by the recognizer's p99. */
    async says(text: string): Promise<void> {
      const heard = transcribed();
      stt.events.push({ type: "final", text, finalized: true });
      await until(() => transcribed() > heard);
      clock.advance(400);
      await settle();
    },
    /** The caller starts talking over her. */
    async interrupts(text: string): Promise<void> {
      const heard = transcribed();
      stt.events.push({ type: "interim", text });
      await until(() => transcribed() > heard);
    },
    async types(content: string, runImmediately: boolean): Promise<void> {
      transport.rtvi("send-text", { content, options: { run_immediately: runImmediately } });
      await settle();
    },
    serverMessages: () => transport.sent.filter((m) => m.type === "server-message"),
    async hangUp(): Promise<void> {
      transport.leave();
      await done;
    },
  };
}

describe("a call bound to a chat on the native engine", () => {
  test("runs as her, opens on the chat, and reports each finished line, a cut-off one as heard", async () => {
    expect(activePersona().id).toBe("milky-green");
    const c = await call({ seedMessages: SEED });
    expect(c.requests[0]?.messages).toEqual([...SEED, KICKOFF]);
    await c.speaks(1);
    await until(() => c.lines.length === 1);

    await c.says("今天吃什么");
    await until(() => c.requests.length === 2);
    // She is cut off once her first sentence has played, then the viewer finishes.
    await c.voiced(2, 2);
    await c.play(720);
    await c.interrupts("等一下");
    await until(() => c.lines.length === 3);
    await c.says("等一下");
    await until(() => c.requests.length === 3);
    await c.speaks(1);
    await until(() => c.lines.length === 5);
    await c.types("我打字说的", true);
    await until(() => c.requests.length === 4);
    await c.speaks(1);
    await until(() => c.lines.length === 7);
    await c.hangUp();

    expect(c.lines).toEqual([
      { role: "assistant", text: "你好呀，又见面了。", interrupted: false, persona: "bob" },
      { role: "user", text: "今天吃什么", interrupted: false, persona: "bob" },
      { role: "assistant", text: "第一句。", interrupted: true, persona: "bob" },
      { role: "user", text: "等一下", interrupted: false, persona: "bob" },
      { role: "assistant", text: "好的。", interrupted: false, persona: "bob" },
      { role: "user", text: "我打字说的", interrupted: false, persona: "bob" },
      { role: "assistant", text: "收到。", interrupted: false, persona: "bob" },
    ]);
    // Her view keeps what the lines say: her cut-off reply is what was heard of it.
    expect(c.requests.at(-1)?.messages).toEqual([
      ...SEED,
      KICKOFF,
      { role: "assistant", content: "你好呀，又见面了。" },
      { role: "user", content: "今天吃什么" },
      { role: "assistant", content: "第一句。" },
      { role: "user", content: "等一下" },
      { role: "assistant", content: "好的。" },
      { role: "user", content: "我打字说的" },
    ]);
    // Mem0 stores what was said on the call, never the chat it was seeded with.
    expect(c.stored).toEqual([
      { persona: "bob", messages: [] },
      {
        persona: "bob",
        messages: [
          KICKOFF,
          { role: "assistant", content: "你好呀，又见面了。" },
          { role: "user", content: "今天吃什么" },
        ],
      },
      expect.anything(),
      expect.anything(),
    ]);
    for (const stored of c.stored) {
      for (const message of SEED) {
        expect((stored as { messages: unknown[] }).messages).not.toContainEqual(message);
      }
    }
    expect(new Set(c.minds)).toEqual(new Set(["bob"]));
    expect(c.ends).toEqual([{ end: "hangup", after: 7 }]);
    expect(activePersona().id).toBe("milky-green");
    expect(logs.messages("WARNING")).toEqual([]);
    expect(logs.messages("ERROR")).toEqual([]);
  }, 15_000);

  test("each line comes with the call's browser, which a server message reaches until it hangs up", async () => {
    const c = await call();
    await c.speaks(1);
    await c.says("今天吃什么");
    await until(() => c.lines.length === 2);
    const [client] = c.clients;
    expect([c.clients.length, new Set(c.clients).size]).toEqual([2, 1]);
    await client?.sendServerMessage({ type: "chat-line", event: { seq: 4 } });
    expect(c.serverMessages()).toEqual([
      { label: "rtvi-ai", type: "server-message", data: { type: "chat-line", event: { seq: 4 } } },
    ]);
    await c.hangUp();
    await client?.sendServerMessage({ type: "chat-line", event: { seq: 5 } });
    expect(c.serverMessages()).toHaveLength(1);
    // The browser's own messages are no tool's: none reached onServerMessage.
    expect(c.sent).toEqual([]);
    expect(logs.messages("ERROR")).toEqual([]);
  }, 15_000);

  test("a hang-up while her reply plays reports what was heard of it once, interrupted, before the end", async () => {
    const c = await call();
    await c.speaks(1);
    await c.says("今天吃什么");
    await c.voiced(2, 2);
    await c.play(720);
    await c.hangUp();
    const atEnd = [...c.lines];
    await Bun.sleep(50);
    const expected: Line[] = [
      { role: "assistant", text: "你好呀，又见面了。", interrupted: false, persona: "bob" },
      { role: "user", text: "今天吃什么", interrupted: false, persona: "bob" },
      { role: "assistant", text: "第一句。", interrupted: true, persona: "bob" },
    ];
    expect(atEnd).toEqual(expected);
    expect(c.lines).toEqual(expected);
    expect(c.ends).toEqual([{ end: "hangup", after: 3 }]);
  }, 15_000);

  test("her photo is handed to the binding as the selfie tool sends it, as her, and the call goes on", async () => {
    const photo = { type: "selfie", urls: ["/api/selfie/abc.png"] };
    const rendered = deferred<void>();
    const selfie: LlmTool = {
      schema: { name: "take_selfie", description: "拍照", properties: {}, required: [] },
      cancelOnInterruption: false,
      timeoutSecs: 120,
      run: async (_, effects) => {
        await rendered.promise;
        await effects.sendServerMessage(photo);
        return { ok: true, count: 1 };
      },
    };
    const takes: MindChunk = {
      type: "tool-calls",
      calls: [{ id: "call-1", name: "take_selfie", arguments: {} }],
    };
    const c = await call(
      {},
      { replies: [["你好呀。"], ["拍给你看。", takes], ["好看吗？"]], tools: [selfie] },
    );
    await c.speaks(1);
    await c.says("今天吃什么");
    await c.speaks(1);
    await until(() => c.lines.length === 3);
    rendered.resolve();
    await until(() => c.requests.length === 3);
    await c.speaks(1);
    await until(() => c.lines.length === 4);
    await c.hangUp();
    expect(c.sent).toEqual([{ data: photo, persona: "bob", afterLines: 3, client: c.clients[0] }]);
    expect(new Set(c.clients).size).toBe(1);
    expect(c.serverMessages()).toEqual([{ label: "rtvi-ai", type: "server-message", data: photo }]);
    expect(c.lines.map((line) => [line.role, line.text])).toEqual([
      ["assistant", "你好呀。"],
      ["user", "今天吃什么"],
      ["assistant", "拍给你看。"],
      ["assistant", "好看吗？"],
    ]);
    expect(c.requests.at(-1)?.messages).toContainEqual({
      role: "tool",
      tool_call_id: "call-1",
      content: '{"ok": true, "count": 1}',
    });
    expect(logs.messages("ERROR")).toEqual([]);
  }, 15_000);

  test("a line its caller fails to record is logged, and the lines after it still arrive", async () => {
    const c = await call({ failing: "我打字说的" });
    await c.speaks(1);
    await until(() => c.lines.length === 1);
    await c.types("我打字说的", false);
    await c.types("再打一句", false);
    await until(() => c.lines.length === 2);
    await c.hangUp();
    expect(c.lines.map((line) => line.text)).toEqual(["你好呀，又见面了。", "再打一句"]);
    expect(logs.messages("ERROR")).toEqual(["Could not report a call line: the chat is gone"]);
    expect(c.ends).toEqual([{ end: "hangup", after: 2 }]);
  }, 15_000);

  test("on a realtime model, the session opens on the chat, and her lines and the viewer's reach the binding", async () => {
    setEnv({ REALTIME_PROVIDER: "openai" });
    resetSettings();
    const asked: string[] = [];
    const events = new AsyncQueue<RealtimeEvent>();
    let items = 0;
    const session: RealtimeSession = {
      inputRate: 24_000,
      outputRate: 24_000,
      appendAudio: () => {},
      addItem: async (item) => {
        asked.push(`add ${item.role} ${item.text}`);
        return `item-${++items}`;
      },
      deleteItem: (id) => void asked.push(`delete ${id}`),
      createResponse: () => void asked.push("create"),
      cancelResponse: () => void asked.push("cancel"),
      truncate: () => {},
      sendToolOutput: () => {},
      events,
      close: async () => events.close(),
    };
    const record = { requests: [] as MindRequest[], stored: [] as unknown[] };
    const transport = new FakeTransport();
    const lines: Line[] = [];
    const ends: string[] = [];
    const done = runNativeSafely(
      transport,
      ADMISSION,
      {
        engine: engine([], record, []),
        runTurn,
        openStt: () => Promise.reject(new Error("a realtime model hears")),
        openSpeech: () => {
          throw new Error("a realtime model speaks");
        },
        openRealtime: async () => session,
        models: voiceModels(),
        about: BOT_ABOUT,
        clock: new FakeClock(0),
      },
      {
        persona: "bob",
        seedMessages: SEED,
        onTranscript: (line) => lines.push({ ...line, persona: activePersona().id }),
        onEnded: (end) => ends.push(end),
      },
    );
    await until(() => transport.connected, 10_000);
    transport.rtvi("client-ready", { version: "2.3.0" });
    await until(() => asked.length === 2);
    expect(asked).toEqual([`add user ${packHistory([...SEED, KICKOFF], "openai")[0]}`, "create"]);

    const pcm = new Int16Array(480).fill(9);
    for (const event of [
      { type: "response-started", responseId: "r1" },
      { type: "audio", responseId: "r1", itemId: "a1", contentIndex: 0, pcm },
      { type: "transcript-delta", responseId: "r1", itemId: "a1", text: "又见面啦。" },
      { type: "response-done", responseId: "r1" },
    ] as const) {
      events.push(event);
    }
    await settle();
    for (let pulled = 0; pulled < 480; pulled += 240) transport.source?.pull(240);
    await until(() => lines.length === 1);
    for (const event of [
      { type: "speech-started" },
      { type: "speech-stopped" },
      { type: "user-transcript", itemId: "u1", text: "今天吃什么", final: true },
    ] as const) {
      events.push(event);
    }
    await until(() => lines.length === 2);
    transport.leave();
    await done;
    expect(lines).toEqual([
      { role: "assistant", text: "又见面啦。", interrupted: false, persona: "bob" },
      { role: "user", text: "今天吃什么", interrupted: false, persona: "bob" },
    ]);
    expect(ends).toEqual(["hangup"]);
  }, 15_000);

  test("a call that can't start reports its end once, as an error", async () => {
    const transport = new FakeTransport();
    const ends: string[] = [];
    const deps = {
      openSpeech: () => {
        throw new Error("MiniMax has no key: set MINIMAX_API_KEY");
      },
      openStt: async () => new FakeStt(),
      models: voiceModels(),
      clock: new FakeClock(0),
    } as unknown as CallDeps;
    await runNativeSafely(transport, ADMISSION, deps, {
      persona: "bob",
      seedMessages: SEED,
      onTranscript: () => {
        throw new Error("no line was said");
      },
      onEnded: (end) => ends.push(end),
    });
    expect(ends).toEqual(["error"]);
    expect(transport.disconnects).toBe(1);
    expect(logs.messages("ERROR")).toEqual([
      "Bot session failed: MiniMax has no key: set MINIMAX_API_KEY",
    ]);
  });
});

describe("which engine a call inside a chat runs on", () => {
  const offer = { allowed: true } as AllowedOffer;

  test("her own settings decide, not the active persona's", async () => {
    mkdirSync(join(dataHome(), "personas", "bob"), { recursive: true });
    writeFileSync(
      join(dataHome(), "personas", "bob", "persona.yaml"),
      "realtime:\n  provider: openrouter\n",
    );
    expect(nativeCanRun()).toBeNull();
    const reason = nativeCanRun("bob");
    expect(reason).toContain("OpenRouter offers no realtime voice model");

    const started: string[] = [];
    const start = sessionStarter<string, { readonly persona: string }>("native", {
      pipedog: async (connection, _admission, binding) =>
        void started.push(`pipedog ${connection} ${binding?.persona}`),
      native: async (connection, _admission, binding) =>
        void started.push(`native ${connection} ${binding?.persona}`),
    });
    await start("pc-1", offer, { persona: "bob" });
    await start("pc-2", offer, { persona: "milky-green" });
    expect(started).toEqual(["pipedog pc-1 bob", "native pc-2 milky-green"]);
    expect(logs.messages("INFO").filter((m) => m.startsWith("[voice]"))).toEqual([
      `[voice] This call runs on pipedog: ${reason}`,
      `[voice] This call runs on pipedog: ${reason}`,
    ]);
    expect(activePersona().id).toBe("milky-green");
  });
});

describe.skipIf(!CAN_DIAL)("over a real peer", () => {
  test("werift's callbacks run nothing outside her scope, and the end is reported once", async () => {
    const record = {
      requests: [] as MindRequest[],
      stored: [] as unknown[],
      minds: [] as string[],
    };
    const speech = new FakeSpeech();
    const deps: CallDeps = {
      engine: engine([["你好呀。"]], record, []),
      runTurn,
      openStt: async () => new FakeStt(),
      openSpeech: () => speech,
      openRealtime: () => Promise.reject(new Error("no realtime here")),
      models: voiceModels(),
      about: BOT_ABOUT,
      clock: new FakeClock(0),
    };
    const lines: Line[] = [];
    const ends: { end: string; after: number }[] = [];
    const sessions: Promise<void>[] = [];
    const server = createSignallingServerWith(
      { ice: { serverPlan: async () => ({ iceServers: [], relayOnly: false, turnUrl: null }) } },
      {
        startSession: (connection, offered, binding) => {
          const session = runNativeSafely(pipedogCallTransport(connection), offered, deps, binding);
          sessions.push(session);
          return session;
        },
        candidates: PASS_THROUGH_RULES,
      },
    );
    const peer = new RTCPeerConnection({ iceServers: [] });
    try {
      peer.addTransceiver("audio", { direction: "sendrecv" });
      const channel = peer.createDataChannel("chat");
      await peer.setLocalDescription(await peer.createOffer());
      const result = await server.offer(
        admission({ sdp: peer.localDescription?.sdp, type: "offer" }),
        {
          persona: "bob",
          seedMessages: SEED,
          onTranscript: (line) => lines.push({ ...line, persona: activePersona().id }),
          onEnded: (end) => ends.push({ end, after: lines.length }),
        },
      );
      const answer = result.body as { sdp: string };
      await peer.setRemoteDescription({ sdp: answer.sdp, type: "answer" } as never);
      await until(() => channel.readyState === "open", 8000);
      // Arrives on werift's data channel callback, with no persona scope of its own.
      channel.send(
        JSON.stringify({
          label: "rtvi-ai",
          type: "client-ready",
          id: "1",
          data: { version: "2.3.0" },
        }),
      );
      await until(() => speech.utterances.at(-1)?.ended === true, 8000);
      const utterance = speech.utterances.at(-1);
      utterance?.pcm(1, 480);
      utterance?.segEnd(1);
      utterance?.finish();
      // Her audio plays on the connection's own clock.
      await until(() => lines.length === 1, 8000);
      // The server hangs up, and the call ends on the connection's own closed callback.
      await server.close();
      await sessions[0];
    } finally {
      await server.close();
      await peer.close();
    }
    expect(lines).toEqual([
      { role: "assistant", text: "你好呀。", interrupted: false, persona: "bob" },
    ]);
    expect(record.minds).toEqual(["bob"]);
    expect(record.requests[0]?.messages.slice(0, 2)).toEqual(SEED);
    expect(ends).toEqual([{ end: "hangup", after: 1 }]);
  }, 20_000);
});
