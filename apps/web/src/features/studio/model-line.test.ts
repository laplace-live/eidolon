import {
  type AvatarModel,
  AvatarStage,
  type DirectionState,
  direct,
  directionOf,
  directionState,
  type ModelInventory,
  resolveSetup,
} from "@laplace.live/eidolon-sdk/avatar";
import { describe, expect, test, vi } from "vitest";
import { directLine, lineEvents, planLine, syllableLevel } from "./model-line";

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

describe("directLine", () => {
  const INVENTORY: ModelInventory = {
    runtime: "0.1.0",
    generator: null,
    canvas: { width: 2048, height: 2048 },
    clips: ["Idle", "Talk", "Nod"].map((name) => ({
      id: name.toLowerCase(),
      name,
      group: name,
      duration: 1,
      looping: name === "Idle",
    })),
    expressions: [],
    hitAreas: [],
    parameters: [],
    parts: [],
    poseGroups: [],
    lipSync: true,
    textures: 1,
  };

  /** Studio's stage on frames the test draws, showing a model that keeps what it is told to play. */
  function preview() {
    const frames = new Map<number, (now: number) => void>();
    let handles = 0;
    const canvas = Object.assign(new EventTarget(), { clientWidth: 400, clientHeight: 500 });
    const stage = new AvatarStage(canvas as unknown as HTMLCanvasElement, {
      clock: {
        request: (frame) => {
          frames.set(++handles, frame);
          return handles;
        },
        cancel: (handle) => frames.delete(handle as number),
      },
    });
    const play = vi.fn<AvatarModel["play"]>();
    const model: AvatarModel = {
      kind: "psd2live",
      inventory: INVENTORY,
      setExpressions: () => {},
      play,
      mouth: () => {},
      lookAt: () => {},
      wear: () => {},
      bounds: () => null,
      update: () => {},
      draw: () => {},
      hitTest: () => null,
      alphaAt: () => 0,
      dispose: () => {},
    };
    stage.show(model, resolveSetup(INVENTORY));
    return {
      stage,
      draw(now: number) {
        const due = [...frames.values()];
        frames.clear();
        for (const frame of due) frame(now);
      },
      nods: () => play.mock.calls.filter(([clip, layer]) => clip === "nod" && layer === 2).length,
    };
  }

  /** A line tried as Try a Line plays it: its start, a tick every 100 ms while she says it, its end. */
  function tryLine(on: ReturnType<typeof preview>, text: string, at: number) {
    const plan = planLine(text);
    const { start, end } = lineEvents(plan, at);
    const done = at + plan.seconds * 1000;
    directLine(on.stage, start);
    on.draw(at);
    for (let now = at + 100; now < done; now += 100) {
      directLine(on.stage, [{ type: "tick", at: now }]);
      on.draw(now);
    }
    directLine(on.stage, end);
    on.draw(done);
  }

  test("her gesture plays each time a line is tried on the stage", () => {
    const on = preview();
    tryLine(on, "[chuckling] 你回来啦。", 0);
    tryLine(on, "[chuckling] 你回来啦。", 5000);
    expect(on.nods()).toBe(2);
  });

  test("so does one her pace lands partway through the line", () => {
    const on = preview();
    tryLine(on, "[懒洋洋的] 嗯，[chuckling]你回来啦。", 0);
    tryLine(on, "[懒洋洋的] 嗯，[chuckling]你回来啦。", 5000);
    expect(on.nods()).toBe(2);
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
