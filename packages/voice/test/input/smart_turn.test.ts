// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/core/test/test_base_smart_turn_buffer.test.ts@ce8f8bc
//
// The port's parameters are fixed at pipedog's defaults, and a clock it is given stamps the
// chunks, so the trim and stop tests use those defaults on a fake clock instead of sleeping. The
// cleanup tests aren't ported: there is no model thread to release.
import { describe, expect, test } from "bun:test";
import {
  MAX_DURATION_SECONDS,
  PRE_SPEECH_MS,
  SmartTurn,
  STOP_SECS,
} from "../../src/input/smart_turn.ts";
import { VAD_START_SECS } from "../../src/input/vad.ts";
import { SMART_TURN_MODEL } from "./speech.ts";

const CHUNK_SIZE = 320; // 20 ms @ 16 kHz

/** A clock tests move by hand, in milliseconds. */
class FakeClock {
  ms = 1_000_000;
  now(): number {
    return this.ms;
  }
}

/** Test double that records the segment audio passed to the model. */
class RecordingSmartTurn extends SmartTurn {
  capturedSegment: Float32Array | null = null;
  probability = 0.99;

  constructor(clock: FakeClock = new FakeClock()) {
    super(SMART_TURN_MODEL, clock);
  }

  protected override async predict(audio: Float32Array): Promise<number> {
    this.capturedSegment = audio.slice();
    return this.probability;
  }
}

function bufferOf(analyzer: SmartTurn): [number, Int16Array][] {
  return (analyzer as unknown as { buffer: [number, Int16Array][] }).buffer;
}

/** Seeded integer generator (stands in for np.random.default_rng(seed=1234)). */
function seededInt16(n: number, seed: number): Int16Array {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Int16Array(n);
  // integers(-32768, 32767): high is exclusive.
  for (let i = 0; i < n; i++) out[i] = -32768 + Math.floor(next() * 65535);
  return out;
}

