// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/audio-silero/src/silero.ts@ce8f8bc, packages/core/src/audio/vad/vad_analyzer.ts@ce8f8bc and packages/core/src/audio/vad/vad_controller.ts@ce8f8bc
//
// Silero VAD on the call's 16 kHz audio: pipedog's analyzer state machine, and its controller's
// started and stopped edges.
import { errorText, logger } from "@eidolon/config";
import { AudioVolumeTracker, expSmoothing } from "./loudness.ts";
import { type OnnxSession, sharedSession } from "./onnx.ts";

export const VAD_SAMPLE_RATE = 16000;
export const VAD_CONFIDENCE = 0.7;
export const VAD_START_SECS = 0.2;
export const VAD_STOP_SECS = 0.2;
export const VAD_MIN_VOLUME = 0.6;

const WINDOW = 512;
const CONTEXT = 64;
const STATE_SIZE = 2 * 128;
// VAD_START_SECS and VAD_STOP_SECS in 32 ms windows: pipedog's round(6.25).
const EDGE_WINDOWS = 6;
const VOLUME_SMOOTHING = 0.2;

// Silero's recurrent state drifts during non-speech (music, long silence or noise) until it
// under-reports the speech that follows. pipedog resets it after every 2 s of audio, but only once
// the VAD is quiet and 5 windows in a row (~160 ms) scored under 0.1: a reset mid-speech makes the
// model lose confidence and can end the turn early.
const RESET_INTERVAL_SECS = 2.0;
const RESET_MAX_CONFIDENCE = 0.1;
const RESET_LOW_CONFIDENCE_WINDOWS = 5;

export type VadState = "quiet" | "starting" | "speaking" | "stopping";
export type VadEdge = "started" | "stopped";

/** What the VAD needs of the model; tests replace it. */
export interface SileroModel {
  /** Speech probability of one 512-sample window. */
  call(window: Float32Array): Promise<number>;
  resetStates(): void;
}

/** Silero on one stream: each window runs with the previous one's last 64 samples and state. */
class SileroOnnxModel implements SileroModel {
  #session: Promise<OnnxSession>;
  #state: Float32Array = new Float32Array(STATE_SIZE);
  #context = new Float32Array(CONTEXT);

  constructor(session: Promise<OnnxSession>) {
    this.#session = session;
  }

  resetStates(): void {
    this.#state = new Float32Array(STATE_SIZE);
    this.#context = new Float32Array(CONTEXT);
  }

