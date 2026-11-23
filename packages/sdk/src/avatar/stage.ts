// A canvas her model lives on: the frame loop, which pauses while nobody can see her, and the
// direction, mouth, gaze and outfit applied to the model each frame. A model that fails is disposed
// and reported once, so the page can show her picture instead.
import type { Direction } from "./direct.ts";
import { type Box, viewFor } from "./framing.ts";
import {
  AvatarError,
  type AvatarModel,
  avatarErrorOf,
  type ModelOutfitLike,
  moodExpressions,
  type ResolvedSetup,
} from "./model.ts";
import type { MouthSource } from "./mouth.ts";

/** Animation frames, which tests replace with a clock of their own. */
export interface FrameClock {
  /** Calls `frame` once, at the next frame, with a time in milliseconds. */
  request(frame: (now: number) => void): unknown;
  cancel(handle: unknown): void;
}

export interface AvatarStageOptions {
  /** The most device pixels drawn per CSS pixel; 2 unless given. */
  readonly maxPixelRatio?: number;
  /** Frames a second at most; 0 (the default) draws every animation frame. */
  readonly fps?: number;
  /** Plays no clip, idle included, and leaves out the eyes' saccades; her face and mouth still move. */
  readonly reducedMotion?: boolean;
  /** Called once a model fails, after the stage disposed it. */
  readonly onError?: (error: AvatarError) => void;
  readonly clock?: FrameClock;
}

const ANIMATION_FRAMES: FrameClock = {
  request: (frame) => requestAnimationFrame(frame),
  cancel: (handle) => cancelAnimationFrame(handle as number),
};

/** The longest step a frame advances her by, so a stalled tab resumes without a jump. */
const MAX_DT = 0.1;
/** Slack for an fps cap, since animation frames land a little early or late. */
const FPS_SLACK_MS = 2;
const IDLE = 0;
const TALK = 1;
const GESTURE = 2;
const AWAY: readonly [number, number] = [0.35, 0.45];
/** How far idle eyes wander from the viewer, and how long they rest between moves. */
const SACCADE = 0.15;
const SACCADE_MIN_MS = 2000;
const SACCADE_MAX_MS = 5000;

const NEUTRAL: Direction = {
  persona: null,
  mood: [],
  pulse: null,
  speaking: false,
  listening: false,
  thinking: false,
  looking: "idle",
  gesture: null,
};

function clamp(value: number, limit: number): number {
  return Math.min(Math.max(value, -limit), limit);
}

/** What was applied to the model, so a frame applies only what changed. */
interface Applied {
  idle: boolean;
  expressions: string | null;
  talking: boolean;
  outfit: boolean;
}

export class AvatarStage {
  readonly #canvas: HTMLCanvasElement;
  readonly #maxPixelRatio: number;
  readonly #fps: number;
  readonly #reducedMotion: boolean;
  readonly #onError: ((error: AvatarError) => void) | undefined;
  readonly #clock: FrameClock;
  #model: AvatarModel | null = null;
  #setup: ResolvedSetup | null = null;
  #box: Box | null = null;
  #direction: Direction = NEUTRAL;
  #applied: Applied = { idle: false, expressions: null, talking: false, outfit: false };
  #gestureSeq: number | null = null;
  #mouth: MouthSource | null = null;
  #gaze: "direction" | "pointer" | readonly [number, number] = "direction";
  #pointer: readonly [number, number] | null = null;
  #saccade: { readonly x: number; readonly y: number; readonly until: number } | null = null;
  #outfit: ModelOutfitLike | null = null;
  #reads: { readonly x: number; readonly y: number; readonly done: (alpha: number) => void }[] = [];
  #handle: unknown = null;
  #last: number | null = null;
  #paused = false;
  #hidden = false;
  #offscreen = false;
  #disposed = false;
  readonly #observer: IntersectionObserver | null = null;

  constructor(canvas: HTMLCanvasElement, o: AvatarStageOptions = {}) {
    this.#canvas = canvas;
    this.#maxPixelRatio = o.maxPixelRatio ?? 2;
    this.#fps = o.fps ?? 0;
    this.#reducedMotion = o.reducedMotion ?? false;
    this.#onError = o.onError;
    this.#clock = o.clock ?? ANIMATION_FRAMES;
    canvas.addEventListener("webglcontextlost", this.#onContextLost);
    if (typeof document !== "undefined") {
      this.#hidden = document.hidden;
      document.addEventListener("visibilitychange", this.#onVisibility);
    }
    if (typeof IntersectionObserver !== "undefined") {
      this.#observer = new IntersectionObserver((entries) => {
        const entry = entries.at(-1);
        if (entry === undefined) return;
        this.#offscreen = !entry.isIntersecting;
        this.#reschedule();
      });
      this.#observer.observe(canvas);
    }
  }

