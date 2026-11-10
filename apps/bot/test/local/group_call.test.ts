// A local group call: the offer route's checks, the runner's GroupChatCall storing what a group call
// reports against the chat's own seqs, and a whole native group call run through that binding over a
// fake transport, recognizer and voices, the real engine on scripted minds and a scripted director.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AllowedOffer } from "@eidolon/access";
import { type ChatEvent, type ParticipantId, stampEvents } from "@eidolon/chat";
import { activePersona, dataHome, resetSettings } from "@eidolon/config";
import { type ChatDeps, type MindChunk, runChat, runTurn } from "@eidolon/engine";
import { selfieStore } from "@eidolon/imagegen";
import type { AnyCallBinding, SignallingServer } from "@eidolon/runtime";
import { runNativeSafely } from "../../../../packages/runtime/src/native/engine.ts";
import { BOT_ABOUT } from "../../../../packages/runtime/src/rtvi.ts";
import {
  FakeSpeech,
  FakeStt,
  FakeTransport,
  settle,
} from "../../../../packages/voice/test/call/harness.ts";
import { FakeClock } from "../../../../packages/voice/test/input/clock.ts";
import { SILERO_MODEL, SMART_TURN_MODEL } from "../../../../packages/voice/test/input/speech.ts";
import { chatCallTarget, offerChatCall } from "../../src/local/chats/calls.ts";
import { type ChatAnswer, ChatRunner } from "../../src/local/chats/runner.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";

const ANN = "ann";
const BEA = "bea";
const PERSONAS: Record<ParticipantId, string> = {
  [ANN]: "identity:\n  name: 安妮\n",
  [BEA]: "identity:\n  name: 露比\n",
};
const ROOT = () => join(dataHome(), "group-call-chats");
const DONE: MindChunk = { type: "done", finishReason: "stop" };

let logs: CapturedLogs;
beforeEach(() => {
  logs = captureLogs();
  for (const [id, yaml] of Object.entries(PERSONAS)) {
    mkdirSync(join(dataHome(), "personas", id), { recursive: true });
    writeFileSync(join(dataHome(), "personas", id, "persona.yaml"), yaml);
  }
  // Another file's persona of the same id may linger in the settings scopes.
  resetSettings();
});
afterEach(() => {
  logs.restore();
  delete process.env.EIDOLON_VOICE_ENGINE;
  rmSync(ROOT(), { recursive: true, force: true });
  for (const id of Object.keys(PERSONAS)) {
    rmSync(join(dataHome(), "personas", id), { recursive: true, force: true });
  }
  resetSettings();
});

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A viewer's line gets no answer: the chat's own turns aren't what these tests are about. */
const silent: ChatAnswer = () => (async function* () {})();

/** A group chat of ann and bea, the viewer's first line in it. */
async function groupChat(runner: ChatRunner): Promise<string> {
  const id = await runner.create([ANN, BEA]);
  await (await runner.send(id, "大家好")).ended;
  return id;
}

/** Each stored event, briefly. */
function brief(event: ChatEvent): unknown[] {
  switch (event.type) {
    case "message": {
      const who = event.speaker.kind === "user" ? "viewer" : event.speaker.id;
      const files = (event.attachments ?? []).map((file) => file.name);
      return [event.seq, who, event.text, event.modality ?? "text", ...files];
    }
    case "decision":
      return [event.seq, "decision", event.after, event.replies.map((reply) => reply.persona)];
    case "call-started":
      return [event.seq, "call-started", event.persona, event.group ?? false];
    case "call-ended":
      return [event.seq, "call-ended", event.reason];
    default:
      return [event.seq, event.type];
  }
}

