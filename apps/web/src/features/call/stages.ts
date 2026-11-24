// One stage per member of a call who had a model, made as the call is placed and kept for its life,
// steered by the call's signals. A view only holds a stage's canvas, which moves between views: a
// canvas out of the page pauses its stage, and its GL context survives the move.
import type { AvatarStage, AvatarStageOptions, FrameClock } from "@laplace.live/eidolon-sdk/avatar";
import type { LoadedModel } from "./cast";
import { type CallSignals, MouthTap } from "./signals";
import type { CallTarget, CastMember } from "./target";

export type StageState = "loading" | "ready" | "failed" | "none";

/** What a view needs of a member's stage. */
export interface CastStage {
  readonly persona: string;
  /** The stage's one canvas, which whichever view shows her now holds. */
  readonly canvas: HTMLCanvasElement;
  /** Her mouth as the stage reads it, for the view's data-mouth. */
  readonly tap: MouthTap;
  readonly state: StageState;
  /** Frames the stage's loop has run, for the view's data-frames. */
  readonly frames: number;
}

/** What the stages follow: the call's direction and the bot track's meter. */
export type StageSignals = Pick<CallSignals, "subscribe" | "direction" | "mouth">;

/** The part of AvatarStage a call drives. */
export type StageLike = Pick<
  AvatarStage,
  "show" | "frame" | "direct" | "mouth" | "wear" | "dispose"
>;

/** What a stage is made of; stages.test.ts gives its own, so it runs on Node. */
export interface StageParts {
  /** A fresh canvas for her stage, the provider's `n`th. */
  canvas(persona: string, n: number): HTMLCanvasElement;
  /** Her stage on `canvas`, once the avatar code has loaded. */
  stage(canvas: HTMLCanvasElement, options: AvatarStageOptions): Promise<StageLike>;
}

export interface StageLoad {
  /** Her model as she has it now, set up and framed; null when she has none any more. */
  load(
    member: CastMember,
    canvas: HTMLCanvasElement,
    signal: AbortSignal,
  ): Promise<LoadedModel | null>;
  readonly reducedMotion: boolean;
}

interface Entry {
  readonly persona: string;
  readonly canvas: HTMLCanvasElement;
  readonly tap: MouthTap;
  /** Aborted as the stage is disposed: whatever its load brings after is dropped. */
  readonly loading: AbortController;
  state: StageState;
  frames: number;
  stage: StageLike | null;
}

const DOM_PARTS: StageParts = {
  canvas(persona, n) {
    const canvas = document.createElement("canvas");
    canvas.className = "absolute inset-0 size-full";
    canvas.setAttribute("aria-hidden", "true");
    canvas.dataset.stage = `${persona}:${n}`;
    return canvas;
  },
  async stage(canvas, options) {
    const { AvatarStage } = await import("./avatar-loader");
    return new AvatarStage(canvas, options);
  },
};

/**
 * The most frames a second a call's stage draws, however fast the display: drawing each of a 120 Hz
 * display's cost the window about 15% of a core and the GPU process 25%.
 */
const CALL_FPS = 60;

/** Animation frames, each counted on `entry` as it runs. */
function countedFrames(entry: Entry): FrameClock {
  return {
    request: (frame) =>
      requestAnimationFrame((now) => {
        entry.frames += 1;
        frame(now);
      }),
    cancel: (handle) => cancelAnimationFrame(handle as number),
  };
}

export class CallStages {
  readonly #signals: StageSignals;
  readonly #parts: StageParts;
  #entries: Entry[] = [];
  #group = false;
  /** Canvases made, for each one's data-stage. */
  #made = 0;
  #version = 0;
  #unsubscribe: (() => void) | null = null;
  readonly #listeners = new Set<() => void>();

  /** No side effects: the DOM's parts unless given. */
  constructor(signals: StageSignals, parts: StageParts = DOM_PARTS) {
    this.#signals = signals;
    this.#parts = parts;
  }

  /** A stage for each member of `target` with a model, loading at once; any before are disposed. */
  load(target: CallTarget, how: StageLoad): void {
    this.#drop();
    this.#group = target.kind === "chat" && target.group;
    // Each call's end, and StrictMode's unmount, disposes the stages: the next call routes again.
    this.#unsubscribe ??= this.#signals.subscribe(this.#route);
    for (const member of target.cast) {
      if (member.appearance.model === null) continue;
      const entry: Entry = {
        persona: member.id,
        canvas: this.#parts.canvas(member.id, ++this.#made),
        tap: new MouthTap(),
        loading: new AbortController(),
        state: "loading",
        frames: 0,
        stage: null,
      };
      this.#entries.push(entry);
      void this.#start(entry, member, how);
    }
    this.#changed();
  }

  get(persona: string): CastStage | undefined {
    return this.#entries.find((entry) => entry.persona === persona);
  }

  /** Every stage made has settled failed or none; false while none is made. */
  get blank(): boolean {
    return (
      this.#entries.length > 0 &&
      this.#entries.every(({ state }) => state === "failed" || state === "none")
    );
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Bumped on every state change and dispose. */
  readonly version = (): number => this.#version;

  /** Every stage and canvas gone, every load aborted; the object stays usable. */
  dispose(): void {
    this.#drop();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#changed();
  }

  async #start(entry: Entry, member: CastMember, how: StageLoad): Promise<void> {
    const { signal } = entry.loading;
    let stage: StageLike;
    let loaded: LoadedModel | null;
    try {
      stage = await this.#parts.stage(entry.canvas, {
        reducedMotion: how.reducedMotion,
        fps: CALL_FPS,
        onError: () => this.#set(entry, "failed"),
        clock: countedFrames(entry),
      });
      if (signal.aborted) {
        stage.dispose();
        return;
      }
      entry.stage = stage;
      loaded = await how.load(member, entry.canvas, signal);
    } catch {
      this.#set(entry, "failed");
      return;
    }
    if (signal.aborted) {
      loaded?.model.dispose();
      return;
    }
    if (loaded === null) {
      this.#set(entry, "none");
      return;
    }
    stage.show(loaded.model, loaded.setup);
    stage.frame(loaded.box);
    stage.wear(loaded.outfit);
    stage.mouth(entry.tap);
    this.#steer(entry);
    this.#set(entry, "ready");
  }

  readonly #route = (): void => {
    for (const entry of this.#entries) this.#steer(entry);
  };

  /** One bot track carries every voice, so on a group call only the speaker's stage reads it. */
  #steer(entry: Entry): void {
    const direction = this.#signals.direction(this.#group ? entry.persona : undefined);
    entry.stage?.direct(direction);
    entry.tap.source = !this.#group || direction.speaking ? this.#signals.mouth : null;
  }

  #set(entry: Entry, state: StageState): void {
    if (entry.loading.signal.aborted || entry.state === state) return;
    entry.state = state;
    this.#changed();
  }

  #drop(): void {
    for (const entry of this.#entries) {
      entry.loading.abort();
      entry.stage?.dispose();
      entry.canvas.remove();
    }
    this.#entries = [];
  }

  #changed(): void {
    this.#version += 1;
    for (const listener of [...this.#listeners]) listener();
  }
}
