// A group call's floor: the real Floor, Mouths, Speaker and kit on a fake clock, with the real
// runChat and runTurn over scripted minds and a scripted director. The director picks who answers,
// each persona speaks in her own voice once the one before her has played out, her label rides her
// first sample, and a barge-in keeps what was heard and drops the turns still to come.
import "../../../config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHAT_FORMAT,
  type ChatEvent,
  type ChatHeader,
  joinSegments,
  type ParticipantId,
} from "@eidolon/chat";
import { activePersona, consoleSink, dataHome, logger, resetSettings } from "@eidolon/config";
import type { DirectorDecision, DirectorInput } from "@eidolon/context";
import type { LlmTool } from "@eidolon/core";
import { type ChatDeps, type MindChunk, type MindRequest, runChat, runTurn } from "@eidolon/engine";
import { runCascadeCall } from "../../src/call/cascade.ts";
import { Floor } from "../../src/call/floor.ts";
import type { GroupFloor } from "../../src/call/group.ts";
import { CallKit } from "../../src/call/kit.ts";
import { memoryCallLog } from "../../src/call/log.ts";
import { Mouth } from "../../src/output/mouth.ts";
import { createSpeaker } from "../../src/output/speaker.ts";
import { type RtviMessage, readRtvi } from "../../src/rtvi/codec.ts";
import { RtviEmitter } from "../../src/rtvi/emitter.ts";
import type { CallDeps, CallPlan, CloseReason, EarEvent } from "../../src/types.ts";
import { FakeClock } from "../input/clock.ts";
import { SILERO_MODEL, SMART_TURN_MODEL } from "../input/speech.ts";
import {
  ABOUT,
  FakeSpeech,
  FakeStt,
  FakeTransport,
  type FakeUtterance,
  line,
  NUDGE,
  settle,
  VIEWER,
} from "./harness.ts";

const ANN = "ann";
const BEA = "bea";
const PERSONAS: Record<ParticipantId, string> = {
  [ANN]: "identity:\n  name: 安妮\n  shortName: 安安\n",
  [BEA]: "identity:\n  name: 露比\n  shortName: 小露\n",
};
const HEADER: ChatHeader = {
  format: CHAT_FORMAT,
  id: "0190f5c8-0000-7000-8000-0000000000bb",
  createdAt: 0,
  participants: [ANN, BEA],
};
const DONE: MindChunk = { type: "done", finishReason: "stop" };

beforeAll(() => {
  for (const [id, yaml] of Object.entries(PERSONAS)) {
    const dir = join(dataHome(), "personas", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "persona.yaml"), yaml);
  }
  // Another file's persona of the same id may linger in the settings scopes.
  resetSettings();
});
afterAll(() => {
  for (const id of Object.keys(PERSONAS)) {
    rmSync(join(dataHome(), "personas", id), { recursive: true, force: true });
  }
  resetSettings();
});

let logs: string[];
beforeEach(() => {
  logs = [];
  logger.setSink((record) => logs.push(record.message));
});
afterEach(() => {
  logger.setSink(consoleSink);
});

/** Lets the call run until `check` holds. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await settle();
  }
  throw new Error("condition not met in time");
}

/** Each persona's replies in turn, as text or raw chunks; past them, `<name>说<n>`. */
type Script = Partial<Record<ParticipantId, (readonly (string | MindChunk)[])[]>>;

type Decide = (input: DirectorInput, signal?: AbortSignal) => Promise<DirectorDecision>;

