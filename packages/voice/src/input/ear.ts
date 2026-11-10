// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/core/src/audio/vad/vad_controller.ts@ce8f8bc, packages/core/src/processors/aggregators/llm_response_universal.ts@ce8f8bc and packages/core/src/audio/resamplers/soxr_stream_resampler.ts@ce8f8bc
//
// A call's hearing: every 20 ms frame goes to the recognizer at once, and in order through the
// VAD and Smart Turn, whose verdicts and the transcripts become the caller's turns.
import { logger } from "@eidolon/config";
import type { SttStream } from "@eidolon/providers/stt";
import { resampler } from "../dsp/resampler/index.ts";
import type { Clock, EarEvent, JoinSegments, Pcm } from "../types.ts";
import type { SmartTurn } from "./smart_turn.ts";
import { TurnDetector } from "./turn.ts";
import { VAD_SAMPLE_RATE, type Vad } from "./vad.ts";

/** No audio for this long while the VAD hears speech (a muted mic) is the end of the speech. */
const AUDIO_IDLE_MS = 1_000;
const SPEECH_ACTIVITY_MS = 200;
// pipedog's stream resampler forgets its history after this long without audio.
const RESAMPLER_CLEAR_MS = 200;

export interface EarDeps {
  readonly stt: SttStream;
  readonly vad: Pick<Vad, "push" | "forceStop" | "speaking">;
  readonly turn: Pick<SmartTurn, "append" | "analyze" | "clear">;
  readonly clock: Clock;
  readonly join: JoinSegments;
}

/**
 * Hears `audio` (16 kHz) and the recognizer's transcripts until both end or `signal` aborts,
 * posting the caller's turns. Rejects when the VAD or Smart Turn fails.
 */
export async function runEar(
  audio: AsyncIterable<Pcm>,
  deps: EarDeps,
  post: (event: EarEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const ear = new Ear(deps, post);
  const onAbort = () => ear.stop(null);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    await ear.run(audio);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

class Ear {
  readonly #deps: EarDeps;
  readonly #post: (event: EarEvent) => void;
  readonly #detector: TurnDetector;
  readonly #toStt: SttSender;
  #stopped = false;
  readonly #ended: Promise<void>;
  #end: (error: unknown) => void = () => {};
  /** Frames and VAD stops, one at a time, as pipedog's aggregator takes its system frames. */
  #frames: Promise<void> = Promise.resolve();
  /** When the latest frame arrived, though the VAD may not have reached it yet. */
  #lastAudio = 0;
  #cancelIdle: (() => void) | null = null;
  #lastActivity = Number.NEGATIVE_INFINITY;

  constructor(deps: EarDeps, post: (event: EarEvent) => void) {
    this.#deps = deps;
    this.#ended = new Promise<void>((resolve, reject) => {
      this.#end = (error) => (error === null ? resolve() : reject(error));
    });
    this.#post = post;
    this.#detector = new TurnDetector({
      clock: deps.clock,
      ttfsP99: deps.stt.ttfsP99,
      join: deps.join,
      post,
      clearAnalyzer: () => deps.turn.clear(),
    });
    this.#toStt = sttSender(deps.stt, deps.clock);
  }

  async run(audio: AsyncIterable<Pcm>): Promise<void> {
    try {
      await Promise.race([Promise.all([this.#listen(audio), this.#transcripts()]), this.#ended]);
    } finally {
      this.#stopped = true;
      this.#cancelIdle?.();
      this.#cancelIdle = null;
      this.#detector.close();
      this.#toStt.close();
    }
  }

  /** Stops hearing at once: `null` on the call's end, else what failed. */
  stop(error: unknown): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#end(error);
  }

  async #listen(audio: AsyncIterable<Pcm>): Promise<void> {
    const { clock } = this.#deps;
    for await (const pcm of audio) {
      if (this.#stopped) return;
      this.#lastAudio = clock.now();
      this.#cancelIdle ??= clock.setTimer(AUDIO_IDLE_MS, () => this.#audioIdle());
      this.#toStt.send(pcm);
      this.#enqueue(() => this.#hear(pcm));
    }
    await this.#frames;
  }

  async #transcripts(): Promise<void> {
    for await (const event of this.#deps.stt.events) {
      if (this.#stopped) return;
      switch (event.type) {
        case "interim":
          this.#detector.interim(event.text);
          break;
        case "final":
          this.#detector.final(event.text, event.finalized);
          break;
        case "finalized":
          break;
        case "error":
          this.#post({ type: "stt-error", message: event.message, fatal: event.fatal });
          break;
      }
    }
  }

  #enqueue(step: () => Promise<void>): void {
    this.#frames = this.#frames
      .then(() => (this.#stopped ? undefined : step()))
      .catch((error: unknown) => this.stop(error));
  }

  async #hear(pcm: Pcm): Promise<void> {
    const { vad, turn, clock } = this.#deps;
    const edge = await vad.push(pcm);
    if (this.#stopped) return;
    // pipedog queues the VAD's edge behind the frame that made it, so Smart Turn gets that frame
    // with the speaking state from before the edge.
    if (turn.append(pcm, this.#detector.vadSpeaking) === "complete") {
      this.#detector.silenceComplete();
    }
    if (edge === "started") this.#detector.speechStarted();
    if (vad.speaking && clock.now() - this.#lastActivity >= SPEECH_ACTIVITY_MS) {
      this.#lastActivity = clock.now();
      this.#post({ type: "user-speaking" });
    }
    if (edge === "stopped") await this.#speechStopped();
  }

  async #speechStopped(): Promise<void> {
    this.#deps.stt.finalize();
    this.#detector.speechStopped();
    const { state } = await this.#deps.turn.analyze();
    if (!this.#stopped) this.#detector.analyzed(state);
  }

  #audioIdle(): void {
    this.#cancelIdle = null;
    const { clock, vad } = this.#deps;
    const remaining = this.#lastAudio + AUDIO_IDLE_MS - clock.now();
    if (remaining > 0) {
      this.#cancelIdle = clock.setTimer(remaining, () => this.#audioIdle());
      return;
    }
    // In line behind the frames that came before the gap, so the stop follows what the VAD made
    // of them; audio that came while they were heard means the mic is back.
    this.#enqueue(async () => {
      if (clock.now() - this.#lastAudio < AUDIO_IDLE_MS || vad.forceStop() !== "stopped") return;
      logger.warning("VAD: no audio received while speaking, forcing speech stop");
      await this.#speechStopped();
    });
  }
}

interface SttSender {
  send(pcm: Pcm): void;
  close(): void;
}

/** Sends 16 kHz frames at the recognizer's own rate, or a realtime session's. */
export function sttSender(
  stt: { readonly inputRate: number; send(pcm: Pcm): void },
  clock: Clock,
): SttSender {
  if (stt.inputRate === VAD_SAMPLE_RATE) return { send: (pcm) => stt.send(pcm), close: () => {} };
  const stream = resampler().createStream(VAD_SAMPLE_RATE, stt.inputRate);
  let last = Number.NEGATIVE_INFINITY;
  return {
    send(pcm) {
      const now = clock.now();
      if (now - last > RESAMPLER_CLEAR_MS) stream.reset();
      last = now;
      const out = stream.processSamples(pcm);
      if (out.length > 0) stt.send(out);
    },
    close: () => stream.destroy(),
  };
}