function concatInt16(chunks: Int16Array[]): Int16Array {
  const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** `int16.astype(np.float32) / 32768.0` */
function toFloat32(values: Int16Array): Float32Array {
  return Float32Array.from(values, (v) => v / 32768.0);
}

function allClose(a: Float32Array, b: number): boolean {
  // np.allclose defaults: rtol=1e-05, atol=1e-08
  return a.every((v) => Math.abs(v - b) <= 1e-8 + 1e-5 * Math.abs(b));
}

/**
 * The deferred segment must be bit-identical to per-chunk conversion: the cast is per-element and
 * the divide is a multiplication by a float constant, so concatenation distributes through both.
 */
test("test_segment_matches_eager_conversion_bit_identical", () => {
  const chunksInt16 = Array.from({ length: 12 }, (_, i) => seededInt16(CHUNK_SIZE, 1234 + i));

  const eagerSegment = concatFloat32(chunksInt16.map((c) => toFloat32(c)));
  const deferredSegment = toFloat32(concatInt16(chunksInt16));

  expect(deferredSegment).toBeInstanceOf(Float32Array);
  expect(eagerSegment.length).toEqual(deferredSegment.length);
  expect(
    new Uint8Array(eagerSegment.buffer).every(
      (byte, i) => byte === new Uint8Array(deferredSegment.buffer)[i],
    ),
  ).toBe(true);
  expect(eagerSegment).toEqual(deferredSegment);
});

/** After append, the buffer holds int16 copies, not float32. */
test("test_buffer_holds_int16_views_after_append", () => {
  const analyzer = new RecordingSmartTurn();
  const chunk = new Int16Array([100, -200, 300, -400]);
  analyzer.append(chunk, true);

  const buffer = bufferOf(analyzer);
  expect(buffer.length).toEqual(1);
  const [, stored] = buffer[0] as [number, Int16Array];
  expect(stored).toBeInstanceOf(Int16Array);
  expect(Array.from(stored)).toEqual(Array.from(chunk));
  chunk[0] = 0;
  expect(stored[0]).toBe(100);
});

/** When a turn is analyzed, the model gets float32 in [-1, 1]. */
test("test_segment_audio_is_normalized_float32", async () => {
  const analyzer = new RecordingSmartTurn();
  const speech = new Int16Array(CHUNK_SIZE).fill(16_000); // constant 0.488...
  for (let i = 0; i < 4; i++) analyzer.append(speech, true);

  await analyzer.analyze();
  expect(analyzer.capturedSegment).not.toBeNull();
  const segment = analyzer.capturedSegment as Float32Array;
  expect(segment).toBeInstanceOf(Float32Array);
  expect(segment.reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toBeLessThanOrEqual(1.0);
  expect(allClose(segment, 16_000 / 32768.0)).toBe(true);
});

/** Without speech, the buffer stays bounded by pre-speech + stop + max duration. */
test("test_pre_speech_buffer_trim_still_bounds_growth", () => {
  const clock = new FakeClock();
  const analyzer = new RecordingSmartTurn(clock);
  const chunk = new Int16Array(CHUNK_SIZE);
  const maxBufferMs = PRE_SPEECH_MS + (STOP_SECS + MAX_DURATION_SECONDS) * 1000;
  for (let i = 0; i < 1000; i++) {
    analyzer.append(chunk, false);
    clock.ms += 20;
  }
  // 11.5 s at 50 chunks a second, give or take the chunk on the boundary.
  expect(bufferOf(analyzer).length).toBeGreaterThanOrEqual(maxBufferMs / 20);
  expect(bufferOf(analyzer).length).toBeLessThanOrEqual(maxBufferMs / 20 + 1);
});

/**
 * clear() after an externally-ended turn must kill the stale silence timer: a turn force-ended
 * mid-speech leaves speech triggered with audio buffered, and the silence after it would otherwise
 * complete a phantom turn.
 */
test("test_clear_prevents_stale_stop_secs_completion", () => {
  const analyzer = new RecordingSmartTurn();
  const speech = new Int16Array(CHUNK_SIZE).fill(16_000);
  const silence = new Int16Array(CHUNK_SIZE);

  for (let i = 0; i < 4; i++) analyzer.append(speech, true);
  expect(analyzer.speechTriggered).toBe(true);

  analyzer.clear();
  expect(analyzer.speechTriggered).toBe(false);

  // Silence well past STOP_SECS.
  for (let i = 0; i < (STOP_SECS * 1000 * 2) / 20; i++) {
    expect(analyzer.append(silence, false)).toEqual("incomplete");
  }
});

/** After clear(), the next prediction only sees post-clear audio. */
test("test_clear_drops_pre_clear_audio_from_next_segment", async () => {
  const analyzer = new RecordingSmartTurn();
  const old = new Int16Array(CHUNK_SIZE).fill(1_000);
  const fresh = new Int16Array(CHUNK_SIZE).fill(2_000);

  for (let i = 0; i < 4; i++) analyzer.append(old, true);
  analyzer.clear();
  for (let i = 0; i < 4; i++) analyzer.append(fresh, true);

  await analyzer.analyze();
  expect(analyzer.capturedSegment).not.toBeNull();
  expect(allClose(analyzer.capturedSegment as Float32Array, 2_000 / 32768.0)).toBe(true);
});

describe("on the clock", () => {
  test("the segment starts the pre-speech and the VAD's start delay before speech", async () => {
    const clock = new FakeClock();
    const analyzer = new RecordingSmartTurn(clock);
    // Speech starts 10 ms into a chunk's slot, so no chunk sits on the segment's start.
    const speechAt = 100 * 20 + 10;
    const first = Math.ceil((speechAt - PRE_SPEECH_MS - VAD_START_SECS * 1000) / 20);
    for (let i = 0; i < 100; i++) {
      analyzer.append(new Int16Array(CHUNK_SIZE).fill(i < first ? 1 : 2), false);
      clock.ms += 20;
    }
    clock.ms += 10;
    analyzer.append(new Int16Array(CHUNK_SIZE).fill(3), true);

    await analyzer.analyze();
    const segment = analyzer.capturedSegment as Float32Array;
    expect(segment.length).toBe((100 - first + 1) * CHUNK_SIZE);
    expect(segment[0]).toBe(2 / 32768);
    expect(segment.at(-1)).toBe(3 / 32768);
  });

  test("the segment keeps the last 8 s", async () => {
    const clock = new FakeClock();
    const analyzer = new RecordingSmartTurn(clock);
    for (let i = 0; i < 500; i++) {
      analyzer.append(new Int16Array(CHUNK_SIZE).fill(i), true);
      clock.ms += 20;
    }
    await analyzer.analyze();
    const segment = analyzer.capturedSegment as Float32Array;
    expect(segment.length).toBe(MAX_DURATION_SECONDS * 16000);
    expect(segment[0]).toBe(100 / 32768);
  });

  test("STOP_SECS of silence after speech completes the turn and clears it", () => {
    const analyzer = new RecordingSmartTurn();
    analyzer.append(new Int16Array(CHUNK_SIZE).fill(9), true);
    const silence = new Int16Array(CHUNK_SIZE);
    for (let i = 1; i < (STOP_SECS * 1000) / 20; i++) {
      expect(analyzer.append(silence, false)).toBe("incomplete");
    }
    expect(analyzer.append(silence, false)).toBe("complete");
    expect(analyzer.speechTriggered).toBe(false);
    expect(bufferOf(analyzer)).toEqual([]);
  });

  test("an incomplete turn keeps its audio and stays triggered; a complete one is cleared", async () => {
    const analyzer = new RecordingSmartTurn();
    analyzer.append(new Int16Array(CHUNK_SIZE).fill(5), true);
    analyzer.probability = 0.5;
    expect(await analyzer.analyze()).toEqual({ state: "incomplete", probability: 0.5 });
    expect(analyzer.speechTriggered).toBe(true);
    expect(bufferOf(analyzer)).toHaveLength(1);

    analyzer.probability = 0.51;
    expect(await analyzer.analyze()).toEqual({ state: "complete", probability: 0.51 });
    expect(analyzer.speechTriggered).toBe(false);
    expect(bufferOf(analyzer)).toEqual([]);
  });

  test("an empty buffer asks the model nothing", async () => {
    const analyzer = new RecordingSmartTurn();
    expect(await analyzer.analyze()).toEqual({ state: "incomplete", probability: null });
    expect(analyzer.capturedSegment).toBeNull();
  });
});

describe("the model", () => {
  test("scores a turn as a probability", async () => {
    const analyzer = new SmartTurn(SMART_TURN_MODEL);
    analyzer.append(new Int16Array(1600), true);
    const { state, probability } = await analyzer.analyze();
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
    expect(state).toBe((probability as number) > 0.5 ? "complete" : "incomplete");
  });

  test("a model that can't load rejects the analysis", async () => {
    const analyzer = new SmartTurn("/nonexistent/smart-turn-v3.2-cpu.onnx");
    analyzer.append(new Int16Array(1600), true);
    await expect(analyzer.analyze()).rejects.toThrow();
  });
});
