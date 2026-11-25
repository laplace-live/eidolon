// The check a character model passes before it is kept: the vendored PSD2Live runtime reads the CC0
// test rig as Studio shows it, and refuses what isn't a whole .p2lrt with PNG textures inside.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { psd2liveDir } from "@eidolon/config";
import { describe, expect, test } from "vitest";
import {
  checkRig,
  LOAD_DEADLINE_MS,
  type RigCheck,
  slowRefusal,
} from "../../src/local/psd2live.ts";

const RIG = readFileSync(join(import.meta.dirname, "fixtures/psd2live/tml.p2lrt"));
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0]);

/** Where a chunk's bytes are, and its table entry, by the .p2lrt 2 layout. */
function chunk(bytes: Uint8Array, tag: string): { entry: number; at: number; length: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const table = view.getUint32(20, true);
  for (let index = 0; index < view.getUint32(16, true); index++) {
    const entry = table + index * 40;
    if (Buffer.from(bytes.subarray(entry, entry + 4)).toString("latin1") === tag) {
      const at = Number(view.getBigUint64(entry + 8, true));
      return { entry, at, length: Number(view.getBigUint64(entry + 16, true)) };
    }
  }
  throw new Error(`no ${tag} chunk`);
}

/**
 * `bytes` with the chunk `tag` holding what `edit` makes of its contents, stored as before, and the
 * chunks after it moved to follow it, each table entry and CRC made again.
 */
function rewritten(bytes: Uint8Array, tag: string, edit: (contents: Buffer) => Buffer): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(16, true);
  const table = view.getUint32(20, true);
  const head = Uint8Array.from(bytes.subarray(0, table + count * 40));
  const entries = new DataView(head.buffer);
  const parts: Uint8Array[] = [head];
  let offset = head.byteLength;
  for (let index = 0; index < count; index++) {
    const entry = table + index * 40;
    const at = Number(view.getBigUint64(entry + 8, true));
    let stored = bytes.subarray(at, at + Number(view.getBigUint64(entry + 16, true)));
    if (Buffer.from(bytes.subarray(entry, entry + 4)).toString("latin1") === tag) {
      const zstd = (view.getUint16(entry + 6, true) & 8) !== 0;
      const contents = edit(zstd ? zstdDecompressSync(stored) : Buffer.from(stored));
      stored = zstd ? zstdCompressSync(contents) : contents;
      entries.setBigUint64(entry + 24, BigInt(contents.byteLength), true);
      entries.setUint32(entry + 32, crc32(stored), true);
    }
    // Each chunk starts on 16 bytes, as an export's do, with nothing else between: the runtime
    // refuses other bytes there.
    const padding = (16 - (offset % 16)) % 16;
    offset += padding;
    entries.setBigUint64(entry + 8, BigInt(offset), true);
    entries.setBigUint64(entry + 16, BigInt(stored.byteLength), true);
    parts.push(new Uint8Array(padding), stored);
    offset += stored.byteLength;
  }
  return Buffer.concat(parts);
}

/** The test rig with its first hit area named `name`. */
function headNamed(name: string): Uint8Array {
  let index = 0;
  // STRS: a u32 count, count + 1 u32 offsets into the UTF-8 after them, then the UTF-8.
  const strings = rewritten(RIG, "STRS", (strs) => {
    index = strs.readUInt32LE(0);
    const text = 4 + 4 * (index + 1);
    const bytes = Buffer.from(name);
    const offsets = Buffer.alloc(text + 4);
    strs.copy(offsets, 0, 0, text);
    offsets.writeUInt32LE(index + 1, 0);
    offsets.writeUInt32LE(strs.readUInt32LE(text - 4) + bytes.byteLength, text);
    return Buffer.concat([offsets, strs.subarray(text), bytes]);
  });
  // HITA: a u32 count, then each area's id, name, mesh count and meshes, as u32s.
  return rewritten(strings, "HITA", (areas) => {
    const renamed = Buffer.from(areas);
    renamed.writeUInt32LE(index, 8);
    return renamed;
  });
}

/** The test rig with `count` copies of its first hit area, each named `name`. */
function crowdedWith(count: number, name: string): Uint8Array {
  return rewritten(headNamed(name), "HITA", (areas) => {
    const copies = Buffer.alloc(4 + 16 * count);
    copies.writeUInt32LE(count, 0);
    // The head's id, name, mesh count (1) and mesh.
    for (let copy = 0; copy < count; copy++) areas.copy(copies, 4 + 16 * copy, 4, 20);
    return copies;
  });
}

function refusal(checked: RigCheck): [string, string] {
  if (checked.ok) throw new Error("the rig passed");
  // As the API sends it: no control character, 200 characters at most.
  expect(/\p{Cc}/u.test(checked.message) || checked.message.length > 200).toBe(false);
  return [checked.code, checked.message];
}

