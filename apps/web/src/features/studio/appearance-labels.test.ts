import { GESTURES, MOOD_TAGS } from "@laplace.live/eidolon-sdk/avatar";
import { expect, test, vi } from "vitest";
import { linguiMacro } from "@/test/lingui-macro";
import { CHARACTER_MODEL_KINDS } from "../../../../bot/src/local/api.ts";

vi.doMock("@lingui/core/macro", linguiMacro);
const { GESTURE_LABELS, MODEL_KIND_LABELS, MOOD_LABELS, NAME_PROBLEMS, STAGE_ERRORS } =
  await import("./appearance-labels");

/** Each key's message, which must be there and its own. */
function messages(
  labels: Readonly<Record<string, { readonly message?: string }>>,
  keys: readonly string[],
): string[] {
  expect(Object.keys(labels).sort()).toEqual([...keys].sort());
  const texts = keys.map((key) => labels[key]?.message ?? "");
  expect(texts.filter((text) => text === "")).toEqual([]);
  expect(new Set(texts).size).toBe(keys.length);
  return texts;
}

test("every mood her cues tag has its own label", () => {
  expect(messages(MOOD_LABELS, MOOD_TAGS)).toContain("Pouting");
});

test("every gesture has its own label", () => {
  expect(messages(GESTURE_LABELS, GESTURES)).toEqual(["Idle", "Talking", "Nod", "Head Shake"]);
});

test("every kind of model is named for what it is", () => {
  expect(messages(MODEL_KIND_LABELS, CHARACTER_MODEL_KINDS)).toEqual(["2D Model · PSD2Live"]);
  expect(
    Object.values(MODEL_KIND_LABELS).some((label) => /live2d/i.test(label.message ?? "")),
  ).toBe(false);
});

test("every way a model can fail to show has its own sentence", () => {
  messages(STAGE_ERRORS, ["runtime", "rig", "webgl", "lost", "trap"]);
});

test("every name the server refuses says why", () => {
  expect(messages(NAME_PROBLEMS, ["empty", "long", "invalid"])).toContain(
    "A name can be up to 64 characters.",
  );
});
