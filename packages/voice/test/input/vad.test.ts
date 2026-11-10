// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/audio-silero/test/test_silero_vad.test.ts@ce8f8bc
//
// The port runs 16 kHz only, so the 8 kHz cases run at 16 kHz, and its typed input has no
// dimensions to get wrong. The repository keeps no audio: syntheticSpeech stands in for the Kokoro
// clip, at its level.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type SileroModel, Vad, type VadState } from "../../src/input/vad.ts";
import {
  concat,
  frames,
  mulberry32,
  SAMPLE_RATE,
  SILERO_MODEL,
  syntheticSpeech,
  toPcm,
} from "./speech.ts";

// 20 ms, the frame size transports deliver.
const FRAME_SECS = 0.02;
const LONG = 300_000;

/** The member the upstream tests reach into. */
interface VadInternals {
  model: SileroModel;
}

/** A seeded generator with numpy-like `normal` and `choice`. */
class Rng {
  #uniform: () => number;
  #spare: number | null = null;

  constructor(seed: number) {
    this.#uniform = mulberry32(seed);
  }

  uniform(): number {
    return this.#uniform();
  }

  #standardNormal(): number {
    if (this.#spare !== null) {
      const s = this.#spare;
      this.#spare = null;
      return s;
    }
    const u1 = Math.max(this.uniform(), Number.MIN_VALUE);
    const u2 = this.uniform();
    const r = Math.sqrt(-2 * Math.log(u1));
    this.#spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  }

  normal(mean: number, std: number, n: number): Float64Array {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = mean + std * this.#standardNormal();
    return out;
  }

  choice<T>(xs: readonly T[]): T {
    return xs[Math.min(xs.length - 1, Math.floor(this.uniform() * xs.length))] as T;
  }
}

function scale(x: Float64Array, k: number): Float64Array {
  return x.map((v) => v * k);
}

function add(a: Float64Array, b: Float64Array): Float64Array {
  expect(a.length).toEqual(b.length);
  return a.map((v, i) => v + (b[i] as number));
}

function tile(x: Float64Array, reps: number): Float64Array {
  return concat(...Array.from({ length: reps }, () => x));
}

function rms(x: Float64Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

/** In-place radix-2 complex FFT (`n` a power of two). */
function fftPow2(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = (re[b] as number) * cr - (im[b] as number) * ci;
        const xi = (re[b] as number) * ci + (im[b] as number) * cr;
        re[b] = (re[a] as number) - xr;
        im[b] = (im[a] as number) - xi;
        re[a] = (re[a] as number) + xr;
        im[a] = (im[a] as number) + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Complex DFT of any length (Bluestein), unnormalized; `inverse` flips the sign only. */
function dft(re: Float64Array, im: Float64Array, inverse: boolean): [Float64Array, Float64Array] {
  const n = re.length;
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const sign = inverse ? 1 : -1;
  const cr = new Float64Array(n);
  const ci = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const ang = (sign * Math.PI * ((k * k) % (2 * n))) / n;
    cr[k] = Math.cos(ang);
    ci[k] = Math.sin(ang);
  }
  const ar = new Float64Array(m);
  const ai = new Float64Array(m);
  for (let k = 0; k < n; k++) {
    ar[k] = (re[k] as number) * (cr[k] as number) - (im[k] as number) * (ci[k] as number);
    ai[k] = (re[k] as number) * (ci[k] as number) + (im[k] as number) * (cr[k] as number);
  }
  const br = new Float64Array(m);
  const bi = new Float64Array(m);
  br[0] = cr[0] as number;
  bi[0] = -(ci[0] as number);
  for (let k = 1; k < n; k++) {
    br[k] = br[m - k] = cr[k] as number;
    bi[k] = bi[m - k] = -(ci[k] as number);
  }
  fftPow2(ar, ai, false);
  fftPow2(br, bi, false);
  for (let k = 0; k < m; k++) {
    const r = (ar[k] as number) * (br[k] as number) - (ai[k] as number) * (bi[k] as number);
    ai[k] = (ar[k] as number) * (bi[k] as number) + (ai[k] as number) * (br[k] as number);
    ar[k] = r;
  }
  fftPow2(ar, ai, true);
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const xr = (ar[k] as number) / m;
    const xi = (ai[k] as number) / m;
    outRe[k] = xr * (cr[k] as number) - xi * (ci[k] as number);
    outIm[k] = xr * (ci[k] as number) + xi * (cr[k] as number);
  }
  return [outRe, outIm];
}