  async call(window: Float32Array): Promise<number> {
    const joined = new Float32Array(CONTEXT + WINDOW);
    joined.set(this.#context, 0);
    joined.set(window, CONTEXT);
    const session = await this.#session;
    const out = await session.run({
      input: { type: "float32", data: joined, dims: [1, CONTEXT + WINDOW] },
      state: { type: "float32", data: this.#state, dims: [2, 1, 128] },
      sr: { type: "int64", data: BigInt64Array.of(BigInt(VAD_SAMPLE_RATE)), dims: [] },
    });
    this.#state = out[session.outputNames[1] as string]!;
    this.#context = joined.slice(joined.length - CONTEXT);
    return out[session.outputNames[0] as string]![0] as number;
  }
}

/** A call's VAD over the Silero model at `modelPath`, whose session every call shares. */
export class Vad {
  protected model: SileroModel;
  #loaded: Promise<unknown>;
  #pending = new Int16Array(0);
  #tail: Promise<unknown> = Promise.resolve();
  #volume = new AudioVolumeTracker();
  #prevVolume = 0.0;
  #state: VadState = "quiet";
  #startingCount = 0;
  #stoppingCount = 0;
  #windowsSinceReset = 0;
  #lowConfidenceWindows = 0;
  #reported: "quiet" | "speaking" = "quiet";

  constructor(modelPath: string) {
    const session = sharedSession(modelPath);
    this.model = new SileroOnnxModel(session);
    this.#loaded = session;
  }

  /** Resolves once the model has loaded; rejects when it can't. */
  ready(): Promise<void> {
    return this.#loaded.then(() => {});
  }

  /** The analyzer's state after the last complete window. */
  get state(): VadState {
    return this.#state;
  }

  /** The last window's smoothed volume, which speech must reach `VAD_MIN_VOLUME` on. */
  get volume(): number {
    return this.#prevVolume;
  }

  /** Whether the last edge was `started`. */
  get speaking(): boolean {
    return this.#reported === "speaking";
  }

  /**
   * Feeds 16 kHz audio of any length, one call at a time in order; resolves with the analyzer's
   * state after every complete window in it.
   */
  analyze(pcm: Int16Array): Promise<VadState> {
    const result = this.#tail.then(() => this.#analyze(pcm));
    this.#tail = result.catch(() => {});
    return result;
  }

  /** `analyze`, reporting only reaching SPEAKING (`started`) or QUIET (`stopped`). */
  async push(pcm: Int16Array): Promise<VadEdge | null> {
    const state = await this.analyze(pcm);
    if (state === "speaking" && this.#reported !== "speaking") {
      this.#reported = "speaking";
      return "started";
    }
    if (state === "quiet" && this.#reported !== "quiet") {
      this.#reported = "quiet";
      return "stopped";
    }
    return null;
  }

  /**
   * Reports `stopped` while speaking, for audio that stopped arriving. The analyzer keeps its
   * state, so audio that resumes as speech reports `started` again.
   */
  forceStop(): VadEdge | null {
    if (this.#reported !== "speaking") return null;
    this.#reported = "quiet";
    return "stopped";
  }

  /** Silero's confidence for one window; a run that fails logs and scores 0. */
  async voiceConfidence(window: Int16Array): Promise<number> {
    // A model that can't load is the caller's error, not a quiet window.
    await this.#loaded;
    try {
      const audio = new Float32Array(window.length);
      for (let i = 0; i < window.length; i++) audio[i] = (window[i] as number) / 32768.0;
      const confidence = await this.model.call(audio);
      this.#maybeResetModel(confidence);
      return confidence;
    } catch (e) {
      logger.error(`Error analyzing audio with Silero VAD: ${errorText(e)}`);
      return 0;
    }
  }

  async #analyze(pcm: Int16Array): Promise<VadState> {
    const combined = new Int16Array(this.#pending.length + pcm.length);
    combined.set(this.#pending, 0);
    combined.set(pcm, this.#pending.length);
    this.#pending = combined;
    if (this.#pending.length < WINDOW) return this.#state;

    while (this.#pending.length >= WINDOW) {
      const window = this.#pending.slice(0, WINDOW);
      this.#pending = this.#pending.subarray(WINDOW);
      this.#update(window, await this.voiceConfidence(window));
    }

    if (this.#state === "starting" && this.#startingCount >= EDGE_WINDOWS) {
      this.#state = "speaking";
      this.#startingCount = 0;
    }
    if (this.#state === "stopping" && this.#stoppingCount >= EDGE_WINDOWS) {
      this.#state = "quiet";
      this.#stoppingCount = 0;
    }
    return this.#state;
  }

  #update(window: Int16Array, confidence: number): void {
    this.#volume.update(window, VAD_SAMPLE_RATE);
    const volume = expSmoothing(this.#volume.volume, this.#prevVolume, VOLUME_SMOOTHING);
    this.#prevVolume = volume;

    if (confidence >= VAD_CONFIDENCE && volume >= VAD_MIN_VOLUME) {
      switch (this.#state) {
        case "quiet":
          this.#state = "starting";
          this.#startingCount = 1;
          break;
        case "starting":
          this.#startingCount += 1;
          break;
        case "stopping":
          this.#state = "speaking";
          this.#stoppingCount = 0;
          break;
      }
    } else {
      switch (this.#state) {
        case "starting":
          this.#state = "quiet";
          this.#startingCount = 0;
          break;
        case "speaking":
          this.#state = "stopping";
          this.#stoppingCount = 1;
          break;
        case "stopping":
          this.#stoppingCount += 1;
          break;
      }
    }
  }

  // Runs before #update, so the state is still the one from before this window, as in pipedog.
  #maybeResetModel(confidence: number): void {
    this.#windowsSinceReset += 1;
    if (confidence < RESET_MAX_CONFIDENCE) {
      this.#lowConfidenceWindows += 1;
    } else {
      this.#lowConfidenceWindows = 0;
    }
    if (
      this.#windowsSinceReset * WINDOW >= RESET_INTERVAL_SECS * VAD_SAMPLE_RATE &&
      this.#state === "quiet" &&
      this.#lowConfidenceWindows >= RESET_LOW_CONFIDENCE_WINDOWS
    ) {
      this.model.resetStates();
      this.#windowsSinceReset = 0;
    }
  }
}
