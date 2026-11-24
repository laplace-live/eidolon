import type { Bounds } from "@laplace.live/eidolon-sdk/avatar";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CharacterModel, ModelInventory, ModelOutfit } from "./api";
import {
  characterModelFileQuery,
  characterModelsQuery,
  defaultCallBox,
  headAreaOf,
  outfitOf,
  setupOf,
} from "./character-models";

afterEach(() => {
  vi.restoreAllMocks();
});

const INVENTORY: ModelInventory = {
  runtime: "0.1.0",
  generator: "psd2live 3.8.4",
  canvas: { width: 2000, height: 3000 },
  clips: [
    { id: "modifier:m32:6d6f74696f6e", name: "Idle", group: "Idle", duration: 12, looping: true },
    { id: "modifier:m34:6d6f74696f6e", name: "Nod", group: "Nod", duration: 1.6, looping: false },
    { id: "wave", name: "Wave", group: "Extra", duration: 2, looping: false },
  ],
  expressions: [
    { id: "smile", name: "微笑" },
    { id: "sad", name: "悲伤" },
    { id: "sleepy", name: "困倦" },
  ],
  hitAreas: [
    { id: "HitAreaHead", name: "头部" },
    { id: "HitAreaBody", name: "身体" },
  ],
  parameters: [],
  parts: [],
  poseGroups: [],
  lipSync: true,
  textures: 1,
};

/** Calls a query's queryFn as TanStack Query would. */
function run<T>(options: { readonly queryFn?: unknown }): Promise<T> {
  const queryFn = options.queryFn as (context: { signal: AbortSignal }) => Promise<T>;
  return queryFn({ signal: new AbortController().signal });
}

describe("the queries", () => {
  test("her models are under her key", async () => {
    const list = { active: null, models: [] };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(list));
    const query = characterModelsQuery("milky-green");
    expect(query.queryKey).toEqual(["personas", "milky-green", "models"]);
    expect(await run(query)).toEqual(list);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/local/personas/milky-green/models");
  });

  test("a model's file is beside the list, by its sha256, kept for good while shown", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(Uint8Array.of(0x50, 0x32)));
    const query = characterModelFileQuery("milky-green", "tml", "ab12");
    expect(query.queryKey).toEqual(["personas", "milky-green", "model-file", "tml", "ab12"]);
    expect(query.staleTime).toBe(Number.POSITIVE_INFINITY);
    expect(query.gcTime).toBe(60_000);
    const body = await run<ArrayBuffer>(query);
    expect([...new Uint8Array(body)]).toEqual([0x50, 0x32]);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/api/local/personas/milky-green/models/tml/file?sha256=ab12",
    );
    // Refreshing the list never reaches a file's key.
    const list = characterModelsQuery("milky-green").queryKey;
    expect(query.queryKey.slice(0, list.length)).not.toEqual(list);
  });
});

describe("headAreaOf", () => {
  const areas = (...hitAreas: ModelInventory["hitAreas"]) => headAreaOf({ hitAreas });

  test("finds the head by its id or its name, in any case", () => {
    expect(headAreaOf(INVENTORY)).toBe("HitAreaHead");
    expect(areas({ id: "area1", name: "Body" }, { id: "area2", name: "Head" })).toBe("area2");
    expect(areas({ id: "HEAD_box", name: "" })).toBe("HEAD_box");
  });

  test("takes the first of two, and none without one", () => {
    expect(areas({ id: "headA", name: "" }, { id: "headB", name: "" })).toBe("headA");
    expect(areas({ id: "HitAreaBody", name: "身体" })).toBeNull();
    expect(areas()).toBeNull();
  });
});

describe("defaultCallBox", () => {
  const head: Bounds = { x0: 900, y0: 400, x1: 1100, y1: 610 };
  const character: Bounds = { x0: 500, y0: 300, x1: 1500, y1: 2900 };

  function model(inventory: ModelInventory, bounds: Readonly<Record<string, Bounds | null>>) {
    const asked: (string | null | undefined)[] = [];
    return {
      asked,
      inventory,
      bounds(area?: string | null) {
        asked.push(area);
        return bounds[area ?? ""] ?? null;
      },
    };
  }

  test("frames her bust around the head's hit area", () => {
    const box = defaultCallBox(model(INVENTORY, { HitAreaHead: head, "": character }));
    // The head is 0.42 of the bust's height, its centre 40% down, the bust 0.8 as wide as tall.
    expect(box.height).toBeCloseTo(210 / 0.42);
    expect(box.width).toBeCloseTo(box.height * 0.8);
    expect(box.x + box.width / 2).toBeCloseTo(1000);
    expect(box.y + box.height * 0.4).toBeCloseTo(505);
  });

  test("without a head area, the top third of her, never her whole bounds as a head", () => {
    const fake = model({ ...INVENTORY, hitAreas: [] }, { "": character });
    expect(defaultCallBox(fake)).toEqual({ x: 500, y: 300, width: 1000, height: 2600 / 3 });
    expect(fake.asked).toEqual([null]);
  });

  test("with nothing drawn, the whole canvas stands for her", () => {
    expect(defaultCallBox(model({ ...INVENTORY, hitAreas: [] }, {}))).toEqual({
      x: 0,
      y: 0,
      width: 2000,
      height: 1000,
    });
  });
});

describe("outfitOf", () => {
  const school: ModelOutfit = {
    id: "school",
    name: "School",
    poses: [],
    parameters: [],
    hiddenParts: [],
  };

  test("the outfit she wears, or none", () => {
    expect(outfitOf({ outfits: [school], outfit: "school" })).toBe(school);
    expect(outfitOf({ outfits: [school], outfit: null })).toBeNull();
  });

  test("an id no longer listed is none", () => {
    expect(outfitOf({ outfits: [school], outfit: "summer" })).toBeNull();
    expect(outfitOf({ outfits: [], outfit: "school" })).toBeNull();
  });
});

describe("setupOf", () => {
  const model = (moods: CharacterModel["moods"], gestures: CharacterModel["gestures"]) =>
    setupOf({ inventory: INVENTORY, moods, gestures });

  test("the owner's choices win, the rest are the defaults the model has", () => {
    const setup = model({ happy: ["sad"], thinking: ["sleepy"] }, { nod: "wave" });
    expect(setup.moods.happy).toEqual(["sad"]);
    expect(setup.moods.thinking).toEqual(["sleepy"]);
    expect(setup.moods.lazy).toEqual(["sleepy"]);
    // surprised's default is an expression this model lacks.
    expect(setup.moods.surprised).toEqual([]);
    expect(setup.gestures).toEqual({
      idle: "modifier:m32:6d6f74696f6e",
      talk: null,
      nod: "wave",
      shake: null,
    });
  });

  test("an empty choice shows no expression; one the model lacks falls back", () => {
    const setup = model({ happy: [] }, { idle: "gone" });
    expect(setup.moods.happy).toEqual([]);
    expect(setup.gestures.idle).toBe("modifier:m32:6d6f74696f6e");
  });
});
