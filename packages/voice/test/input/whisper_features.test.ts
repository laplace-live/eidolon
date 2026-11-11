// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/core/test/test_local_smart_turn_v3_features.test.ts@ce8f8bc
//
// Upstream compares against transformers' WhisperFeatureExtractor, which has no JS counterpart, so
// those comparisons stay skipped as they are upstream; the shape checks they made run here.
import { describe, expect, test } from "bun:test";
import {
  computeWhisperLogMelFeatures,
  WHISPER_NUM_FRAMES,
  WHISPER_NUM_MELS,
} from "../../src/input/whisper_features.ts";

interface ReferenceExtractor {
  /** `_np_extract_fbank_features(x[np.newaxis, :], device="cpu")[0]`, row-major (80, 800). */
  npExtractFbankFeatures(x: Float32Array): Float32Array;
  /** Public `__call__(...).input_features.squeeze(0)`, row-major (80, 800). */
  call(audio: Float32Array, options: { doNormalize: boolean }): Float32Array;
}
const referenceExtractor: ReferenceExtractor | undefined = undefined;
const SKIP_REASON = "transformers (WhisperFeatureExtractor reference) is not available in JS";
const maybeTest = referenceExtractor ? test : test.skip;

const N_SAMPLES = 128_000; // 8 seconds at 16 kHz

// Seeded standard-normal generator (stands in for np.random.default_rng(0xC0FFEE)).
function standardNormal(n: number, seed: number): Float64Array {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    const u1 = Math.max(next(), Number.MIN_VALUE);
    const u2 = next();
    const r = Math.sqrt(-2 * Math.log(u1));
    out[i] = r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  return out;
}

function silence(): Float32Array {
  return new Float32Array(N_SAMPLES);
}

function noise(): Float32Array {
  const g = standardNormal(N_SAMPLES, 0xc0ffee);
  return Float32Array.from(g, (v) => v * 0.1);
}

function sweep(): Float32Array {
  const out = new Float32Array(N_SAMPLES);
  for (let i = 0; i < N_SAMPLES; i++) {
    const t = Math.fround((8 * i) / N_SAMPLES);
    out[i] = 0.5 * Math.sin(2 * Math.PI * (200 + ((4000 - 200) * t) / 8) * t);
  }
  return out;
}

function partial(): Float32Array {
  const g = standardNormal(8_000, 0xc0ffee);
  const out = new Float32Array(128_000);
  for (let i = 0; i < 8_000; i++) out[120_000 + i] = (g[i] as number) * 0.1;
  return out;
}

const FIXTURES: Array<[string, () => Float32Array]> = [
  ["silence", silence],
  ["noise", noise],
  ["sweep", sweep],
  ["partial", partial],
];

function assertAllClose(
  got: Float32Array,
  expected: Float32Array,
  rtol: number,
  atol: number,
): void {
  expect(got.length).toBe(expected.length);
  let mismatches = 0;
  for (let i = 0; i < got.length; i++) {
    const a = got[i] as number;
    const b = expected[i] as number;
    if (!(Math.abs(a - b) <= atol + rtol * Math.abs(b))) mismatches++;
  }
  expect(mismatches).toBe(0);
}

describe("test_local_smart_turn_v3_features", () => {
  for (const doNormalize of [true, false]) {
    for (const [id, audioFactory] of FIXTURES) {
      const pyId = `${doNormalize ? "True" : "False"}-${id}`;

      test(`features are an (80, 800) float32 matrix [${pyId}]`, () => {
        const got = computeWhisperLogMelFeatures(audioFactory(), { doNormalize });
        expect(got).toBeInstanceOf(Float32Array);
        expect(got.length).toBe(WHISPER_NUM_MELS * WHISPER_NUM_FRAMES);
        expect(got.every(Number.isFinite)).toBe(true);
      });

      maybeTest(`test_matches_transformers_numpy_path[${pyId}] (${SKIP_REASON})`, () => {
        // The vendored implementation matches transformers' numpy code path tightly.
        const ref = referenceExtractor as unknown as ReferenceExtractor;
        const audio = audioFactory();
        const got = computeWhisperLogMelFeatures(audio, { doNormalize });

        let x = new Float32Array(N_SAMPLES);
        x.set(audio.subarray(0, N_SAMPLES));
        if (doNormalize) {
          let mean = 0;
          for (const v of x) mean += v;
          mean /= x.length;
          let variance = 0;
          for (const v of x) variance += (v - mean) * (v - mean);
          variance /= x.length;
          const denom = Math.sqrt(variance + 1e-7);
          x = Float32Array.from(x, (v) => (v - mean) / denom);
        }

        assertAllClose(got, ref.npExtractFbankFeatures(x), 1e-5, 1e-5);
      });

      maybeTest(`test_matches_transformers_public_call[${pyId}] (${SKIP_REASON})`, () => {
        // Looser tolerance: transformers' torch path diverges from numpy by ~1e-4.
        const ref = referenceExtractor as unknown as ReferenceExtractor;
        const audio = audioFactory();
        const got = computeWhisperLogMelFeatures(audio, { doNormalize });
        assertAllClose(got, ref.call(audio, { doNormalize }), 1e-4, 1e-4);
      });
    }
  }
});
