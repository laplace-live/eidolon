// The mouth curve on synthetic voices: bursts with gaps, and a tone whose loudness swings like
// syllables, which a plain loudness map holds open throughout.
import { afterEach, describe, expect, test, vi } from "vitest";
import { loudnessOf, MOUTH_CURVE, MouthMeter, mouthCurve } from "../src/avatar/mouth.ts";

const RATE = 48_000;
const FPS = 60;
/** The analyser's window. */
const WINDOW = 1024;

/** Each 60 fps frame's loudness over the analyser's last window of `signal`. */
function frames(seconds: number, signal: (t: number) => number): number[] {
  const samples = Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) =>
    signal(i / RATE),
  );
  const out: number[] = [];
  for (let frame = 1; frame <= Math.round(seconds * FPS); frame++) {
    const end = Math.round((frame / FPS) * RATE);
    out.push(loudnessOf(samples.subarray(Math.max(0, end - WINDOW), end)));
  }
  return out;
}

const tone = (amplitude: number) => (t: number) => amplitude * Math.sin(2 * Math.PI * 220 * t);

/** A 220 Hz tone whose amplitude swings between 0.07 and 0.35 `hz` times a second. */
const syllables = (hz: number) => (t: number) =>
  0.35 * (0.6 + 0.4 * Math.sin(2 * Math.PI * hz * t)) * Math.sin(2 * Math.PI * 220 * t);

/** How often the mouth shuts after opening: below 0.25 after above 0.5. */
function closures(levels: readonly number[]): number {
  let count = 0;
  let open = false;
  for (const level of levels) {
    if (!open && level > 0.5) open = true;
    else if (open && level < 0.25) {
      open = false;
      count++;
    }
  }
  return count;
}

function plainMap(dbFrames: readonly number[]): number[] {
  return dbFrames.map((db) =>
    Math.min(1, Math.max(0, (db - MOUTH_CURVE.lo) / (MOUTH_CURVE.hi - MOUTH_CURVE.lo))),
  );
}

describe("mouthCurve", () => {
  test("is the curve tuned on her voice", () => {
    expect(MOUTH_CURVE).toEqual({
      lo: -40,
      hi: -10,
      peakWindow: 0.25,
      floorWindow: 0.12,
      minRange: 10,
      base: 0.1,
      attack: 0.02,
      release: 0.045,
    });
  });

  test("shuts the mouth on each dip of a swinging tone, which a loudness map never does", () => {
    for (const hz of [2, 4]) {
      const db = frames(3, syllables(hz));
      // The dips stay 14 dB above the curve's floor: loudness alone keeps her mouth half open.
      expect(Math.min(...db)).toBeGreaterThan(MOUTH_CURVE.lo + 10);
      expect([hz, closures(mouthCurve(db))]).toEqual([hz, 3 * hz]);
      expect([hz, closures(plainMap(db))]).toEqual([hz, 0]);
    }
  });

  test("opens for each burst and shuts in each gap", () => {
    const levels = mouthCurve(frames(2, (t) => (t % 0.25 < 0.15 ? tone(0.35)(t) : 0)));
    expect(closures(levels)).toBe(8);
    for (let burst = 0; burst < 8; burst++) {
      const at = (seconds: number) => levels[Math.round((burst * 0.25 + seconds) * FPS) - 1] ?? 0;
      expect([burst, at(0.13) > 0.85, at(0.24) < 0.2]).toEqual([burst, true, true]);
    }
  });

  test("holds a steady vowel open at its loudness", () => {
    const db = frames(1, tone(0.35));
    const levels = mouthCurve(db);
    expect(closures(levels)).toBe(0);
    const loud = plainMap(db);
    for (const [i, level] of levels.entries()) {
      if (i >= 6) expect([i, Math.abs(level - (loud[i] ?? 0)) < 0.03]).toEqual([i, true]);
    }
  });

  test("keeps it shut in silence and just above the floor, opening from 2 dB above it", () => {
    expect(Math.max(...mouthCurve(frames(1, () => 0)))).toBe(0);
    const faint = frames(1, tone(0.008));
    expect(faint[10]).toBeLessThan(MOUTH_CURVE.lo + 2);
    expect(Math.max(...mouthCurve(faint))).toBe(0);
    expect(Math.max(...mouthCurve(Array(60).fill(MOUTH_CURVE.lo + 1.9)))).toBe(0);
    expect(mouthCurve(Array(60).fill(MOUTH_CURVE.lo + 2)).at(-1)).toBeGreaterThan(0);
  });

  test("opens faster than it closes, and a frame of no time moves nothing", () => {
    const [opening = 0] = mouthCurve([-10], { dt: 0.02 });
    const [, closing = 1] = mouthCurve([-10, -180], { dt: 0.02, attack: 0.001 });
    expect(opening).toBeCloseTo(1 - Math.exp(-1), 5);
    expect(closing).toBeCloseTo(Math.exp(-0.02 / 0.045), 3);
    expect(mouthCurve([-10, -10], { dt: 0 })).toEqual([0, 0]);
  });
});

