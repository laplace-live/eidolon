// Copyright (c) 2026 PSD2Live contributors
// SPDX-License-Identifier: MIT
//
// Ported from psd2live targets/web/src/main/resources/io/github/psd2live/targets/web/p2l.js@f66ba461
//
// The player's half that runs without WebGL: a rig on a runtime instance, its lists, poses and
// behaviors, and what its renderer draws. An id the rig lacks changes nothing, where the player's -1
// stopped the clip playing or faded every expression out.
import type { Bounds } from "../framing.ts";
import {
  AvatarError,
  avatarErrorOf,
  type ModelClip,
  type ModelInventory,
  type ModelNamed,
  type ModelParameter,
} from "../model.ts";
import {
  compilePsd2liveRuntime,
  cString,
  instantiatePsd2live,
  type P2lExports,
  type Psd2liveRuntimeSource,
  withCString,
} from "./runtime.ts";

const BLINK = 1;
const BREATH = 2;
const LOOK = 4;
const LIP_SYNC = 8;
const STAGE_CLIPS = 1;
const STAGE_EXPRESSIONS = 2;
const STAGE_BEHAVIORS = 4;
/** p2l_rig_load_ex's P2L_LOAD_VERIFY_CRC: every chunk that carries a CRC is checked. */
const VERIFY_CRC = 1;
const ERROR_CAPACITY = 512;

/** A mesh as the file holds it, which its renderer uploads once. */
export interface Psd2liveMesh {
  readonly vertices: number;
  readonly uvs: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
  readonly texture: number;
  readonly blend: number;
  readonly alphaBlend: number;
  readonly culling: boolean;
  readonly masks: readonly number[];
  readonly invertMask: boolean;
}

/** A part's isolated group: its blend modes, mask inversion and masks. */
export interface Psd2liveGroup {
  readonly blend: number;
  readonly alphaBlend: number;
  readonly invertMask: boolean;
  readonly masks: readonly number[];
}

/** What a clip layer plays: the clip (null for none), its time and priority, and whether a one-shot ended. */
export interface Psd2liveLayerState {
  readonly clip: string | null;
  readonly time: number;
  readonly priority: number;
  readonly finished: boolean;
}

export class Psd2liveRig {
  /** Loads [bytes] of a .p2lrt file on an instantiated runtime, checking every chunk's CRC. */
  static load(rt: P2lExports, bytes: Uint8Array): Psd2liveRig {
    let rig = 0;
    try {
      const at = rt.p2l_alloc(bytes.length);
      new Uint8Array(rt.memory.buffer, at, bytes.length).set(bytes);
      const error = rt.p2l_alloc(ERROR_CAPACITY);
      rig = rt.p2l_rig_load_ex(at, bytes.length, VERIFY_CRC, error, ERROR_CAPACITY);
      rt.p2l_dealloc(at, bytes.length);
      const message = rig ? "" : cString(rt, error);
      rt.p2l_dealloc(error, ERROR_CAPACITY);
      if (!rig) throw new AvatarError("rig", message || "The rig could not be loaded");
      return new Psd2liveRig(rt, rig);
    } catch (error) {
      if (rig) {
        try {
          rt.p2l_rig_free(rig);
        } catch {}
      }
      throw avatarErrorOf(error, "rig");
    }
  }

  private readonly rt: P2lExports;
  private rig: number;
  private blinkSeed: number | undefined;
  readonly width: number;
  readonly height: number;
  readonly clips: readonly ModelClip[];
  readonly parameters: readonly string[];
  readonly expressions: readonly ModelNamed[];
  readonly hitAreas: readonly ModelNamed[];
  readonly parts: readonly ModelNamed[];
  /** What advanced mode the file offers: 1 skinning, 2 exact links, 4 live simulation, 8 collision. */
  readonly advancedFeatures: number;
  readonly meshes: readonly Psd2liveMesh[];
  /** Each part's isolated group, by part index. */
  readonly groups: readonly Psd2liveGroup[];
  private readonly commandCapacity: number;
  private readonly commandsPointer: number;
  private readonly colors: number;
  readonly meshIds: readonly string[];
  readonly bones: readonly string[];

