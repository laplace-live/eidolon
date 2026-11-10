// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/core/src/audio/volume.ts@ce8f8bc and packages/core/src/audio/utils.ts@ce8f8bc
//
// How loud the caller is: ITU-R BS.1770 integrated loudness over the last 400 ms, which the VAD
// requires of speech alongside Silero's confidence.

/** One BS.1770 gating block: shorter chunks accumulate into a rolling window this long. */
export const VOLUME_WINDOW_SECS = 0.4;

/**
 * The volume of a mono stream over its last `VOLUME_WINDOW_SECS`: 0 until the window is full,
 * measured on read and cached until more audio arrives, and discarded when the rate changes.
 */
export class AudioVolumeTracker {
  protected buffer: Int16Array = new Int16Array(0);
  #sampleRate = 0;
  #windowSamples = 0;
  // null once the window holds audio that hasn't been measured yet.
  #volume: number | null = 0.0;

  /** Between 0 (quiet) and 1 (loud). */
  get volume(): number {
    if (this.#volume === null) {
      this.#volume = calculateAudioVolume(this.buffer, this.#sampleRate);
    }
    return this.#volume;
  }

  update(pcm: Int16Array, sampleRate: number): void {
    if (sampleRate !== this.#sampleRate) {
      this.#sampleRate = sampleRate;
      // Rounded up: a window a sample short of a gating block can't be measured.
      this.#windowSamples = Math.ceil(VOLUME_WINDOW_SECS * sampleRate);
      this.reset();
    }

    const combined = new Int16Array(this.buffer.length + pcm.length);
    combined.set(this.buffer, 0);
    combined.set(pcm, this.buffer.length);
    this.buffer =
      combined.length > this.#windowSamples
        ? combined.slice(combined.length - this.#windowSamples)
        : combined;
    if (this.buffer.length === this.#windowSamples) {
      this.#volume = null;
    }
  }

  reset(): void {
    this.buffer = new Int16Array(0);
    this.#volume = 0.0;
  }
}

/** `value` mapped from [min, max] onto [0, 1], clamped. */
export function normalizeValue(value: number, minValue: number, maxValue: number): number {
  const normalized = (value - minValue) / (maxValue - minValue);
  return Math.max(0, Math.min(1, normalized));
}

/** `prevValue` moved `factor` of the way toward `value`. */
export function expSmoothing(value: number, prevValue: number, factor: number): number {
  return prevValue + factor * (value - prevValue);
}

type Biquad = { b: [number, number, number]; a: [number, number, number] };

// K-weighting for any sample rate, from the analog prototype libebur128 and pyloudnorm use.
function kWeightingFilters(rate: number): [Biquad, Biquad] {
  // Stage 1: high shelf.
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / rate);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b: [
      (Vh + (Vb * K) / Q + K * K) / a0,
      (2 * (K * K - Vh)) / a0,
      (Vh - (Vb * K) / Q + K * K) / a0,
    ],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  };
  // Stage 2: high pass (RLB).
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / rate);
  a0 = 1 + K / Q + K * K;
  const highPass: Biquad = {
    b: [1, -2, 1],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  };
  return [shelf, highPass];
}

function applyBiquad(input: Float64Array, { b, a }: Biquad): Float64Array {
  const out = new Float64Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i] as number;
    const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

function integratedLoudness(samples: Float64Array, rate: number): number {
  const blockSize = 0.4;
  const blockLength = Math.round(blockSize * rate);
  if (samples.length < blockLength) {
    throw new Error("Audio must have length greater than the block size.");
  }
  const [shelf, highPass] = kWeightingFilters(rate);
  const filtered = applyBiquad(applyBiquad(samples, shelf), highPass);

  // 400 ms gating blocks with 75% overlap.
  const step = blockSize * 0.25;
  const numBlocks = Math.round((samples.length / rate - blockSize) / step) + 1;
  const z: number[] = [];
  for (let j = 0; j < numBlocks; j++) {
    const lower = Math.trunc(blockSize * (j * 0.25) * rate);
    const upper = Math.min(Math.trunc(blockSize * (j * 0.25 + 1) * rate), filtered.length);
    let sum = 0;
    for (let i = lower; i < upper; i++) {
      const v = filtered[i] as number;
      sum += v * v;
    }
    z.push(sum / (blockSize * rate));
  }
  const blockLoudness = (zj: number) => -0.691 + 10 * Math.log10(zj);

  // Absolute gate.
  const gammaA = -70.0;
  const aboveAbs = z.filter((zj) => blockLoudness(zj) >= gammaA);
  if (aboveAbs.length === 0) return Number.NEGATIVE_INFINITY;
  const meanAbs = aboveAbs.reduce((s, v) => s + v, 0) / aboveAbs.length;

  // Relative gate.
  const gammaR = blockLoudness(meanAbs) - 10.0;
  const aboveRel = z.filter((zj) => blockLoudness(zj) > gammaR && blockLoudness(zj) > gammaA);
  if (aboveRel.length === 0) return Number.NEGATIVE_INFINITY;
  const meanRel = aboveRel.reduce((s, v) => s + v, 0) / aboveRel.length;
  return -0.691 + 10 * Math.log10(meanRel);
}

/**
 * BS.1770 loudness of at least one gating block (400 ms) of audio, normalized from −110..−10
 * LUFS to 0..1; audio under the absolute gate reads 0. Throws on less than a block.
 */
export function calculateAudioVolume(pcm: Int16Array, sampleRate: number): number {
  const samples = new Float64Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    samples[i] = Math.fround((pcm[i] as number) / 32768.0);
  }
  return normalizeValue(integratedLoudness(samples, sampleRate), -110, -10);
}
