// The check a character model passes before it is kept: PSD2Live's runtime, the wasm the SDK
// vendors, loads the .p2lrt as a page would, and what it reads of the rig is kept beside it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { logger, psd2liveDir } from "@eidolon/config";
import type { ModelClip, ModelInventory, ModelNamed, ModelParameter } from "./api.ts";

/** "P2LRT" and three NULs, which every .p2lrt starts with. */
const MAGIC = [0x50, 0x32, 0x4c, 0x52, 0x54, 0, 0, 0];
/** P2L_LOAD_VERIFY_CRC. */
const VERIFY_CRC = 1;
/** p2l_texture_info's kind for a PNG inside the file, the only kind the web player draws. */
const EMBEDDED_PNG = 0;
// The runtime writes at most capacity - 1 bytes of its reason, so a reason is ≤ 200 characters.
const ERROR_CAPACITY = 201;
/** Room for the most any call here writes through its out-pointers. */
const OUT_BYTES = 24;
/**
 * The most an inventory may hold, counting its text and ENTRY_BYTES an entry, since every list and
 * status reads it back: the test rig's takes 10 KB.
 */
const INVENTORY_BYTES = 1 << 20;
/** Near what model.json spends on an entry besides its text. */
const ENTRY_BYTES = 64;

/** A rig whose inventory passes INVENTORY_BYTES. */
class Oversized extends Error {}

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

function runtimeModule(): WebAssembly.Module {
  compiled ??= new WebAssembly.Module(readFileSync(join(psd2liveDir(), "p2l_runtime.wasm")));
  return compiled;
}

