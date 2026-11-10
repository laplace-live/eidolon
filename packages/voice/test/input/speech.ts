// Test audio made on the spot: the repository keeps no recordings (.gitignore), so a
// formant-synthesized voice that Silero scores as speech stands in for one.
import { join } from "node:path";
import { PROJECT_ROOT } from "@eidolon/config";

export const SAMPLE_RATE = 16000;
/** 20 ms, the frame the transport delivers. */
export const FRAME_SAMPLES = 320;

// Until the models move into packages/voice/models, the copies pipedog's packages ship, which
// packages/runtime installs and loads today.
const RUNTIME = join(PROJECT_ROOT, "packages/runtime");
export const SILERO_MODEL = Bun.resolveSync("@pipedog/audio-silero/silero_vad.onnx", RUNTIME);
export const SMART_TURN_MODEL = Bun.resolveSync(
  "@pipedog/audio-smart-turn/smart-turn-v3.2-cpu.onnx",
  RUNTIME,
);

/** A seeded uniform generator on [0, 1) (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded Gaussian noise (Box-Muller), like a room's tone or a line's hiss. */
export function noise(seconds: number, std: number, seed: number): Float64Array {
  const rand = mulberry32(seed);
  const out = new Float64Array(Math.trunc(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) {
    const u1 = Math.max(rand(), Number.MIN_VALUE);
    out[i] = std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rand());
  }
  return out;
}

// Peterson and Barney's adult vowel formants (Hz).
const VOWELS: readonly (readonly [number, number, number])[] = [
  [730, 1090, 2440],
  [270, 2290, 3010],
  [300, 870, 2240],
  [530, 1840, 2480],
  [570, 840, 2410],
  [660, 1720, 2410],
  [490, 1350, 1690],
];

// The RMS of the 6.4 s Kokoro clip pipedog's VAD tests listen to.
const SPEECH_RMS = 1900;

/**
 * Continuous speech without pauses, as a cascade formant synthesizer: syllables of gliding vowels
 * after a fricative or a stop, on a jittered glottal pulse whose pitch falls over each phrase.
 */
export function syntheticSpeech(seconds: number, seed: number): Float64Array {
  const rand = mulberry32(seed);
  const n = Math.trunc(seconds * SAMPLE_RATE);
  const formants = [new Float64Array(n), new Float64Array(n), new Float64Array(n)] as const;
  const voiced = new Float64Array(n);
  const aspiration = new Float64Array(n);
  const pitch = new Float64Array(n);

  let i = 0;
  let from = VOWELS[0] as readonly [number, number, number];
  let phraseStart = 0;
  let base = 180 + 40 * rand();
  while (i < n) {
    const to = VOWELS[Math.floor(rand() * VOWELS.length)] as readonly [number, number, number];
    const fricative = rand() < 0.5;
    const consonant = Math.trunc((0.03 + 0.06 * rand()) * SAMPLE_RATE);
    const vowel = Math.trunc((0.09 + 0.16 * rand()) * SAMPLE_RATE);
    const loudness = 0.7 + 0.3 * rand();
    for (let k = 0; k < consonant && i < n; k++, i++) {
      for (let f = 0; f < 3; f++) formants[f][i] = from[f] as number;
      voiced[i] = fricative ? 0.1 : 0;
      aspiration[i] = fricative ? 0.25 : k > consonant * 0.7 ? 0.5 : 0;
      pitch[i] = base;
    }
    for (let k = 0; k < vowel && i < n; k++, i++) {
      const glide = Math.min(1, k / (0.04 * SAMPLE_RATE));
      for (let f = 0; f < 3; f++) {
        formants[f][i] = (from[f] as number) + ((to[f] as number) - (from[f] as number)) * glide;
      }
      const attack = Math.min(1, k / (0.015 * SAMPLE_RATE));
      const release = Math.min(1, (vowel - k) / (0.02 * SAMPLE_RATE));
      voiced[i] = loudness * attack * release;
      aspiration[i] = 0.02;
      const declination = 1 - (0.08 * (i - phraseStart)) / SAMPLE_RATE;
      const vibrato = 1 + 0.04 * Math.sin((2 * Math.PI * 3 * i) / SAMPLE_RATE);
      pitch[i] = base * declination * vibrato;
    }
    from = to;
    if ((i - phraseStart) / SAMPLE_RATE > 1.8 + rand()) {
      phraseStart = i;
      base = 160 + 70 * rand();
    }
  }

  const out = new Float64Array(n);
  const delay = [0, 0, 0, 0, 0, 0];
  let phase = 0;
  for (let s = 0; s < n; s++) {
    phase += ((pitch[s] as number) * (1 + 0.01 * (rand() * 2 - 1))) / SAMPLE_RATE;
    if (phase >= 1) phase -= 1;
    const pulse = phase < 0.4 ? Math.sin((Math.PI * phase) / 0.4) ** 2 : 0;
    let x = (voiced[s] as number) * (pulse - 0.3) + (aspiration[s] as number) * (rand() * 2 - 1);
    for (let f = 0; f < 3; f++) {
      const r = Math.exp((-Math.PI * (70 + 30 * f)) / SAMPLE_RATE);
      const c = 2 * r * Math.cos((2 * Math.PI * (formants[f][s] as number)) / SAMPLE_RATE);
      const d = -r * r;
      const y = (1 - c - d) * x + c * (delay[2 * f] as number) + d * (delay[2 * f + 1] as number);
      delay[2 * f + 1] = delay[2 * f] as number;
      delay[2 * f] = y;
      x = y;
    }
    out[s] = x;
  }
  for (let s = n - 1; s > 0; s--) out[s] = (out[s] as number) - 0.9 * (out[s - 1] as number);

  let squares = 0;
  for (const v of out) squares += v * v;
  const gain = SPEECH_RMS / Math.sqrt(squares / n);
  return out.map((v) => v * gain);
}

export function concat(...parts: Float64Array[]): Float64Array {
  const out = new Float64Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Clipped to int16 and truncated toward zero, as numpy's `clip(...).astype(np.int16)`. */
export function toPcm(audio: ArrayLike<number>): Int16Array {
  return Int16Array.from({ length: audio.length }, (_, i) =>
    Math.trunc(Math.min(32767, Math.max(-32768, audio[i] as number))),
  );
}

/** `pcm` in consecutive frames of `size` samples, dropping a short last one. */
export function* frames(pcm: Int16Array, size = FRAME_SAMPLES): Generator<Int16Array> {
  for (let start = 0; start + size <= pcm.length; start += size) {
    yield pcm.subarray(start, start + size);
  }
}
