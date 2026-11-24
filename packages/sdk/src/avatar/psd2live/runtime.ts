// PSD2Live's runtime: its WebAssembly module, compiled once per URL and instantiated once per model,
// so a trap stops only the model it ran for. The module imports nothing and touches only its own
// memory.
import { AvatarError } from "../model.ts";

/** The oldest ABI the player runs on: 1.2 brought clip layers, several expressions at once and lip sync. */
export const PSD2LIVE_ABI = { major: 1, minor: 2 } as const;

/** The runtime itself, or where to fetch it. */
export type Psd2liveRuntimeSource = URL | string | BufferSource | WebAssembly.Module;

/** The vendored runtime, beside this module in the source and in the npm package's dist/avatar/. */
export function psd2liveRuntimeUrl(): URL {
  // Browser code: bundlers resolve this literal and emit the file it names, and the SDK's build
  // copies wasm/ beside dist/avatar/index.js. The server reads the same file through psd2liveDir().
  return new URL("./wasm/p2l_runtime.wasm", import.meta.url);
}

const compiled = new Map<string, Promise<WebAssembly.Module>>();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function compile(bytes: BufferSource): Promise<WebAssembly.Module> {
  try {
    return await WebAssembly.compile(bytes);
  } catch (error) {
    // A page whose CSP lacks 'wasm-unsafe-eval' refuses to compile any module.
    throw new AvatarError("runtime", `PSD2Live's runtime did not compile: ${messageOf(error)}`, {
      cause: error,
    });
  }
}

async function fetchRuntime(url: string): Promise<WebAssembly.Module> {
  const unfetched = (error: unknown) =>
    new AvatarError("runtime", `PSD2Live's runtime could not be fetched: ${messageOf(error)}`, {
      cause: error,
    });
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw unfetched(error);
  }
  if (!response.ok) {
    throw new AvatarError("runtime", `PSD2Live's runtime could not be fetched: ${response.status}`);
  }
  let bytes: ArrayBuffer;
  try {
    // compileStreaming needs application/wasm, which not every server sends.
    bytes = await response.arrayBuffer();
  } catch (error) {
    // fetch resolves at the headers; the body can still break off.
    throw unfetched(error);
  }
  return compile(bytes);
}

/** The runtime's module: the vendored one unless given, fetched and compiled once per URL. */
export function compilePsd2liveRuntime(
  source: Psd2liveRuntimeSource = psd2liveRuntimeUrl(),
): Promise<WebAssembly.Module> {
  if (source instanceof WebAssembly.Module) return Promise.resolve(source);
  if (!(source instanceof URL) && typeof source !== "string") return compile(source);
  const url = String(source);
  const cached = compiled.get(url);
  if (cached !== undefined) return cached;
  const module = fetchRuntime(url);
  compiled.set(url, module);
  module.catch(() => {
    if (compiled.get(url) === module) compiled.delete(url);
  });
  return module;
}

type Pointer = number;
type Handle = number;

