// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/core/src/audio/turn/smart_turn/base_smart_turn.ts@ce8f8bc and packages/core/src/audio/turn/smart_turn/local_smart_turn_v3.ts@ce8f8bc
//
// Smart Turn v3: whether the caller has finished their turn, judged from the last 8 s of the
// 16 kHz audio around their speech.
import { logger } from "@eidolon/config";
import type { Clock } from "../types.ts";
import { sharedSession } from "./onnx.ts";
import { VAD_SAMPLE_RATE, VAD_START_SECS } from "./vad.ts";
import {
  computeWhisperLogMelFeatures,
  WHISPER_NUM_FRAMES,
  WHISPER_NUM_MELS,
} from "./whisper_features.ts";

/** Silence after speech that ends the turn without asking the model. */
export const STOP_SECS = 3;
export const PRE_SPEECH_MS = 500;
export const MAX_DURATION_SECONDS = 8;

export type EndOfTurn = "complete" | "incomplete";

export interface TurnPrediction {
  readonly state: EndOfTurn;
  /** The model's probability of COMPLETE; null when there was no audio to ask it about. */
  readonly probability: number | null;
}

const performanceClock: Pick<Clock, "now"> = { now: () => performance.now() };

/** The last `seconds` of `audio`, zero-padded at the front to exactly that long. */
function lastSeconds(audio: Float32Array, seconds: number): Float32Array {
  const maxSamples = seconds * VAD_SAMPLE_RATE;
  if (audio.length > maxSamples) return audio.slice(audio.length - maxSamples);
  if (audio.length < maxSamples) {
    const padded = new Float32Array(maxSamples);
    padded.set(audio, maxSamples - audio.length);
    return padded;
  }
  return audio;
}

/**
 * One call's turn analyzer over the Smart Turn model at `modelPath`, whose session every call
 * shares. `clock` stamps each chunk of audio as it arrives.
 */
export class SmartTurn {
  protected buffer: [number, Int16Array][] = [];
  #modelPath: string;
  #clock: Pick<Clock, "now">;
  #speechTriggered = false;
  #silenceMs = 0;
  #speechStart: number | null = null;

  constructor(modelPath: string, clock: Pick<Clock, "now"> = performanceClock) {
    this.#modelPath = modelPath;
    this.#clock = clock;
  }

  /** Whether speech has been heard since the turn was last cleared. */
  get speechTriggered(): boolean {
    return this.#speechTriggered;
  }

  /**
   * Buffers a chunk, `isSpeech` while the VAD reports speaking. `complete` (clearing the buffer)
   * once `STOP_SECS` of silence follow speech; before any speech, keeps only the audio the segment
   * could still need.
   */
  append(pcm: Int16Array, isSpeech: boolean): EndOfTurn {
    this.buffer.push([this.#seconds(), pcm.slice()]);

    if (isSpeech) {
      this.#silenceMs = 0;
      this.#speechTriggered = true;
      this.#speechStart ??= this.#seconds();
    } else if (this.#speechTriggered) {
      this.#silenceMs += pcm.length / (VAD_SAMPLE_RATE / 1000);
      if (this.#silenceMs >= STOP_SECS * 1000) {
        logger.debug(`End of Turn complete due to stop_secs. Silence in ms: ${this.#silenceMs}`);
        this.#clear("complete");
        return "complete";
      }
    } else {
      const maxBufferTime = PRE_SPEECH_MS / 1000 + STOP_SECS + MAX_DURATION_SECONDS;
      while (
        this.buffer.length > 0 &&
        (this.buffer[0] as [number, Int16Array])[0] < this.#seconds() - maxBufferTime
      ) {
        this.buffer.shift();
      }
    }
    return "incomplete";
  }

  /**
   * Asks the model about the segment buffered so far, from `PRE_SPEECH_MS` plus the VAD's start
   * delay before speech began; `complete` clears the turn. Audio appended while the model runs is
   * left out of the segment.
   */
  async analyze(): Promise<TurnPrediction> {
    const segment = this.#segment();
    let result: TurnPrediction = { state: "incomplete", probability: null };
    if (segment !== null) {
      const probability = await this.predict(segment);
      result = { state: probability > 0.5 ? "complete" : "incomplete", probability };
    }
    if (result.state === "complete") this.#clear("complete");
    logger.debug(`End of Turn result: ${result.state} (${result.probability})`);
    return result;
  }

  /** Forgets the turn, as when it has ended elsewhere. */
  clear(): void {
    this.#clear("complete");
  }

  /** The model's probability that the turn is complete, from 16 kHz audio of any length. */
  protected async predict(audio: Float32Array): Promise<number> {
    const session = await sharedSession(this.#modelPath);
    const features = computeWhisperLogMelFeatures(lastSeconds(audio, 8), { doNormalize: true });
    const out = await session.run({
      input_features: {
        type: "float32",
        data: features,
        dims: [1, WHISPER_NUM_MELS, WHISPER_NUM_FRAMES],
      },
    });
    return Number(out[session.outputNames[0] as string]![0]);
  }

  #seconds(): number {
    return this.#clock.now() / 1000;
  }

  #clear(state: EndOfTurn): void {
    // An incomplete turn is still the caller's, so speech stays triggered.
    this.#speechTriggered = state === "incomplete";
    this.buffer = [];
    this.#speechStart = null;
    this.#silenceMs = 0;
  }

  #segment(): Float32Array | null {
    if (this.buffer.length === 0) return null;
    const preSpeechMs = PRE_SPEECH_MS + VAD_START_SECS * 1000;
    const startTime = (this.#speechStart ?? 0) - preSpeechMs / 1000;
    let startIndex = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      if ((this.buffer[i] as [number, Int16Array])[0] >= startTime) {
        startIndex = i;
        break;
      }
    }

    const chunks = this.buffer.slice(startIndex).map(([, chunk]) => chunk);
    let segment = new Float32Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) {
        segment[offset + i] = (chunk[i] as number) / 32768.0;
      }
      offset += chunk.length;
    }

    const maxSamples = Math.trunc(MAX_DURATION_SECONDS * VAD_SAMPLE_RATE);
    if (segment.length > maxSamples) segment = segment.slice(segment.length - maxSamples);
    return segment.length > 0 ? segment : null;
  }
}
