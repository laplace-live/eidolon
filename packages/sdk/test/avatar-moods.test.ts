// The mood table on prompt.md's published directions and others written in their style.
import { describe, expect, test } from "vitest";
import {
  type ModelInventory,
  moodExpressions,
  moodSettings,
  resolveSetup,
} from "../src/avatar/model.ts";
import {
  CUE_EFFECTS,
  DEFAULT_MOOD_EXPRESSIONS,
  MOOD_TAGS,
  type MoodTag,
  moodTags,
  soundCueEffect,
} from "../src/avatar/moods.ts";
import { CUE_EMOJI } from "../src/markup.ts";

function inventory(o: Partial<ModelInventory> = {}): ModelInventory {
  return {
    runtime: "0.1.0",
    generator: null,
    canvas: { width: 2048, height: 2048 },
    clips: [],
    expressions: ["smile", "sad", "angry", "surprised", "shy", "sleepy", "gloom"].map((id) => ({
      id,
      name: id,
    })),
    hitAreas: [],
    parameters: [],
    parts: [],
    poseGroups: [],
    lipSync: true,
    textures: 1,
    ...o,
  };
}

describe("moodTags", () => {
  test("reads prompt.md's published directions", () => {
    const cases: readonly (readonly [string, MoodTag[]])[] = [
      ["懒洋洋的，带点笑意", ["lazy", "happy"]],
      ["嘴硬，装作嫌弃", ["pout"]],
      ["温柔地安慰", ["gentle"]],
      ["有点失落，慢慢地说", ["sad"]],
      ["压低声音，像在说悄悄话", []],
      ["突然来劲，语速变快", []],
      ["温暖，带着怀念", []],
    ];
    for (const [direction, tags] of cases)
      expect([direction, moodTags(direction)]).toEqual([direction, tags]);
  });

  test("reads directions written in their style, two families at most, in precedence order", () => {
    const cases: readonly (readonly [string, MoodTag[]])[] = [
      ["惊讶，声音一下子拔高", ["surprised"]],
      ["想了想，慢悠悠地说", ["thinking"]],
      ["无奈地叹了口气", ["wry"]],
      ["不好意思地笑", ["shy", "happy"]],
      ["委屈巴巴，快要哭了", ["sad"]],
      ["气呼呼的，提高音量", ["angry"]],
      ["阴阳怪气地拖腔", ["gloom"]],
      ["傲娇地哼了一声", ["pout"]],
      ["困得睁不开眼", ["lazy"]],
      ["兴奋，语速飞快", ["happy"]],
      ["轻声哄着", ["gentle"]],
      ["又惊又喜，有点害羞地笑", ["surprised", "shy"]],
      ["得意洋洋地调侃", ["happy"]],
      ["随意地", []],
    ];
    for (const [direction, tags] of cases)
      expect([direction, moodTags(direction)]).toEqual([direction, tags]);
  });

  test("哭笑不得 never tags sad, while a 哭 outside it does", () => {
    expect(moodTags("哭笑不得")).not.toContain("sad");
    expect(moodTags("哭笑不得")).toEqual(["wry", "happy"]);
    expect(moodTags("有点哭笑不得，嘴上还不认")).not.toContain("sad");
    expect(moodTags("哭笑不得，又差点哭出来")).toEqual(["wry", "sad"]);
    expect(moodTags("哭腔")).toEqual(["sad"]);
  });

  test("困惑 is puzzled and 困扰 or 困难 no mood, while a 困 outside them is sleepy", () => {
    expect(moodTags("困惑地")).toEqual(["thinking"]);
    expect(moodTags("有点困惑，又忍不住笑")).toEqual(["thinking", "happy"]);
    expect(moodTags("被问得有点困扰")).toEqual([]);
    expect(moodTags("觉得这事挺困难")).toEqual([]);
    expect(moodTags("困得睁不开眼")).toEqual(["lazy"]);
    expect(moodTags("困惑完又犯困")).toEqual(["thinking", "lazy"]);
  });

  test("a negation right before a Chinese keyword, softened or not, takes its mood away", () => {
    const cases: readonly (readonly [string, MoodTag[]])[] = [
      ["不高兴地嘟囔", ["pout"]],
      ["有点不开心，慢慢地说", []],
      ["不太开心，闷闷地说", ["sad"]],
      ["没有生气，只是无奈", ["wry"]],
      ["没生气，就是有点委屈", ["sad"]],
      ["不是生气，是委屈", ["sad"]],
      ["一点也不惊讶，懒洋洋的", ["lazy"]],
      ["别难过，温柔地哄", ["gentle"]],
      ["一点都不害羞，大大方方地说", []],
      ["不困，突然来劲", []],
      ["特别开心，语速变快", ["happy"]],
      ["忍不住笑出声", ["happy"]],
      ["毫不掩饰地得意", ["happy"]],
      ["有点不爽，嘴硬", ["angry", "pout"]],
      ["完全没想到，愣了一下", ["surprised"]],
      ["没好气地说", ["wry"]],
    ];
    for (const [direction, tags] of cases)
      expect([direction, moodTags(direction)]).toEqual([direction, tags]);
  });

  test("matches English keywords as whole words, whatever their case", () => {
    const cases: readonly (readonly [string, MoodTag[]])[] = [
      ["softly, with a warm smile", ["gentle"]],
      ["Teasing", ["happy"]],
      ["sleepy, a bit annoyed", ["angry", "lazy"]],
      ["unhappy and tired", []],
      ["warmly", []],
      ["SURPRISED!", ["surprised"]],
      ["curious and playful", ["thinking", "happy"]],
    ];
    for (const [direction, tags] of cases)
      expect([direction, moodTags(direction)]).toEqual([direction, tags]);
  });
});