/** The director answers with `rounds` in order, one list of personas per decision, then no one. */
function director(...rounds: (readonly ParticipantId[] | "hold")[]) {
  const inputs: DirectorInput[] = [];
  const decide: Decide = async (input, signal) => {
    inputs.push(input);
    const round = rounds[inputs.length - 1] ?? [];
    if (round === "hold") {
      // Weighs until the call stops it.
      await new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    const ids = round === "hold" ? [] : round;
    return {
      replies: ids.map((persona) => ({ persona, mode: "text" })),
      source: "model",
      scores: {},
    };
  };
  return { decide, inputs };
}

/** A selfie that resolves when the test says. */
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

function engine(script: Script, decide: Decide, tools: readonly LlmTool[] = []): ChatDeps {
  const said = new Map<ParticipantId, number>();
  let n = 0;
  return {
    createMind: () => ({
      async *stream(request) {
        const persona = activePersona().id;
        requests.push({ persona, request });
        const turn = said.get(persona) ?? 0;
        said.set(persona, turn + 1);
        const reply = script[persona]?.[turn] ?? [
          `${activePersona().identity.name}说${turn + 1}。`,
        ];
        for (const part of reply)
          yield typeof part === "string" ? { type: "text", text: part } : part;
        yield DONE;
      },
    }),
    parts: async () => ({
      systemInstruction: "SYSTEM",
      providers: [],
      gate: null,
      tools,
      memories: async () => [],
    }),
    saveAttachment: () => Promise.reject(new Error("a call saves no files")),
    fetchImage: () => Promise.reject(new Error("a call fetches no images")),
    newId: () => `e-${++n}`,
    speech: {
      canSpeak: () => false,
      synthesize: () => Promise.reject(new Error("a call speaks no voice messages")),
      transcribe: () => Promise.reject(new Error("a call hears no voice messages")),
    },
    director: { decide },
  };
}

let requests: { readonly persona: ParticipantId; readonly request: MindRequest }[];

/** A group call's Floor on its loop, `ANN` hosting, each persona with her own Mouth and voice. */
function startGroup(
  o: { readonly script?: Script; readonly decide: Decide; readonly tools?: readonly LlmTool[] },
  events: readonly ChatEvent[] = [],
) {
  requests = [];
  const clock = new FakeClock(1_000);
  const kit = new CallKit(clock);
  const sent: RtviMessage[] = [];
  const emitter = new RtviEmitter((message) => sent.push(message), ABOUT);
  const speaker = createSpeaker((event) => kit.post({ source: "speaker", event }));
  const speeches = new Map<ParticipantId, FakeSpeech>();
  const mouths = new Map<ParticipantId, Mouth>();
  for (const persona of [ANN, BEA]) {
    const speech = new FakeSpeech();
    speeches.set(persona, speech);
    mouths.set(
      persona,
      new Mouth({
        persona,
        speech,
        markup: undefined,
        speaker,
        join: joinSegments,
        clock,
        post: (event) => kit.post({ source: "mouth", event }),
      }),
    );
  }
  const deps = engine(o.script ?? {}, o.decide, o.tools);
  const group: GroupFloor = {
    mouthOf: (persona) => mouths.get(persona),
    nameOf: (persona) => (persona === ANN ? "安妮" : "露比"),
    answer: (request) => runChat(request, deps),
  };
  const log = memoryCallLog({ ...HEADER, id: "call-9" }, events);
  const endings: CloseReason[] = [];
  let ids = 0;
  const floor = new Floor({
    plan: {
      id: "call-9",
      host: ANN,
      viewer: VIEWER,
      log,
      greet: true,
      realtime: false,
      group: true,
    },
    kit,
    emitter,
    speaker,
    mouth: mouths.get(ANN) as Mouth,
    turn: (request) => runTurn(request, deps),
    nudge: NUDGE,
    newId: () => `id-${++ids}`,
    onEnding: (reason) => endings.push(reason),
    group,
  });
  kit.active();
  const loop = (async () => {
    for await (const event of kit.events) {
      floor.handle(event);
      if (floor.finished !== null) break;
    }
    kit.stop();
    return floor.finished;
  })();
  let mark = 0;
  const call = {
    clock,
    kit,
    sent,
    log,
    endings,
    loop,
    /** Every message since the last `news`, as lines; a speaker label names her. */
    news(): string[] {
      const lines = sent.slice(mark).map((message) => {
        const data = message.data as { type?: unknown; persona?: unknown } | undefined;
        return message.type === "server-message"
          ? `server-message ${data?.type} ${data?.persona}`
          : line(message);
      });
      mark = sent.length;
      return lines;
    },
    events(): ChatEvent[] {
      return [...log.snapshot().events];
    },
    /** Each stored line and decision, briefly. */
    said(): string[] {
      return call.events().flatMap((event) => {
        if (event.type === "message") {
          const who = event.speaker.kind === "user" ? "viewer" : event.speaker.id;
          return [`${who}: ${event.text}${event.interrupted ? " (cut)" : ""}`];
        }
        if (event.type === "decision") {
          return [
            `decision after ${event.after}: ${event.replies.map((r) => r.persona).join(",")}`,
          ];
        }
        return [];
      });
    },
    /** `persona`'s latest utterance. */
    utterance(persona: ParticipantId): FakeUtterance {
      const utterance = speeches.get(persona)?.utterances.at(-1);
      if (utterance === undefined) throw new Error(`${persona} has said nothing`);
      return utterance;
    },
    speech(persona: ParticipantId): FakeSpeech {
      return speeches.get(persona) as FakeSpeech;
    },
    async ready(): Promise<void> {
      kit.post({
        source: "rtvi",
        message: readRtvi({
          label: "rtvi-ai",
          type: "client-ready",
          id: "r",
          data: { version: "2.3.0" },
        }),
      });
      await settle();
    },
    async ear(...events: EarEvent[]): Promise<void> {
      for (const event of events) kit.post({ source: "ear", event });
      await settle();
    },
    async says(text: string): Promise<void> {
      await call.ear(
        { type: "user-started" },
        { type: "final", text },
        { type: "user-stopped", text },
      );
    },
    /** Pulls `samples` in the transport's 10 ms frames. */
    async play(samples: number): Promise<void> {
      for (let left = samples; left > 0; left -= 240) speaker.pull(Math.min(240, left));
      await settle();
    },
    /** Her reply of `segments` sentences, once all are said, voiced and played whole. */
    async plays(persona: ParticipantId, segments = 1): Promise<void> {
      await until(() => {
        const utterance = speeches.get(persona)?.utterances.at(-1);
        return utterance?.ended === true && utterance.said.length === segments;
      });
      const utterance = call.utterance(persona);
      for (let seg = 1; seg <= segments; seg++) {
        utterance.pcm(seg, 480);
        utterance.segEnd(seg);
      }
      utterance.finish();
      await settle();
      await call.play(480 * segments);
    },
  };
  return call;
}

describe("a group call", () => {
  test("doesn't greet: nothing starts until the caller speaks", async () => {
    const { decide, inputs } = director();
    const call = startGroup({ decide });
    await call.ready();
    expect(call.news()).toEqual(["bot-ready"]);
    expect(inputs).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  test("the director picks who answers, and each speaks in her own voice once the last has played out", async () => {
    const { decide, inputs } = director([ANN, BEA]);
    const call = startGroup({ decide });
    await call.ready();
    call.news();
    await call.says("你们好");
    await until(() => requests.length === 1);
    expect(requests.map((r) => r.persona)).toEqual([ANN]);
    expect(inputs[0]?.lines.at(-1)?.text).toBe("你们好");

    // Her words reach her own voice, but her label waits for her first sample.
    await until(() => call.speech(ANN).utterances.length === 1);
    await settle();
    expect(call.news()).not.toContain(`server-message speaker ${ANN}`);
    expect(call.speech(BEA).utterances).toHaveLength(0);
    await call.plays(ANN);
    const annSpoke = call.news();
    expect(annSpoke).toContain(`server-message speaker ${ANN}`);
    expect(annSpoke.indexOf(`server-message speaker ${ANN}`)).toBe(
      annSpoke.indexOf("bot-started-speaking") - 1,
    );
    expect(call.sent.find((m) => m.type === "server-message")?.data).toEqual({
      type: "speaker",
      persona: ANN,
      name: "安妮",
    });

    // Only once her audio has played does the next turn start, which reads what she said.
    await until(() => requests.length === 2);
    expect(requests[1]?.persona).toBe(BEA);
    expect(JSON.stringify(requests[1]?.request.messages)).toContain("安妮：安妮说1。");
    expect(inputs).toHaveLength(1);
    await call.plays(BEA);
    expect(call.news()).toContain(`server-message speaker ${BEA}`);

    // The director is asked about her line only after it played: no one answers it.
    await until(() => inputs.length === 2);
    expect(inputs[1]?.hop).toBe(1);
    await settle();
    expect(call.said()).toEqual([
      "viewer: 你们好",
      "decision after 1: ann,bea",
      "ann: 安妮说1。",
      "bea: 露比说1。",
      "decision after 4: ",
    ]);
    expect(
      call
        .events()
        .filter((e) => e.type === "message")
        .map((e) => e.type === "message" && e.modality),
    ).toEqual(["call", "call", "call"]);
  });

  test("a reply in text alone is labeled before its first words", async () => {
    const { decide, inputs } = director([ANN, BEA]);
    const call = startGroup({ decide });
    await call.ready();
    call.news();
    call.kit.post({
      source: "rtvi",
      message: readRtvi({
        label: "rtvi-ai",
        type: "send-text",
        id: "c-send-text",
        data: { content: "打字回我们", options: { audio_response: false } },
      }),
    });
    await until(() => inputs.length === 2);
    await settle();
    expect(call.speech(ANN).utterances).toEqual([]);
    expect(call.speech(BEA).utterances).toEqual([]);
    expect(
      call
        .news()
        .filter((line) => line.startsWith("server-message") || line.startsWith("bot-output")),
    ).toEqual([
      `server-message speaker ${ANN}`,
      "bot-output new 安妮说1。",
      `server-message speaker ${BEA}`,
      "bot-output new 露比说1。",
    ]);
  });

  test("a barge-in mid-turn keeps what was heard of her, drops the turns still to come, and answers the new line", async () => {
    const { decide, inputs } = director([ANN, BEA], [BEA]);
    const call = startGroup({ decide, script: { [ANN]: [["第一句。", "第二句。"]] } });
    await call.ready();
    await call.says("讲个故事");
    await until(() => call.speech(ANN).utterances.at(-1)?.said.length === 2);
    const utterance = call.utterance(ANN);
    utterance.pcm(1, 480);
    utterance.segEnd(1);
    utterance.pcm(2, 480);
    await settle();
    await call.play(720);
    call.news();

    await call.ear({ type: "user-started" });
    await until(() => call.said().includes("ann: 第一句。 (cut)"));
    expect(call.news()).toEqual([
      "user-started-speaking",
      "bot-interrupted",
      "bot-tts-stopped",
      "bot-stopped-speaking",
    ]);
    await call.ear({ type: "final", text: "等一下" }, { type: "user-stopped", text: "等一下" });
    await until(() => requests.length === 2);
    // Her queued turn never ran: the line that cut her in gets the chat's answer.
    expect(requests.map((r) => r.persona)).toEqual([ANN, BEA]);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.lines.at(-1)?.text).toBe("等一下");
    await call.plays(BEA);
    await until(() => inputs.length === 3);
    expect(call.said()).toEqual([
      "viewer: 讲个故事",
      "decision after 1: ann,bea",
      "ann: 第一句。 (cut)",
      "viewer: 等一下",
      "decision after 4: bea",
      "bea: 露比说1。",
      "decision after 6: ",
    ]);
  });

  test("a barge-in while the director weighs the next turn stores nothing more", async () => {
    const { decide, inputs } = director([ANN], "hold");
    const call = startGroup({ decide });
    await call.ready();
    await call.says("你好");
    await call.plays(ANN);
    await until(() => inputs.length === 2);
    await call.ear({ type: "user-started" }, { type: "user-stopped", text: null });
    await settle();
    expect(call.said()).toEqual(["viewer: 你好", "decision after 1: ann", "ann: 安妮说1。"]);
    // No one was cut off mid-turn, so no one is asked to go on.
    expect(requests).toHaveLength(1);
    expect(inputs).toHaveLength(2);
  });

  test("an empty turn that cut her off asks her alone to go on", async () => {
    const { decide, inputs } = director([ANN, BEA]);
    const call = startGroup({ decide, script: { [ANN]: [["从前有座山。"], ["我接着说。"]] } });
    await call.ready();
    await call.says("讲个故事");
    await until(() => call.speech(ANN).utterances.at(-1)?.said.length === 1);
    await call.ear({ type: "user-started" }, { type: "user-stopped", text: null });
    await until(() => requests.length === 2);
    expect(requests.map((r) => r.persona)).toEqual([ANN, ANN]);
    expect(JSON.stringify(requests[1]?.request.messages)).toContain(NUDGE);
    expect(inputs).toHaveLength(1);
  });

  test("her photo says it is hers, and its follow-up is her turn alone", async () => {
    const selfie = selfieTool();
    const { decide, inputs } = director([BEA]);
    const call = startGroup({
      decide,
      tools: [selfie.tool],
      script: {
        [BEA]: [
          [
            "我拍一张。",
            { type: "tool-calls", calls: [{ id: "s1", name: "take_selfie", arguments: {} }] },
          ],
          ["拍好啦。"],
        ],
      },
    });
    await call.ready();
    await call.says("小露拍张照");
    await call.plays(BEA);
    await until(() => inputs.length === 2);
    expect(requests).toHaveLength(1);
    selfie.shoot();
    await until(() => requests.length === 2);
    expect(call.sent.find((m) => (m.data as { type?: string })?.type === "selfie")?.data).toEqual({
      type: "selfie",
      urls: ["https://x/1.png"],
      persona: BEA,
    });
    expect(requests.map((r) => r.persona)).toEqual([BEA, BEA]);
    // Her follow-up answers her own photo: the director isn't asked who answers it.
    expect(inputs).toHaveLength(2);
    await call.plays(BEA);
    expect(call.said().slice(-1)).toEqual(["bea: 拍好啦。"]);
  });
});

describe("runCascadeCall with a group", () => {
  test("opens each persona's voice in her own scope, hears through the host's, and closes them all", async () => {
    const transport = new FakeTransport();
    const stt = new FakeStt();
    const opened: { role: string; persona: string }[] = [];
    const speeches: FakeSpeech[] = [];
    const { decide } = director();
    const deps: CallDeps = {
      engine: engine({}, decide),
      runTurn,
      runChat,
      openStt: async () => {
        opened.push({ role: "hearing", persona: activePersona().id });
        return stt;
      },
      openSpeech: () => {
        opened.push({ role: "voice", persona: activePersona().id });
        const speech = new FakeSpeech();
        speeches.push(speech);
        return speech;
      },
      openRealtime: () => Promise.reject(new Error("no realtime here")),
      models: { silero: SILERO_MODEL, smartTurn: SMART_TURN_MODEL },
      about: ABOUT,
      clock: new FakeClock(0),
    };
    const plan: CallPlan = {
      id: "call-10",
      host: BEA,
      viewer: VIEWER,
      log: memoryCallLog({ ...HEADER, id: "call-10" }),
      greet: false,
      realtime: false,
      group: true,
    };
    const ear = async () => {};
    const running = runCascadeCall(transport, plan, deps, new AbortController().signal, { ear });
    await until(() => transport.connected);
    expect(opened).toEqual([
      { role: "voice", persona: ANN },
      { role: "voice", persona: BEA },
      { role: "hearing", persona: BEA },
    ]);
    transport.rtvi("client-ready", { version: "2.3.0" });
    await settle();
    expect(transport.types).toEqual(["bot-ready"]);
    transport.leave();
    expect(await running).toBe("client");
    expect(speeches.map((speech) => speech.closed)).toEqual([true, true]);
    expect(stt.closed).toBe(true);
  });

  test("can't start without the engine's runChat", async () => {
    const { decide } = director();
    const deps = {
      engine: engine({}, decide),
      runTurn,
      openStt: async () => new FakeStt(),
      openSpeech: () => new FakeSpeech(),
      openRealtime: () => Promise.reject(new Error("no realtime here")),
      models: { silero: SILERO_MODEL, smartTurn: SMART_TURN_MODEL },
      about: ABOUT,
      clock: new FakeClock(0),
    } satisfies CallDeps;
    const plan: CallPlan = {
      id: "call-11",
      host: ANN,
      viewer: VIEWER,
      log: memoryCallLog({ ...HEADER, id: "call-11" }),
      greet: false,
      realtime: false,
      group: true,
    };
    const failed = await runCascadeCall(
      new FakeTransport(),
      plan,
      deps,
      new AbortController().signal,
    )
      .then(() => null)
      .catch((error: unknown) => (error as Error).message);
    expect(failed).toBe("A group call needs the engine's runChat");
  });
});