/** The runtime's exports the player calls, as p2l_runtime.h declares them; a `bool` comes back 0 or 1. */
export interface P2lExports {
  readonly memory: WebAssembly.Memory;
  p2l_abi_version(): number;
  p2l_version(): Pointer;
  p2l_alloc(length: number): Pointer;
  p2l_dealloc(pointer: Pointer, length: number): void;
  p2l_rig_load_ex(
    bytes: Pointer,
    length: number,
    flags: number,
    error: Pointer,
    capacity: number,
  ): Handle;
  p2l_rig_free(rig: Handle): void;
  p2l_canvas(rig: Handle, width: Pointer, height: Pointer): void;
  p2l_behaviors(rig: Handle, flags: number): void;
  p2l_advanced_available(rig: Handle): number;
  p2l_set_advanced(rig: Handle, features: number): number;
  p2l_parameter_count(rig: Handle): number;
  p2l_parameter_id(rig: Handle, index: number): Pointer;
  p2l_parameter_range(
    rig: Handle,
    index: number,
    min: Pointer,
    max: Pointer,
    defaultValue: Pointer,
  ): number;
  p2l_parameter_current(rig: Handle): Pointer;
  p2l_set_parameter(rig: Handle, index: number, value: number): void;
  p2l_set_parameter_override(rig: Handle, index: number, value: number, weight: number): number;
  p2l_role_parameters(rig: Handle, role: Pointer, out: Pointer, capacity: number): number;
  p2l_clip_count(rig: Handle): number;
  p2l_clip_id(rig: Handle, index: number): Pointer;
  p2l_clip_name(rig: Handle, index: number): Pointer;
  p2l_clip_group(rig: Handle, index: number): Pointer;
  p2l_clip_info(
    rig: Handle,
    index: number,
    duration: Pointer,
    fps: Pointer,
    looping: Pointer,
    fadeIn: Pointer,
    fadeOut: Pointer,
  ): number;
  p2l_play(rig: Handle, index: number): void;
  p2l_play_layer(rig: Handle, layer: number, index: number, priority: number): number;
  p2l_layer_state(
    rig: Handle,
    layer: number,
    clip: Pointer,
    time: Pointer,
    priority: Pointer,
    finished: Pointer,
  ): number;
  p2l_expression_count(rig: Handle): number;
  p2l_expression_id(rig: Handle, index: number): Pointer;
  p2l_expression_name(rig: Handle, index: number): Pointer;
  p2l_expression(rig: Handle, index: number): void;
  p2l_expression_add(rig: Handle, index: number): number;
  p2l_expression_remove(rig: Handle, index: number): number;
  p2l_expressions_playing(rig: Handle, out: Pointer, capacity: number): number;
  p2l_hit_area_count(rig: Handle): number;
  p2l_hit_area_id(rig: Handle, index: number): Pointer;
  p2l_hit_area_name(rig: Handle, index: number): Pointer;
  p2l_hit_test(rig: Handle, x: number, y: number): number;
  p2l_hit_area_meshes(rig: Handle, index: number, out: Pointer, capacity: number): number;
  p2l_mesh_count(rig: Handle): number;
  p2l_mesh_id(rig: Handle, index: number): Pointer;
  p2l_mesh_vertex_count(rig: Handle, index: number): number;
  p2l_mesh_uvs(rig: Handle, index: number): Pointer;
  p2l_mesh_indices(rig: Handle, index: number, count: Pointer): Pointer;
  p2l_mesh_texture(rig: Handle, index: number): number;
  p2l_mesh_blend(rig: Handle, index: number, culling: Pointer): number;
  p2l_mesh_alpha_blend(rig: Handle, index: number): number;
  p2l_mesh_masks(
    rig: Handle,
    index: number,
    out: Pointer,
    capacity: number,
    inverted: Pointer,
  ): number;
  p2l_mesh_vertices(rig: Handle, index: number): Pointer;
  p2l_mesh_opacity(rig: Handle, index: number): number;
  p2l_mesh_colors(rig: Handle, index: number, multiply: Pointer, screen: Pointer): void;
  p2l_render_commands(rig: Handle, out: Pointer, capacity: number): number;
  p2l_part_count(rig: Handle): number;
  p2l_part_id(rig: Handle, index: number): Pointer;
  p2l_part_name(rig: Handle, index: number): Pointer;
  p2l_part_group(
    rig: Handle,
    index: number,
    blend: Pointer,
    alphaBlend: Pointer,
    invertMask: Pointer,
  ): number;
  p2l_part_masks(rig: Handle, index: number, out: Pointer, capacity: number): number;
  p2l_part_composite(
    rig: Handle,
    index: number,
    opacity: Pointer,
    multiply: Pointer,
    screen: Pointer,
  ): number;
  p2l_set_part_opacity(rig: Handle, index: number, opacity: number): number;
  p2l_bone_count(rig: Handle): number;
  p2l_bone_id(rig: Handle, index: number): Pointer;
  p2l_bone_transform(rig: Handle, index: number, out: Pointer): number;
  p2l_sim_colliders(rig: Handle, out: Pointer, capacity: number): number;
  p2l_sim_reset(rig: Handle): void;
  p2l_sim_wind(rig: Handle, x: number, y: number): void;
  p2l_pose_group_count(rig: Handle): number;
  p2l_pose_group_size(rig: Handle, group: number): number;
  p2l_pose_show(rig: Handle, group: number, entry: number): number;
  p2l_pose_shown(rig: Handle, group: number): number;
  p2l_look_at(rig: Handle, x: number, y: number): void;
  p2l_lip_sync(rig: Handle, level: number): void;
  p2l_update(rig: Handle, dt: number): void;
  p2l_evaluate(rig: Handle): void;
  p2l_texture_count(rig: Handle): number;
  p2l_texture_png(
    rig: Handle,
    index: number,
    length: Pointer,
    width: Pointer,
    height: Pointer,
  ): Pointer;
  p2l_meta_count(rig: Handle): number;
  p2l_meta_key(rig: Handle, index: number): Pointer;
  p2l_meta_value(rig: Handle, index: number): Pointer;
}

/** A new instance of the runtime, refused unless its ABI is PSD2LIVE_ABI's major at its minor or later. */
export function instantiatePsd2live(module: WebAssembly.Module): P2lExports {
  let exports: Partial<P2lExports>;
  try {
    exports = new WebAssembly.Instance(module, {}).exports as Partial<P2lExports>;
  } catch (error) {
    throw new AvatarError("runtime", `PSD2Live's runtime did not start: ${messageOf(error)}`, {
      cause: error,
    });
  }
  const abi = typeof exports.p2l_abi_version === "function" ? exports.p2l_abi_version() >>> 0 : 0;
  const major = abi >>> 16;
  const minor = abi & 0xffff;
  if (major !== PSD2LIVE_ABI.major || minor < PSD2LIVE_ABI.minor) {
    throw new AvatarError(
      "runtime",
      `PSD2Live's runtime has ABI ${major}.${minor}; the player needs ${PSD2LIVE_ABI.major}.${PSD2LIVE_ABI.minor} or a later ${PSD2LIVE_ABI.major}.x`,
    );
  }
  return exports as P2lExports;
}

/** The NUL-terminated UTF-8 string at `pointer`; empty for a null pointer. */
export function cString(rt: Pick<P2lExports, "memory">, pointer: Pointer): string {
  if (!pointer) return "";
  const bytes = new Uint8Array(rt.memory.buffer, pointer);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(bytes.subarray(0, end === -1 ? bytes.length : end));
}

/** Runs `use` with `text` as a NUL-terminated string in the runtime's memory, freed after. */
export function withCString<T>(
  rt: Pick<P2lExports, "memory" | "p2l_alloc" | "p2l_dealloc">,
  text: string,
  use: (pointer: Pointer) => T,
): T {
  const bytes = new TextEncoder().encode(text);
  const pointer = rt.p2l_alloc(bytes.length + 1);
  try {
    const memory = new Uint8Array(rt.memory.buffer, pointer, bytes.length + 1);
    memory.set(bytes);
    memory[bytes.length] = 0;
    return use(pointer);
  } finally {
    rt.p2l_dealloc(pointer, bytes.length + 1);
  }
}