describe("TestSileroVAD", () => {
  let vad: Vad;

  beforeAll(async () => {
    vad = new Vad(SILERO_MODEL);
    await vad.ready();
  });

  test("test_voice_confidence_silence", async () => {
    const confidence = await vad.voiceConfidence(new Int16Array(512));
    expect(confidence).toBeGreaterThanOrEqual(0.0);
    expect(confidence).toBeLessThanOrEqual(1.0);
    // Silence should not be confidently classified as speech.
    expect(confidence).toBeLessThan(0.5);
  });

  test("test_voice_confidence_conversion_matches_expected", async () => {
    // The int16->float32 conversion feeds the model the expected values.
    const samples = Int16Array.from([0, 16384, -32768, 32767]);
    const internals = vad as unknown as VadInternals;
    const originalModel = internals.model;
    let captured: Float32Array | undefined;
    internals.model = {
      async call(audio) {
        captured = audio;
        return originalModel.call(new Float32Array(512));
      },
      resetStates: () => originalModel.resetStates(),
    };
    try {
      await vad.voiceConfidence(samples);
    } finally {
      internals.model = originalModel;
    }
    expect(captured).toEqual(Float32Array.from(samples, (s) => s / 32768.0));
  });
});

describe("TestSileroVADLongStreams", () => {
  // Silero VAD over long streams, where the model's recurrent state persists.
  let speech: Float64Array;
  let rng: Rng;
  let vad: Vad;
  let position: number;
  let resetPositions: number[];

  beforeAll(() => {
    speech = syntheticSpeech(6.4, 1);
  });

  beforeEach(() => {
    rng = new Rng(0);
    startStream();
  });

  /** Start a fresh VAD, like a new audio stream, recording where in the audio it resets the model. */
  function startStream(): void {
    vad = new Vad(SILERO_MODEL);
    position = 0.0;
    resetPositions = [];
    const model = (vad as unknown as VadInternals).model;
    const resetStates = model.resetStates.bind(model);
    model.resetStates = () => {
      resetPositions.push(position);
      resetStates();
    };
  }

  function noise(seconds: number, std: number): Float64Array {
    return rng.normal(0, std, Math.trunc(seconds * SAMPLE_RATE));
  }

  /** Noise weighted toward low frequencies, like room and line noise. */
  function pinkNoise(seconds: number, targetRms: number): Float64Array {
    const samples = Math.trunc(seconds * SAMPLE_RATE);
    const white = rng.normal(0, 1, samples);
    const [re, im] = dft(white, new Float64Array(samples), false);
    // rfftfreq, with frequencies[0] = frequencies[1]; negative-frequency bins
    // mirror the positive ones, so the inverse transform stays real.
    for (let k = 0; k < samples; k++) {
      const bin = Math.max(1, Math.min(k, samples - k));
      const w = 1 / Math.sqrt((bin * SAMPLE_RATE) / samples);
      re[k] = (re[k] as number) * w;
      im[k] = (im[k] as number) * w;
    }
    const [pr] = dft(re, im, true);
    const pink = pr.map((v) => v / samples);
    return scale(pink, targetRms / rms(pink));
  }

  /** Synthesized music: plucked notes over a sustained chord. */
  function music(seconds: number): Float64Array {
    const samples = Math.trunc(seconds * SAMPLE_RATE);
    const notes = new Float64Array(samples);
    const noteSamples = Math.trunc(0.25 * SAMPLE_RATE);
    for (let start = 0; start < samples; start += noteSamples) {
      const len = Math.min(noteSamples, samples - start);
      const frequency = rng.choice([261.6, 293.7, 329.6, 392.0, 440.0, 523.3]);
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        let harmonics = 0;
        for (let h = 1; h < 6; h++) harmonics += Math.sin(2 * Math.PI * frequency * h * t) / h;
        notes[start + i] = harmonics * Math.exp(-6 * t);
      }
    }
    const out = new Float64Array(samples);
    let peak = 0;
    for (let i = 0; i < samples; i++) {
      const t = i / SAMPLE_RATE;
      let chord = 0;
      for (const f of [130.8, 164.8, 196.0]) chord += Math.sin(2 * Math.PI * f * t);
      out[i] = (notes[i] as number) + 0.3 * chord;
      peak = Math.max(peak, Math.abs(out[i] as number));
    }
    return scale(out, 6000 / peak);
  }

  /** Share of frames from `start` seconds on that the VAD reports as speech. */
  function speakingShare(states: VadState[], start: number): number {
    const after = states.slice(Math.trunc(start / FRAME_SECS));
    return after.filter((s) => s === "speaking").length / after.length;
  }

  /** Feeds audio in transport-sized frames; the VAD state after each. */
  async function analyze(audio: Float64Array): Promise<VadState[]> {
    const states: VadState[] = [];
    let start = 0;
    for (const frame of frames(toPcm(audio))) {
      position = start / SAMPLE_RATE;
      states.push(await vad.analyze(frame));
      start += frame.length;
    }
    return states;
  }

  test(
    "test_detects_speech_after_minutes_of_background_sound",
    async () => {
      // Quiet speech is still detected after minutes of room tone or noise.
      //
      // A model whose state drifts during non-speech loses confidence in the
      // speech that follows, which shows first on quiet speech.
      const quietSpeech = scale(speech, 0.15);
      const backgrounds: Record<string, (seconds: number) => Float64Array> = {
        "room tone": (seconds) => noise(seconds, 60),
        "pink noise": (seconds) => pinkNoise(seconds, 200),
      };
      for (const [name, background] of Object.entries(backgrounds)) {
        startStream();
        const leadIn = background(120);
        const speechWithBg = add(quietSpeech, background(quietSpeech.length / SAMPLE_RATE));

        const states = await analyze(concat(leadIn, speechWithBg));

        const speaking = speakingShare(states, leadIn.length / SAMPLE_RATE);
        expect(
          speaking,
          `VAD missed speech after 2 minutes of ${name}: ${Math.round(speaking * 100)}%`,
        ).toBeGreaterThan(0.8);
      }
    },
    LONG,
  );

  test(
    "test_detects_speech_after_music",
    async () => {
      // Quiet speech is still detected shortly after a minute of music, which
      // leaves the model unable to detect the speech that follows until its
      // state is reset.
      const leadIn = concat(music(60), noise(2.5, 60));

      const states = await analyze(concat(leadIn, scale(speech, 0.15)));

      const speaking = speakingShare(states, leadIn.length / SAMPLE_RATE);
      expect(
        speaking,
        `VAD missed speech after music: ${Math.round(speaking * 100)}%`,
      ).toBeGreaterThan(0.8);
    },
    LONG,
  );

  test(
    "test_sustained_speech_has_no_false_stops",
    async () => {
      // Minutes of uninterrupted speech over background noise never end early.
      const looped = tile(speech, 30); // ~3 minutes
      const signalRms = rms(looped);
      const noisy = add(looped, rng.normal(0, signalRms / Math.sqrt(10), looped.length)); // 10 dB SNR

      const states = await analyze(noisy);

      expect(states.indexOf("speaking")).toBeGreaterThanOrEqual(0);
      const afterStart = states.slice(states.indexOf("speaking"));
      expect(
        afterStart.includes("quiet"),
        "VAD reported the speaker stopping during continuous speech",
      ).toBe(false);
    },
    LONG,
  );

  test(
    "test_model_is_reset_during_non_speech",
    async () => {
      // The model is reset about every two seconds while there's no speech.
      await analyze(noise(30, 300));

      expect(
        resetPositions.length >= 12 && resetPositions.length <= 15,
        `expected a reset about every 2s over 30s, got ${resetPositions.length}`,
      ).toBe(true);
      const spacing = resetPositions.slice(1).map((p, i) => p - (resetPositions[i] as number));
      expect(Math.min(...spacing)).toBeGreaterThanOrEqual(2.0);
    },
    LONG,
  );

  test(
    "test_model_is_never_reset_during_speech",
    async () => {
      // A minute of uninterrupted speech gets no resets, and resets resume after it.
      const looped = tile(speech, 10); // ~1 minute
      const speechStart = 10.0;
      const speechEnd = speechStart + looped.length / SAMPLE_RATE;

      await analyze(concat(noise(speechStart, 60), looped, noise(10, 60)));

      const duringSpeech = resetPositions.filter((p) => speechStart <= p && p <= speechEnd);
      expect(duringSpeech, "model was reset during speech").toEqual([]);
      expect(resetPositions.some((p) => p > speechEnd)).toBe(true);
    },
    LONG,
  );
});

