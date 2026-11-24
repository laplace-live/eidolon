import type { Box } from "@laplace.live/eidolon-sdk/avatar";
import { describe, expect, test } from "vitest";
import type { CharacterModel, ModelInventory, ModelOutfit } from "@/lib/api";
import {
  activeModelOf,
  boxScale,
  clampBox,
  draftChanges,
  draftOf,
  draftProblem,
  gestureClip,
  keptDraft,
  MAX_OUTFITS,
  type ModelDraft,
  moodExpressions,
  nameProblem,
  newOutfitId,
  newOutfitName,
  nudgedBox,
  pinchStep,
  rebaseDraft,
  rigPointAt,
  sameValue,
  shownRect,
  toggledExpression,
  withGesture,
  withHiddenParts,
  withMood,
  withNewOutfit,
  withOutfit,
  withoutGesture,
  withoutMood,
  withoutOutfit,
  withParameter,
  withPose,
} from "./model-draft";

const INVENTORY: ModelInventory = {
  runtime: "0.1.0",
  generator: "psd2live 3.8.4",
  canvas: { width: 2048, height: 2048 },
  clips: [
    { id: "modifier:m32:6d6f74696f6e", name: "Idle", group: "Idle", duration: 12, looping: true },
    { id: "modifier:m34:6d6f74696f6e", name: "Nod", group: "Nod", duration: 1.58, looping: false },
    { id: "wave", name: "Wave", group: "Extra", duration: 2, looping: false },
  ],
  expressions: [
    { id: "smile", name: "微笑" },
    { id: "sad", name: "悲伤" },
    { id: "sleepy", name: "困倦" },
    { id: "angry", name: "生气" },
  ],
  hitAreas: [{ id: "HitAreaHead", name: "头部" }],
  parameters: [
    { id: "ParamCheek", min: 0, max: 1, default: 0 },
    { id: "ParamAngleX", min: -45, max: 45, default: 0 },
  ],
  parts: [
    { id: "hat", name: "帽子" },
    { id: "bag", name: "包" },
  ],
  poseGroups: [2, 3],
  lipSync: true,
  textures: 6,
};

const SCHOOL: ModelOutfit = {
  id: "outfit-1",
  name: "School",
  poses: [{ group: 0, entry: 1 }],
  parameters: [{ id: "ParamCheek", value: 0.5 }],
  hiddenParts: ["hat"],
};

const SAVED: CharacterModel = {
  id: "tml",
  name: "tml",
  kind: "psd2live",
  size: 3_471_396,
  sha256: "59c6".padEnd(64, "0"),
  importedAt: "2026-11-23T00:00:00.000Z",
  updatedAt: "2026-11-23T00:00:00.000Z",
  inventory: INVENTORY,
  framing: { call: null, companion: null },
  moods: { happy: ["sad"] },
  gestures: { nod: "wave" },
  outfits: [SCHOOL],
  outfit: null,
};