  private constructor(runtime: P2lExports, rig: number) {
    this.rt = runtime;
    this.rig = rig;
    runtime.p2l_behaviors(this.rig, BLINK | BREATH | LOOK);

    const width = runtime.p2l_alloc(8);
    runtime.p2l_canvas(this.rig, width, width + 4);
    const canvas = new Float32Array(runtime.memory.buffer, width, 2);
    this.width = canvas[0] ?? 0;
    this.height = canvas[1] ?? 0;
    runtime.p2l_dealloc(width, 8);

    this.clips = this.list(runtime.p2l_clip_count, runtime.p2l_clip_id).map((id, i) =>
      this.clip(id, i),
    );
    this.parameters = this.list(runtime.p2l_parameter_count, runtime.p2l_parameter_id);
    this.expressions = this.named(
      runtime.p2l_expression_count,
      runtime.p2l_expression_id,
      runtime.p2l_expression_name,
    );
    this.hitAreas = this.named(
      runtime.p2l_hit_area_count,
      runtime.p2l_hit_area_id,
      runtime.p2l_hit_area_name,
    );
    this.parts = this.named(runtime.p2l_part_count, runtime.p2l_part_id, runtime.p2l_part_name);
    this.advancedFeatures = runtime.p2l_advanced_available(this.rig);
    const meshes: Psd2liveMesh[] = [];
    const count = runtime.p2l_mesh_count(this.rig);
    const scratch = runtime.p2l_alloc(16);
    for (let m = 0; m < count; m++) {
      const vertices = runtime.p2l_mesh_vertex_count(this.rig, m);
      const indexPointer = runtime.p2l_mesh_indices(this.rig, m, scratch);
      const indexCount = new Uint32Array(runtime.memory.buffer, scratch, 1)[0] ?? 0;
      const blend = runtime.p2l_mesh_blend(this.rig, m, scratch + 4);
      const culling = new Uint8Array(runtime.memory.buffer, scratch + 4, 1)[0] !== 0;
      const alphaBlend = runtime.p2l_mesh_alpha_blend(this.rig, m);
      const masks = this.indices(
        (out, capacity, inverted) => runtime.p2l_mesh_masks(this.rig, m, out, capacity, inverted),
        true,
      );
      const uvs = runtime.p2l_mesh_uvs(this.rig, m);
      meshes.push({
        vertices,
        uvs: new Float32Array(runtime.memory.buffer, uvs, vertices * 2).slice(),
        indices: new Uint32Array(runtime.memory.buffer, indexPointer, indexCount).slice(),
        texture: runtime.p2l_mesh_texture(this.rig, m),
        blend,
        alphaBlend,
        culling,
        masks: masks.list,
        invertMask: masks.inverted,
      });
    }
    this.meshes = meshes;
    // Each part's isolated group: its blend modes, mask inversion and masks.
    const groups: Psd2liveGroup[] = [];
    const parts = runtime.p2l_part_count(this.rig);
    for (let p = 0; p < parts; p++) {
      runtime.p2l_part_group(this.rig, p, scratch, scratch + 4, scratch + 8);
      const modes = new Int32Array(runtime.memory.buffer, scratch, 2);
      const blend = modes[0] ?? 0;
      const alphaBlend = modes[1] ?? 0;
      const invertMask = new Uint8Array(runtime.memory.buffer, scratch + 8, 1)[0] !== 0;
      const masks = this.indices(
        (out, capacity) => runtime.p2l_part_masks(this.rig, p, out, capacity),
        false,
      ).list;
      groups.push({ blend, alphaBlend, invertMask, masks });
    }
    this.groups = groups;
    runtime.p2l_dealloc(scratch, 16);
    // Every mesh, and each isolated group's opening and closing.
    this.commandCapacity = count + 2 * parts;
    this.commandsPointer = runtime.p2l_alloc(this.commandCapacity * 4 + 4);
    this.colors = runtime.p2l_alloc(28);
    this.meshIds = this.list(runtime.p2l_mesh_count, runtime.p2l_mesh_id);
    this.bones = this.list(runtime.p2l_bone_count, runtime.p2l_bone_id);
  }

  /**
   * Indices the runtime writes through [read](out, capacity, flag): counted first, then filled; [withFlag]
   * reads the bool it writes after them too.
   */
  private indices(
    read: (out: number, capacity: number, flag: number) => number,
    withFlag: boolean,
  ): { list: number[]; inverted: boolean } {
    const rt = this.rt;
    const n = read(0, 0, 0);
    const out = rt.p2l_alloc(n * 4 + 4);
    read(out, n, withFlag ? out + n * 4 : 0);
    const list = Array.from(new Uint32Array(rt.memory.buffer, out, n));
    const inverted = withFlag && new Uint8Array(rt.memory.buffer, out + n * 4, 1)[0] !== 0;
    rt.p2l_dealloc(out, n * 4 + 4);
    return { list, inverted };
  }

