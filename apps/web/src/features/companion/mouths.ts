// The desktop companion's mouth: on a call, the levels the main window sends over the port; for a
// voice message, openings worked out ahead from its file and timed by its playback.
import { type MouthSource, mouthCurve } from "@laplace.live/eidolon-sdk/avatar";

/** The port's level holds this long without a new one; past it her mouth shuts. */
export const MOUTH_STALE_MS = 250;
/** Her voice messages' mouth, in frames a second. */
export const VOICE_FPS = 60;

const SILENCE_DB = -180;

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

const performanceNow = () => performance.now();

/** Her mouth on a call: the latest level over the port, shut once none came for MOUTH_STALE_MS. */
export class PortMouth implements MouthSource {
  readonly #now: () => number;
  #level = 0;
  #at = Number.NEGATIVE_INFINITY;

  constructor(now: () => number = performanceNow) {
    this.#now = now;
  }

  /** Clamped into 0..1. */
  set(level: number): void {
    this.#level = clamp01(level);
    this.#at = this.#now();
  }

  read(): number {
    return this.#now() - this.#at > MOUTH_STALE_MS ? 0 : this.#level;
  }
}

/** The loudness, dBFS (-180 for silence), of each 1/VOICE_FPS frame of mono samples. */
export function dbFrames(samples: Float32Array, rate: number): number[] {
  const count = Math.ceil((samples.length * VOICE_FPS) / rate);
  const frames: number[] = [];
  for (let frame = 0; frame < count; frame++) {
    const start = Math.round((frame * rate) / VOICE_FPS);
    const end = Math.min(Math.round(((frame + 1) * rate) / VOICE_FPS), samples.length);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const sample = samples[i] ?? 0;
      sum += sample * sample;
    }
    const rms = end > start ? Math.sqrt(sum / (end - start)) : 0;
    frames.push(rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB);
  }
  return frames;
}

/** Her mouth's opening for each frame of a voice message: mouthCurve over dbFrames at 1/VOICE_FPS. */
export function voiceOpenings(samples: Float32Array, rate: number): Float32Array {
  return Float32Array.from(mouthCurve(dbFrames(samples, rate), { dt: 1 / VOICE_FPS }));
}

/** Her mouth for a voice message playing in the main window, timed by its playback events. */
export class VoiceTimeline implements MouthSource {
  readonly #now: () => number;
  #openings: ArrayLike<number> | null = null;
  #playing: { readonly position: number; readonly at: number } | null = null;

  constructor(now: () => number = performanceNow) {
    this.#now = now;
  }

  /** Its openings once decoded; until then, and with null, her mouth stays shut. */
  load(openings: ArrayLike<number> | null): void {
    this.#openings = openings;
  }

  /** Playing from `position` seconds, now. */
  play(position: number): void {
    this.#playing = { position, at: this.#now() };
  }

  stop(): void {
    this.#playing = null;
  }

  read(): number {
    const playing = this.#playing;
    const openings = this.#openings;
    if (playing === null || openings === null) return 0;
    const seconds = playing.position + (this.#now() - playing.at) / 1000;
    return openings[Math.floor(seconds * VOICE_FPS)] ?? 0;
  }
}

/** What her stage reads, passed through: it keeps the widest opening for data-mouth. */
export class WidestTap implements MouthSource {
  source: MouthSource | null = null;
  #widest = 0;

  read(dt: number): number {
    const level = this.source?.read(dt) ?? 0;
    if (level > this.#widest) this.#widest = level;
    return level;
  }

  /** The widest since the last take, then 0 again. */
  take(): number {
    const widest = this.#widest;
    this.#widest = 0;
    return widest;
  }
}
