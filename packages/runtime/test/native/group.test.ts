// A group call on the native engine: a GroupCallBinding run over a fake transport, a fake recognizer
// and a fake voice per persona, the real hearing models, the real engine on scripted minds and a
// scripted director. It opens on the chat itself, reports each line and decision numbered on from
// it, and each persona's Mem0 stores only the viewer's call lines and hers. A realtime persona can't
// join one, and nothing but the native engine runs one.
import "../../../config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AllowedOffer, UserContext } from "@eidolon/access";
import {
  CHAT_FORMAT,
  type ChatEvent,
  type ChatHeader,
  type ParticipantId,
  stampEvents,
} from "@eidolon/chat";
import { activePersona, dataHome, resetSettings } from "@eidolon/config";
import type { DirectorInput } from "@eidolon/context";
import type { ContextProvider } from "@eidolon/core";
import { type ChatDeps, type MindChunk, type MindRequest, runChat, runTurn } from "@eidolon/engine";
import { MEM0_STORE_KEY } from "@eidolon/memory";
import { realtimeIn } from "@eidolon/providers";
import type { CallDeps } from "@eidolon/voice";
import { FakeSpeech, FakeStt, FakeTransport, settle } from "../../../voice/test/call/harness.ts";
import { FakeClock } from "../../../voice/test/input/clock.ts";
import { voiceModels } from "../../src/audio.ts";
import type { AnyCallBinding, GroupCallBinding } from "../../src/native/binding.ts";
import {
  groupReason,
  nativeCanRun,
  runNativeSafely,
  sessionStarter,
} from "../../src/native/engine.ts";
import { BOT_ABOUT } from "../../src/rtvi.ts";
import type { CallClient } from "../../src/session/session.ts";
import { captureLogs, type LogCapture, setEnv, until } from "../support.ts";

const HOST = "bob";
const OTHER = "cat";
const PERSONAS: Record<ParticipantId, string> = {
  [HOST]: "identity:\n  name: 波波\n",
  [OTHER]: "identity:\n  name: 咪咪\n",
};
const VIEWER: UserContext = { mid: 7, uname: "看客", face: null, isLoggedIn: true };
const ADMISSION: Pick<AllowedOffer, "user" | "token" | "requestData"> = {
  user: VIEWER,
  token: null,
  requestData: null,
};
const HEADER: ChatHeader = {
  format: CHAT_FORMAT,
  id: "0190f5c8-0000-7000-8000-0000000000dd",
  createdAt: 0,
  participants: [HOST, OTHER],
};
/** The chat as stored when the call opens. */
const CHAT: readonly ChatEvent[] = stampEvents(
  [
    { type: "message", id: "u1", speaker: { kind: "user" }, text: "大家好" },
    { type: "message", id: "b1", speaker: { kind: "persona", id: HOST }, text: "你好呀" },
  ],
  0,
  1,
);
const DONE: MindChunk = { type: "done", finishReason: "stop" };

let logs: LogCapture;
let restoreEnv: () => void;
beforeEach(() => {
  logs = captureLogs();
  // Voices that mark where each segment's audio ends.
  restoreEnv = setEnv({ TTS_PROVIDER: "minimax", REALTIME_PROVIDER: undefined });
  for (const [id, yaml] of Object.entries(PERSONAS)) {
    mkdirSync(join(dataHome(), "personas", id), { recursive: true });
    writeFileSync(join(dataHome(), "personas", id, "persona.yaml"), yaml);
  }
  // Another file's persona of the same id may linger in the settings scopes.
  resetSettings();
});
afterEach(() => {
  restoreEnv();
  logs.restore();
  for (const id of Object.keys(PERSONAS)) {
    rmSync(join(dataHome(), "personas", id), { recursive: true, force: true });
  }
  resetSettings();
});