describe("the offer route", () => {
  const signalling = {
    offers: [] as (AnyCallBinding | undefined)[],
    offer: async (_admission: AllowedOffer, binding?: AnyCallBinding) => {
      signalling.offers.push(binding);
      return { status: 200, body: { pc_id: "pc-1", sdp: "v=0", type: "answer" } };
    },
  } satisfies Pick<SignallingServer, "offer"> & { offers: unknown[] };
  const admission = {
    allowed: true,
    body: { sdp: "v=0", type: "offer" },
  } as unknown as AllowedOffer;
  const refusal = async (response: Response) => [
    response.status,
    ((await response.json()) as { error: { code: string } }).error.code,
  ];

  test("reads `group` from the offer's requestData", () => {
    const chatId = Bun.randomUUIDv7();
    expect(chatCallTarget({ chatId, persona: ANN, group: true })).toEqual({
      chatId,
      persona: ANN,
      group: true,
    });
    expect(chatCallTarget({ chatId, persona: ANN, group: false })).toEqual({
      chatId,
      persona: ANN,
    });
    expect(chatCallTarget({ chatId, persona: ANN, group: "yes" })).toBeInstanceOf(Response);
  });

  test("calls the whole group only on the native engine, in a group, with no realtime persona", async () => {
    signalling.offers = [];
    const runner = new ChatRunner({ root: ROOT(), answer: silent });
    const id = await groupChat(runner);
    const one = await runner.create([ANN]);
    const target = { chatId: id, persona: ANN, group: true };

    process.env.EIDOLON_VOICE_ENGINE = "pipedog";
    expect((await runner.read(id)).groupCall).toBe(false);
    const off = await offerChatCall(runner, signalling, admission, target);
    expect(await refusal(off)).toEqual([400, "bad-request"]);

    process.env.EIDOLON_VOICE_ENGINE = "";
    expect((await runner.read(id)).groupCall).toBe(true);
    process.env.EIDOLON_VOICE_ENGINE = "native";
    expect((await runner.read(id)).groupCall).toBe(true);
    delete process.env.EIDOLON_VOICE_ENGINE;
    expect((await runner.read(id)).groupCall).toBe(true);
    expect((await runner.read(one)).groupCall).toBe(false);
    const alone = await offerChatCall(runner, signalling, admission, { ...target, chatId: one });
    expect(await refusal(alone)).toEqual([400, "bad-request"]);

    writeFileSync(
      join(dataHome(), "personas", BEA, "persona.yaml"),
      `${PERSONAS[BEA]}realtime:\n  provider: openai\n`,
    );
    resetSettings();
    expect((await runner.read(id)).groupCall).toBe(false);
    const realtime = await offerChatCall(runner, signalling, admission, target);
    expect(await refusal(realtime)).toEqual([409, "realtime-in-group"]);
    expect(signalling.offers).toEqual([]);
    expect(runner.callIn(id)).toBeNull();
    expect(
      (await runner.store.read(id)).events.filter((event) => event.type === "call-started"),
    ).toEqual([]);
  });

  test("a group offer binds the session to the whole chat, its call-started marked group", async () => {
    signalling.offers = [];
    const runner = new ChatRunner({ root: ROOT(), answer: silent });
    const id = await groupChat(runner);
    const answered = await offerChatCall(runner, signalling, admission, {
      chatId: id,
      persona: BEA,
      group: true,
    });
    expect(answered.status).toBe(200);
    const [binding] = signalling.offers;
    expect(binding).toMatchObject({ group: true, persona: BEA });
    expect(runner.callIn(id)).toMatchObject({ persona: BEA, group: true, pcId: "pc-1" });
    expect((await runner.read(id)).call).toMatchObject({ persona: BEA, group: true });
    const chat = (binding as Extract<AnyCallBinding, { group: true }>).chat;
    expect(chat.events.map(brief)).toEqual([
      [1, "viewer", "大家好", "text"],
      [2, "call-started", BEA, true],
    ]);
    await (binding as Extract<AnyCallBinding, { group: true }>).onEnded("hangup");
    await runner.shutdown();
  });
});

