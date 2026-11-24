import { describe, expect, test } from "vitest";
import type { CharacterModel, CharacterModels, ModelOutfit } from "@/lib/api";
import type { CompanionPick } from "@/lib/desktop";
import { menuState, pageAction, pickHolds } from "./menu";
import { type CompanionCall, NO_COMPANION_CALL } from "./protocol";

const outfit = (id: string): ModelOutfit => ({
  id,
  name: `Outfit ${id}`,
  poses: [],
  parameters: [],
  hiddenParts: [],
});

function model(id: string, outfits: readonly ModelOutfit[] = [], worn: string | null = null) {
  return {
    id,
    name: `Model ${id}`,
    kind: "psd2live",
    size: 1,
    sha256: "ab12",
    importedAt: "2026-11-23T00:00:00.000Z",
    updatedAt: "2026-11-23T00:00:00.000Z",
    inventory: {
      runtime: "0.1.0",
      generator: null,
      canvas: { width: 100, height: 100 },
      clips: [],
      expressions: [],
      hitAreas: [],
      parameters: [],
      parts: [],
      poseGroups: [],
      lipSync: false,
      textures: 1,
    },
    framing: { call: null, companion: null },
    moods: {},
    gestures: {},
    outfits,
    outfit: worn,
  } satisfies CharacterModel;
}

const UP: CompanionCall = { up: true, live: true, hers: true, micOn: false, callable: false };
const CALLABLE: CompanionCall = { ...NO_COMPANION_CALL, callable: true };

describe("menuState", () => {
  const models: CharacterModels = {
    active: "a",
    models: [model("a", [outfit("school"), outfit("summer")], "summer"), model("b")],
  };

  test("the call: up while one is, Call places hers while linked and callable, else opens /call", () => {
    expect(menuState({ linked: true, call: UP, models }).call).toBe("up");
    expect(menuState({ linked: false, call: UP, models }).call).toBe("up");
    expect(menuState({ linked: true, call: CALLABLE, models }).call).toBe("idle");
    expect(menuState({ linked: false, call: CALLABLE, models }).call).toBe("open");
    expect(menuState({ linked: true, call: NO_COMPANION_CALL, models }).call).toBe("open");
  });

  test("the microphone and the call's phase come from the call", () => {
    expect(menuState({ linked: true, call: UP, models })).toMatchObject({
      live: true,
      micOn: false,
    });
    expect(
      menuState({ linked: true, call: { ...UP, live: false, micOn: true }, models }),
    ).toMatchObject({
      live: false,
      micOn: true,
    });
  });

  test("her models by id and name, the active one's outfits and the one she wears", () => {
    expect(menuState({ linked: true, call: NO_COMPANION_CALL, models })).toEqual({
      call: "open",
      live: false,
      micOn: true,
      models: [
        { id: "a", name: "Model a" },
        { id: "b", name: "Model b" },
      ],
      model: "a",
      outfits: [
        { id: "school", name: "Outfit school" },
        { id: "summer", name: "Outfit summer" },
      ],
      outfit: "summer",
    });
  });

  test("lists are capped, and a worn outfit past the cap reads as none", () => {
    const outfits = Array.from({ length: 40 }, (_, i) => outfit(`o${i}`));
    const many: CharacterModels = {
      active: "m55",
      models: Array.from({ length: 60 }, (_, i) =>
        i === 55 ? model(`m${i}`, outfits, "o35") : model(`m${i}`),
      ),
    };
    const state = menuState({ linked: true, call: NO_COMPANION_CALL, models: many });
    expect(state.models).toHaveLength(50);
    // The active model can fall past the cap: it is still named, so main checks no item.
    expect(state.model).toBe("m55");
    expect(state.outfits).toHaveLength(32);
    expect(state.outfit).toBeNull();
  });

  test("an outfit she no longer has reads as none", () => {
    const gone: CharacterModels = {
      active: "a",
      models: [model("a", [outfit("school")], "summer")],
    };
    expect(menuState({ linked: true, call: NO_COMPANION_CALL, models: gone }).outfit).toBeNull();
  });

  test("with no active model, her models are listed, none is hers, and she has no outfits", () => {
    const none: CharacterModels = {
      active: null,
      models: [model("a", [outfit("school")]), model("b")],
    };
    const state = menuState({ linked: true, call: NO_COMPANION_CALL, models: none });
    expect(state.models.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(state.model).toBeNull();
    expect(state.outfits).toEqual([]);
    expect(state.outfit).toBeNull();
  });

  test("before her models are read, the menu holds none", () => {
    expect(menuState({ linked: false, call: NO_COMPANION_CALL, models: undefined })).toEqual({
      call: "open",
      live: false,
      micOn: true,
      models: [],
      model: null,
      outfits: [],
      outfit: null,
    });
  });
});

describe("pageAction", () => {
  test("a model or an outfit is hers to change; As Exported takes the outfit off", () => {
    expect(pageAction("model:b")).toEqual({ kind: "model", id: "b" });
    expect(pageAction("outfit:school")).toEqual({ kind: "outfit", id: "school" });
    expect(pageAction("outfit:")).toEqual({ kind: "outfit", id: null });
  });

  test("main's picks, the call's included, are never hers", () => {
    const picks: (CompanionPick | null)[] = [
      "call",
      "hang-up",
      "mute",
      "unmute",
      "open",
      "size:large",
      "always-on-top",
      "hide",
      "model:",
      null,
    ];
    for (const pick of picks) expect(pageAction(pick)).toBeNull();
  });
});

describe("pickHolds", () => {
  const opened = { persona: "milky-green", model: "tml" };

  test("a pick acts on the persona and model her menu listed while they're still hers", () => {
    expect(pickHolds(opened, opened, { kind: "model", id: "other" })).toBe(true);
    expect(pickHolds(opened, opened, { kind: "outfit", id: "summer" })).toBe(true);
  });

  test("another persona since takes every pick away, another model an outfit's", () => {
    const now = { persona: "hazel", model: "tml" };
    expect(pickHolds(opened, now, { kind: "model", id: "tml" })).toBe(false);
    expect(pickHolds(opened, now, { kind: "outfit", id: null })).toBe(false);
    const swapped = { ...opened, model: "other" };
    expect(pickHolds(opened, swapped, { kind: "outfit", id: "summer" })).toBe(false);
    expect(pickHolds(opened, swapped, { kind: "model", id: "tml" })).toBe(true);
  });

  test("with no persona read, nothing holds", () => {
    const unread = { persona: undefined, model: undefined };
    expect(pickHolds(unread, unread, { kind: "model", id: "tml" })).toBe(false);
  });
});
