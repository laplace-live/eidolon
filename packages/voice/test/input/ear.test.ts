// The Ear's plumbing on scripted VAD, Smart Turn and recognizer fakes and a fake clock, and once on
// the real models.
import { describe, expect, test } from "bun:test";
import { AsyncQueue } from "@eidolon/config";
import type { SttEvent, SttStream } from "@eidolon/providers/stt";
import { resampler } from "../../src/dsp/resampler/index.ts";
import { type EarDeps, runEar } from "../../src/input/ear.ts";
import { type EndOfTurn, SmartTurn } from "../../src/input/smart_turn.ts";
import { Vad, type VadEdge } from "../../src/input/vad.ts";
import type { EarEvent, Pcm } from "../../src/types.ts";
import { FakeClock } from "./clock.ts";
import {
  concat,
  FRAME_SAMPLES,
  frames,
  noise,
  SILERO_MODEL,
  SMART_TURN_MODEL,
  syntheticSpeech,
  toPcm,
} from "./speech.ts";

const FRAME_MS = 20;
const AUDIO_IDLE_MS = 1_000;

/** A recognizer that records what it was sent; the test scripts its events. */
class FakeStt implements SttStream {
  readonly ttfsP99 = 0.35;
  readonly sent: Int16Array[] = [];
  readonly events = new AsyncQueue<SttEvent>();
  onFinalize: () => void = () => {};
  readonly log: string[];
  readonly inputRate: 16000 | 24000;

  constructor(log: string[], inputRate: 16000 | 24000 = 16000) {
    this.log = log;
    this.inputRate = inputRate;
  }

  send(pcm: Int16Array): void {
    this.sent.push(pcm.slice());
  }

  finalize(): void {
    this.log.push("finalize");
    this.onFinalize();
  }

  async close(): Promise<void> {
    this.events.close();
  }
}

/** A VAD whose edges come at scripted frames; while `hold` is set, frames wait for it. */
class ScriptedVad {
  speaking = false;
  pushed = 0;
  readonly edges = new Map<number, VadEdge>();
  hold: Promise<void> | null = null;
  failure: Error | null = null;

  async push(_pcm: Int16Array): Promise<VadEdge | null> {
    const index = this.pushed++;
    if (this.hold) await this.hold;
    if (this.failure) throw this.failure;
    const edge = this.edges.get(index) ?? null;
    if (edge) this.speaking = edge === "started";
    return edge;
  }

  forceStop(): VadEdge | null {
    if (!this.speaking) return null;
    this.speaking = false;
    return "stopped";
  }
}

/** Smart Turn with a scripted verdict; `append` reports 3 s of silence at scripted frames. */
class ScriptedTurn {
  readonly appends: boolean[] = [];
  readonly silenceAt = new Set<number>();
  verdict: EndOfTurn = "complete";
  hold: Promise<void> | null = null;
  cleared = 0;
  readonly log: string[];

  constructor(log: string[]) {
    this.log = log;
  }

  append(_pcm: Int16Array, isSpeech: boolean): EndOfTurn {
    this.appends.push(isSpeech);
    return this.silenceAt.has(this.appends.length - 1) ? "complete" : "incomplete";
  }

  async analyze(): Promise<{ state: EndOfTurn; probability: number | null }> {
    this.log.push("analyze");
    if (this.hold) await this.hold;
    return { state: this.verdict, probability: null };
  }

  clear(): void {
    this.cleared++;
  }
}

function describeEvent(event: EarEvent): string {
  switch (event.type) {
    case "interim":
    case "final":
      return `${event.type} ${event.text}`;
    case "user-stopped":
      return `user-stopped ${event.text}`;
    case "stt-error":
      return `stt-error ${event.message} ${event.fatal}`;
    default:
      return event.type;
  }
}