describe("checkRig", () => {
  test("reads the test rig as Studio shows it", () => {
    const checked = checkRig(RIG);
    if (!checked.ok) throw new Error(checked.message);
    const { inventory } = checked;
    expect(inventory).toMatchObject({
      runtime: "0.1.0",
      generator: "psd2live 3.8.4",
      canvas: { width: 2048, height: 2048 },
      poseGroups: [],
      lipSync: true,
      textures: 6,
    });
    // An editor export: its clips' ids aren't their names.
    expect(
      inventory.clips.map(({ id, name, group, looping }) => [id, name, group, looping]),
    ).toEqual([
      ["modifier:m32:6d6f74696f6e", "Idle", "Idle", true],
      ["modifier:m33:6d6f74696f6e", "Blink", "Blink", false],
      ["modifier:m34:6d6f74696f6e", "Nod", "Nod", false],
      ["modifier:m35:6d6f74696f6e", "Shake", "Shake", false],
      ["modifier:m36:6d6f74696f6e", "Talk", "Talk", false],
    ]);
    expect(inventory.clips[0]?.duration).toBe(12);
    expect(inventory.expressions.map(({ id }) => id)).toEqual([
      "smile",
      "sad",
      "angry",
      "surprised",
      "shy",
      "sleepy",
      "gloom",
    ]);
    expect(inventory.hitAreas).toEqual([
      { id: "HitAreaHead", name: "头部" },
      { id: "HitAreaBody", name: "身体" },
    ]);
    expect(inventory.parameters).toHaveLength(82);
    expect(inventory.parameters[0]).toEqual({ id: "ParamAngleX", min: -45, max: 45, default: 0 });
    expect(inventory.parts.map(({ name }) => name)).toEqual([
      "头部",
      "头部附件",
      "身体",
      "前发",
      "面部",
      "后发",
    ]);
  });

  test("bytes that don't start as a .p2lrt does are unsupported-media-type", () => {
    for (const bytes of [PNG, ZIP, new Uint8Array(0), RIG.subarray(0, 5)]) {
      expect(refusal(checkRig(bytes))[0]).toBe("unsupported-media-type");
    }
  });

  test("what the runtime refuses is invalid-model, with its reason", () => {
    const flipped = Uint8Array.from(RIG);
    const textures = chunk(flipped, "TEXR");
    const inside = textures.at + (textures.length >> 1);
    flipped[inside] = (flipped[inside] as number) ^ 0xff;
    const versioned = Uint8Array.from([...RIG.subarray(0, 8), 1, 2, 3, 4]);
    expect(
      [RIG.subarray(0, RIG.length - 1), flipped, versioned].map((bytes) =>
        refusal(checkRig(bytes)),
      ),
    ).toEqual([
      ["invalid-model", "Chunk META lies outside the file"],
      ["invalid-model", "Chunk TEXR fails its CRC"],
      ["invalid-model", "Unsupported .p2lrt version 513"],
    ]);
  });

  test("a texture page that isn't a PNG inside the file is invalid-model", () => {
    const ktx2 = Uint8Array.from(RIG);
    const textures = chunk(ktx2, "TEXR");
    // The first page's kind, 1 for KTX2, under a CRC made again so only the kind changes.
    ktx2[textures.at + 4] = 1;
    const crc = crc32(ktx2.subarray(textures.at, textures.at + textures.length));
    new DataView(ktx2.buffer).setUint32(textures.entry + 32, crc, true);
    expect(refusal(checkRig(ktx2))).toEqual([
      "invalid-model",
      "Its textures must be PNGs inside the file; export it with PNG textures",
    ]);
  });

  test("a rig that holds far more than an export does is invalid-model", () => {
    const oversized = [
      "invalid-model",
      "Its inventory passes 1 MiB, far more than any PSD2Live export holds",
    ];
    // 300,000 bytes of UTF-8, which is kept whole.
    const long = checkRig(headNamed("头".repeat(100_000)));
    if (!long.ok) throw new Error(long.message);
    expect(long.inventory.hitAreas[0]).toEqual({ id: "HitAreaHead", name: "头".repeat(100_000) });
    expect(refusal(checkRig(headNamed("头".repeat(400_000))))).toEqual(oversized);
    expect(refusal(checkRig(crowdedWith(100_000, "头")))).toEqual(oversized);
  });

  test("the runtime is PSD2Live's committed build, byte for byte", () => {
    const wasm = readFileSync(join(psd2liveDir(), "p2l_runtime.wasm"));
    expect(createHash("sha256").update(wasm).digest("hex")).toBe(
      "d8bbff52f27aebd40baca94139f9eca5af0f9d2a07c1c70fc5c15633121862a7",
    );
  });
});

describe("slowRefusal", () => {
  test("lets through what the runtime loads, refuses or can't read within the deadline", async () => {
    expect(LOAD_DEADLINE_MS).toBe(5000);
    expect(await slowRefusal(RIG)).toBeNull();
    expect(await slowRefusal(PNG)).toBeNull();
    const flipped = Uint8Array.from(RIG);
    const textures = chunk(flipped, "TEXR");
    const inside = textures.at + (textures.length >> 1);
    flipped[inside] = (flipped[inside] as number) ^ 0xff;
    expect(await slowRefusal(flipped)).toBeNull();
  });

  test("refuses a rig the runtime takes longer to load, ending its load at the deadline", async () => {
    // The runtime's load is quadratic in hit areas: 40,000 sharing this name take it about 2 s.
    const slow = crowdedWith(40_000, "x".repeat(5000));
    const started = performance.now();
    expect(await slowRefusal(slow, 100)).toEqual({
      ok: false,
      code: "invalid-model",
      message: "PSD2Live's runtime takes over 0.1 s to load it, far longer than any export",
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