describe("loudnessOf", () => {
  test("is the RMS in dBFS, with a floor for silence", () => {
    expect(
      loudnessOf(Float32Array.from({ length: 480 }, (_, i) => (i % 2 ? 0.5 : -0.5))),
    ).toBeCloseTo(20 * Math.log10(0.5));
    expect(loudnessOf(new Float32Array(16))).toBe(-180);
    expect(loudnessOf([])).toBe(-180);
  });
});

class FakeNode {
  readonly connected: unknown[] = [];
  disconnected = false;
  connect(target: unknown) {
    this.connected.push(target);
  }
  disconnect() {
    this.disconnected = true;
  }
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  signal: (i: number) => number = () => 0;
  getFloatTimeDomainData(out: Float32Array) {
    for (let i = 0; i < out.length; i++) out[i] = this.signal(i);
  }
}

class FakeContext {
  state = "suspended";
  resumed = 0;
  closed = 0;
  readonly destination = new FakeNode();
  readonly analyser = new FakeAnalyser();
  source = new FakeNode();
  streams: unknown[] = [];
  /** What createMediaStreamSource throws, as browsers do for a stream with no audio track. */
  refusal: Error | null = null;
  resume() {
    this.resumed++;
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closed++;
    return Promise.resolve();
  }
  createMediaStreamSource(stream: unknown) {
    if (this.refusal !== null) throw this.refusal;
    this.streams.push(stream);
    return this.source;
  }
  createAnalyser() {
    return this.analyser;
  }
}

/** Makes `new AudioContext()` hand out `context`. */
function stubAudioContext(context: FakeContext): void {
  vi.stubGlobal(
    "AudioContext",
    class {
      constructor() {
        // biome-ignore lint/correctness/noConstructorReturn: hands the test's fake out as the context.
        return context;
      }
    },
  );
}

describe("MouthMeter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("reads the track through an analyser that reaches no speaker, a frame at a time", () => {
    const context = new FakeContext();
    const track = { kind: "audio" };
    vi.stubGlobal(
      "MediaStream",
      class {
        readonly tracks: unknown[];
        constructor(tracks: unknown[]) {
          this.tracks = tracks;
        }
      },
    );
    const meter = new MouthMeter(track as unknown as MediaStreamTrack, {
      context: context as unknown as AudioContext,
    });
    expect(context.resumed).toBe(1);
    expect(context.streams).toEqual([{ tracks: [track] }]);
    expect(context.analyser.fftSize).toBe(1024);
    expect(context.source.connected).toEqual([context.analyser]);
    expect(context.analyser.connected).toEqual([]);

    context.analyser.signal = (i) => 0.35 * Math.sin((2 * Math.PI * 220 * i) / RATE);
    const db = loudnessOf(
      Float32Array.from({ length: WINDOW }, (_, i) => context.analyser.signal(i)),
    );
    const levels = Array.from({ length: 30 }, () => meter.read(1 / FPS));
    expect(levels).toEqual(mouthCurve(Array(30).fill(db), { dt: 1 / FPS }));
    expect(levels.at(-1)).toBeGreaterThan(0.9);

    meter.close();
    expect(context.source.disconnected).toBe(true);
    expect(context.closed).toBe(0);
    expect(meter.read(1 / FPS)).toBe(0);
  });

  test("closes the context it made, and takes a stream as it is", () => {
    const context = new FakeContext();
    stubAudioContext(context);
    const stream = { getAudioTracks: () => [] };
    const meter = new MouthMeter(stream as unknown as MediaStream);
    expect(context.streams).toEqual([stream]);
    meter.close();
    meter.close();
    expect(context.closed).toBe(1);
  });

  test("closes the context it made when the stream has no audio to read, never the caller's", () => {
    const noAudio = () => new DOMException("MediaStream has no audio track", "InvalidStateError");
    const stream = { getAudioTracks: () => [] } as unknown as MediaStream;
    const own = new FakeContext();
    own.refusal = noAudio();
    stubAudioContext(own);
    expect(() => new MouthMeter(stream)).toThrow(own.refusal);
    expect(own.closed).toBe(1);

    const theirs = new FakeContext();
    theirs.refusal = noAudio();
    expect(() => new MouthMeter(stream, { context: theirs as unknown as AudioContext })).toThrow(
      theirs.refusal,
    );
    expect(theirs.closed).toBe(0);
  });
});