describe("a group call's binding", () => {
  test("stores each line as whose it is, each decision against the line as the chat numbered it, and her photo as hers", async () => {
    const runner = new ChatRunner({ root: ROOT(), answer: silent });
    const id = await groupChat(runner);
    const call = await runner.startGroupCall(id, ANN);
    const client = { sendServerMessage: async () => {} };
    // As the call's log numbers them: it holds her recall and tools besides its lines.
    const said = stampEvents(
      [
        { type: "message", id: "v", speaker: { kind: "user" }, text: "讲讲你们", modality: "call" },
        { type: "decision", after: 3, replies: [{ persona: ANN, mode: "text" }], source: "model" },
        {
          type: "message",
          id: "a",
          speaker: { kind: "persona", id: ANN },
          text: "我先说",
          modality: "call",
          interrupted: true,
          cutOff: "length",
        },
        { type: "decision", after: 5, replies: [], source: "model" },
      ],
      2,
      9,
    ).map((event, i) => ({ ...event, seq: [3, 4, 7, 9][i] as number }));
    call.onEvents(said.slice(0, 2), client);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]);
    const url = selfieStore.publish({ data: png, mediaType: "image/png" }, 600);
    call.onServerMessage?.({ type: "selfie", urls: [url], persona: BEA }, client);
    call.onEvents(said.slice(2, 3), client);
    call.onEvents([{ ...(said[3] as ChatEvent), after: 7 } as ChatEvent], client);
    await call.onEnded("hangup");
    await runner.shutdown();

    const name = `${createHash("sha256").update(png).digest("hex")}.png`;
    expect((await runner.store.read(id)).events.map(brief)).toEqual([
      [1, "viewer", "大家好", "text"],
      [2, "call-started", ANN, true],
      [3, "viewer", "讲讲你们", "call"],
      [4, "decision", 3, [ANN]],
      [5, BEA, "", "call", name],
      [6, ANN, "我先说", "call"],
      [7, "decision", 6, []],
      [8, "call-ended", "hangup"],
    ]);
    const cut = (await runner.store.read(id)).events.find((event) => event.seq === 6);
    expect(cut).toMatchObject({ interrupted: true, cutOff: "length" });
  });

  test("a whole native group call: the director picks who answers, and the chat stores it all", async () => {
    const runner = new ChatRunner({ root: ROOT(), answer: silent });
    const id = await groupChat(runner);
    const call = await runner.startGroupCall(id, ANN);

    const transport = new FakeTransport();
    const stt = new FakeStt();
    const clock = new FakeClock(0);
    const speeches = new Map<ParticipantId, FakeSpeech>();
    const rounds = [[ANN, BEA]];
    let decided = 0;
    const engine: ChatDeps = {
      createMind: () => ({
        async *stream() {
          yield { type: "text", text: `${activePersona().identity.name}在。` };
          yield DONE;
        },
      }),
      parts: async () => ({
        systemInstruction: "SYSTEM",
        providers: [],
        gate: null,
        tools: [],
        memories: async () => [],
      }),
      saveAttachment: () => Promise.reject(new Error("a call keeps no files")),
      fetchImage: () => Promise.reject(new Error("a call fetches no images")),
      newId: () => Bun.randomUUIDv7(),
      speech: {
        canSpeak: () => false,
        synthesize: () => Promise.reject(new Error("no voice messages")),
        transcribe: () => Promise.reject(new Error("no voice messages")),
      },
      director: {
        decide: async () => {
          const ids = rounds[decided++] ?? [];
          return {
            replies: ids.map((persona) => ({ persona, mode: "text" })),
            source: "model",
            scores: {},
          };
        },
      },
    };
    const deps: Parameters<typeof runNativeSafely>[2] = {
      engine,
      runTurn,
      runChat,
      openStt: async () => stt,
      openSpeech: () => {
        const speech = new FakeSpeech();
        speeches.set(activePersona().id, speech);
        return speech;
      },
      openRealtime: () => Promise.reject(new Error("no realtime here")),
      models: { silero: SILERO_MODEL, smartTurn: SMART_TURN_MODEL },
      about: BOT_ABOUT,
      clock,
    };
    const speaks = async (persona: ParticipantId) => {
      await until(() => speeches.get(persona)?.utterances.at(-1)?.ended === true);
      const utterance = speeches.get(persona)?.utterances.at(-1);
      utterance?.pcm(1, 240);
      utterance?.segEnd(1);
      utterance?.finish();
      await settle();
      transport.source?.pull(240);
      await settle();
    };
    const admission = {
      user: { mid: null, uname: null, face: null, isLoggedIn: false },
      token: null,
      requestData: { chatId: id, persona: ANN, group: true },
    };
    const done = runNativeSafely(transport, admission, deps, call);
    await until(() => transport.connected);
    transport.rtvi("client-ready", { version: "2.3.0" });
    await settle();
    stt.events.push({ type: "final", text: "你们在吗", finalized: true });
    await until(() => transport.types.includes("user-transcription"));
    clock.advance(400);
    await speaks(ANN);
    await speaks(BEA);
    await until(() => decided === 2);
    await settle();
    transport.leave();
    await done;
    await until(() => runner.callIn(id) === null);
    await runner.shutdown();

    expect((await runner.store.read(id)).events.map(brief)).toEqual([
      [1, "viewer", "大家好", "text"],
      [2, "call-started", ANN, true],
      [3, "viewer", "你们在吗", "call"],
      [4, "decision", 3, [ANN, BEA]],
      [5, ANN, "安妮在。", "call"],
      [6, BEA, "露比在。", "call"],
      [7, "decision", 6, []],
      [8, "call-ended", "hangup"],
    ]);
    expect(
      logs.lines().filter((line) => line.startsWith("ERROR") || line.startsWith("WARNING")),
    ).toEqual([]);
  }, 20_000);
});
