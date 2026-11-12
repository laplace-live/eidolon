import { describe, expect, test } from "bun:test";
import type { VoiceStyle } from "@/lib/api";
import { builtInHint, nameProblem, withoutStyle, withStyle } from "./voice-styles";

const gentle: VoiceStyle = { name: "gentle", voiceId: "g", hint: "" };
const naiHei: VoiceStyle = { name: "nai_hei", voiceId: "n", hint: "奶黑" };
const lively: VoiceStyle = { name: "lively", voiceId: "l", hint: "" };
const own = [gentle, naiHei];

describe("nameProblem", () => {
  test("a new name: a lowercase letter, then letters, digits or _, and never her own voice's", () => {
    expect(nameProblem("lively", own, "")).toBeNull();
    expect(nameProblem("calm_2", own, "")).toBeNull();
    expect(nameProblem("", own, "")).toBe("empty");
    expect(nameProblem("default", own, "")).toBe("default");
    for (const name of ["Gentle", "2calm", "_x", "nai-hei", "温柔", "a".repeat(33)]) {
      expect(nameProblem(name, own, ""), name).toBe("pattern");
    }
  });

  test("another style's name is taken; the one being edited keeps its own", () => {
    expect(nameProblem("gentle", own, "")).toBe("taken");
    expect(nameProblem("gentle", own, "nai_hei")).toBe("taken");
    expect(nameProblem("gentle", own, "gentle")).toBeNull();
    expect(nameProblem("", own, "gentle")).toBe("empty");
  });

  test("a name a hand-written file or a variable gave a style stays while it is kept", () => {
    const written = [
      { name: "nai-hei", voiceId: "n", hint: "" },
      { ...gentle, name: "default" },
    ];
    expect(nameProblem("nai-hei", written, "nai-hei")).toBeNull();
    expect(nameProblem("default", written, "default")).toBeNull();
    expect(nameProblem("nai-hei", written, "")).toBe("pattern");
    // The environment's TTS_VOICE_ID_2D, customized: not hers yet, and named as it was.
    expect(nameProblem("2d", own, "2d")).toBeNull();
    expect(nameProblem("2e", own, "2d")).toBe("pattern");
  });
});

test("a new style goes last; an edited one keeps its place, renamed or not", () => {
  expect(withStyle(own, null, lively)).toEqual([gentle, naiHei, lively]);
  expect(withStyle(own, "gentle", lively)).toEqual([lively, naiHei]);
  const reworded = { ...naiHei, hint: "黑化" };
  expect(withStyle(own, "nai_hei", reworded)).toEqual([gentle, reworded]);
  expect(own).toEqual([gentle, naiHei]);
});

test("withoutStyle drops one by name", () => {
  expect(withoutStyle(own, "gentle")).toEqual([naiHei]);
  expect(withoutStyle(own, "calm")).toEqual(own);
});

test("builtInHint reads only the map's own words", () => {
  const hints = { gentle: "温柔" };
  expect(builtInHint("gentle", hints)).toBe("温柔");
  expect(builtInHint("nai_hei", hints)).toBeNull();
  expect(builtInHint("constructor", hints)).toBeNull();
});
