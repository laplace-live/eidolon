// The mood table on prompt.md's published directions and others written in their style.
import { describe, expect, test } from "vitest";
import { type ModelInventory, moodExpressions, resolveSetup } from "../src/avatar/model.ts";
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
});
