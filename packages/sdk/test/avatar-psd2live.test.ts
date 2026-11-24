// PSD2Live's vendored runtime and the GL-free half of its ported player, on the CC0 test rig the
// editor exported: clip ids like modifier:m32:…, named and grouped Idle, Blink, Nod, Shake and Talk.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { AvatarError, resolveSetup } from "../src/avatar/model.ts";
import { Psd2liveModel } from "../src/avatar/psd2live/model.ts";
import type { Psd2liveRenderer } from "../src/avatar/psd2live/renderer.ts";
import { inspectPsd2liveRig, Psd2liveRig } from "../src/avatar/psd2live/rig.ts";
import {
  compilePsd2liveRuntime,
  cString,
  instantiatePsd2live,
  PSD2LIVE_ABI,
  psd2liveRuntimeUrl,
  withCString,
} from "../src/avatar/psd2live/runtime.ts";

const FIXTURE = resolve(
  import.meta.dirname,
  "../../../apps/bot/test/local/fixtures/psd2live/tml.p2lrt",
);
const WASM_SHA256 = "d8bbff52f27aebd40baca94139f9eca5af0f9d2a07c1c70fc5c15633121862a7";
const CLIP_NAMES = ["Idle", "Blink", "Nod", "Shake", "Talk"];
const EXPRESSIONS = ["smile", "sad", "angry", "surprised", "shy", "sleepy", "gloom"];

let module: WebAssembly.Module;
let fixture: Uint8Array;