/** Lets every pending promise run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** An Ear on fakes, with what it posted (activity left out unless asked for). */
function ear(inputRate: 16000 | 24000 = 16000) {
  const log: string[] = [];
  const clock = new FakeClock(10_000);
  const stt = new FakeStt(log, inputRate);
  const vad = new ScriptedVad();
  const turn = new ScriptedTurn(log);
  const audio = new AsyncQueue<Pcm>();
  const posted: string[] = [];
  const abort = new AbortController();
  const deps: EarDeps = { stt, vad, turn, clock, join: (parts) => parts.join("|") };
  const done = runEar(audio, deps, (event) => posted.push(describeEvent(event)), abort.signal);
  const events = () => posted.filter((e) => e !== "user-speaking");
  /** Delivers frames 20 ms apart, each heard before the next arrives. */
  async function hear(...pcms: Pcm[]): Promise<void> {
    for (const pcm of pcms) {
      audio.push(pcm);
      await settle();
      clock.advance(FRAME_MS);
    }
  }
  const speak = (count: number) => hear(...Array.from({ length: count }, () => frame(1000)));
  async function end(): Promise<void> {
    audio.close();
    await stt.close();
    await done;
  }
  return { log, clock, stt, vad, turn, posted, events, abort, done, hear, speak, end };
}

function frame(value: number): Pcm {
  return new Int16Array(FRAME_SAMPLES).fill(value);
}

describe("each frame", () => {
  test("reaches the recognizer at once, without waiting for the VAD", async () => {
    const e = ear();
    const held = Promise.withResolvers<void>();
    e.vad.hold = held.promise;
    await e.speak(3);
    expect([e.stt.sent.length, e.vad.pushed, e.turn.appends.length]).toEqual([3, 1, 0]);
    e.vad.hold = null;
    held.resolve();
    await settle();
    expect([e.vad.pushed, e.turn.appends.length]).toEqual([3, 3]);
    await e.end();
  });

  test("reaches Smart Turn with the speaking state from before its own VAD edge", async () => {
    const e = ear();
    e.vad.edges.set(2, "started");
    e.vad.edges.set(5, "stopped");
    await e.speak(8);
    expect(e.turn.appends).toEqual([false, false, false, true, true, true, false, false]);
    await e.end();
  });

  test("goes to a 24 kHz recognizer resampled, the resampler starting afresh after a gap", async () => {
    const e = ear(24000);
    const tone = (i: number) =>
      Int16Array.from({ length: FRAME_SAMPLES }, (_, n) =>
        Math.round(8000 * Math.sin((2 * Math.PI * 440 * (i * FRAME_SAMPLES + n)) / 16000)),
      );
    const pcms = Array.from({ length: 15 }, (_, i) => tone(i));
    const reference = resampler().createStream(16000, 24000);
    const expected: Int16Array[] = [];
    for (const [i, pcm] of pcms.entries()) {
      if (i === 10) reference.reset();
      expected.push(reference.processSamples(pcm));
    }
    reference.destroy();

    await e.hear(...pcms.slice(0, 10));
    e.clock.advance(300);
    await e.hear(...pcms.slice(10));
    expect(e.stt.sent).toEqual(expected.filter((pcm) => pcm.length > 0));
    const samples = e.stt.sent.reduce((n, pcm) => n + pcm.length, 0);
    expect(samples).toBeGreaterThan(13 * 480);
    await e.end();
  });
});