  /** The model shown, for controls that drive it directly. */
  get model(): AvatarModel | null {
    return this.#model;
  }

  /** Shows `model`, disposing the one shown before. */
  show(model: AvatarModel, setup: ResolvedSetup): void {
    if (this.#disposed) {
      model.dispose();
      return;
    }
    if (this.#model !== model) this.#drop();
    this.#model = model;
    this.#setup = setup;
    this.#applied = { idle: false, expressions: null, talking: false, outfit: false };
    this.#last = null;
    this.#reschedule();
  }

  /** Frames `box`, a region of the rig's canvas, filling the canvas element whatever its size. */
  frame(box: Box): void {
    this.#box = box;
  }

  /** The direction to follow from the next frame; the latest wins. */
  direct(direction: Direction): void {
    this.#direction = direction;
  }

  /** What her mouth follows, read once a frame; null keeps it shut. */
  mouth(source: MouthSource | null): void {
    this.#mouth = source;
  }

  /** Where she looks: as her direction says, at the pointer, or at a fixed point (each axis -1..1, y up). */
  gaze(mode: "direction" | "pointer" | readonly [number, number]): void {
    const following = this.#gaze === "pointer";
    this.#gaze = mode;
    if (typeof window === "undefined" || following === (mode === "pointer")) return;
    if (mode === "pointer") window.addEventListener("pointermove", this.#onPointer);
    else window.removeEventListener("pointermove", this.#onPointer);
  }

  wear(outfit: ModelOutfitLike | null): void {
    this.#outfit = outfit;
    this.#applied.outfit = false;
  }

  /** The drawn alpha, 0..1, under a point of the page after the next draw; 0 without a model. */
  alphaAt(clientX: number, clientY: number): Promise<number> {
    if (this.#disposed || this.#model === null) return Promise.resolve(0);
    return new Promise((done) => {
      this.#reads.push({ x: clientX, y: clientY, done });
      this.#reschedule();
    });
  }

  pause(): void {
    this.#paused = true;
    this.#reschedule();
  }

  resume(): void {
    this.#paused = false;
    this.#reschedule();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#reschedule();
    this.#canvas.removeEventListener("webglcontextlost", this.#onContextLost);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.#onVisibility);
    }
    this.#observer?.disconnect();
    this.gaze("direction");
    this.#drop();
  }

  readonly #onVisibility = (): void => {
    this.#hidden = document.hidden;
    this.#reschedule();
  };

  readonly #onPointer = (event: PointerEvent): void => {
    this.#pointer = [event.clientX, event.clientY];
  };

  readonly #onContextLost = (): void => {
    const model = this.#model;
    if (model !== null) this.#fail(model, new AvatarError("lost", "The WebGL context was lost"));
  };

