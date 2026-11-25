// Scores MOUTH_CURVE on recordings of her voice, read as MouthMeter reads a call at 60 fps: the RMS
// of the last 1024 samples at 48 kHz once a frame, through the SDK's own loudnessOf and mouthCurve.
// Prints the voiced frames' loudness and, for the curve and Phase 0's plain loudness map, the share
// of voiced frames that leave her mouth shut and its closures a second, averaged over the files.
// Each file is decoded by ffmpeg, which must be on PATH.
//
//   node docs/benchmarks/2026-11-23-mouth-curve/score.ts <audio file>…
import { spawnSync } from "node:child_process";
import {
  loudnessOf,
  MOUTH_CURVE,
  type MouthCurveOptions,
  mouthCurve,
} from "../../../packages/sdk/src/avatar/mouth.ts";

const RATE = 48_000;
const FPS = 60;
/** MouthMeter's analyser window. */
const WINDOW = 1024;
/** A frame louder than this, in dBFS, is voiced. */
const VOICED_DB = -45;
/** An opening below SHUT is shut; a closure is the opening falling below it after rising past OPEN. */
const SHUT = 0.2;
const OPEN = 0.45;
/** The loudness map alone, as Phase 0 tuned it before the curve weighed each frame. */
const PLAIN: Partial<MouthCurveOptions> = { hi: -8, base: 1, attack: 0.035, release: 0.09 };

function decode(file: string): Float32Array {
  const run = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-f", "f32le", "-ac", "1", "-ar", String(RATE), "-"],
    { maxBuffer: 2 ** 31 - 1 },
  );
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) throw new Error(`ffmpeg can't decode ${file}: ${run.stderr.toString()}`);
  // A copy, since a Float32Array needs its offset aligned to 4 bytes.
  const bytes = new Uint8Array(run.stdout);
  return new Float32Array(bytes.buffer, 0, bytes.byteLength >> 2);
}

/** Loudness in dBFS, one a frame. */
function framesOf(samples: Float32Array): number[] {
  const frames: number[] = [];
  for (let end = WINDOW; end <= samples.length; end += RATE / FPS) {
    frames.push(loudnessOf(samples.subarray(end - WINDOW, end)));
  }
  return frames;
}

function scoreOf(frames: readonly number[], openings: readonly number[]) {
  let voiced = 0;
  let shut = 0;
  let closures = 0;
  let open = false;
  openings.forEach((opening, index) => {
    if (opening > OPEN) open = true;
    else if (open && opening < SHUT) {
      open = false;
      closures++;
    }
    if ((frames[index] ?? VOICED_DB) <= VOICED_DB) return;
    voiced++;
    if (opening < SHUT) shut++;
  });
  return { shut: voiced > 0 ? shut / voiced : 0, closures: closures / (openings.length / FPS) };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node docs/benchmarks/2026-11-23-mouth-curve/score.ts <audio file>…");
  process.exit(2);
}
const curves = { MOUTH_CURVE, "loudness map alone": PLAIN };
const totals = new Map(Object.keys(curves).map((name) => [name, { shut: 0, closures: 0 }]));
const voiced: number[] = [];
for (const file of files) {
  const frames = framesOf(decode(file));
  if (frames.length === 0) throw new Error(`${file} is shorter than one frame`);
  voiced.push(...frames.filter((db) => db > VOICED_DB));
  for (const [name, curve] of Object.entries(curves)) {
    const score = scoreOf(frames, mouthCurve(frames, curve));
    const total = totals.get(name);
    if (total === undefined) continue;
    total.shut += score.shut / files.length;
    total.closures += score.closures / files.length;
  }
}
voiced.sort((a, b) => a - b);
const percentile = (p: number) => (voiced[Math.floor(p * (voiced.length - 1))] ?? NaN).toFixed(1);
console.log(
  `${files.length} files, ${voiced.length} voiced frames: p10 ${percentile(0.1)}, p50 ${percentile(0.5)}, p90 ${percentile(0.9)} dBFS`,
);
for (const [name, total] of totals) {
  console.log(
    `${name.padEnd(20)} shut on ${(total.shut * 100).toFixed(0)}% of voiced frames, ${total.closures.toFixed(2)} closures a second`,
  );
}
