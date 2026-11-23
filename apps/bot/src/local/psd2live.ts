// The check a character model passes before it is kept: PSD2Live's runtime, the wasm the SDK
// vendors, loads the .p2lrt as a page would, and what it reads of the rig is kept beside it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger, psd2liveDir } from "@eidolon/config";
import type { ModelClip, ModelInventory, ModelNamed, ModelParameter } from "./api.ts";

/** "P2LRT" and three NULs, which every .p2lrt starts with. */
const MAGIC = [0x50, 0x32, 0x4c, 0x52, 0x54, 0, 0, 0];
/** P2L_LOAD_VERIFY_CRC. */
const VERIFY_CRC = 1;
/** p2l_texture_info's kind for a PNG inside the file; a page drawn from anything else won't load. */
const EMBEDDED_PNG = 0;
// The runtime writes at most capacity - 1 bytes of its reason, so a reason is ≤ 200 characters.
const ERROR_CAPACITY = 201;
/** Room for the most any call here writes through its out-pointers. */
const OUT_BYTES = 24;

type Pointer = number;
type Count = (rig: Pointer) => number;
type Indexed = (rig: Pointer, index: number) => Pointer;

/** The runtime's exports this check calls. */
interface P2lRuntime {
  readonly memory: WebAssembly.Memory;
  p2l_abi_version(): number;
  p2l_version(): Pointer;
  p2l_alloc(length: number): Pointer;
  p2l_rig_load_ex(
    bytes: Pointer,
    length: number,
    flags: number,
    error: Pointer,
    capacity: number,
  ): Pointer;
  p2l_rig_free(rig: Pointer): void;
  p2l_canvas(rig: Pointer, width: Pointer, height: Pointer): void;
  p2l_clip_count: Count;
  p2l_clip_id: Indexed;
  p2l_clip_name: Indexed;
  p2l_clip_group: Indexed;
  p2l_clip_info(
    rig: Pointer,
    index: number,
    duration: Pointer,
    fps: Pointer,
    looping: Pointer,
    fadeIn: Pointer,
    fadeOut: Pointer,
  ): number;
  p2l_expression_count: Count;
  p2l_expression_id: Indexed;
  p2l_expression_name: Indexed;
  p2l_hit_area_count: Count;
  p2l_hit_area_id: Indexed;
  p2l_hit_area_name: Indexed;
  p2l_parameter_count: Count;
  p2l_parameter_id: Indexed;
  p2l_parameter_range(
    rig: Pointer,
    index: number,
    min: Pointer,
    max: Pointer,
    defaultValue: Pointer,
  ): number;
  p2l_part_count: Count;
  p2l_part_id: Indexed;
  p2l_part_name: Indexed;
  p2l_pose_group_count: Count;
  p2l_pose_group_size(rig: Pointer, group: number): number;
  p2l_role_parameters(rig: Pointer, role: Pointer, out: Pointer, capacity: number): number;
  p2l_texture_count: Count;
  p2l_texture_info(
    rig: Pointer,
    index: number,
    kind: Pointer,
    width: Pointer,
    height: Pointer,
    data: Pointer,
    length: Pointer,
  ): Pointer;
  p2l_meta_count: Count;
  p2l_meta_key: Indexed;
  p2l_meta_value: Indexed;
}

export type RigCheck =
  | { readonly ok: true; readonly inventory: ModelInventory }
  | {
      readonly ok: false;
      readonly code: "unsupported-media-type" | "invalid-model";
      readonly message: string;
    };

let compiled: WebAssembly.Module | null = null;

/** A fresh instance, so a trap in one check leaves nothing behind for the next. */
function instantiate(): P2lRuntime {
  compiled ??= new WebAssembly.Module(readFileSync(join(psd2liveDir(), "p2l_runtime.wasm")));
  const runtime = new WebAssembly.Instance(compiled, {}).exports as unknown as P2lRuntime;
  const abi = runtime.p2l_abi_version();
  if (abi >>> 16 !== 1 || (abi & 0xffff) < 2) {
    throw new Error(
      `PSD2Live's runtime implements ABI ${abi >>> 16}.${abi & 0xffff}; the check needs 1.2 or a later 1.x`,
    );
  }
  return runtime;
}

const DECODER = new TextDecoder();