/** A fresh instance, so a trap in one check leaves nothing behind for the next. */
function instantiate(): P2lRuntime {
  const runtime = new WebAssembly.Instance(runtimeModule(), {}).exports as unknown as P2lRuntime;
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

/**
 * What Studio and the pages read of the rig at `rig`, once every page is a PNG in the file; throws
 * Oversized once it passes INVENTORY_BYTES, before reading the entry or string that would.
 */
function inventoryOf(runtime: P2lRuntime, rig: Pointer): RigCheck {
  const out = runtime.p2l_alloc(OUT_BYTES);
  // Fresh for every read: a call may grow the memory, which detaches the views made before it.
  const outs = () => new DataView(runtime.memory.buffer, out >>> 0, OUT_BYTES);
  let left = INVENTORY_BYTES;
  const spend = (bytes: number) => {
    left -= bytes;
    if (left < 0) throw new Oversized();
  };
  const entries = (count: number) => {
    spend(count * ENTRY_BYTES);
    return count;
  };
  /** text(), looking for its NUL only as far as what is left. */
  const read = (at: Pointer): string => {
    if (at === 0) return "";
    const { buffer } = runtime.memory;
    const start = at >>> 0;
    const bytes = new Uint8Array(buffer, start, Math.min(left + 1, buffer.byteLength - start));
    const end = bytes.indexOf(0);
    if (end === -1) throw new Oversized();
    spend(end);
    return DECODER.decode(bytes.subarray(0, end));
  };
  const named = (count: Count, id: Indexed, name: Indexed): ModelNamed[] =>
    Array.from({ length: entries(count(rig)) }, (_, index) => ({
      id: read(id(rig, index)),
      name: read(name(rig, index)),
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
  const clips = Array.from(
    { length: entries(runtime.p2l_clip_count(rig)) },
    (_, index): ModelClip => {
      runtime.p2l_clip_info(rig, index, out, out + 4, out + 8, out + 12, out + 16);
      const info = outs();
      const duration = info.getFloat32(0, true);
      const looping = info.getUint8(8) !== 0;
      return {
        id: read(runtime.p2l_clip_id(rig, index)),
        name: read(runtime.p2l_clip_name(rig, index)),
        group: read(runtime.p2l_clip_group(rig, index)),
        duration,
        looping,
      };
    },
  );
  const parameters = Array.from(
    { length: entries(runtime.p2l_parameter_count(rig)) },
    (_, index): ModelParameter => {
      runtime.p2l_parameter_range(rig, index, out, out + 4, out + 8);
      const range = outs();
      const min = range.getFloat32(0, true);
      const max = range.getFloat32(4, true);
      const value = range.getFloat32(8, true);
      return { id: read(runtime.p2l_parameter_id(rig, index)), min, max, default: value };
    },
  );
  const meta = new Map(
    Array.from({ length: entries(runtime.p2l_meta_count(rig)) }, (_, index) => [
      read(runtime.p2l_meta_key(rig, index)),
      read(runtime.p2l_meta_value(rig, index)),
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
      poseGroups: Array.from({ length: entries(runtime.p2l_pose_group_count(rig)) }, (_, group) =>
        runtime.p2l_pose_group_size(rig, group),
      ),
      lipSync: runtime.p2l_role_parameters(rig, lipSync, 0, 0) > 0,
      textures,
    },
  };
}

function isRigFile(bytes: Uint8Array): boolean {
  return MAGIC.every((byte, index) => bytes[index] === byte);
}

/** The longest the runtime may take to load a rig: the test rig padded to 200 MiB takes 0.04 s. */
export const LOAD_DEADLINE_MS = 5000;

// The runtime's load grows with the square of a rig's hit areas: 100,000 sharing a 6,000-character
// name take it 18 s, and a file far under MAX_MODEL_BYTES holds many more. It runs here in a worker
// first, ended at the deadline, so the server's thread loads only a rig that loaded within it.
const LOAD_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { module, bytes, flags, capacity } = workerData;
const runtime = new WebAssembly.Instance(module, {}).exports;
const at = runtime.p2l_alloc(bytes.byteLength + 1);
new Uint8Array(runtime.memory.buffer, at >>> 0, bytes.byteLength).set(bytes);
const error = runtime.p2l_alloc(capacity);
const rig = runtime.p2l_rig_load_ex(at, bytes.byteLength, flags, error, capacity);
if (rig !== 0) runtime.p2l_rig_free(rig);
parentPort.postMessage(rig !== 0);
`;

/**
 * The refusal for `bytes` the runtime takes longer than `deadline` ms to load, as a worker times
 * it; null for any other, which checkRig then reads, a file it refuses or traps on included.
 */
export async function slowRefusal(
  bytes: Uint8Array,
  deadline = LOAD_DEADLINE_MS,
): Promise<Extract<RigCheck, { ok: false }> | null> {
  if (!isRigFile(bytes)) return null;
  const worker = new Worker(LOAD_SOURCE, {
    eval: true,
    workerData: { module: runtimeModule(), bytes, flags: VERIFY_CRC, capacity: ERROR_CAPACITY },
  });
  const slow = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), deadline);
    const done = () => {
      clearTimeout(timer);
      resolve(false);
    };
    worker.once("message", done).once("error", done).once("exit", done);
  });
  await worker.terminate();
  if (!slow) return null;
  return {
    ok: false,
    code: "invalid-model",
    message: `PSD2Live's runtime takes over ${deadline / 1000} s to load it, far longer than any export`,
  };
}

/**
 * Whether `bytes` are a rig PSD2Live's runtime loads, every chunk's CRC checked, every texture a
 * PNG in the file and its inventory within INVENTORY_BYTES, and if so what it holds. Bytes that
 * don't start as a .p2lrt does are unsupported-media-type; anything else refused is invalid-model,
 * with the runtime's reason when it refused.
 */
export function checkRig(bytes: Uint8Array): RigCheck {
  if (!isRigFile(bytes)) {
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
    if (error instanceof Oversized) {
      return refused("Its inventory passes 1 MiB, far more than any PSD2Live export holds");
    }
    // A panic in the runtime traps, which ends this instance alone.
    if (!(error instanceof WebAssembly.RuntimeError)) throw error;
    logger.warning(`PSD2Live's runtime stopped on a model upload: ${error.message}`);
    return refused("PSD2Live's runtime stopped on this file");
  }
}
