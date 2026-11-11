// pipedog's @pipedog/resampler-wasm at ce8f8bc, vendored: rubato's windowed-sinc resampler compiled
// to WebAssembly (rust/), byte for byte the build pipedog's transports run.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resamplerDir } from "@eidolon/config";
import { engineFromModule, type RubatoEngine } from "./engine.ts";

export {
  QUALITIES,
  type Quality,
  type QualityInfo,
  type ResampleOptions,
  RubatoEngine,
  RubatoStream,
} from "./engine.ts";

let engine: RubatoEngine | null = null;

/** The process's engine, compiled on first use. */
export function resampler(): RubatoEngine {
  engine ??= engineFromModule(
    new WebAssembly.Module(readFileSync(join(resamplerDir(), "resampler.wasm"))),
  );
  return engine;
}
