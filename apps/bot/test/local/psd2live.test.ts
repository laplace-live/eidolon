// The check a character model passes before it is kept: the vendored PSD2Live runtime reads the CC0
// test rig as Studio shows it, and refuses what isn't a whole .p2lrt with PNG textures inside.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { psd2liveDir } from "@eidolon/config";
import { describe, expect, test } from "vitest";
import { checkRig, type RigCheck } from "../../src/local/psd2live.ts";

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

  test("the runtime is PSD2Live's committed build, byte for byte", () => {
    const wasm = readFileSync(join(psd2liveDir(), "p2l_runtime.wasm"));
    expect(createHash("sha256").update(wasm).digest("hex")).toBe(
      "d8bbff52f27aebd40baca94139f9eca5af0f9d2a07c1c70fc5c15633121862a7",
    );
  });
});
