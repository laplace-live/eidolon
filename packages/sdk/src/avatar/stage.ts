// A canvas her model lives on: the frame loop, which pauses while nobody can see her, and the
// direction, mouth, gaze and outfit applied to the model each frame. A model that fails is disposed
// and reported once, so the page can show her picture instead.
import type { Direction } from "./direct.ts";
import { type Box, viewFor } from "./framing.ts";
import { HEAD_GESTURES, type HeadGesture, headGestureHolds, MoodHolds } from "./holds.ts";
import {
  AvatarError,
  type AvatarModel,
  avatarErrorOf,
  type Gesture,
  type ModelOutfitLike,
  moodExpressions,
  moodSettings,
  type ParameterHold,
  type ResolvedSetup,
} from "./model.ts";
import { type AvatarStageMotion, AWAY } from "./motions.ts";
import type { MouthSource } from "./mouth.ts";

/** Animation frames, which tests replace with a clock of their own. */
export interface FrameClock {
  /** Calls `frame` once, at the next frame, with a time in milliseconds. */
  request(frame: (now: number) => void): unknown;
  cancel(handle: unknown): void;
}

export interface AvatarStageOptions extends AvatarStageMotion {
  /** The most device pixels drawn per CSS pixel; 2 unless given. */
  readonly maxPixelRatio?: number;
  /** Frames a second at most; 0 (the default) draws every animation frame. */
  readonly fps?: number;
  /**
   * Plays no clip, idle included, and no nod or shake of its own, and leaves out the eyes' saccades;
   * her face and mouth still move.
   */
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
const MIN_PACE = 0.25;
const MAX_PACE = 4;
const IDLE = 0;
const TALK = 1;
const GESTURE = 2;
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

function sameHolds(a: readonly ParameterHold[], b: readonly ParameterHold[]): boolean {
  return (
    a.length === b.length &&
    a.every((hold, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        hold.id === other.id &&
        hold.value === other.value &&
        hold.weight === other.weight
      );
    })
  );
}

/** What was applied to the model, so a frame applies only what changed. */
interface Applied {
  /** The clip the stage plays on the idle layer; null for none. */
  idle: string | null;
  expressions: string | null;
  /** The clip the stage plays on the talk layer; null for none. */
  talk: string | null;
  outfit: boolean;
  /** How far her gaze turns her; null until a setup's is applied. */
  look: number | null;
}

export class AvatarStage {
  readonly #canvas: HTMLCanvasElement;
  readonly #maxPixelRatio: number;
  readonly #fps: number;
  readonly #reducedMotion: boolean;
  readonly #pace: number;
  readonly #offset: number;
  readonly #sway: number;
  readonly #away: readonly [number, number];
  readonly #reaction: number;
  readonly #onError: ((error: AvatarError) => void) | undefined;
  readonly #clock: FrameClock;
  #model: AvatarModel | null = null;
  #setup: ResolvedSetup | null = null;
  #box: Box | null = null;
  #direction: Direction = NEUTRAL;
  #applied: Applied = { idle: null, expressions: null, talk: null, outfit: false, look: null };
  #moods = new MoodHolds();
  /** A model was shown anew since the last frame: its starting offset is applied once. */
  #fresh = false;
  /** A setup was shown since the last frame: its moods' parameters take their values at once. */
  #settle = true;
  /** What the model was last told to hold. */
  #held: readonly ParameterHold[] = [];
  #gestureSeq: number | null = null;
  /** A non-speaking direction gesture waiting out `#reaction`. */
  #delayed: { readonly name: Gesture; readonly at: number } | null = null;
  /** A gesture a page asked for, made at the next frame. */
  #asked: Gesture | null = null;
  /** Seconds of frames applied, scaled by `#pace`, so a pause holds it as it holds the clips. */
  #time = 0;
  /** A nod or a shake the stage plays through her head's parameters, from a `#time`. */
  #motion: { readonly name: HeadGesture; readonly at: number } | null = null;
  /** The model's role parameters, as asked for. */
  #roles = new Map<string, readonly string[]>();
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
    this.#pace =
      o.pace !== undefined && Number.isFinite(o.pace) && o.pace > 0
        ? Math.min(Math.max(o.pace, MIN_PACE), MAX_PACE)
        : 1;
    this.#offset =
      o.offset !== undefined && Number.isFinite(o.offset) && o.offset > 0 ? o.offset : 0;
    this.#sway = o.sway !== undefined && Number.isFinite(o.sway) && o.sway >= 0 ? o.sway : 1;
    this.#away = o.away !== undefined ? [clamp(o.away[0], 1), clamp(o.away[1], 1)] : AWAY;
    this.#reaction =
      o.reaction !== undefined && Number.isFinite(o.reaction) && o.reaction > 0 ? o.reaction : 0;
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

  /**
   * Shows `model`, disposing the one shown before. Shown again, the same model takes `setup` in
   * place, and a clip it plays goes on unless `setup` changed it.
   */
  show(model: AvatarModel, setup: ResolvedSetup): void {
    if (this.#disposed) {
      model.dispose();
      return;
    }
    const same = this.#model === model;
    if (!same) {
      this.#drop();
      this.#last = null;
      this.#moods = new MoodHolds();
      this.#held = [];
      this.#delayed = null;
      this.#motion = null;
      this.#roles = new Map();
      this.#fresh = true;
    }
    this.#model = model;
    this.#setup = setup;
    this.#settle = true;
    const was = this.#applied;
    this.#applied = {
      idle: same ? was.idle : null,
      expressions: null,
      talk: same ? was.talk : null,
      outfit: was.outfit && same,
      look: null,
    };
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

