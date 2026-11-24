// The call's signals for her stages: her direction from the call's events and a tick, and her mouth
// from the bot's track. Kept apart from any stage, so a stage elsewhere can follow them too.
import type { BotOutputData } from "@laplace.live/eidolon-sdk";
import {
  type Direction,
  type DirectionEvent,
  type DirectionState,
  direct,
  directionOf,
  directionState,
  MouthMeter,
  type MouthSource,
} from "@laplace.live/eidolon-sdk/avatar";
import { SKIPPED_OUTPUT } from "./transcript";

/** How often a live call's direction ticks, firing her cues' timers and ending their pulses. */
export const TICK_MS = 100;

/**
 * A bot-output as direct() takes it; null for output that doesn't move her: words, tokens,
 * backchannels and expressions, text she won't say, or one with no segment id or spoken status.
 */
export function outputEvent(data: BotOutputData, at: number): DirectionEvent | null {
  const type = data.output_type ?? data.text_type ?? data.aggregated_by;
  if (type !== undefined && SKIPPED_OUTPUT.has(type)) return null;
  if (data.will_be_spoken === false || data.segment_id === undefined || data.text === "") {
    return null;
  }
  const status = data.spoken_status;
  if (status !== "new" && status !== "in-progress" && status !== "completed") return null;
  const event = {
    type: "bot-output",
    at,
    segment: data.segment_id,
    text: data.text,
    status,
  } as const;
  // A voice's "new" can carry an empty accumulated text, which isn't a word timing.
  const progress = status === "in-progress" ? data.spoken_progress : undefined;
  return progress === undefined ? event : { ...event, spoken: progress.accumulated_text.length };
}

/** A stage's mouth: it reads the call's meter while routed to it, and keeps how wide it opened. */
export class MouthTap implements MouthSource {
  /** The call's meter while she speaks, else null: a closed mouth. */
  source: MouthSource | null = null;
  #widest = 0;

  read(dt: number): number {
    const level = this.source?.read(dt) ?? 0;
    if (level > this.#widest) this.#widest = level;
    return level;
  }

  /** The widest opening read since the last take, then 0 again. */
  take(): number {
    const widest = this.#widest;
    this.#widest = 0;
    return widest;
  }
}

export interface SignalClock {
  now(): number;
  /** Runs `run` every `ms`; the function it returns stops it. */
  every(run: () => void, ms: number): () => void;
}

const PAGE_CLOCK: SignalClock = {
  now: () => performance.now(),
  every(run, ms) {
    const timer = setInterval(run, ms);
    return () => clearInterval(timer);
  },
};

/**
 * The shell's for its life, one call after another. The constructor starts nothing and close()
 * leaves it usable: StrictMode makes one twice and runs the shell's cleanup between its mounts.
 */
export class CallSignals {
  readonly #clock: SignalClock;
  #state: DirectionState = directionState();
  #context: AudioContext | null = null;
  #meter: MouthMeter | null = null;
  #track: string | null = null;
  #stopTicking: (() => void) | null = null;
  readonly #listeners = new Set<() => void>();
  readonly #tickListeners = new Set<() => void>();

  constructor(clock: SignalClock = PAGE_CLOCK) {
    this.#clock = clock;
  }

  /** Creates the shell's AudioContext, or resumes it after `end`. Only ever inside a click. */
  wake(): void {
    if (this.#context === null) this.#context = new AudioContext();
    else void this.#context.resume().catch(() => {});
  }

  /** Taps `track` with a MouthMeter on that context (never on the destination); null closes it. */
  listen(track: MediaStreamTrack | null): void {
    if (track !== null && track.id === this.#track) return;
    this.#closeMeter();
    if (track !== null && this.#context !== null) {
      this.#meter = new MouthMeter(track, { context: this.#context });
      this.#track = track.id;
    }
    this.#notify();
  }

  /** The bot track's meter, null without one. */
  get mouth(): MouthSource | null {
    return this.#meter;
  }

  /** A call starts: fresh direction, ticking every TICK_MS. */
  begin(): void {
    this.#stop();
    this.#reset();
    this.#stopTicking = this.#clock.every(this.#tick, TICK_MS);
    this.#notify();
  }

  /** The call is over: no tick, fresh direction, the meter closed, the context suspended. */
  end(): void {
    this.#stop();
    this.#reset();
    this.#closeMeter();
    // A tab left open after a call holds no running audio device.
    void this.#context?.suspend().catch(() => {});
    this.#notify();
  }

  feed(event: DirectionEvent): void {
    this.#state = direct(this.#state, event);
    this.#notify();
  }

  now(): number {
    return this.#clock.now();
  }

  /** directionOf(state) for a one-persona call, directionOf(state, persona) for a group member. */
  direction(persona?: string): Direction {
    return persona === undefined ? directionOf(this.#state) : directionOf(this.#state, persona);
  }

  /** Notified after every feed, tick and listen, and as a call begins and ends. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Notified after each tick alone, for what samples the call at TICK_MS. */
  readonly onTick = (listener: () => void): (() => void) => {
    this.#tickListeners.add(listener);
    return () => this.#tickListeners.delete(listener);
  };

  /** Closes and forgets the context, closes the meter, stops ticking; the next wake makes a new context. */
  close(): void {
    this.#stop();
    this.#closeMeter();
    const context = this.#context;
    this.#context = null;
    void context?.close().catch(() => {});
  }

  readonly #tick = (): void => {
    this.#state = direct(this.#state, { type: "tick", at: this.#clock.now() });
    this.#notify();
    for (const listener of [...this.#tickListeners]) listener();
  };

  #stop(): void {
    this.#stopTicking?.();
    this.#stopTicking = null;
  }

  /** Starts over, numbering gestures on: a stage that outlives a call never skips a new one. */
  #reset(): void {
    this.#state = direct(this.#state, { type: "reset", at: this.#clock.now() });
  }

  #closeMeter(): void {
    this.#meter?.close();
    this.#meter = null;
    this.#track = null;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