describe("a turn", () => {
  test("the VAD's stop finalizes the recognizer, then asks Smart Turn; frames wait for its verdict", async () => {
    const e = ear();
    e.vad.edges.set(1, "started");
    e.vad.edges.set(10, "stopped");
    const verdict = Promise.withResolvers<void>();
    e.turn.hold = verdict.promise;
    e.stt.onFinalize = () => e.stt.events.push({ type: "final", text: "你好", finalized: true });
    await e.speak(11);
    expect(e.log).toEqual(["finalize", "analyze"]);
    await e.speak(3);
    expect([e.stt.sent.length, e.turn.appends.length]).toEqual([14, 11]);
    expect(e.events()).toEqual(["user-started", "final 你好"]);

    verdict.resolve();
    await settle();
    expect(e.turn.appends.length).toBe(14);
    expect(e.events()).toEqual(["user-started", "final 你好", "user-stopped 你好"]);
    await e.end();
  });

  test("goes from the VAD's start through the transcripts to its end", async () => {
    const e = ear();
    e.vad.edges.set(1, "started");
    e.vad.edges.set(30, "stopped");
    e.stt.onFinalize = () =>
      e.stt.events.push({ type: "final", text: "今天天气怎么样", finalized: true });
    await e.speak(10);
    e.stt.events.push({ type: "interim", text: "今天" });
    await e.speak(25);
    expect(e.events()).toEqual([
      "user-started",
      "interim 今天",
      "final 今天天气怎么样",
      "user-stopped 今天天气怎么样",
    ]);
    expect(e.turn.cleared).toBe(1);
    await e.end();
  });

  test("posts speech activity every 0.2 s while the VAD hears speech", async () => {
    const e = ear();
    e.vad.edges.set(0, "started");
    e.vad.edges.set(30, "stopped");
    await e.speak(40);
    // Frames 0, 10 and 20 are 0.2 s apart; frame 30 is the stop.
    expect(e.posted.filter((p) => p === "user-speaking")).toHaveLength(3);
    expect(e.posted.slice(0, 2)).toEqual(["user-started", "user-speaking"]);
    await e.end();
  });

  test("Smart Turn's 3 s of silence ends it without asking the model again", async () => {
    const e = ear();
    e.vad.edges.set(0, "started");
    e.vad.edges.set(5, "stopped");
    e.turn.verdict = "incomplete";
    e.turn.silenceAt.add(20);
    e.stt.onFinalize = () => e.stt.events.push({ type: "final", text: "嗯", finalized: true });
    await e.speak(20);
    expect(e.events()).toEqual(["user-started", "final 嗯"]);
    await e.speak(1);
    expect(e.events().at(-1)).toBe("user-stopped 嗯");
    expect(e.log).toEqual(["finalize", "analyze"]);
    await e.end();
  });

  test("no audio for 1 s while the VAD hears speech ends the speech", async () => {
    const e = ear();
    e.vad.edges.set(0, "started");
    e.stt.onFinalize = () => e.stt.events.push({ type: "final", text: "喂", finalized: true });
    await e.speak(5);
    e.clock.advance(AUDIO_IDLE_MS - FRAME_MS * 1 - 1);
    await settle();
    expect(e.log).toEqual([]);
    e.clock.advance(1);
    await settle();
    expect(e.log).toEqual(["finalize", "analyze"]);
    expect(e.events()).toEqual(["user-started", "final 喂", "user-stopped 喂"]);
    await e.end();
  });

  test("audio that keeps arriving while the VAD is slow is not missing audio", async () => {
    const e = ear();
    e.vad.edges.set(0, "started");
    await e.speak(3);
    const held = Promise.withResolvers<void>();
    e.vad.hold = held.promise;
    await e.speak(2 * (AUDIO_IDLE_MS / FRAME_MS));
    e.vad.hold = null;
    held.resolve();
    await settle();
    expect(e.vad.pushed).toBe(3 + 2 * (AUDIO_IDLE_MS / FRAME_MS));
    expect([e.log, e.events(), e.vad.speaking]).toEqual([[], ["user-started"], true]);
    await e.end();
  });

  test("missing audio stops the speech after the frame the VAD is on, unless audio came since", async () => {
    for (const resumes of [false, true]) {
      const e = ear();
      e.vad.edges.set(0, "started");
      await e.speak(3);
      const held = Promise.withResolvers<void>();
      e.vad.hold = held.promise;
      await e.speak(1);
      e.clock.advance(AUDIO_IDLE_MS);
      await settle();
      expect([e.log, e.vad.speaking]).toEqual([[], true]);
      if (resumes) await e.speak(1);
      e.vad.hold = null;
      held.resolve();
      await settle();
      expect(e.log).toEqual(resumes ? [] : ["finalize", "analyze"]);
      expect(e.vad.speaking).toBe(resumes);
      await e.end();
    }
  });

  test("no audio while the VAD hears nothing changes nothing", async () => {
    const e = ear();
    await e.speak(5);
    e.clock.advance(10 * AUDIO_IDLE_MS);
    await settle();
    expect([e.log, e.posted]).toEqual([[], []]);
    await e.end();
  });
});