  /**
   * Makes a gesture at the next frame, outside her direction and under reduced motion too: its clip
   * once over her idle and talking, or for a nod or a head shake with no clip, a turn of her head.
   */
  gesture(name: Gesture): void {
    this.#asked = name;
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
    const step = dt * this.#pace;
    this.#last = now;
    const reads = this.#reads.splice(0);
    try {
      this.#apply(model, now, step);
      model.mouth(this.#level(dt));
      model.update(step);
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

  #apply(model: AvatarModel, now: number, step: number): void {
    this.#time += step;
    const setup = this.#setup;
    if (setup === null) return;
    const direction = this.#direction;
    const applied = this.#applied;
    if (!applied.outfit) {
      model.wear(this.#outfit);
      applied.outfit = true;
    }
    if (setup.look !== applied.look) {
      if (this.#sway === 1) model.lookStrength(setup.look);
      else model.lookStrength(setup.look, { sway: this.#sway });
      applied.look = setup.look;
    }
    const idle = this.#reducedMotion ? null : setup.gestures.idle;
    if (idle !== applied.idle) {
      model.play(idle, IDLE, { loop: true });
      applied.idle = idle;
    }
    if (this.#fresh) {
      this.#fresh = false;
      if (!this.#reducedMotion && this.#offset > 0) model.advance?.(this.#offset);
    }
    // A lent mood shows over the reply's when the two can't both.
    const tags = direction.pulse === null ? direction.mood : [direction.pulse, ...direction.mood];
    const expressions = moodExpressions(setup, tags);
    const key = expressions.join("\n");
    if (key !== applied.expressions) {
      model.setExpressions(expressions);
      applied.expressions = key;
    }
    const talk = direction.speaking && !this.#reducedMotion ? setup.gestures.talk : null;
    if (talk !== applied.talk) {
      model.play(talk, TALK, { loop: true });
      applied.talk = talk;
    }
    const gesture = direction.gesture;
    if (gesture !== null && gesture.seq !== this.#gestureSeq) {
      this.#gestureSeq = gesture.seq;
      if (!this.#reducedMotion) {
        if (!direction.speaking && this.#reaction > 0) {
          this.#delayed = { name: gesture.name, at: this.#time + this.#reaction * this.#pace };
        } else {
          this.#delayed = null;
          this.#make(model, setup, gesture.name);
        }
      }
    }
    if (this.#delayed !== null && this.#time >= this.#delayed.at) {
      const { name } = this.#delayed;
      this.#delayed = null;
      this.#make(model, setup, name);
    }
    if (this.#asked !== null) {
      this.#delayed = null;
      this.#make(model, setup, this.#asked);
      this.#asked = null;
    }
    this.#moods.set(moodSettings(setup, tags), this.#settle);
    this.#settle = false;
    // The head's turn goes over a mood that holds the same parameter.
    const holds = [...this.#moods.step(step), ...this.#motionHolds(model)];
    if (!sameHolds(holds, this.#held)) {
      model.hold(holds);
      this.#held = holds;
    }
    const [x, y] = this.#lookTarget(direction, now);
    model.lookAt(x, y);
  }

  /**
   * A gesture's clip once on the gesture layer, or for a nod or a head shake with no clip, a turn of
   * her head; either replaces a gesture still playing.
   */
  #make(model: AvatarModel, setup: ResolvedSetup, name: Gesture): void {
    const clip = setup.gestures[name];
    if (clip !== null) {
      this.#motion = null;
      model.play(clip, GESTURE, { priority: 2 });
      return;
    }
    if (name !== "nod" && name !== "shake") return;
    model.play(null, GESTURE);
    this.#motion = { name, at: this.#time };
  }

  /** What the nod or shake under way holds now on her head's parameters; none once it is over. */
  #motionHolds(model: AvatarModel): ParameterHold[] {
    const motion = this.#motion;
    if (motion === null) return [];
    const { role, seconds } = HEAD_GESTURES[motion.name];
    const t = (this.#time - motion.at) / seconds;
    if (!(t < 1)) {
      this.#motion = null;
      return [];
    }
    let ids = this.#roles.get(role);
    if (ids === undefined) {
      ids = model.roleParameters(role);
      this.#roles.set(role, ids);
    }
    const turned = new Set(ids);
    const parameters = model.inventory.parameters.filter(({ id }) => turned.has(id));
    return headGestureHolds(motion.name, t, parameters).filter(({ weight }) => weight > 0);
  }

  #lookTarget(direction: Direction, now: number): readonly [number, number] {
    const gaze = this.#gaze;
    if (gaze === "pointer") return this.#pointerTarget();
    if (gaze !== "direction") return gaze;
    if (direction.looking === "viewer") return [0, 0];
    if (direction.looking === "away") {
      if (this.#reducedMotion) return this.#away;
      const t = this.#offset + this.#time;
      return [this.#away[0] + 0.04 * Math.sin(t * 0.9), this.#away[1] + 0.03 * Math.sin(t * 1.3)];
    }
    if (this.#reducedMotion) return [0, 0];
    const saccade = this.#saccade;
    if (saccade !== null && saccade.until > now) return [saccade.x, saccade.y];
    const dwell = (SACCADE_MIN_MS + Math.random() * (SACCADE_MAX_MS - SACCADE_MIN_MS)) / this.#pace;
    const next = {
      x: (Math.random() * 2 - 1) * SACCADE,
      y: (Math.random() * 2 - 1) * SACCADE,
      until: now + dwell,
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
