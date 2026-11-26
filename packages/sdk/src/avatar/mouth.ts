// Her mouth from her voice's loudness. A plain loudness map holds the mouth open through connected
// speech, so each frame is also weighed against the loudness around it: the dips between syllables
// close it.

/** The opening curve, loudness in dBFS and times in seconds. */
export interface MouthCurveOptions {
  /** Loudness at which the loudness map reads 0; the mouth stays shut until 2 dB above it. */
  readonly lo: number;
  /** Loudness at which it opens fully. */
  readonly hi: number;
  /** How far back a syllable's peak is remembered. */
  readonly peakWindow: number;
  /** How far back the dip before it is looked for. */
  readonly floorWindow: number;
  /** The narrowest swing in dB read as a syllable, so a held vowel keeps the mouth open. */
  readonly minRange: number;
  /** How open the mouth stays at a dip, as a share of the loudness map. */
  readonly base: number;
  readonly attack: number;
  readonly release: number;
}

/**
 * Tuned on her 12 Fish voice messages: it shuts the mouth on 25% of voiced frames, 1.5 closures a
 * second, where the loudness map alone gave 0.46.
 */
export const MOUTH_CURVE: MouthCurveOptions = {
  lo: -40,
  hi: -10,
  peakWindow: 0.25,
  floorWindow: 0.12,
  minRange: 10,
  base: 0.1,
  attack: 0.02,
  release: 0.045,
};

const GATE_DB = 2;
const SILENCE_DB = -180;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The loudness of samples (-1..1), in dBFS. */
export function loudnessOf(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] ?? 0;
    sum += sample * sample;
  }
  const rms = samples.length > 0 ? Math.sqrt(sum / samples.length) : 0;
  return rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB;
}

/** The curve run frame by frame, carrying its windows and envelope. */
export class MouthFollower {
  readonly #o: MouthCurveOptions;
  readonly #frames: { readonly at: number; readonly db: number }[] = [];
  #time = 0;
  #level = 0;

  constructor(o: Partial<MouthCurveOptions> = {}) {
    this.#o = { ...MOUTH_CURVE, ...o };
  }

  /** The opening, 0..1, after a frame of `db` that lasted `dt` seconds. */
  step(db: number, dt: number): number {
    const o = this.#o;
    const elapsed = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.#time += elapsed;
    const frames = this.#frames;
    frames.push({ at: this.#time, db });
    const horizon = this.#time - Math.max(o.peakWindow, o.floorWindow);
    while (frames.length > 1 && (frames[0]?.at ?? 0) <= horizon) frames.shift();
    let peak = db;
    let floor = db;
    for (const frame of frames) {
      if (frame.at > this.#time - o.peakWindow && frame.db > peak) peak = frame.db;
      if (frame.at > this.#time - o.floorWindow && frame.db < floor) floor = frame.db;
    }
    const range = Math.max(peak - floor, o.minRange);
    const local = clamp01((db - (peak - range)) / range);
    const loud = clamp01((db - o.lo) / (o.hi - o.lo));
    const target = db < o.lo + GATE_DB ? 0 : loud * (o.base + (1 - o.base) * local);
    const tau = target > this.#level ? o.attack : o.release;
    if (elapsed > 0) this.#level += (target - this.#level) * (1 - Math.exp(-elapsed / tau));
    return this.#level;
  }
}

/** The mouth openings, 0..1, for frames of loudness in dBFS, `dt` seconds apart (1/60 unless given). */
export function mouthCurve(
  dbFrames: readonly number[],
  o: Partial<MouthCurveOptions> & { readonly dt?: number } = {},
): number[] {
  const follower = new MouthFollower(o);
  const dt = o.dt ?? 1 / 60;
  return dbFrames.map((db) => follower.step(db, dt));
}

/** Something her mouth follows: read once a frame, `dt` seconds after the last. */
export interface MouthSource {
  read(dt: number): number;
}

/** The analyser's window: 21 ms at 48 kHz, about a frame and a third at 60 fps. */
const FFT_SIZE = 1024;

/**
 * Her mouth from an audio track, such as the call's bot track, read through an AnalyserNode that
 * reaches no speaker. It keeps no animation loop: the stage reads it once a frame.
 */
export class MouthMeter implements MouthSource {
  readonly #context: AudioContext;
  readonly #ownContext: boolean;
  readonly #source: MediaStreamAudioSourceNode;
  readonly #analyser: AnalyserNode;
  readonly #samples: Float32Array<ArrayBuffer>;
  readonly #follower: MouthFollower;
  #closed = false;

  constructor(
    source: MediaStreamTrack | MediaStream,
    o: { readonly context?: AudioContext; readonly curve?: Partial<MouthCurveOptions> } = {},
  ) {
    const stream =
      typeof (source as MediaStream).getAudioTracks === "function"
        ? (source as MediaStream)
        : new MediaStream([source as MediaStreamTrack]);
    this.#ownContext = o.context === undefined;
    this.#context = o.context ?? new AudioContext();
    try {
      // Browsers refuse a stream with no audio track.
      this.#source = this.#context.createMediaStreamSource(stream);
      this.#analyser = this.#context.createAnalyser();
      this.#analyser.fftSize = FFT_SIZE;
      this.#source.connect(this.#analyser);
    } catch (error) {
      if (this.#ownContext) void this.#context.close().catch(() => {});
      throw error;
    }
    // An AudioContext made outside a click starts suspended, and a suspended one reads silence.
    if (this.#context.state === "suspended") void this.#context.resume().catch(() => {});
    // 8-bit samples quantize near -42 dBFS, the curve's floor, so they are read as floats.
    this.#samples = new Float32Array(this.#analyser.fftSize);
    this.#follower = new MouthFollower(o.curve);
  }

  read(dt: number): number {
    if (this.#closed) return 0;
    this.#analyser.getFloatTimeDomainData(this.#samples);
    return this.#follower.step(loudnessOf(this.#samples), dt);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#source.disconnect();
    if (this.#ownContext) void this.#context.close().catch(() => {});
  }
}
