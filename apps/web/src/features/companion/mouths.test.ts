import { describe, expect, test } from "vitest";
import {
  dbFrames,
  MOUTH_STALE_MS,
  PortMouth,
  VOICE_FPS,
  VoiceTimeline,
  voiceOpenings,
  WidestTap,
} from "./mouths";

function clock() {
  let now = 0;
  return { now: () => now, at: (ms: number) => (now = ms) };
}

describe("PortMouth", () => {
  test("reads the latest level until it goes stale", () => {
    const time = clock();
    const mouth = new PortMouth(time.now);
    expect(mouth.read()).toBe(0);
    mouth.set(0.6);
    expect(mouth.read()).toBe(0.6);
    time.at(MOUTH_STALE_MS);
    expect(mouth.read()).toBe(0.6);
    time.at(300);
    expect(mouth.read()).toBe(0);
  });

  test("clamps a level into 0..1", () => {
    const mouth = new PortMouth(clock().now);
    mouth.set(1.4);
    expect(mouth.read()).toBe(1);
    mouth.set(-0.5);
    expect(mouth.read()).toBe(0);
  });
});

/** A 220 Hz tone at -15 dBFS in four syllables a second, as the smoke's call speech is. */
function syllables(seconds: number, rate: number): Float32Array {
  const peak = 10 ** (-15 / 20);
  const samples = new Float32Array(seconds * rate);
  for (let i = 0; i < samples.length; i++) {
    const at = i / rate;
    const syllable = 0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * at);
    samples[i] = Math.sin(2 * Math.PI * 220 * at) * syllable * peak;
  }
  return samples;
}

describe("dbFrames", () => {
  test("a second of silence at 48 kHz is 60 frames of -180", () => {
    const frames = dbFrames(new Float32Array(48_000), 48_000);
    expect(frames).toHaveLength(VOICE_FPS);
    expect(new Set(frames)).toEqual(new Set([-180]));
  });

  test("a full-scale sine is about -3 dBFS in every frame", () => {
    // 480 Hz: eight whole cycles a frame.
    const rate = 48_000;
    const samples = Float32Array.from({ length: rate }, (_, i) =>
      Math.sin((2 * Math.PI * 480 * i) / rate),
    );
    const frames = dbFrames(samples, rate);
    expect(frames).toHaveLength(VOICE_FPS);
    for (const db of frames) expect(db).toBeCloseTo(-3.01, 1);
  });

  test("a tail shorter than a frame is a frame of its own", () => {
    expect(dbFrames(new Float32Array(48_000 + 100), 48_000)).toHaveLength(VOICE_FPS + 1);
  });
});

describe("voiceOpenings", () => {
  test("her mouth opens at each syllable's peak and shuts between them", () => {
    const rate = 48_000;
    const openings = voiceOpenings(syllables(2, rate), rate);
    expect(openings).toHaveLength(2 * VOICE_FPS);
    // Peaks at 0.125 s, 0.375 s…; dips at 0.25 s, 0.5 s…
    for (let syllable = 1; syllable < 7; syllable++) {
      const peak = Math.round((0.125 + syllable / 4) * VOICE_FPS);
      const dip = Math.round(((syllable + 1) / 4) * VOICE_FPS);
      expect(openings[peak]).toBeGreaterThan(0.5);
      expect(openings[dip]).toBeLessThan(0.2);
    }
  });
});

describe("VoiceTimeline", () => {
  const openings = Float32Array.from({ length: 300 }, (_, i) => i / 1000);

  test("reads shut before play, its frame while playing, and shut after stop", () => {
    const time = clock();
    const timeline = new VoiceTimeline(time.now);
    timeline.load(openings);
    expect(timeline.read()).toBe(0);
    timeline.play(1);
    time.at(500);
    expect(timeline.read()).toBeCloseTo(0.09);
    timeline.stop();
    expect(timeline.read()).toBe(0);
  });

  test("reads shut until its openings come, with none, and past its end", () => {
    const time = clock();
    const timeline = new VoiceTimeline(time.now);
    timeline.play(0);
    expect(timeline.read()).toBe(0);
    timeline.load(openings);
    time.at(1_000);
    expect(timeline.read()).toBeCloseTo(0.06);
    timeline.load(null);
    expect(timeline.read()).toBe(0);
    timeline.load(openings);
    time.at(10_000);
    expect(timeline.read()).toBe(0);
  });
});

test("WidestTap passes each reading on and keeps the widest until taken", () => {
  const readings = [0.2, 0.7, 0.1];
  const tap = new WidestTap();
  expect(tap.read(0.016)).toBe(0);
  tap.source = { read: () => readings.shift() ?? 0 };
  expect([tap.read(0.016), tap.read(0.016), tap.read(0.016)]).toEqual([0.2, 0.7, 0.1]);
  expect(tap.take()).toBe(0.7);
  expect(tap.take()).toBe(0);
});