describe("edges", () => {
  test("speech reports started then stopped, and only once each", async () => {
    const vad = new Vad(SILERO_MODEL);
    const audio = toPcm(
      concat(new Float64Array(SAMPLE_RATE), syntheticSpeech(3, 2), new Float64Array(SAMPLE_RATE)),
    );
    const edges: string[] = [];
    for (const frame of frames(audio)) {
      const edge = await vad.push(frame);
      if (edge) edges.push(edge);
      if (edge === "started") expect(vad.speaking).toBe(true);
    }
    expect(edges).toEqual(["started", "stopped"]);
    expect(vad.speaking).toBe(false);
  });

  test("audio that stops arriving mid-speech stops it, and speech after starts it again", async () => {
    const vad = new Vad(SILERO_MODEL);
    const speech = [...frames(toPcm(concat(new Float64Array(8000), syntheticSpeech(3, 3))))];
    let edge = null;
    for (const frame of speech.slice(0, 75)) edge = (await vad.push(frame)) ?? edge;
    expect(edge).toBe("started");
    expect(vad.forceStop()).toBe("stopped");
    expect(vad.forceStop()).toBeNull();
    expect(vad.state).toBe("speaking");

    edge = null;
    for (const frame of speech.slice(75)) edge = (await vad.push(frame)) ?? edge;
    expect(edge).toBe("started");
  });

  test("pushes not awaited are analyzed one at a time, in order", async () => {
    const audio = toPcm(concat(new Float64Array(8000), syntheticSpeech(2, 4)));
    const serial = new Vad(SILERO_MODEL);
    const expected: VadState[] = [];
    for (const frame of frames(audio)) expected.push(await serial.analyze(frame));

    const concurrent = new Vad(SILERO_MODEL);
    const states = await Promise.all([...frames(audio)].map((frame) => concurrent.analyze(frame)));
    expect(states).toEqual(expected);
  });

  test("a model that can't load rejects", async () => {
    const vad = new Vad("/nonexistent/silero_vad.onnx");
    await expect(vad.ready()).rejects.toThrow();
    await expect(vad.push(new Int16Array(512))).rejects.toThrow();
  });
});
