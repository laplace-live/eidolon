// A PSD2Live model for the stage: a rig on a runtime instance of its own, so a trap ends only this
// model, and the renderer that draws it.
import type { Bounds, View } from "../framing.ts";
import {
  type AvatarModel,
  avatarErrorOf,
  type ModelInventory,
  type ModelOutfitLike,
} from "../model.ts";
import { Psd2liveRenderer } from "./renderer.ts";
import { Psd2liveRig } from "./rig.ts";
import {
  compilePsd2liveRuntime,
  instantiatePsd2live,
  type Psd2liveRuntimeSource,
} from "./runtime.ts";

/** Loads a .p2lrt model to draw on `canvas`, with the vendored runtime unless given another. */
export async function loadPsd2liveModel(
  canvas: HTMLCanvasElement,
  bytes: Uint8Array,
  o: { readonly runtime?: Psd2liveRuntimeSource } = {},
): Promise<Psd2liveModel> {
  const rig = Psd2liveRig.load(instantiatePsd2live(await compilePsd2liveRuntime(o.runtime)), bytes);
  let renderer: Psd2liveRenderer | null = null;
  try {
    renderer = new Psd2liveRenderer(rig, canvas);
    await renderer.loadTextures();
    return new Psd2liveModel(rig, renderer);
  } catch (error) {
    try {
      renderer?.dispose();
      rig.dispose();
    } catch {}
    throw avatarErrorOf(error, "webgl");
  }
}

/** A clip played on a layer that the model must end or replay itself. */
interface Playing {
  readonly clip: string;
  readonly priority: number;
  readonly loop: boolean;
  /** Seconds left of one pass of a clip that loops by itself, played once; null for the rest. */
  left: number | null;
}

export class Psd2liveModel implements AvatarModel {
  readonly kind = "psd2live" as const;
  readonly inventory: ModelInventory;
  /** The rig itself, for what the stage doesn't do: poses, parameters, part opacity. */
  readonly rig: Psd2liveRig;
  readonly #renderer: Psd2liveRenderer;
  readonly #playing = new Map<number, Playing>();
  /** Each pose group's entry as loaded, which taking an outfit off shows again. */
  readonly #poses: readonly number[];
  #worn: ModelOutfitLike | null = null;
  #disposed = false;

  constructor(rig: Psd2liveRig, renderer: Psd2liveRenderer) {
    this.rig = rig;
    this.#renderer = renderer;
    this.inventory = rig.inventory();
    this.#poses = this.inventory.poseGroups.map((_, group) => rig.poseShown(group));
  }

  setExpressions(ids: readonly string[]): void {
    this.#run(() => this.rig.setExpressions(ids));
  }

  play(
    clip: string | null,
    layer: 0 | 1 | 2,
    o: { readonly loop?: boolean; readonly priority?: number } = {},
  ): void {
    this.#run(() => {
      if (clip === null) {
        this.#playing.delete(layer);
        this.rig.playLayer(null, layer, 0);
        return;
      }
      const priority = o.priority ?? 1;
      if (!this.rig.playLayer(clip, layer, priority)) return;
      const loop = o.loop ?? false;
      const authored = this.inventory.clips.find(({ id }) => id === clip);
      const left = !loop && authored?.looping === true ? authored.duration : null;
      if (loop || layer > 0) this.#playing.set(layer, { clip, priority, loop, left });
      else this.#playing.delete(layer);
    });
  }

  mouth(level: number): void {
    this.#run(() => this.rig.lipSync(Math.min(Math.max(level, 0), 1)));
  }

  lookAt(x: number, y: number): void {
    this.#run(() => this.rig.lookAt(x, y));
  }

  wear(outfit: ModelOutfitLike | null): void {
    this.#run(() => {
      const worn = this.#worn;
      if (worn !== null) {
        for (const { id } of worn.parameters) this.rig.setParameterOverride(id, 0, 0);
        for (const id of worn.hiddenParts) this.rig.setPartOpacity(id, 1);
        for (const { group } of worn.poses) {
          const entry = this.#poses[group];
          if (entry !== undefined && entry >= 0) this.rig.showPose(group, entry);
        }
      }
      this.#worn = outfit;
      if (outfit === null) return;
      for (const { group, entry } of outfit.poses) this.rig.showPose(group, entry);
      for (const { id, value } of outfit.parameters) this.rig.setParameterOverride(id, value, 1);
      for (const id of outfit.hiddenParts) this.rig.setPartOpacity(id, 0);
    });
  }

  bounds(area?: string | null): Bounds | null {
    if (this.#disposed) return null;
    return this.#run(() => this.rig.bounds(area));
  }

  update(dt: number): void {
    if (this.#disposed) return;
    this.#run(() => {
      this.rig.update(dt);
      // The runtime holds a finished one-shot at its last frame over the layers below (p2l_runtime.h,
      // p2l_clip_time), which would freeze her idle under a nod: a looped clip starts again as it
      // ends, and one played once stops. A clip authored to loop wraps its time and never says it
      // finished, so played once it stops after one pass by the clock.
      for (const [layer, playing] of this.#playing) {
        const state = this.rig.layerState(layer);
        if (playing.left !== null) playing.left -= dt;
        if (state === null || state.clip !== playing.clip) {
          this.#playing.delete(layer);
        } else if (state.finished && playing.loop) {
          this.rig.playLayer(playing.clip, layer, playing.priority);
        } else if (state.finished || (playing.left !== null && playing.left <= 0)) {
          this.rig.playLayer(null, layer, 0);
          this.#playing.delete(layer);
        }
      }
    });
  }

  draw(pixelRatio: number, view: View): void {
    if (this.#disposed) return;
    this.#run(() => this.#renderer.draw(pixelRatio, view));
  }

  hitTest(clientX: number, clientY: number): string | null {
    if (this.#disposed) return null;
    return this.#run(() => {
      const [x, y] = this.#renderer.toRig(clientX, clientY);
      return this.rig.hitTest(x, y);
    });
  }

  alphaAt(clientX: number, clientY: number): number {
    if (this.#disposed) return 0;
    return this.#run(() => this.#renderer.alphaAt(clientX, clientY));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // After a trap the runtime may trap again freeing the rig; its instance goes with the model.
    try {
      this.#renderer.dispose();
    } catch {}
    try {
      this.rig.dispose();
    } catch {}
  }

  #run<T>(task: () => T): T {
    try {
      return task();
    } catch (error) {
      throw avatarErrorOf(error, "trap");
    }
  }
}