describe("the draft", () => {
  test("holds the fields Studio edits, and nothing it doesn't", () => {
    expect(draftOf(SAVED)).toEqual({
      framing: { call: null, companion: null },
      moods: { happy: ["sad"] },
      gestures: { nod: "wave" },
      outfits: [SCHOOL],
      outfit: null,
    });
  });

  test("compares by value, whatever order an object's keys are in", () => {
    expect(sameValue({ a: [1, { b: 2, c: null }] }, { a: [1, { c: null, b: 2 }] })).toBe(true);
    expect(sameValue({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue(null, {})).toBe(false);
    expect(sameValue([], {})).toBe(false);
    expect(sameValue("x", "x")).toBe(true);
  });

  test("Save sends only the fields that changed", () => {
    const draft = draftOf(SAVED);
    expect(draftChanges(draft, SAVED)).toEqual({});
    const moved = {
      ...draft,
      framing: { call: { x: 1, y: 2, width: 3, height: 4 }, companion: null },
    };
    expect(draftChanges(moved, SAVED)).toEqual({ framing: moved.framing });
    const worn = { ...draft, moods: { happy: ["sad"] }, outfit: "outfit-1" };
    expect(draftChanges(worn, SAVED)).toEqual({ outfit: "outfit-1" });
  });

  test("outfits go with their names trimmed, so spaces typed around one change nothing", () => {
    const spaced = withOutfit(draftOf(SAVED), { ...SCHOOL, name: "  School " });
    expect(draftChanges(spaced, SAVED)).toEqual({});
    const renamed = withOutfit(draftOf(SAVED), { ...SCHOOL, name: " Summer " });
    expect(draftChanges(renamed, SAVED)).toEqual({ outfits: [{ ...SCHOOL, name: "Summer" }] });
  });

  test("a rename elsewhere keeps the edits; a Save takes the server's answer", () => {
    const edited = { ...draftOf(SAVED), outfit: "outfit-1" };
    const renamed = { ...SAVED, name: "Tml", moods: { happy: ["smile"] } };
    expect(rebaseDraft(edited, draftOf(SAVED), draftOf(renamed))).toEqual({
      ...draftOf(renamed),
      outfit: "outfit-1",
    });
    const sent = withOutfit(edited, { ...SCHOOL, name: "School " });
    const answer = { ...SAVED, outfit: "outfit-1" };
    expect(rebaseDraft(sent, sent, draftOf(answer))).toEqual(draftOf(answer));
    // What was typed while it was out stays.
    const typed = { ...sent, gestures: {} };
    expect(rebaseDraft(typed, sent, draftOf(answer)).gestures).toEqual({});
  });

  test("a field put back while its Save is out stays put back, whatever reaches the card first", () => {
    const saved = draftOf(SAVED);
    const sent = { ...saved, moods: { happy: ["sad", "smile"] } };
    const answer = draftOf({ ...SAVED, moods: sent.moods });
    expect(rebaseDraft(saved, saved, answer, sent)).toEqual(saved);
    // The server trims the names it was sent, which makes its answer no less the Save's.
    const spaced = withOutfit(saved, { ...SCHOOL, name: " Summer " });
    const trimmed = draftOf({ ...SAVED, outfits: [{ ...SCHOOL, name: "Summer" }] });
    expect(rebaseDraft(saved, saved, trimmed, spaced)).toEqual(saved);
    // A rename from before the Save reached the server leaves what was sent.
    const renamed: CharacterModel = { ...SAVED, name: "Tml" };
    expect(rebaseDraft(sent, saved, draftOf(renamed), sent)).toEqual(sent);
  });
});

describe("names", () => {
  test("one line of 1 to 64 characters, as the server takes them", () => {
    expect(nameProblem("School")).toBeNull();
    expect(nameProblem("  ")).toBe("empty");
    expect(nameProblem("制".repeat(64))).toBeNull();
    expect(nameProblem("制".repeat(65))).toBe("long");
    expect(nameProblem(` ${"a".repeat(64)} `)).toBeNull();
    expect(nameProblem("a\tb")).toBe("invalid");
    expect(nameProblem("a\nb")).toBe("invalid");
  });

  test("an outfit the server would refuse holds Save back", () => {
    const draft = withNewOutfit(draftOf(SAVED), "");
    expect(draftProblem(draftOf(SAVED))).toBeNull();
    expect(draftProblem(draft)).toEqual({ outfit: "outfit-2", problem: "empty" });
  });
});

describe("moods", () => {
  test("a mood shows the owner's choice, else the default the model has", () => {
    expect(moodExpressions(INVENTORY, SAVED.moods, "happy")).toEqual(["sad"]);
    expect(moodExpressions(INVENTORY, SAVED.moods, "lazy")).toEqual(["sleepy"]);
    expect(moodExpressions(INVENTORY, {}, "wry")).toEqual(["sad", "smile"]);
    expect(moodExpressions(INVENTORY, {}, "surprised")).toEqual([]);
    expect(moodExpressions(INVENTORY, { thinking: ["angry"] }, "thinking")).toEqual(["angry"]);
  });

  test("a choice is kept, at most two of the model's own, and none is a choice too", () => {
    expect(withMood(INVENTORY, {}, "happy", ["angry"])).toEqual({ happy: ["angry"] });
    expect(withMood(INVENTORY, {}, "happy", [])).toEqual({ happy: [] });
    expect(withMood(INVENTORY, {}, "sad", ["gone", "angry", "angry", "smile", "sad"])).toEqual({
      sad: ["angry", "smile"],
    });
  });

  test("choosing the default again is no choice at all", () => {
    expect(withMood(INVENTORY, { happy: ["sad"] }, "happy", ["smile"])).toEqual({});
    expect(withMood(INVENTORY, { thinking: ["sad"] }, "thinking", [])).toEqual({});
    expect(withoutMood({ happy: ["sad"], sad: [] }, "happy")).toEqual({ sad: [] });
    const moods = { sad: [] };
    expect(withoutMood(moods, "happy")).toBe(moods);
  });

  test("an expression toggles in while there is room", () => {
    expect(toggledExpression([], "smile")).toEqual(["smile"]);
    expect(toggledExpression(["smile"], "sad")).toEqual(["smile", "sad"]);
    expect(toggledExpression(["smile", "sad"], "smile")).toEqual(["sad"]);
    expect(toggledExpression(["smile", "sad"], "angry")).toBeNull();
  });
});

describe("gestures", () => {
  test("a gesture plays the owner's clip, else the default the model has", () => {
    expect(gestureClip(INVENTORY, SAVED.gestures, "nod")).toBe("wave");
    expect(gestureClip(INVENTORY, {}, "nod")).toBe("modifier:m34:6d6f74696f6e");
    expect(gestureClip(INVENTORY, {}, "talk")).toBeNull();
  });

  test("a choice is a clip the model has, and the default again is none", () => {
    expect(withGesture(INVENTORY, {}, "talk", "wave")).toEqual({ talk: "wave" });
    expect(withGesture(INVENTORY, { nod: "wave" }, "nod", "modifier:m34:6d6f74696f6e")).toEqual({});
    expect(withGesture(INVENTORY, { nod: "wave" }, "nod", "gone")).toEqual({});
    expect(withoutGesture({ nod: "wave", idle: "wave" }, "nod")).toEqual({ idle: "wave" });
  });
});

describe("outfits", () => {
  test("a new outfit takes the lowest free id, up to the server's limit", () => {
    expect(newOutfitId([])).toBe("outfit-1");
    expect(newOutfitId([{ id: "outfit-1" }, { id: "outfit-3" }])).toBe("outfit-2");
    const added = withNewOutfit(draftOf(SAVED), "Summer");
    expect(added.outfits.at(-1)).toEqual({
      id: "outfit-2",
      name: "Summer",
      poses: [],
      parameters: [],
      hiddenParts: [],
    });
    let full: ModelDraft = { ...draftOf(SAVED), outfits: [] };
    for (let n = 0; n < MAX_OUTFITS + 3; n++) full = withNewOutfit(full, `${n}`);
    expect(full.outfits).toHaveLength(MAX_OUTFITS);
  });

  test("a new outfit is named with the lowest number no outfit's name has", () => {
    const named = (n: number) => `Outfit ${n}`;
    expect(newOutfitName([], named)).toBe("Outfit 1");
    expect(newOutfitName([{ name: "Outfit 2" }, { name: "Outfit 2" }], named)).toBe("Outfit 1");
    expect(newOutfitName([{ name: " Outfit 1" }, { name: "Outfit 2" }], named)).toBe("Outfit 3");
    // A translation that drops the number can't make a free name; it still makes one.
    expect(newOutfitName([{ name: "Outfit" }], () => "Outfit")).toBe("Outfit");
  });

  test("taking away the one she wears leaves her in none", () => {
    const worn = { ...draftOf(SAVED), outfit: "outfit-1" };
    expect(withoutOutfit(worn, "outfit-1")).toMatchObject({ outfits: [], outfit: null });
    const other = withoutOutfit(withNewOutfit(worn, "Summer"), "outfit-2");
    expect(other).toMatchObject({ outfits: [SCHOOL], outfit: "outfit-1" });
  });

  test("a pose group shows one entry, or the one it loads with", () => {
    expect(withPose(SCHOOL, 1, 2).poses).toEqual([
      { group: 0, entry: 1 },
      { group: 1, entry: 2 },
    ]);
    expect(withPose(SCHOOL, 0, 0).poses).toEqual([{ group: 0, entry: 0 }]);
    expect(withPose(SCHOOL, 0, null).poses).toEqual([]);
  });

  test("a parameter is held within its range, once, or let go", () => {
    expect(withParameter(INVENTORY, SCHOOL, "ParamAngleX", 60).parameters).toEqual([
      { id: "ParamCheek", value: 0.5 },
      { id: "ParamAngleX", value: 45 },
    ]);
    expect(withParameter(INVENTORY, SCHOOL, "ParamCheek", -1).parameters).toEqual([
      { id: "ParamCheek", value: 0 },
    ]);
    expect(withParameter(INVENTORY, SCHOOL, "ParamCheek", null).parameters).toEqual([]);
    expect(withParameter(INVENTORY, SCHOOL, "gone", 1).parameters).toEqual(SCHOOL.parameters);
  });

  test("a part is hidden once", () => {
    expect(withHiddenParts(SCHOOL, ["bag", "hat", "bag"]).hiddenParts).toEqual(["bag", "hat"]);
  });
});

describe("framing", () => {
  const box = { x: 800, y: 300, width: 400, height: 500 };
  const wide = { width: 800, height: 500 };

  test("a box shows whole and centred, touching two sides", () => {
    expect(boxScale(box, wide)).toBe(1);
    expect(shownRect(box, wide)).toEqual({ left: 200, top: 0, width: 400, height: 500 });
    expect(shownRect(box, { width: 200, height: 500 })).toEqual({
      left: 0,
      top: 125,
      width: 200,
      height: 250,
    });
  });

  test("a point of the element is found on her canvas", () => {
    expect(rigPointAt(box, wide, [400, 250])).toEqual([1000, 550]);
    expect(rigPointAt(box, wide, [200, 0])).toEqual([800, 300]);
    expect(rigPointAt(box, { width: 400, height: 250 }, [0, 0])).toEqual([600, 300]);
    expect(rigPointAt(box, { width: 0, height: 0 }, [10, 10])).toEqual([1000, 550]);
  });

  test("a frame stays where she can be found, within a size", () => {
    const canvas = { width: 2048, height: 2048 };
    expect(clampBox(box, canvas)).toEqual(box);
    expect(clampBox({ x: 5000, y: -3000, width: 400, height: 500 }, canvas)).toEqual({
      x: 1848,
      y: -250,
      width: 400,
      height: 500,
    });
    const tiny = clampBox({ x: 1000, y: 1000, width: 8, height: 10 }, canvas);
    expect(tiny.height).toBeCloseTo(2048 / 50);
    expect(tiny.width / tiny.height).toBeCloseTo(0.8);
    expect(clampBox({ x: 0, y: 0, width: 8000, height: 10000 }, canvas).height).toBe(6144);
    expect(clampBox({ x: 1 / 3, y: 2 / 3, width: 400, height: 500 }, canvas)).toEqual({
      x: 0.33,
      y: 0.67,
      width: 400,
      height: 500,
    });
  });

  test("a nudge moves her, so the frame goes the other way", () => {
    expect(nudgedBox(box, 1, 0)).toEqual({ ...box, x: 780 });
    expect(nudgedBox(box, 0, -1)).toEqual({ ...box, y: 325 });
  });

  type Point = readonly [number, number];
  type Move = { readonly finger: 0 | 1; readonly to: Point };

  /** `from` after `moves`, each moving one finger as a pointermove does, the other where it was. */
  function touched(from: Box, fingers: readonly [Point, Point], moves: readonly Move[]): Box {
    const at: [Point, Point] = [...fingers];
    let frame = from;
    for (const { finger, to } of moves) {
      const step = pinchStep(wide, at[1 - finger], at[finger], to);
      if (step === null) throw new Error("the fingers met");
      frame = step(frame);
      at[finger] = to;
    }
    return frame;
  }

  const near = (point: Point) => point.map((value) => expect.closeTo(value, 6));

  test("a pinch keeps what is under each finger under it", () => {
    const still: Point = [300, 250];
    const moving: Point = [400, 250];
    const spread = Array.from(
      { length: 15 },
      (_, n): Move => ({ finger: 1, to: [410 + n * 10, 250] }),
    );
    const pinched = touched(box, [still, moving], spread);
    expect(box.height / pinched.height).toBeCloseTo(2.5);
    expect(rigPointAt(pinched, wide, still)).toEqual(near(rigPointAt(box, wide, still)));
    expect(rigPointAt(pinched, wide, [550, 250])).toEqual(near(rigPointAt(box, wide, moving)));
  });

  test("two fingers dragged together carry her with them", () => {
    const left: Point = [300, 250];
    const right: Point = [500, 250];
    const drag = Array.from({ length: 10 }, (_, n): Move[] => [
      { finger: 0, to: [300 + (n + 1) * 10, 250 - (n + 1) * 5] },
      { finger: 1, to: [500 + (n + 1) * 10, 250 - (n + 1) * 5] },
    ]).flat();
    const dragged = touched(box, [left, right], drag);
    expect(dragged.height).toBeCloseTo(box.height);
    expect(rigPointAt(dragged, wide, [400, 200])).toEqual(near(rigPointAt(box, wide, left)));
    expect(rigPointAt(dragged, wide, [600, 200])).toEqual(near(rigPointAt(box, wide, right)));
  });

  test("fingers that meet leave the frame alone", () => {
    expect(pinchStep(wide, [10, 10], [10, 10], [20, 20])).toBeNull();
    expect(pinchStep(wide, [10, 10], [20, 20], [10, 10])).toBeNull();
  });
});

describe("a new file", () => {
  test("keeps what of the draft its rig still has, as the server keeps what was saved", () => {
    const rig: ModelInventory = {
      ...INVENTORY,
      clips: INVENTORY.clips.filter(({ id }) => id !== "wave"),
      expressions: INVENTORY.expressions.filter(({ id }) => id !== "sad"),
      parameters: [{ id: "ParamCheek", min: 0, max: 0.4, default: 0 }],
      parts: [{ id: "bag", name: "包" }],
      poseGroups: [2],
    };
    const draft: ModelDraft = {
      framing: { call: { x: 1, y: 2, width: 3, height: 4 }, companion: null },
      moods: { happy: ["sad"], sad: ["sad", "smile"], thinking: [] },
      gestures: { nod: "wave", idle: "modifier:m32:6d6f74696f6e" },
      outfits: [
        {
          ...SCHOOL,
          poses: [
            { group: 0, entry: 1 },
            { group: 1, entry: 0 },
          ],
          parameters: [
            { id: "ParamCheek", value: 0.5 },
            { id: "ParamAngleX", value: 3 },
          ],
          hiddenParts: ["hat", "bag"],
        },
      ],
      outfit: "outfit-1",
    };
    expect(keptDraft(draft, rig)).toEqual({
      framing: draft.framing,
      // A mood left with none of its expressions goes back to its default; none chosen stays none.
      moods: { sad: ["smile"], thinking: [] },
      gestures: { idle: "modifier:m32:6d6f74696f6e" },
      outfits: [
        {
          ...SCHOOL,
          poses: [{ group: 0, entry: 1 }],
          parameters: [{ id: "ParamCheek", value: 0.4 }],
          hiddenParts: ["bag"],
        },
      ],
      outfit: "outfit-1",
    });
  });
});

describe("her active model", () => {
  const OTHER = { ...SAVED, id: "other" };
  const list = (active: string | null) => ({ active, models: [SAVED, OTHER] });

  test("comes from her own setting, else from the environment's", () => {
    expect(activeModelOf(list("tml"), { value: "tml", envValue: null })).toEqual({
      id: "tml",
      own: true,
      fallback: null,
    });
    for (const value of [null, ""]) {
      expect(activeModelOf(list("tml"), { value, envValue: "tml" })).toEqual({
        id: "tml",
        own: false,
        fallback: "tml",
      });
    }
  });

  test("falls back to the environment's model once hers is cleared, while she has it", () => {
    const own = (envValue: string) =>
      activeModelOf(list("tml"), { value: "tml", envValue })?.fallback;
    expect(own("tml")).toBe("tml");
    expect(own("other")).toBe("other");
    expect(own("gone")).toBeNull();
  });

  test("is none while she shows none, and unknown until her setting loads", () => {
    expect(activeModelOf(list(null), { value: "gone", envValue: null })).toBeNull();
    expect(activeModelOf(list("tml"), undefined)).toBeNull();
  });
});