describe("the recognizer's events", () => {
  test("a turn of no words ends as the recognizer acknowledges its finalize", async () => {
    const e = ear();
    e.vad.edges.set(1, "started");
    e.vad.edges.set(10, "stopped");
    e.stt.onFinalize = () => e.stt.events.push({ type: "finalized" });
    await e.speak(11);
    expect(e.log).toEqual(["finalize", "analyze"]);
    expect(e.events()).toEqual(["user-started", "user-stopped null"]);
    expect(e.turn.cleared).toBe(1);
    await e.end();
  });

  test("an error passes through; an acknowledgement with no turn changes nothing", async () => {
    const e = ear();
    e.stt.events.push({ type: "finalized" });
    e.stt.events.push({ type: "error", message: "Soniox dropped", fatal: false });
    e.stt.events.push({ type: "error", message: "Soniox gave up", fatal: true });
    await settle();
    expect(e.posted).toEqual(["stt-error Soniox dropped false", "stt-error Soniox gave up true"]);
    await e.end();
  });
});

describe("ending", () => {
  test("ends when the audio and the transcripts have", async () => {
    const e = ear();
    await e.speak(2);
    await e.end();
    expect(e.clock.pending).toBe(0);
  });

  test("an abort ends it at once; nothing is posted after", async () => {
    const e = ear();
    e.vad.edges.set(0, "started");
    await e.speak(2);
    e.abort.abort();
    await e.done;
    const before = [...e.posted];
    e.stt.events.push({ type: "interim", text: "late" });
    await e.speak(2);
    e.clock.advance(10_000);
    await settle();
    expect(e.posted).toEqual(before);
    expect(e.clock.pending).toBe(0);
  });

  test("a frame or a verdict still in flight at the abort changes nothing", async () => {
    for (const inFlight of ["frame", "verdict"] as const) {
      const e = ear();
      e.vad.edges.set(0, inFlight === "frame" ? "started" : "stopped");
      e.vad.speaking = inFlight === "verdict";
      const held = Promise.withResolvers<void>();
      if (inFlight === "frame") e.vad.hold = held.promise;
      else e.turn.hold = held.promise;
      await e.speak(1);
      e.abort.abort();
      await e.done;
      held.resolve();
      await settle();
      expect(e.posted, inFlight).toEqual([]);
      expect(e.clock.pending, inFlight).toBe(0);
    }
  });

  test("a VAD that fails ends it with the failure", async () => {
    const e = ear();
    e.vad.failure = new Error("no model");
    const outcome = e.done.then(
      () => "ended",
      (error: Error) => error.message,
    );
    await e.speak(1);
    expect(await outcome).toBe("no model");
  });
});

test("hears a spoken turn on the real VAD and Smart Turn", async () => {
  const clock = new FakeClock(0);
  const log: string[] = [];
  const stt = new FakeStt(log);
  const vad = new Vad(SILERO_MODEL);
  const turn = new SmartTurn(SMART_TURN_MODEL, clock);
  await vad.ready();
  let pending = 0;
  const counted = {
    push: async (pcm: Int16Array) => {
      pending++;
      try {
        return await vad.push(pcm);
      } finally {
        pending--;
      }
    },
    forceStop: () => vad.forceStop(),
    get speaking() {
      return vad.speaking;
    },
  };
  const analyzing = {
    append: (pcm: Int16Array, isSpeech: boolean) => turn.append(pcm, isSpeech),
    analyze: async () => {
      pending++;
      try {
        return await turn.analyze();
      } finally {
        pending--;
      }
    },
    clear: () => turn.clear(),
  };
  stt.onFinalize = () => {
    stt.onFinalize = () => {};
    stt.events.push({ type: "final", text: "你好", finalized: true });
  };
  const audio = new AsyncQueue<Pcm>();
  const events: string[] = [];
  const abort = new AbortController();
  const done = runEar(
    audio,
    { stt, vad: counted, turn: analyzing, clock, join: (parts) => parts.join("") },
    (event) => events.push(describeEvent(event)),
    abort.signal,
  );
  const pcm = toPcm(concat(noise(1, 60, 1), syntheticSpeech(2, 2), noise(4, 60, 3)));
  for (const f of frames(pcm)) {
    audio.push(f);
    do await settle();
    while (pending > 0);
    clock.advance(FRAME_MS);
  }
  expect(events.filter((e) => e !== "user-speaking")).toEqual([
    "user-started",
    "final 你好",
    "user-stopped 你好",
  ]);
  expect(events).toContain("user-speaking");
  audio.close();
  await stt.close();
  await done;
});
