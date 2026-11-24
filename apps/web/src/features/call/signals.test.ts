import type { BotOutputData } from "@laplace.live/eidolon-sdk";
import { describe, expect, test, vi } from "vitest";
import { CallSignals, MouthTap, outputEvent, type SignalClock, TICK_MS } from "./signals";

const sentence = (o: Partial<BotOutputData>): BotOutputData => ({
  text: "你好呀。",
  segment_id: 3,
  output_type: "sentence",
  will_be_spoken: true,
  spoken_status: "new",
  spoken_progress: { accumulated_text: "", remaining_text: "你好呀。" },
  ...o,
});

describe("outputEvent", () => {
  test("passes on a sentence as it is announced, said and done", () => {
    expect(outputEvent(sentence({}), 5)).toEqual({
      type: "bot-output",
      at: 5,
      segment: 3,
      text: "你好呀。",
      status: "new",
    });
    const progress = sentence({
      spoken_status: "in-progress",
      spoken_progress: { accumulated_text: "你", remaining_text: "好呀。" },
    });
    expect(outputEvent(progress, 6)).toEqual({
      type: "bot-output",
      at: 6,
      segment: 3,
      text: "你好呀。",
      status: "in-progress",
      spoken: 1,
    });
    const done = sentence({
      spoken_status: "completed",
      spoken_progress: { accumulated_text: "你好呀。", remaining_text: "" },
    });
    expect(outputEvent(done, 7)).toEqual({
      type: "bot-output",
      at: 7,
      segment: 3,
      text: "你好呀。",
      status: "completed",
    });
  });

  test("skips what doesn't move her", () => {
    for (const output_type of ["word", "token", "backchannel", "expression_sound"]) {
      expect(outputEvent(sentence({ output_type }), 1)).toBeNull();
    }
    const pause = sentence({ output_type: undefined, text_type: "expression_pause" });
    expect(outputEvent(pause, 1)).toBeNull();
    expect(outputEvent(sentence({ will_be_spoken: false }), 1)).toBeNull();
    expect(outputEvent(sentence({ segment_id: undefined }), 1)).toBeNull();
    expect(outputEvent(sentence({ spoken_status: undefined }), 1)).toBeNull();
    expect(outputEvent(sentence({ text: "" }), 1)).toBeNull();
  });
});

describe("MouthTap", () => {
  test("reads shut without a source, and keeps the widest opening until it is taken", () => {
    const tap = new MouthTap();
    expect(tap.read(0.016)).toBe(0);
    const levels = [0.2, 0.7, 0.1];
    tap.source = { read: () => levels.shift() ?? 0 };
    expect([tap.read(0.016), tap.read(0.016), tap.read(0.016)]).toEqual([0.2, 0.7, 0.1]);
    expect(tap.take()).toBe(0.7);
    expect(tap.take()).toBe(0);
  });
});

/** A clock whose runs only happen when the test calls them. */
function fakeClock() {
  const runs: { run: () => void; ms: number }[] = [];
  let at = 0;
  const stops = vi.fn();
  const clock: SignalClock = {
    now: () => (at += 10),
    every(run, ms) {
      runs.push({ run, ms });
      return stops;
    },
  };
  return { clock, runs, stops };
}

describe("CallSignals", () => {
  test("ticks while a call runs, and follows who speaks", () => {
    const { clock, runs, stops } = fakeClock();
    const signals = new CallSignals(clock);
    expect(runs).toEqual([]);
    signals.begin();
    expect(runs.map(({ ms }) => ms)).toEqual([TICK_MS]);

    const changed = vi.fn();
    const ticked = vi.fn();
    const offChanged = signals.subscribe(changed);
    const offTicked = signals.onTick(ticked);
    runs[0]!.run();
    expect([changed.mock.calls.length, ticked.mock.calls.length]).toEqual([1, 1]);

    signals.feed({ type: "bot-started-speaking", at: signals.now() });
    expect([changed.mock.calls.length, ticked.mock.calls.length]).toEqual([2, 1]);
    expect(signals.direction().speaking).toBe(true);
    signals.feed({ type: "bot-stopped-speaking", at: signals.now() });
    expect(signals.direction().speaking).toBe(false);

    signals.feed({ type: "speaker", at: signals.now(), persona: "hazel" });
    signals.feed({ type: "bot-started-speaking", at: signals.now() });
    expect(signals.direction("hazel").speaking).toBe(true);
    expect(signals.direction("milky-green").speaking).toBe(false);

    signals.end();
    expect(stops).toHaveBeenCalledTimes(1);
    expect(signals.direction("hazel").speaking).toBe(false);
    expect([changed.mock.calls.length, ticked.mock.calls.length]).toEqual([6, 1]);

    offChanged();
    offTicked();
    runs[0]!.run();
    signals.feed({ type: "bot-started-speaking", at: signals.now() });
    expect([changed.mock.calls.length, ticked.mock.calls.length]).toEqual([6, 1]);
  });

  test("begins again after an end, from a fresh direction", () => {
    const { clock, runs, stops } = fakeClock();
    const signals = new CallSignals(clock);
    signals.begin();
    signals.feed({ type: "bot-started-speaking", at: signals.now() });
    signals.feed({
      type: "bot-output",
      at: signals.now(),
      segment: 1,
      text: "[开心地] 嗯！",
      status: "new",
    });
    expect(signals.direction()).toMatchObject({ speaking: true, mood: ["happy"] });
    signals.end();
    signals.begin();
    expect(runs).toHaveLength(2);
    expect(stops).toHaveBeenCalledTimes(1);
    expect(signals.direction()).toMatchObject({
      speaking: false,
      thinking: false,
      listening: false,
      mood: [],
    });
    signals.close();
    expect(stops).toHaveBeenCalledTimes(2);
  });
});