describe("soundCueEffect", () => {
  test("decides every cue Fish reads, and nothing else", () => {
    expect([...CUE_EFFECTS.keys()].sort()).toEqual([...CUE_EMOJI.keys()].sort());
    for (const [name, effect] of CUE_EFFECTS) {
      if (effect === null) continue;
      expect([name, effect.seconds > 0]).toEqual([name, true]);
      if (effect.mood !== undefined) expect(MOOD_TAGS).toContain(effect.mood);
    }
    expect(soundCueEffect("懒洋洋的")).toBeNull();
    expect(soundCueEffect("break")).toBeNull();
  });

  test("chuckling and laughing lend happy for 1.5 s and nod", () => {
    for (const name of ["chuckling", "laughing", " Chuckling "]) {
      expect([name, soundCueEffect(name)]).toEqual([
        name,
        { mood: "happy", seconds: 1.5, gesture: "nod" },
      ]);
    }
    expect(soundCueEffect("sighing")).toMatchObject({ mood: "wry" });
    expect(soundCueEffect("gasping")).toMatchObject({ mood: "surprised" });
    expect(soundCueEffect("whispering")).toBeNull();
  });
});

describe("a model's moods", () => {
  test("every mood has its default expressions", () => {
    expect(Object.keys(DEFAULT_MOOD_EXPRESSIONS).sort()).toEqual([...MOOD_TAGS].sort());
    expect(DEFAULT_MOOD_EXPRESSIONS.thinking).toEqual([]);
  });

  test("two moods show their expressions' union in tag order, at most two", () => {
    const setup = resolveSetup(inventory());
    expect(moodExpressions(setup, moodTags("懒洋洋的，带点笑意"))).toEqual(["sleepy", "smile"]);
    expect(moodExpressions(setup, ["happy", "gentle"])).toEqual(["smile"]);
    expect(moodExpressions(setup, ["wry", "lazy"])).toEqual(["sad", "smile"]);
    expect(moodExpressions(setup, [])).toEqual([]);
  });

  test("defaults keep only the expressions the rig has; the owner's choices replace them", () => {
    const sparse = resolveSetup(inventory({ expressions: [{ id: "smile", name: "微笑" }] }));
    expect(sparse.moods.wry).toEqual(["smile"]);
    expect(sparse.moods.lazy).toEqual([]);
    const chosen = resolveSetup(inventory(), {
      moods: { lazy: ["smile", "sleepy", "shy"], sad: [], gentle: ["missing"], custom: ["shy"] },
    });
    expect(chosen.moods.lazy).toEqual(["smile", "sleepy"]);
    expect(chosen.moods.sad).toEqual([]);
    expect(chosen.moods.gentle).toEqual([]);
    expect(chosen.moods.happy).toEqual(["smile"]);
  });

  test("gestures match a clip by group, then name, then id, unless the owner picked one it has", () => {
    const clip = (id: string, name: string, group: string) => ({
      id,
      name,
      group,
      duration: 1,
      looping: false,
    });
    const setup = resolveSetup(
      inventory({
        clips: [
          clip("a", "Wave", "Idle"),
          clip("b", "Idle", "Extra"),
          clip("Talk", "Speak", ""),
          clip("c", "Nod", ""),
        ],
      }),
      { gestures: { nod: "a", shake: "missing" } },
    );
    expect(setup.gestures).toEqual({ idle: "a", talk: "Talk", nod: "a", shake: null });
  });

  test("a mood holds the parameters the owner gave it that the rig has, each once, in range", () => {
    const parameter = (id: string, min: number, max: number) => ({ id, min, max, default: 0 });
    const rig = inventory({
      expressions: [],
      parameters: [
        parameter("ParamEyeLSmile", -1, 1),
        parameter("ParamMouthForm", -1, 1),
        parameter("CheekPuff", 0, 1),
        ...Array.from({ length: 10 }, (_, i) => parameter(`p${i}`, 0, 1)),
      ],
    });
    const setup = resolveSetup(rig, {
      moodParameters: {
        happy: [
          { id: "ParamEyeLSmile", value: 1 },
          { id: "ParamMouthForm", value: 3 },
          { id: "ParamGone", value: 0.5 },
          { id: "ParamEyeLSmile", value: -1 },
          { id: "CheekPuff", value: Number.NaN },
        ],
        sad: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, value: 0.5 })),
        custom: [{ id: "CheekPuff", value: 1 }],
      },
    });
    expect(setup.moodParameters.happy).toEqual([
      { id: "ParamEyeLSmile", value: 1 },
      { id: "ParamMouthForm", value: 1 },
    ]);
    expect(setup.moodParameters.sad.map(({ id }) => id)).toEqual(
      Array.from({ length: 8 }, (_, i) => `p${i}`),
    );
    expect(setup.moodParameters.gentle).toEqual([]);
    expect(Object.keys(setup.moodParameters).sort()).toEqual([...MOOD_TAGS].sort());
    expect(resolveSetup(rig).moodParameters.happy).toEqual([]);

    // Two moods hold both moods' parameters, the first mood's value where both name one.
    const two = resolveSetup(rig, {
      moodParameters: {
        lazy: [{ id: "ParamEyeLSmile", value: -0.5 }],
        happy: [
          { id: "ParamEyeLSmile", value: 1 },
          { id: "ParamMouthForm", value: 1 },
        ],
      },
    });
    expect(moodSettings(two, ["lazy", "happy"])).toEqual([
      { id: "ParamEyeLSmile", value: -0.5 },
      { id: "ParamMouthForm", value: 1 },
    ]);
    expect(moodSettings(two, [])).toEqual([]);
  });

  test("her look is the owner's, kept within 0..1, and all of the runtime's turn without one", () => {
    expect(resolveSetup(inventory()).look).toBe(1);
    expect(resolveSetup(inventory(), { look: 0.35 }).look).toBe(0.35);
    expect(resolveSetup(inventory(), { look: 0 }).look).toBe(0);
    expect(resolveSetup(inventory(), { look: 1.5 }).look).toBe(1);
    expect(resolveSetup(inventory(), { look: -0.2 }).look).toBe(0);
    expect(resolveSetup(inventory(), { look: Number.NaN }).look).toBe(1);
  });
});