/** The NUL-terminated UTF-8 at `at`; "" for a null pointer. */
function text(runtime: P2lRuntime, at: Pointer): string {
  if (at === 0) return "";
  const bytes = new Uint8Array(runtime.memory.buffer, at >>> 0);
  const end = bytes.indexOf(0);
  return DECODER.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** `bytes` copied into the runtime's memory, with a NUL after them. */
function copyIn(runtime: P2lRuntime, bytes: Uint8Array): Pointer {
  // Zeroed, so the copy ends in a NUL.
  const at = runtime.p2l_alloc(bytes.byteLength + 1);
  new Uint8Array(runtime.memory.buffer, at >>> 0, bytes.byteLength).set(bytes);
  return at;
}

function refused(message: string): RigCheck {
  const reason = message.replace(/\p{Cc}/gu, "").trim();
  return {
    ok: false,
    code: "invalid-model",
    message: reason || "PSD2Live's runtime refused the file",
  };
}

/** What Studio and the pages read of the rig at `rig`, once every page is a PNG in the file. */
function inventoryOf(runtime: P2lRuntime, rig: Pointer): RigCheck {
  const out = runtime.p2l_alloc(OUT_BYTES);
  // Fresh for every read: a call may grow the memory, which detaches the views made before it.
  const outs = () => new DataView(runtime.memory.buffer, out >>> 0, OUT_BYTES);
  const named = (count: Count, id: Indexed, name: Indexed): ModelNamed[] =>
    Array.from({ length: count(rig) }, (_, index) => ({
      id: text(runtime, id(rig, index)),
      name: text(runtime, name(rig, index)),
    }));

  const textures = runtime.p2l_texture_count(rig);
  for (let page = 0; page < textures; page++) {
    runtime.p2l_texture_info(rig, page, out, out + 4, out + 8, out + 12, out + 16);
    if (outs().getInt32(0, true) !== EMBEDDED_PNG) {
      return refused("Its textures must be PNGs inside the file; export it with PNG textures");
    }
  }

  runtime.p2l_canvas(rig, out, out + 4);
  const canvas = { width: outs().getFloat32(0, true), height: outs().getFloat32(4, true) };
  const clips = Array.from({ length: runtime.p2l_clip_count(rig) }, (_, index): ModelClip => {
    runtime.p2l_clip_info(rig, index, out, out + 4, out + 8, out + 12, out + 16);
    const info = outs();
    const duration = info.getFloat32(0, true);
    const looping = info.getUint8(8) !== 0;
    return {
      id: text(runtime, runtime.p2l_clip_id(rig, index)),
      name: text(runtime, runtime.p2l_clip_name(rig, index)),
      group: text(runtime, runtime.p2l_clip_group(rig, index)),
      duration,
      looping,
    };
  });
  const parameters = Array.from(
    { length: runtime.p2l_parameter_count(rig) },
    (_, index): ModelParameter => {
      runtime.p2l_parameter_range(rig, index, out, out + 4, out + 8);
      const range = outs();
      const min = range.getFloat32(0, true);
      const max = range.getFloat32(4, true);
      const value = range.getFloat32(8, true);
      return { id: text(runtime, runtime.p2l_parameter_id(rig, index)), min, max, default: value };
    },
  );
  const meta = new Map(
    Array.from({ length: runtime.p2l_meta_count(rig) }, (_, index) => [
      text(runtime, runtime.p2l_meta_key(rig, index)),
      text(runtime, runtime.p2l_meta_value(rig, index)),
    ]),
  );
  const generator = meta.get("generator");
  const version = meta.get("generator_version");
  const lipSync = copyIn(runtime, new TextEncoder().encode("LipSync"));

  return {
    ok: true,
    inventory: {
      runtime: text(runtime, runtime.p2l_version()),
      generator: generator ? (version ? `${generator} ${version}` : generator) : null,
      canvas,
      clips,
      expressions: named(
        runtime.p2l_expression_count,
        runtime.p2l_expression_id,
        runtime.p2l_expression_name,
      ),
      hitAreas: named(
        runtime.p2l_hit_area_count,
        runtime.p2l_hit_area_id,
        runtime.p2l_hit_area_name,
      ),
      parameters,
      parts: named(runtime.p2l_part_count, runtime.p2l_part_id, runtime.p2l_part_name),
      poseGroups: Array.from({ length: runtime.p2l_pose_group_count(rig) }, (_, group) =>
        runtime.p2l_pose_group_size(rig, group),
      ),
      lipSync: runtime.p2l_role_parameters(rig, lipSync, 0, 0) > 0,
      textures,
    },
  };
}

/**
 * Whether `bytes` are a rig PSD2Live's runtime loads, every chunk's CRC checked and every texture
 * a PNG in the file, and if so what it holds. Bytes that don't start as a .p2lrt does are
 * unsupported-media-type; anything the runtime refuses is invalid-model, with its reason.
 */
export function checkRig(bytes: Uint8Array): RigCheck {
  if (!MAGIC.every((byte, index) => bytes[index] === byte)) {
    return {
      ok: false,
      code: "unsupported-media-type",
      message: "A model is a .p2lrt file, as PSD2Live exports it",
    };
  }
  const runtime = instantiate();
  try {
    const at = copyIn(runtime, bytes);
    const error = runtime.p2l_alloc(ERROR_CAPACITY);
    const rig = runtime.p2l_rig_load_ex(at, bytes.byteLength, VERIFY_CRC, error, ERROR_CAPACITY);
    if (rig === 0) return refused(text(runtime, error));
    try {
      return inventoryOf(runtime, rig);
    } finally {
      runtime.p2l_rig_free(rig);
    }
  } catch (error) {
    // A panic in the runtime traps, which ends this instance alone.
    if (!(error instanceof WebAssembly.RuntimeError)) throw error;
    logger.warning(`PSD2Live's runtime stopped on a model upload: ${error.message}`);
    return refused("PSD2Live's runtime stopped on this file");
  }
}
