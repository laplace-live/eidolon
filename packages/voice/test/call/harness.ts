// A call's Floor on its real kit, emitter, Speaker and Mouth, with fakes for the rest: the test
// posts what the Ear hears and what the client sends, scripts each turn's lines and her voice's
// audio, pulls the Speaker as the transport's clock would, and moves the clock.
import type { UserContext } from "@eidolon/access";
import {
  CHAT_FORMAT,
  type ChatEvent,
  type ChatEventDraft,
  type ChatHeader,
  joinSegments,
} from "@eidolon/chat";
import { AsyncQueue } from "@eidolon/config";
import type { CallChatOutput, CallTurnRequest } from "@eidolon/engine";
import { reportUsage } from "@eidolon/providers";
import type { SpeechStream, Utterance, UtteranceAudio } from "@eidolon/providers/speech-stream";
import type { SttEvent, SttStream } from "@eidolon/providers/stt";
import { Floor, type FloorOptions } from "../../src/call/floor.ts";
import { CallKit } from "../../src/call/kit.ts";
import { memoryCallLog } from "../../src/call/log.ts";
import { Mouth } from "../../src/output/mouth.ts";
import { createSpeaker } from "../../src/output/speaker.ts";
import type { RtviMessage } from "../../src/rtvi/codec.ts";
import { readRtvi } from "../../src/rtvi/codec.ts";
import { RtviEmitter } from "../../src/rtvi/emitter.ts";
import type {
  CallLog,
  CallTransport,
  CloseReason,
  EarEvent,
  Heard,
  Pcm,
  PcmSource,
} from "../../src/types.ts";
import { FakeClock } from "../input/clock.ts";

export const HOST = "milky-green";
export const NUDGE = "（刚才被打断了）";
export const ABOUT = { library: "laplace-eidolon", library_version: "0.6.0" };
export const VIEWER: UserContext = { mid: 7, uname: "Ken", face: null, isLoggedIn: true };
export const HEADER: ChatHeader = {
  format: CHAT_FORMAT,
  id: "0190f5c8-0000-7000-8000-0000000000aa",
  createdAt: 0,
  participants: [HOST],
};

/** Lets every task the test started run until each waits on something the test controls. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Bun.sleep(0);
}

/** An utterance that records what it was given; the test scripts its audio. */
export class FakeUtterance implements Utterance {
  readonly audio = new AsyncQueue<UtteranceAudio>();
  readonly voice: string | null;
  readonly said: string[] = [];
  ended = false;
  cancelled = false;

  constructor(voice: string | null) {
    this.voice = voice;
  }

  say(segment: { readonly id: number; readonly text: string }): void {
    this.said.push(segment.text);
  }

  end(): void {
    this.ended = true;
  }

  cancel(): void {
    this.cancelled = true;
    this.audio.drop();
  }

  pcm(seg: number, samples: number): void {
    this.audio.push({ kind: "pcm", seg, pcm: new Int16Array(samples).fill(1) });
  }

  words(seg: number, words: readonly { chars: number; startMs: number }[]): void {
    this.audio.push({ kind: "words", seg, words });
  }

  segEnd(seg: number): void {
    this.audio.push({ kind: "seg-end", seg });
  }

  finish(last: UtteranceAudio = { kind: "end" }): void {
    this.audio.push(last);
    this.audio.close();
  }
}

export class FakeSpeech implements SpeechStream {
  readonly sampleRate = 24_000;
  readonly utterances: FakeUtterance[] = [];
  closed = false;