  /** Each parameter's id with its range and default. */
  parameterRanges(): ModelParameter[] {
    const rt = this.rt;
    const out = rt.p2l_alloc(12);
    const ranges = this.parameters.map((id, i) => {
      rt.p2l_parameter_range(this.rig, i, out, out + 4, out + 8);
      const range = new Float32Array(rt.memory.buffer, out, 3);
      return { id, min: range[0] ?? 0, max: range[1] ?? 0, default: range[2] ?? 0 };
    });
    rt.p2l_dealloc(out, 12);
    return ranges;
  }

  /** The value every parameter had in the last evaluation, after clips, expressions, behaviors and physics. */
  parameterValues(): number[] {
    const pointer = this.rt.p2l_parameter_current(this.rig);
    if (!pointer) return [];
    return Array.from(new Float32Array(this.rt.memory.buffer, pointer, this.parameters.length));
  }

  /** Mesh [m]'s vertices in canvas pixels at the last evaluation, valid until the next runtime call. */
  meshVertices(m: number): Float32Array<ArrayBuffer> {
    const pointer = this.rt.p2l_mesh_vertices(this.rig, m);
    const length = pointer ? (this.meshes[m]?.vertices ?? 0) * 2 : 0;
    return new Float32Array(this.rt.memory.buffer, pointer, length);
  }

  /** The mesh indices hit area [i] covers. */
  hitAreaMeshes(i: number): number[] {
    const n = this.rt.p2l_hit_area_meshes(this.rig, i, 0, 0);
    const out = this.rt.p2l_alloc(n * 4 + 4);
    this.rt.p2l_hit_area_meshes(this.rig, i, out, n);
    const meshes = Array.from(new Uint32Array(this.rt.memory.buffer, out, n));
    this.rt.p2l_dealloc(out, n * 4 + 4);
    return meshes;
  }

