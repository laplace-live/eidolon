import {
  type DirectionState,
  direct,
  directionOf,
  directionState,
} from "@laplace.live/eidolon-sdk/avatar";
import { describe, expect, test } from "vitest";
import { lineEvents, planLine, syllableLevel } from "./model-line";

describe("planLine", () => {
  test("reads the mood her opening direction tags and the cues that move her face", () => {
    expect(planLine("[懒洋洋的，带点笑意] 嗯…你回来啦。[chuckling][panting]")).toEqual({
      text: "[懒洋洋的，带点笑意] 嗯…你回来啦。[chuckling][panting]",
      seconds: 5 / 4.5,
      moods: ["lazy", "happy"],
      cues: ["chuckling"],
    });
    expect(planLine("  [sleepy, teasing] Oh, you're back.").moods).toEqual(["lazy", "happy"]);
  });

  test("a direction anywhere but the start sets no mood", () => {
    expect(planLine("你好 [开心]").moods).toEqual([]);
    expect(planLine("").moods).toEqual([]);
  });

  test("she takes as long as her voice would, within limits", () => {
    expect(planLine("一二三四五六七八九").seconds).toBe(2);
    expect(planLine("[chuckling]").seconds).toBe(1);
    expect(planLine("字".repeat(500)).seconds).toBe(30);
  });
});

describe("lineEvents", () => {
  function play(events: readonly Parameters<typeof direct>[1][], state = directionState()) {
    return events.reduce<DirectionState>((current, event) => direct(current, event), state);
  }

  test("she speaks with the line's mood, then stops and keeps it", () => {
    const plan = planLine("[懒洋洋的] 嗯，[chuckling]你回来啦。");
    const { start, end } = lineEvents(plan, 1000);
    const speaking = play(start);
    expect(directionOf(speaking)).toMatchObject({ speaking: true, mood: ["lazy"], pulse: null });
    // The cue fires as her voice would reach it.
    const laughing = direct(speaking, { type: "tick", at: 1300 });
    expect(directionOf(laughing)).toMatchObject({ pulse: "happy", gesture: { name: "nod" } });
    expect(end.map((event) => event.at)).toEqual([
      1000 + plan.seconds * 1000,
      1000 + plan.seconds * 1000,
    ]);
    expect(directionOf(play(end, laughing))).toMatchObject({ speaking: false, mood: ["lazy"] });
  });

  test("a line starts afresh, whatever played before", () => {
    const first = play(lineEvents(planLine("[生气] 哼。"), 0).start);
    const second = play(lineEvents(planLine("好吧。"), 5000).start, first);
    expect(directionOf(second).mood).toEqual([]);
  });
});

describe("syllableLevel", () => {
  test("opens and shuts once a syllable while she speaks", () => {
    expect(syllableLevel(0, 2)).toBe(0);
    const middle = syllableLevel(0.5 / 4.5, 2);
    expect(middle).toBeGreaterThan(0.4);
    expect(middle).toBeLessThanOrEqual(0.85);
    expect(syllableLevel(1 / 4.5, 2)).toBeCloseTo(0);
  });

  test("is shut before and after the line", () => {
    expect(syllableLevel(-0.1, 2)).toBe(0);
    expect(syllableLevel(2, 2)).toBe(0);
    expect(syllableLevel(Number.NaN, 2)).toBe(0);
  });
});