  utterance(voice: string | null): FakeUtterance {
    const utterance = new FakeUtterance(voice);
    this.utterances.push(utterance);
    return utterance;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** One of her turns as the engine would run it, its lines scripted by the test. */
export class FakeTurn {
  readonly request: CallTurnRequest;
  readonly #queue = new AsyncQueue<CallChatOutput>();
  readonly id: string;
  #ending: Promise<Heard> | null = null;
  #pushed = 0;
  #read = 0;
  #reading: (() => void)[] = [];
  /** Sync tools running, which an abort cancels. */
  readonly #running = new Set<string>();

  /** `stubborn`: an abort doesn't end it, as a turn stuck in a provider wouldn't end. */
  constructor(request: CallTurnRequest, id: string, stubborn = false) {
    this.request = request;
    this.id = id;
    // As the engine does, an abort cancels her sync tools and ends her turn with what was heard.
    if (!stubborn) {
      request.signal.addEventListener(
        "abort",
        () => {
          for (const callId of this.#running) this.tool(callId, "cancelled");
          void this.end();
        },
        { once: true },
      );
    }
    this.push({ type: "started", turn: id, persona: request.persona });
  }

  push(...lines: CallChatOutput[]): void {
    for (const line of lines) {
      this.#pushed++;
      this.#queue.push(line);
    }
  }

  /** Its lines; one counts as read once its reader asks for the next. */
  get lines(): AsyncIterable<CallChatOutput> {
    const turn = this;
    return (async function* () {
      for await (const line of turn.#queue) {
        yield line;
        turn.#read++;
        if (turn.#read === turn.#pushed) for (const resolve of turn.#reading.splice(0)) resolve();
      }
    })();
  }

  /** As the engine's call hooks wait: until every line pushed so far has been read. */
  #allRead(): Promise<void> {
    if (this.#read === this.#pushed) return Promise.resolve();
    return new Promise((resolve) => this.#reading.push(resolve));
  }

  mind(state: "started" | "ended", error?: string): void {
    this.push({ type: "mind", turn: this.id, state, ...(error === undefined ? {} : { error }) });
  }

  delta(text: string): void {
    this.push({ type: "delta", turn: this.id, text });
  }

  /** A whole mind round of `text`. */
  round(text: string): void {
    this.mind("started");
    this.delta(text);
    this.mind("ended");
  }

  tool(
    callId: string,
    state: "running" | "done" | "failed" | "cancelled",
    async = false,
    name = "change_voice_style",
  ): void {
    if (!async && state === "running") this.#running.add(callId);
    else this.#running.delete(callId);
    this.push({ type: "tool", turn: this.id, name, callId, async, state });
  }

  events(...events: ChatEventDraft[]): void {
    this.push({ type: "events", events });
  }

  /** Ends her speech, stores what was heard of it, and ends; at most once. */
  end(): Promise<Heard> {
    this.#ending ??= (async () => {
      if (!this.request.signal.aborted) await this.#allRead();
      const heard = await this.request.heard();
      if (heard.text !== "") {
        this.events({
          type: "message",
          id: `m-${this.id}`,
          speaker: { kind: "persona", id: this.request.persona },
          text: heard.text,
          modality: "call",
          ...(heard.complete ? {} : { interrupted: true }),
        });
      }
      this.push({ type: "ended", turn: this.id });
      this.#queue.close();
      return heard;
    })();
    return this.#ending;
  }
}

export interface CallOptions {
  readonly greet?: boolean;
  /** Her turns ignore an abort. */
  readonly stubborn?: boolean;
  /** Runs her turns instead of scripting them. */
  readonly turn?: FloorOptions["turn"];
}

/** One message as a short line: its type, and what tells it apart from its kind. */
export function line(message: RtviMessage): string {
  const data = (message.data ?? {}) as Record<string, unknown>;
  switch (message.type) {
    case "bot-output": {
      const progress = data.spoken_progress as { accumulated_text: string };
      const text = data.spoken_status === "in-progress" ? progress.accumulated_text : data.text;
      return `bot-output ${data.spoken_status} ${text}`;
    }
    case "user-input":
      return `user-input ${data.input_type} ${data.text}`;
    case "user-transcription":
    case "user-llm-text":
    case "bot-llm-text":
    case "bot-transcription":
    case "bot-tts-text":
      return `${message.type} ${data.text}`;
    case "error":
    case "error-response":
      return `${message.type} ${data.error}`;
    case "llm-function-call-in-progress":
      return `${message.type} ${data.tool_call_id}`;
    case "llm-function-call-stopped":
      return `${message.type} ${data.tool_call_id}${data.cancelled ? " cancelled" : ""}`;
    default:
      return message.type;
  }
}

/** A Floor running its loop on the kit, as runCascadeCall runs it. */
export function startCall(options: CallOptions = {}) {
  const clock = new FakeClock(1_000);
  const kit = new CallKit(clock);
  const sent: RtviMessage[] = [];
  const emitter = new RtviEmitter((message) => sent.push(message), ABOUT);
  const speaker = createSpeaker((event) => kit.post({ source: "speaker", event }));
  const speech = new FakeSpeech();
  const mouth = new Mouth({
    persona: HOST,
    speech,
    markup: undefined,
    speaker,
    join: joinSegments,
    clock,
    post: (event) => kit.post({ source: "mouth", event }),
  });
  const log: CallLog = memoryCallLog(HEADER);
  const turns: FakeTurn[] = [];
  const endings: CloseReason[] = [];
  let ids = 0;
  const floor = new Floor({
    plan: {
      id: "call-1",
      host: HOST,
      viewer: VIEWER,
      log,
      greet: options.greet ?? false,
      realtime: false,
    },
    kit,
    emitter,
    speaker,
    mouth,
    turn:
      options.turn ??
      ((request) => {
        const turn = new FakeTurn(request, `turn-${turns.length + 1}`, options.stubborn);
        turns.push(turn);
        return turn.lines;
      }),
    nudge: NUDGE,
    newId: () => `id-${++ids}`,
    onEnding: (reason) => endings.push(reason),
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
    speaker,
    speech,
    log,
    turns,
    endings,
    floor,
    loop,
    /** The latest turn. */
    get turn(): FakeTurn {
      const turn = turns.at(-1);
      if (turn === undefined) throw new Error("no turn has started");
      return turn;
    },
    utterance(i = -1): FakeUtterance {
      const utterance = speech.utterances.at(i);
      if (utterance === undefined) throw new Error("no utterance");
      return utterance;
    },
    /** Every message since the last `news`, as lines. */
    news(): string[] {
      const lines = sent.slice(mark).map(line);
      mark = sent.length;
      return lines;
    },
    events(): ChatEvent[] {
      return [...log.snapshot().events];
    },
    async rtvi(type: string, data?: Record<string, unknown>, id = `c-${type}`): Promise<void> {
      kit.post({ source: "rtvi", message: readRtvi({ label: "rtvi-ai", type, id, data }) });
      await settle();
    },
    async ready(): Promise<void> {
      await call.rtvi("client-ready", { version: "2.3.0" }, "c-ready");
    },
    async ear(...events: EarEvent[]): Promise<void> {
      for (const event of events) kit.post({ source: "ear", event });
      await settle();
    },
    /** A whole turn of the caller's: started, its final, stopped. */
    async says(text: string): Promise<void> {
      await call.ear(
        { type: "user-started" },
        { type: "final", text },
        { type: "user-stopped", text },
      );
    },
    /** Pulls `samples` of audio in the transport's 10 ms frames, then lets the call catch up. */
    async play(samples: number): Promise<void> {
      for (let left = samples; left > 0; left -= 240) speaker.pull(Math.min(240, left));
      await settle();
    },
    async advance(ms: number): Promise<void> {
      clock.advance(ms);
      await settle();
    },
  };
  return call;
}

export type Call = ReturnType<typeof startCall>;

/** Her reply `text` in one round, voiced as one segment, played to its end. */
export async function spokenReply(call: Call, text: string, samples = 480): Promise<void> {
  const turn = call.turn;
  turn.round(text);
  await settle();
  const ending = turn.end();
  await settle();
  const utterance = call.utterance();
  utterance.pcm(1, samples);
  utterance.segEnd(1);
  utterance.finish();
  await settle();
  await call.play(samples);
  await ending;
  await settle();
}

/** A call's transport, its client scripted by the test. */
export class FakeTransport implements CallTransport {
  readonly audioIn = new AsyncQueue<Pcm>();
  readonly messages = new AsyncQueue<unknown>();
  readonly sent: Readonly<Record<string, unknown>>[] = [];
  source: PcmSource | null = null;
  connected = false;
  disconnects = 0;
  readonly closed: Promise<"client">;
  #leave: () => void = () => {};

  constructor() {
    this.closed = new Promise((resolve) => {
      this.#leave = () => resolve("client");
    });
  }

  attachSpeaker(source: PcmSource): void {
    this.source = source;
  }

  send(message: Readonly<Record<string, unknown>>): void {
    this.sent.push(message);
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnects++;
  }

  leave(): void {
    this.#leave();
  }

  rtvi(type: string, data?: Record<string, unknown>): void {
    this.messages.push({ label: "rtvi-ai", type, id: `c-${type}`, data });
  }

  get types(): string[] {
    return this.sent.map((m) => m.type as string);
  }
}

/** A recognizer that bills what it is sent, as the real ones do. */
export class FakeStt implements SttStream {
  readonly inputRate = 16_000;
  readonly ttfsP99 = 0.35;
  readonly acknowledgesFinalize = true;
  readonly events = new AsyncQueue<SttEvent>();
  samples = 0;
  closed = false;

  send(pcm: Int16Array): void {
    this.samples += pcm.length;
    reportUsage({
      role: "hearing",
      provider: "soniox",
      model: "stt-rt-v3",
      units: { audioSeconds: pcm.length / 16_000 },
    });
  }

  finalize(): void {}

  async close(): Promise<void> {
    this.closed = true;
    this.events.close();
  }
}