/** A group call of `bob` and `cat`, `bob` hosting, its client ready. */
async function groupCall(rounds: readonly (readonly ParticipantId[])[]) {
  const transport = new FakeTransport();
  const stt = new FakeStt();
  const clock = new FakeClock(0);
  const speeches = new Map<ParticipantId, FakeSpeech>();
  const opened: { role: string; persona: string }[] = [];
  const minds: { persona: string; request: MindRequest }[] = [];
  const stored: { persona: string; messages: unknown }[] = [];
  const decided: DirectorInput[] = [];
  const memory: ContextProvider = {
    onContext: async (turn) => {
      stored.push({ persona: activePersona().id, messages: turn.metadata[MEM0_STORE_KEY] });
    },
    errorMessage: () => "memory error",
  };
  const engine: ChatDeps = {
    createMind: () => ({
      async *stream(request) {
        const persona = activePersona().id;
        minds.push({ persona, request });
        yield { type: "text", text: `${activePersona().identity.name}来了。` };
        yield DONE;
      },
    }),
    parts: async () => ({
      systemInstruction: "persona prompt",
      providers: [{ label: "LaplaceMem0MemoryService", provider: memory }],
      gate: null,
      tools: [],
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
    director: {
      decide: async (input) => {
        decided.push(input);
        const ids = rounds[decided.length - 1] ?? [];
        return {
          replies: ids.map((persona) => ({ persona, mode: "text" })),
          source: "model",
          scores: {},
        };
      },
    },
  };
  const deps: CallDeps = {
    engine,
    runTurn,
    runChat,
    openStt: async () => {
      opened.push({ role: "hearing", persona: activePersona().id });
      return stt;
    },
    openSpeech: () => {
      const persona = activePersona().id;
      opened.push({ role: "voice", persona });
      const speech = new FakeSpeech();
      speeches.set(persona, speech);
      return speech;
    },
    openRealtime: () => Promise.reject(new Error("no realtime here")),
    models: voiceModels(),
    about: BOT_ABOUT,
    clock,
  };
  const events: ChatEvent[] = [];
  const clients: CallClient[] = [];
  const sent: { data: unknown; persona: string }[] = [];
  const ends: string[] = [];
  const binding: GroupCallBinding = {
    group: true,
    persona: HOST,
    chat: { header: HEADER, events: CHAT },
    onEvents: (batch, client) => {
      clients.push(client);
      events.push(...batch);
    },
    onServerMessage: (data, client) => {
      clients.push(client);
      sent.push({ data, persona: activePersona().id });
    },
    onEnded: (end) => ends.push(end),
  };
  const done = runNativeSafely(transport, ADMISSION, deps, binding);
  await until(() => transport.connected, 10_000);
  transport.rtvi("client-ready", { version: "2.3.0" });
  await settle();
  return {
    transport,
    opened,
    minds,
    stored,
    decided,
    events,
    clients,
    sent,
    ends,
    /** `persona`'s reply, voiced and played whole once she has said it. */
    async speaks(persona: ParticipantId): Promise<void> {
      await until(() => speeches.get(persona)?.utterances.at(-1)?.ended === true);
      const utterance = speeches.get(persona)?.utterances.at(-1);
      utterance?.pcm(1, 240);
      utterance?.segEnd(1);
      utterance?.finish();
      await settle();
      transport.source?.pull(240);
      await settle();
    },
    async says(text: string): Promise<void> {
      stt.events.push({ type: "final", text, finalized: true });
      await until(() => transport.types.includes("user-transcription"));
      clock.advance(400);
      await settle();
    },
    async hangUp(): Promise<void> {
      transport.leave();
      await done;
    },
  };
}

describe("a group call on the native engine", () => {
  test("opens on the chat, and reports each line and decision numbered on from it, as each speaks", async () => {
    const c = await groupCall([[HOST, OTHER]]);
    // No greeting: she waits for the viewer.
    expect(c.transport.types).toEqual(["bot-ready"]);
    expect(c.opened).toEqual([
      { role: "voice", persona: HOST },
      { role: "voice", persona: OTHER },
      { role: "hearing", persona: HOST },
    ]);
    await c.says("今天做什么");
    await until(() => c.minds.length === 1);
    await c.speaks(HOST);
    await until(() => c.minds.length === 2);
    await c.speaks(OTHER);
    await until(() => c.decided.length === 2);
    await settle();
    await c.hangUp();

    const brief = c.events.map((event) =>
      event.type === "message"
        ? [event.seq, event.speaker.kind === "user" ? "viewer" : event.speaker.id, event.text]
        : event.type === "decision"
          ? [event.seq, "decision", event.after, event.replies.map((r) => r.persona)]
          : [event.seq, event.type],
    );
    expect(brief).toEqual([
      [3, "viewer", "今天做什么"],
      [4, "decision", 3, [HOST, OTHER]],
      [5, HOST, "波波来了。"],
      [6, OTHER, "咪咪来了。"],
      [7, "decision", 6, []],
    ]);
    expect(c.minds.map((m) => m.persona)).toEqual([HOST, OTHER]);
    // Each turn opens on the chat, and the next one hears the last.
    expect(JSON.stringify(c.minds[0]?.request.messages)).toContain("大家好");
    expect(JSON.stringify(c.minds[1]?.request.messages)).toContain("波波：波波来了。");
    // Mem0 stores the viewer's call lines and her own, never the chat's or another persona's.
    expect(c.stored).toEqual([
      { persona: HOST, messages: [{ role: "user", content: "今天做什么" }] },
      { persona: OTHER, messages: [{ role: "user", content: "今天做什么" }] },
    ]);
    // Her label reaches the binding as it reaches the browser, as each starts to speak.
    expect(c.sent.map((s) => s.data)).toEqual([
      { type: "speaker", persona: HOST, name: "波波" },
      { type: "speaker", persona: OTHER, name: "咪咪" },
    ]);
    expect(new Set(c.sent.map((s) => s.persona))).toEqual(new Set([HOST]));
    expect(new Set(c.clients).size).toBe(1);
    expect(c.ends).toEqual(["hangup"]);
    expect(logs.messages("ERROR")).toEqual([]);
  }, 15_000);
});

describe("who can join a group call", () => {
  test("a realtime persona can't: the call fails as it starts, and reports its end as an error", async () => {
    writeFileSync(
      join(dataHome(), "personas", OTHER, "persona.yaml"),
      `${PERSONAS[OTHER]}realtime:\n  provider: openai\n`,
    );
    expect(realtimeIn([HOST, OTHER])).toBe(OTHER);
    expect(groupReason(HOST, [HOST])).toBeNull();
    const reason = groupReason(HOST, [HOST, OTHER]);
    expect(reason).toBe("cat's calls run on a realtime model, which can't join a group call");

    const transport = new FakeTransport();
    const ends: string[] = [];
    await runNativeSafely(transport, ADMISSION, {} as CallDeps, {
      group: true,
      persona: HOST,
      chat: { header: HEADER, events: CHAT },
      onEvents: () => {},
      onEnded: (end) => ends.push(end),
    });
    expect(ends).toEqual(["error"]);
    expect(transport.disconnects).toBe(1);
    expect(logs.messages("ERROR")).toEqual([`Bot session failed: ${reason}`]);
  });

  test("under native, a group call runs natively whatever nativeCanRun says; under pipedog, never asks", async () => {
    writeFileSync(
      join(dataHome(), "personas", HOST, "persona.yaml"),
      "realtime:\n  provider: openrouter\n",
    );
    expect(nativeCanRun(HOST)).not.toBeNull();
    const started: string[] = [];
    const sessions = {
      pipedog: async (connection: string, _admission: AllowedOffer, binding?: AnyCallBinding) =>
        void started.push(`pipedog ${connection} ${binding?.persona}`),
      native: async (connection: string, _admission: AllowedOffer, binding?: AnyCallBinding) =>
        void started.push(`native ${connection} ${binding?.persona}`),
    };
    const group: GroupCallBinding = {
      group: true,
      persona: HOST,
      chat: { header: HEADER, events: CHAT },
      onEvents: () => {},
      onEnded: () => {},
    };
    await sessionStarter<string, AnyCallBinding>("native", sessions)(
      "pc-1",
      { allowed: true } as AllowedOffer,
      group,
    );
    expect(started).toEqual([`native pc-1 ${HOST}`]);
    expect(sessionStarter<string, AnyCallBinding>("pipedog", sessions)).toBe(sessions.pipedog);
  });
});