  #running(): boolean {
    return (
      this.#model !== null && !this.#paused && !this.#hidden && !this.#offscreen && !this.#disposed
    );
  }

  /** Requests the next frame while the loop should run, and cancels it while it shouldn't. */
  #reschedule(): void {
    if (this.#running()) {
      if (this.#handle === null) this.#handle = this.#clock.request(this.#frame);
      return;
    }
    if (this.#handle !== null) {
      this.#clock.cancel(this.#handle);
      this.#handle = null;
    }
    this.#last = null;
  }

  readonly #frame = (now: number): void => {
    this.#handle = null;
    const model = this.#model;
    if (model === null || !this.#running()) return;
    const last = this.#last;
    if (this.#fps > 0 && last !== null && now - last < 1000 / this.#fps - FPS_SLACK_MS) {
      this.#reschedule();
      return;
    }
    const dt = last === null ? 0 : Math.min(Math.max((now - last) / 1000, 0), MAX_DT);
    this.#last = now;
    const reads = this.#reads.splice(0);
    try {
      this.#apply(model, now);
      model.mouth(this.#level(dt));
      model.update(dt);
      model.draw(this.#pixelRatio(), this.#view(model));
      // The drawing buffer is cleared once the page composites the frame, so it is read now.
      for (const read of reads) read.done(model.alphaAt(read.x, read.y));
    } catch (error) {
      for (const read of reads) read.done(0);
      this.#fail(model, error);
      return;
    }
    this.#reschedule();
  };

  #level(dt: number): number {
    try {
      return this.#mouth?.read(dt) ?? 0;
    } catch {
      return 0;
    }
  }

  #pixelRatio(): number {
    const ratio =
      typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
    return Math.min(ratio, this.#maxPixelRatio);
  }

  #view(model: AvatarModel) {
    const { width, height } = model.inventory.canvas;
    return viewFor(
      this.#box ?? { x: 0, y: 0, width, height },
      { width, height },
      { width: this.#canvas.clientWidth, height: this.#canvas.clientHeight },
    );
  }

  #apply(model: AvatarModel, now: number): void {
    const setup = this.#setup;
    if (setup === null) return;
    const direction = this.#direction;
    const applied = this.#applied;
    if (!applied.outfit) {
      model.wear(this.#outfit);
      applied.outfit = true;
    }
    if (!applied.idle) {
      if (!this.#reducedMotion && setup.gestures.idle !== null) {
        model.play(setup.gestures.idle, IDLE, { loop: true });
      }
      applied.idle = true;
    }
    // A lent mood shows over the reply's when the two can't both.
    const tags = direction.pulse === null ? direction.mood : [direction.pulse, ...direction.mood];
    const expressions = moodExpressions(setup, tags);
    const key = expressions.join("\n");
    if (key !== applied.expressions) {
      model.setExpressions(expressions);
      applied.expressions = key;
    }
    const talking = direction.speaking && !this.#reducedMotion && setup.gestures.talk !== null;
    if (talking !== applied.talking) {
      model.play(talking ? setup.gestures.talk : null, TALK, { loop: true });
      applied.talking = talking;
    }
    const gesture = direction.gesture;
    if (gesture !== null && gesture.seq !== this.#gestureSeq) {
      this.#gestureSeq = gesture.seq;
      const clip = setup.gestures[gesture.name];
      if (!this.#reducedMotion && clip !== null) model.play(clip, GESTURE, { priority: 2 });
    }
    const [x, y] = this.#lookTarget(direction, now);
    model.lookAt(x, y);
  }

  #lookTarget(direction: Direction, now: number): readonly [number, number] {
    const gaze = this.#gaze;
    if (gaze === "pointer") return this.#pointerTarget();
    if (gaze !== "direction") return gaze;
    if (direction.looking === "viewer") return [0, 0];
    if (direction.looking === "away") {
      if (this.#reducedMotion) return AWAY;
      const t = now / 1000;
      return [AWAY[0] + 0.04 * Math.sin(t * 0.9), AWAY[1] + 0.03 * Math.sin(t * 1.3)];
    }
    if (this.#reducedMotion) return [0, 0];
    const saccade = this.#saccade;
    if (saccade !== null && saccade.until > now) return [saccade.x, saccade.y];
    const next = {
      x: (Math.random() * 2 - 1) * SACCADE,
      y: (Math.random() * 2 - 1) * SACCADE,
      until: now + SACCADE_MIN_MS + Math.random() * (SACCADE_MAX_MS - SACCADE_MIN_MS),
    };
    this.#saccade = next;
    return [next.x, next.y];
  }

  #pointerTarget(): readonly [number, number] {
    const pointer = this.#pointer;
    if (pointer === null) return [0, 0];
    const rect = this.#canvas.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return [0, 0];
    return [
      clamp((pointer[0] - (rect.left + rect.width / 2)) / (rect.width / 2), 1),
      clamp(-(pointer[1] - (rect.top + rect.height / 2)) / (rect.height / 2), 1),
    ];
  }

  /** Disposes a model that threw and reports it, once. */
  #fail(model: AvatarModel, error: unknown): void {
    if (this.#model !== model) return;
    this.#drop();
    this.#reschedule();
    this.#onError?.(avatarErrorOf(error, "trap"));
  }

  #drop(): void {
    const model = this.#model;
    this.#model = null;
    this.#setup = null;
    for (const read of this.#reads.splice(0)) read.done(0);
    if (model === null) return;
    try {
      model.dispose();
    } catch {}
  }
}