  /**
   * The canvas-pixel bounds of hit area [area]'s meshes, or with none of every mesh drawn, at the last
   * evaluation; null when there is nothing there.
   */
  bounds(area?: string | null): Bounds | null {
    let meshes: number[];
    if (area === undefined || area === null) {
      meshes = Array.from(this.renderCommands()).filter(
        (command) => command >= 0 && this.meshOpacity(command) > 0,
      );
    } else {
      const index = this.hitAreas.findIndex(({ id }) => id === area);
      if (index < 0) return null;
      meshes = this.hitAreaMeshes(index);
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const m of meshes) {
      const v = this.meshVertices(m);
      for (let i = 0; i + 1 < v.length; i += 2) {
        const x = v[i] ?? Number.NaN;
        const y = v[i + 1] ?? Number.NaN;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return x0 <= x1 && y0 <= y1 ? { x0, y0, x1, y1 } : null;
  }

  /** Every bone's canvas frame [a, b, c, d, tx, ty] at the last evaluation, by id. */
  boneFrames(): { id: string; m: number[] }[] {
    const out = this.rt.p2l_alloc(24);
    const frames: { id: string; m: number[] }[] = [];
    this.bones.forEach((id, i) => {
      if (this.rt.p2l_bone_transform(this.rig, i, out)) {
        frames.push({ id, m: Array.from(new Float32Array(this.rt.memory.buffer, out, 6)) });
      }
    });
    this.rt.p2l_dealloc(out, 24);
    return frames;
  }

  /** The simulations' colliders as the last update placed them: [ax, ay, bx, by, radiusA, radiusB] in canvas pixels. */
  colliders(): number[][] {
    const n = this.rt.p2l_sim_colliders(this.rig, 0, 0);
    if (n === 0) return [];
    const out = this.rt.p2l_alloc(n * 24);
    this.rt.p2l_sim_colliders(this.rig, out, n);
    const flat = Array.from(new Float32Array(this.rt.memory.buffer, out, n * 6));
    this.rt.p2l_dealloc(out, n * 24);
    return Array.from({ length: n }, (_, i) => flat.slice(i * 6, i * 6 + 6));
  }

  /** How many parts each pose group switches between. */
  poseGroups(): number[] {
    return Array.from({ length: this.rt.p2l_pose_group_count(this.rig) }, (_, g) =>
      this.rt.p2l_pose_group_size(this.rig, g),
    );
  }

  /** Shows part [entry] of pose group [group], fading the others out. */
  showPose(group: number, entry: number): boolean {
    return this.rt.p2l_pose_show(this.rig, group, entry) !== 0;
  }

  /** The entry pose group [group] shows, or -1. */
  poseShown(group: number): number {
    return this.rt.p2l_pose_shown(this.rig, group);
  }

  /** An opacity 0..1 the host gives part [id], over its poses; an id the rig lacks changes nothing. */
  setPartOpacity(id: string, opacity: number): void {
    const i = this.parts.findIndex((part) => part.id === id);
    if (i >= 0) this.rt.p2l_set_part_opacity(this.rig, i, opacity);
  }

  /** Starts the simulations again at rest. */
  resetSimulation(): void {
    this.rt.p2l_sim_reset(this.rig);
  }

  /** Wind besides the scenes' own, canvas pixels per second² (x right, y down). */
  wind(x: number, y: number): void {
    this.rt.p2l_sim_wind(this.rig, x, y);
  }

  /** Behaviors: 1 blink, 2 breathing, 4 gaze, 8 lip sync. */
  behaviors(flags: number): void {
    this.rt.p2l_behaviors(this.rig, flags);
  }

  /** Reseeds the blink timing. */
  behaviorSeed(seed: number): void {
    const next = seed >>> 0;
    this.blinkSeed = next;
    this.rt.p2l_behavior_seed(this.rig, next);
  }

  /**
   * How strongly breathing sways her and gaze turns her head, body and eyes, and how quickly gaze
   * follows, 1 each as loaded; false, changing nothing, for a negative one.
   */
  behaviorStrength(sway: number, look: number, lookSpeed: number): boolean {
    return this.rt.p2l_behavior_strength(this.rig, sway, look, lookSpeed) !== 0;
  }

  /** Frees the rig; it is unusable afterwards. */
  dispose(): void {
    if (!this.rig) return;
    const rig = this.rig;
    this.rig = 0;
    this.rt.p2l_dealloc(this.commandsPointer, this.commandCapacity * 4 + 4);
    this.rt.p2l_dealloc(this.colors, 28);
    this.rt.p2l_rig_free(rig);
  }

  private string(pointer: number): string {
    return cString(this.rt, pointer);
  }

  private list(
    count: (rig: number) => number,
    id: (rig: number, index: number) => number,
  ): string[] {
    return Array.from({ length: count(this.rig) }, (_, i) => this.string(id(this.rig, i)));
  }

  private named(
    count: (rig: number) => number,
    id: (rig: number, index: number) => number,
    name: (rig: number, index: number) => number,
  ): ModelNamed[] {
    return Array.from({ length: count(this.rig) }, (_, i) => ({
      id: this.string(id(this.rig, i)),
      name: this.string(name(this.rig, i)),
    }));
  }

  private clip(id: string, i: number): ModelClip {
    const rt = this.rt;
    const out = rt.p2l_alloc(20);
    rt.p2l_clip_info(this.rig, i, out, out + 4, out + 8, out + 12, out + 16);
    const duration = new Float32Array(rt.memory.buffer, out, 1)[0] ?? 0;
    const looping = new Uint8Array(rt.memory.buffer, out + 8, 1)[0] !== 0;
    rt.p2l_dealloc(out, 20);
    return {
      id,
      name: this.string(rt.p2l_clip_name(this.rig, i)),
      group: this.string(rt.p2l_clip_group(this.rig, i)),
      duration,
      looping,
    };
  }

  /** Plays a clip by id, cross-fading; null stops. */
  play(id: string | null): void {
    if (id === null) {
      this.rt.p2l_play(this.rig, -1);
      return;
    }
    const i = this.clips.findIndex((clip) => clip.id === id);
    if (i >= 0) this.rt.p2l_play(this.rig, i);
  }

  /**
   * Plays a clip by id on clip layer [layer] over those below it, when [priority] is at least that of
   * the clip playing there; null stops the layer. Whether it started.
   */
  playLayer(id: string | null, layer: number, priority: number): boolean {
    const i = id === null ? -1 : this.clips.findIndex((clip) => clip.id === id);
    if (id !== null && i < 0) return false;
    return this.rt.p2l_play_layer(this.rig, layer, i, priority) !== 0;
  }

  /** What clip layer [layer] plays; null for a layer the runtime doesn't have. */
  layerState(layer: number): Psd2liveLayerState | null {
    const rt = this.rt;
    const out = rt.p2l_alloc(16);
    const ok = rt.p2l_layer_state(this.rig, layer, out, out + 4, out + 8, out + 12) !== 0;
    const clip = new Int32Array(rt.memory.buffer, out, 1)[0] ?? -1;
    const time = new Float32Array(rt.memory.buffer, out + 4, 1)[0] ?? 0;
    const priority = new Uint32Array(rt.memory.buffer, out + 8, 1)[0] ?? 0;
    const finished = new Uint8Array(rt.memory.buffer, out + 12, 1)[0] !== 0;
    rt.p2l_dealloc(out, 16);
    if (!ok) return null;
    return { clip: this.clips[clip]?.id ?? null, time, priority, finished };
  }

  /** Fades an expression in by id, the others out; null fades them all out. */
  expression(id: string | null): void {
    if (id === null) {
      this.rt.p2l_expression(this.rig, -1);
      return;
    }
    const i = this.expressions.findIndex((expression) => expression.id === id);
    if (i >= 0) this.rt.p2l_expression(this.rig, i);
  }

  /** The expressions playing, oldest first, fading ones left out. */
  expressionsPlaying(): string[] {
    return this.playingIndices().map((i) => this.expressions[i]?.id ?? "");
  }

  /**
   * Fades expressions in and out until exactly [ids] play. An id the rig lacks is ignored, and a list
   * of only those changes nothing.
   */
  setExpressions(ids: readonly string[]): void {
    const wanted = new Set<number>();
    for (const id of ids) {
      const i = this.expressions.findIndex((expression) => expression.id === id);
      if (i >= 0) wanted.add(i);
    }
    if (ids.length > 0 && wanted.size === 0) return;
    const playing = new Set(this.playingIndices());
    for (const i of playing) if (!wanted.has(i)) this.rt.p2l_expression_remove(this.rig, i);
    for (const i of wanted) if (!playing.has(i)) this.rt.p2l_expression_add(this.rig, i);
  }

  private playingIndices(): number[] {
    const rt = this.rt;
    const n = rt.p2l_expressions_playing(this.rig, 0, 0);
    const out = rt.p2l_alloc(n * 4 + 4);
    rt.p2l_expressions_playing(this.rig, out, n);
    const playing = Array.from(new Uint32Array(rt.memory.buffer, out, n));
    rt.p2l_dealloc(out, n * 4 + 4);
    return playing;
  }

  /** Turns advanced mode's [features] on (0 is the Cubism-equivalent rig); returns those now on. */
  setAdvanced(features: number): number {
    return this.rt.p2l_set_advanced(this.rig, features);
  }

  /** The hit area (e.g. "HitAreaHead") at a point of the rig's canvas, or null. */
  hitTest(x: number, y: number): string | null {
    const i = this.rt.p2l_hit_test(this.rig, x, y);
    return i < 0 ? null : (this.hitAreas[i]?.id ?? null);
  }

  /** Where to look, each axis -1..1 (x right, y up). */
  lookAt(x: number, y: number): void {
    this.rt.p2l_look_at(this.rig, x, y);
  }

  /** Mouth opening 0..1; switches lip sync on. */
  lipSync(level: number): void {
    this.rt.p2l_behaviors(this.rig, BLINK | BREATH | LOOK | LIP_SYNC);
    this.rt.p2l_lip_sync(this.rig, level);
  }

  /** Sets a parameter by id under clips and behaviors. */
  setParameter(id: string, value: number): void {
    const i = this.parameters.indexOf(id);
    if (i >= 0) this.rt.p2l_set_parameter(this.rig, i, value);
  }

  /**
   * Moves a parameter toward [value] by [weight] 0..1 over clips and expressions, under behaviors and
   * physics; weight 0 lets it go.
   */
  setParameterOverride(id: string, value: number, weight: number): void {
    const i = this.parameters.indexOf(id);
    if (i >= 0) this.rt.p2l_set_parameter_override(this.rig, i, value, weight);
  }

  /** The ids of the parameters a role such as AngleX moves; none when the rig gives it none. */
  roleParameters(role: string): string[] {
    const rt = this.rt;
    return withCString(rt, role, (name) => {
      const n = rt.p2l_role_parameters(this.rig, name, 0, 0);
      const out = rt.p2l_alloc(n * 4 + 4);
      rt.p2l_role_parameters(this.rig, name, out, n);
      const indices = Array.from(new Uint32Array(rt.memory.buffer, out, n));
      rt.p2l_dealloc(out, n * 4 + 4);
      return indices.flatMap((i) => this.parameters[i] ?? []);
    });
  }

  update(dt: number): void {
    this.rt.p2l_update(this.rig, dt);
  }

  /** Deforms the rig at the host's pose alone, dropping what clips and physics added. */
  evaluate(): void {
    this.rt.p2l_evaluate(this.rig);
  }

  /** Advances clips and behaviors by [dt] seconds and settles pendulums at that pose. */
  advance(dt: number): void {
    if (!Number.isFinite(dt) || !(dt > 0)) return;
    this.rt.p2l_update_stages(this.rig, dt, STAGE_CLIPS | STAGE_BEHAVIORS);
    if (this.blinkSeed !== undefined) this.rt.p2l_behavior_seed(this.rig, this.blinkSeed);
    this.rt.p2l_update_stages(this.rig, 0, STAGE_CLIPS | STAGE_EXPRESSIONS | STAGE_BEHAVIORS);
    this.rt.p2l_physics_stabilize(this.rig);
  }

  /** The meshes to draw back to front, each isolated group opened by -2 - its part and closed by -1. */
  renderCommands(): Int32Array<ArrayBuffer> {
    const count = this.rt.p2l_render_commands(this.rig, this.commandsPointer, this.commandCapacity);
    return new Int32Array(
      this.rt.memory.buffer,
      this.commandsPointer,
      Math.min(count, this.commandCapacity),
    ).slice();
  }

  meshOpacity(m: number): number {
    return this.rt.p2l_mesh_opacity(this.rig, m);
  }

  /** Mesh [m]'s multiply then screen colors, valid until the next runtime call. */
  meshColors(m: number): Float32Array<ArrayBuffer> {
    this.rt.p2l_mesh_colors(this.rig, m, this.colors, this.colors + 12);
    return new Float32Array(this.rt.memory.buffer, this.colors, 6);
  }

  /** Part [part]'s group opacity, multiply and screen colors, valid until the next runtime call; null when it has none. */
  partComposite(part: number): Float32Array<ArrayBuffer> | null {
    const c = this.colors;
    if (!this.rt.p2l_part_composite(this.rig, part, c, c + 4, c + 16)) return null;
    return new Float32Array(this.rt.memory.buffer, c, 7);
  }

  textureCount(): number {
    return this.rt.p2l_texture_count(this.rig);
  }

  /** Texture page [i]'s PNG bytes, copied out. */
  texturePng(i: number): Uint8Array<ArrayBuffer> {
    const rt = this.rt;
    const out = rt.p2l_alloc(16);
    const pointer = rt.p2l_texture_png(this.rig, i, out, out + 8, out + 12);
    const length = pointer ? (new Uint32Array(rt.memory.buffer, out, 1)[0] ?? 0) : 0;
    const png = new Uint8Array(rt.memory.buffer, pointer, length).slice();
    rt.p2l_dealloc(out, 16);
    return png;
  }

  /** What the runtime reads from the file, as a model's inventory keeps it. */
  inventory(): ModelInventory {
    const rt = this.rt;
    const meta = new Map<string, string>();
    for (let i = 0; i < rt.p2l_meta_count(this.rig); i++) {
      meta.set(
        this.string(rt.p2l_meta_key(this.rig, i)),
        this.string(rt.p2l_meta_value(this.rig, i)),
      );
    }
    const generator = meta.get("generator");
    const version = meta.get("generator_version");
    return {
      runtime: this.string(rt.p2l_version()),
      generator: generator ? (version ? `${generator} ${version}` : generator) : null,
      canvas: { width: this.width, height: this.height },
      clips: this.clips.map((clip) => ({ ...clip })),
      expressions: this.expressions.map((expression) => ({ ...expression })),
      hitAreas: this.hitAreas.map((area) => ({ ...area })),
      parameters: this.parameterRanges(),
      parts: this.parts.map((part) => ({ ...part })),
      poseGroups: this.poseGroups(),
      lipSync:
        withCString(rt, "LipSync", (role) => rt.p2l_role_parameters(this.rig, role, 0, 0)) > 0,
      textures: this.textureCount(),
    };
  }
}

/** What a .p2lrt file holds, read by the runtime without drawing it. */
export async function inspectPsd2liveRig(
  bytes: Uint8Array,
  o: { readonly runtime?: Psd2liveRuntimeSource } = {},
): Promise<ModelInventory> {
  const rig = Psd2liveRig.load(instantiatePsd2live(await compilePsd2liveRuntime(o.runtime)), bytes);
  try {
    return rig.inventory();
  } finally {
    rig.dispose();
  }
}
