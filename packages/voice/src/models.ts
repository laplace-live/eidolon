import { join } from "node:path";
import { voiceModelsDir } from "@eidolon/config";
import type { CallDeps } from "./types.ts";

/** The Ear's model files, in this checkout's models/ or the npm package's data/models/. */
export function voiceModels(): CallDeps["models"] {
  const dir = voiceModelsDir();
  return { silero: join(dir, "silero_vad.onnx"), smartTurn: join(dir, "smart-turn-v3.2-cpu.onnx") };
}