beforeAll(async () => {
  module = await compilePsd2liveRuntime(new Uint8Array(readFileSync(psd2liveRuntimeUrl())));
  fixture = new Uint8Array(readFileSync(FIXTURE));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function load(bytes: Uint8Array = fixture): Psd2liveRig {
  return Psd2liveRig.load(instantiatePsd2live(module), bytes);
}

/** A module exporting memory and a p2l_abi_version that answers `major << 16 | minor`. */
function abiModule(major: number, minor: number): WebAssembly.Module {
  const leb = (value: number): number[] => {
    const bytes: number[] = [];
    let rest = value;
    for (;;) {
      const byte = rest & 0x7f;
      rest >>= 7;
      const done = (rest === 0 && (byte & 0x40) === 0) || (rest === -1 && (byte & 0x40) !== 0);
      bytes.push(done ? byte : byte | 0x80);
      if (done) return bytes;
    }
  };
  const name = (text: string) => [text.length, ...new TextEncoder().encode(text)];
  const section = (id: number, body: number[]) => [id, body.length, ...body];
  const code = [0, 0x41, ...leb((major << 16) | minor), 0x0b];
  return new WebAssembly.Module(
    new Uint8Array([
      ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
      ...section(1, [1, 0x60, 0, 1, 0x7f]),
      ...section(3, [1, 0]),
      ...section(5, [1, 0, 1]),
      ...section(7, [2, ...name("p2l_abi_version"), 0, 0, ...name("memory"), 2, 0]),
      ...section(10, [1, code.length, ...code]),
    ]),
  );
}

describe("the vendored runtime", () => {
  test("is PSD2Live's build at f66ba461: 130 exports, no imports, ABI 1.4", () => {
    const bytes = readFileSync(psd2liveRuntimeUrl());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(WASM_SHA256);
    expect(WebAssembly.Module.exports(module)).toHaveLength(130);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const rt = instantiatePsd2live(module);
    const abi = rt.p2l_abi_version();
    expect([abi >>> 16, abi & 0xffff]).toEqual([1, 4]);
    expect(cString(rt, rt.p2l_version())).toBe("0.1.0");
  });

  test("starts only at ABI 1.2 or a later 1.x", () => {
    expect(PSD2LIVE_ABI).toEqual({ major: 1, minor: 2 });
    for (const [major, minor, ok] of [
      [1, 1, false],
      [1, 2, true],
      [1, 9, true],
      [2, 0, false],
      [0, 7, false],
    ] as const) {
      const start = () => instantiatePsd2live(abiModule(major, minor));
      if (ok) {
        expect([`${major}.${minor}`, start().p2l_abi_version()]).toEqual([
          `${major}.${minor}`,
          (major << 16) | minor,
        ]);
      } else {
        expect(start).toThrow(
          expect.objectContaining({ name: "AvatarError", code: "runtime" }) as unknown as Error,
        );
      }
    }
  });

  test("compiles once per URL, from its bytes, and lets a failed fetch be tried again", async () => {
    const bytes = readFileSync(psd2liveRuntimeUrl());
    const fetch = vi.fn(async () => new Response(new Uint8Array(bytes)));
    vi.stubGlobal("fetch", fetch);
    const url = "https://example.test/assets/p2l_runtime.wasm";
    const [first, second] = await Promise.all([
      compilePsd2liveRuntime(url),
      compilePsd2liveRuntime(new URL(url)),
    ]);
    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await compilePsd2liveRuntime(first)).toBe(first);

    const missing = "https://example.test/missing.wasm";
    fetch.mockResolvedValueOnce(new Response("nope", { status: 404 }));
    await expect(compilePsd2liveRuntime(missing)).rejects.toMatchObject({
      name: "AvatarError",
      code: "runtime",
    });
    expect(await compilePsd2liveRuntime(missing)).toBeInstanceOf(WebAssembly.Module);
    expect(fetch).toHaveBeenCalledTimes(3);

    await expect(compilePsd2liveRuntime(new Uint8Array([0, 1, 2, 3]))).rejects.toMatchObject({
      code: "runtime",
    });
  });

  test("a download that breaks off is a runtime error, and is fetched again after", async () => {
    const bytes = new Uint8Array(readFileSync(psd2liveRuntimeUrl()));
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 1024));
              controller.error(new TypeError("terminated"));
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const url = "https://example.test/assets/cut-off.wasm";
    await expect(compilePsd2liveRuntime(url)).rejects.toMatchObject({
      name: "AvatarError",
      code: "runtime",
      message: "PSD2Live's runtime could not be fetched: terminated",
    });
    await expect(inspectPsd2liveRig(fixture, { runtime: url })).rejects.toMatchObject({
      code: "runtime",
    });
    fetch.mockResolvedValueOnce(new Response(bytes));
    expect(await compilePsd2liveRuntime(url)).toBeInstanceOf(WebAssembly.Module);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test("hands strings across as NUL-terminated UTF-8", () => {
    const rt = instantiatePsd2live(module);
    expect(withCString(rt, "她的形象", (pointer) => cString(rt, pointer))).toBe("她的形象");
    expect(cString(rt, 0)).toBe("");
  });
});

describe("the rig", () => {
  test("inspectPsd2liveRig reads the editor export's inventory", async () => {
    const inventory = await inspectPsd2liveRig(fixture, { runtime: module });
    expect(inventory).toMatchObject({
      runtime: "0.1.0",
      generator: "psd2live 3.8.4",
      canvas: { width: 2048, height: 2048 },
      poseGroups: [],
      lipSync: true,
      textures: 6,
    });
    expect(inventory.clips.map(({ name, group }) => [name, group])).toEqual(
      CLIP_NAMES.map((name) => [name, name]),
    );
    for (const clip of inventory.clips) {
      expect([clip.name, clip.id]).toEqual([clip.name, expect.stringMatching(/^modifier:m3\d:/)]);
    }
    expect(inventory.clips[0]).toMatchObject({ name: "Idle", duration: 12, looping: true });
    expect(inventory.clips.find((clip) => clip.name === "Nod")?.looping).toBe(false);
    expect(inventory.expressions.map(({ id }) => id)).toEqual(EXPRESSIONS);
    expect(inventory.expressions[0]).toEqual({ id: "smile", name: "微笑" });
    expect(inventory.hitAreas).toEqual([
      { id: "HitAreaHead", name: "头部" },
      { id: "HitAreaBody", name: "身体" },
    ]);
    expect(inventory.parameters).toHaveLength(82);
    expect(inventory.parameters).toContainEqual({
      id: "ParamMouthOpenY",
      min: 0,
      max: 1,
      default: 0,
    });
    expect(inventory.parts).toHaveLength(6);
    expect(inventory.parts[0]).toMatchObject({ name: "头部" });
  });

  test("resolveSetup finds the editor export's clips by group, not by id", async () => {
    const inventory = await inspectPsd2liveRig(fixture, { runtime: module });
    const idOf = (name: string) => inventory.clips.find((clip) => clip.name === name)?.id;
    const setup = resolveSetup(inventory);
    expect(setup.gestures).toEqual({
      idle: idOf("Idle"),
      talk: idOf("Talk"),
      nod: idOf("Nod"),
      shake: idOf("Shake"),
    });
    expect(setup.moods).toMatchObject({
      lazy: ["sleepy"],
      happy: ["smile"],
      wry: ["sad", "smile"],
      thinking: [],
    });
  });

  test("lip sync opens and shuts the mouth through ParamMouthOpenY", () => {
    const rig = load();
    const mouth = rig.parameters.indexOf("ParamMouthOpenY");
    expect(mouth).toBeGreaterThanOrEqual(0);
    rig.lipSync(1);
    rig.update(0.05);
    expect(rig.parameterValues()[mouth]).toBeCloseTo(1, 3);
    rig.lipSync(0);
    for (let i = 0; i < 10; i++) rig.update(0.05);
    expect(rig.parameterValues()[mouth]).toBeCloseTo(0, 3);
    rig.dispose();
  });

  test("shows two expressions at once: sleepy shuts her eyes while smile lifts her mouth", () => {
    const rig = load();
    const value = (id: string) => rig.parameterValues()[rig.parameters.indexOf(id)] ?? Number.NaN;
    rig.setExpressions(["sleepy", "smile"]);
    expect(rig.expressionsPlaying().sort()).toEqual(["sleepy", "smile"]);
    for (let i = 0; i < 20; i++) rig.update(0.1);
    expect(value("ParamEyeLOpen")).toBeLessThan(0.5);
    expect(value("ParamMouthForm")).toBeGreaterThan(0.5);
    rig.setExpressions(["smile"]);
    expect(rig.expressionsPlaying()).toEqual(["smile"]);
    rig.setExpressions([]);
    expect(rig.expressionsPlaying()).toEqual([]);
    rig.dispose();
  });

  test("an id it lacks changes nothing: the clip and expressions playing stay", () => {
    const rig = load();
    const idle = rig.clips.find((clip) => clip.group === "Idle")?.id ?? null;
    expect(rig.playLayer(idle, 0, 1)).toBe(true);
    rig.setExpressions(["smile", "sleepy"]);
    rig.update(0.1);

    expect(rig.playLayer("Idle", 0, 1)).toBe(false);
    rig.play("nope");
    rig.expression("nope");
    rig.setExpressions(["nope"]);
    rig.setExpressions(["also-nope", "nope"]);
    rig.setParameter("ParamNope", 1);
    rig.setPartOpacity("PartNope", 0);
    rig.update(0.1);
    expect(rig.layerState(0)?.clip).toBe(idle);
    expect(rig.expressionsPlaying().sort()).toEqual(["sleepy", "smile"]);

    rig.setExpressions(["smile", "nope"]);
    expect(rig.expressionsPlaying()).toEqual(["smile"]);
    expect(rig.playLayer(null, 0, 0)).toBe(true);
    expect(rig.layerState(0)).toMatchObject({ clip: null, finished: true });
    rig.dispose();
  });

  test("frames her head: the Head hit area's bounds, and a hit test at their centre", () => {
    const rig = load();
    const head = rig.bounds("HitAreaHead");
    expect(head).not.toBeNull();
    const { x0, y0, x1, y1 } = head ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
    expect([x0, y0, x1, y1].map(Math.round)).toEqual([869, 175, 1177, 517]);
    expect(rig.hitTest((x0 + x1) / 2, (y0 + y1) / 2)).toBe("HitAreaHead");
    expect(rig.hitTest(5, 5)).toBeNull();
    const character = rig.bounds(null);
    expect(
      [character?.x0, character?.y0, character?.x1, character?.y1].map((v) => Math.round(v ?? 0)),
    ).toEqual([600, 46, 1439, 2009]);
    expect(rig.bounds()).toEqual(character);
    expect(rig.bounds("HitAreaTail")).toBeNull();
    rig.dispose();
  });

  test("refuses what isn't a sound rig with the runtime's reason", () => {
    const refusal = (bytes: Uint8Array) => {
      try {
        load(bytes);
      } catch (error) {
        return error;
      }
      return null;
    };
    const garbage = refusal(new TextEncoder().encode("hello, not a rig"));
    expect(garbage).toBeInstanceOf(AvatarError);
    expect(garbage).toMatchObject({ code: "rig", message: "Not a .p2lrt rig" });
    expect(refusal(fixture.slice(0, 100_000))).toMatchObject({
      code: "rig",
      message: expect.stringContaining("outside the file"),
    });
    // p2l_rig_load_ex's CRC check catches a flipped byte inside a texture page.
    const flipped = fixture.slice();
    flipped[3_000_000] = (flipped[3_000_000] ?? 0) ^ 0xff;
    expect(refusal(flipped)).toMatchObject({ code: "rig", message: "Chunk TEXR fails its CRC" });
  });

  test("dispose frees the rig once", () => {
    const rig = load();
    rig.dispose();
    rig.dispose();
    expect(rig.hitTest(1000, 300)).toBeNull();
    expect(rig.bounds("HitAreaHead")).toBeNull();
  });
});

describe("the model", () => {
  test("a gesture plays once over her idle, which shows through again as it ends", () => {
    const rig = load();
    const idleOnly = load();
    const model = new Psd2liveModel(rig, { dispose() {} } as unknown as Psd2liveRenderer);
    const clipOf = (group: string) => rig.clips.find((clip) => clip.group === group)?.id ?? null;
    const nod = clipOf("Nod");
    const head = (of: Psd2liveRig) =>
      ["ParamAngleX", "ParamAngleY", "ParamAngleZ"].map(
        (id) => of.parameterValues()[of.parameters.indexOf(id)] ?? Number.NaN,
      );
    model.play(clipOf("Idle"), 0, { loop: true });
    idleOnly.playLayer(clipOf("Idle"), 0, 1);

    // At 60 fps: the Nod starts at frame 30, lasts 1.58 s and fades out over 1 s once it stops.
    const start = 30;
    const ended = start + 100;
    const faded = ended + 70;
    let nodding = 0;
    let after = 0;
    for (let frame = 1; frame <= 8 * 60; frame++) {
      if (frame === start) model.play(nod, 2, { priority: 2 });
      model.update(1 / 60);
      idleOnly.update(1 / 60);
      const idle = head(idleOnly);
      const apart = Math.max(...head(rig).map((v, i) => Math.abs(v - (idle[i] ?? Number.NaN))));
      const gesture = rig.layerState(2);
      if (frame < start) {
        expect(gesture?.clip).toBeNull();
      } else if (frame < start + 90) {
        expect(gesture?.clip).toBe(nod);
        nodding = Math.max(nodding, apart);
      } else if (frame >= ended) {
        expect(gesture).toMatchObject({ clip: null, priority: 0 });
      }
      if (frame >= faded) after = Math.max(after, apart);
    }
    expect(nodding).toBeGreaterThan(5);
    expect(after).toBeLessThan(1e-3);
    model.dispose();
    idleOnly.dispose();
  });

  test("a clip authored to loop, played once as a gesture, ends after one pass", () => {
    const rig = load();
    const model = new Psd2liveModel(rig, { dispose() {} } as unknown as Psd2liveRenderer);
    const looping = rig.clips.find((clip) => clip.group === "Idle");
    const authored = model.inventory.clips.find((clip) => clip.id === looping?.id);
    expect(authored).toMatchObject({ looping: true });
    const pass = authored?.duration ?? Number.NaN;
    model.play(looping?.id ?? null, 2, { priority: 2 });
    let frames = 0;
    for (; frames < Math.ceil(pass * 60) - 1; frames++) model.update(1 / 60);
    expect(rig.layerState(2)?.clip).toBe(looping?.id);
    for (; frames < Math.ceil(pass * 60) + 2; frames++) model.update(1 / 60);
    expect(rig.layerState(2)).toMatchObject({ clip: null, priority: 0 });
    model.dispose();
  });
});
