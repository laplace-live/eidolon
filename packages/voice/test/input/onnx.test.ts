import { join } from "node:path";
import { PROJECT_ROOT, spawnProcess } from "@eidolon/config";
import { describe, expect, test } from "vitest";
import { sharedSession } from "../../src/input/onnx.ts";
import { voiceModels } from "../../src/models.ts";
import { SILERO_MODEL, SMART_TURN_MODEL } from "./speech.ts";

/**
 * The exit code, and ORT_DISABLE_TELEMETRY as getenv reads it when ORT loads, in a process whose
 * environment sets it to `value`: a stand-in ORT records it as sharedSession imports it.
 */
async function telemetryAtLoad(value: string | undefined): Promise<[number, string]> {
  const env: Record<string, string> = {};
  for (const [name, set] of Object.entries(process.env)) {
    if (set !== undefined && name !== "ORT_DISABLE_TELEMETRY") env[name] = set;
  }
  if (value !== undefined) env.ORT_DISABLE_TELEMETRY = value;
  const onnx = join(import.meta.dirname, "../../src/input/onnx.ts");
  const getenv = join(import.meta.dirname, "getenv.ts");
  const child = spawnProcess(
    [
      process.execPath,
      "-e",
      `const { cEnv } = await import(${JSON.stringify(getenv)});
let seen = "never loaded";
globalThis.ortLoads = () => {
  seen = String(cEnv("ORT_DISABLE_TELEMETRY"));
};
(await import("node:module")).registerHooks({
  resolve: (specifier, context, next) =>
    specifier === "onnxruntime-node"
      ? { url: "stub:onnxruntime-node", shortCircuit: true }
      : next(specifier, context),
  load: (url, context, next) =>
    url === "stub:onnxruntime-node"
      ? {
          format: "module",
          shortCircuit: true,
          source: "globalThis.ortLoads(); export const InferenceSession = { create: async () => ({ outputNames: [] }) };",
        }
      : next(url, context),
});
const { sharedSession } = await import(${JSON.stringify(onnx)});
await sharedSession("model.onnx");
process.stdout.write(seen);`,
    ],
    { env },
  );
  const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return [code, text];
}

describe("onnx sessions", () => {
  test("the ORT build is the pinned 1.31.1: another shifts Smart Turn's probabilities", async () => {
    // Through sharedSession first, so ORT loads as the bot loads it: after its telemetry is off.
    await sharedSession(SILERO_MODEL);
    const mod: any = await import("onnxruntime-node");
    const ort = mod.InferenceSession ? mod : mod.default;
    expect(ort.env.versions).toEqual({ common: "1.31.1", node: "1.31.1" });
  });

  test("ORT's telemetry is off by the time it loads, where its getenv reads it", async () => {
    expect(await telemetryAtLoad(undefined)).toEqual([0, "1"]);
  });

  test("an ORT_DISABLE_TELEMETRY the environment sets is kept", async () => {
    expect(await telemetryAtLoad("0")).toEqual([0, "0"]);
  });

  test("the models are the committed ones in packages/voice/models", () => {
    expect(voiceModels()).toEqual({
      silero: join(PROJECT_ROOT, "packages/voice/models/silero_vad.onnx"),
      smartTurn: join(PROJECT_ROOT, "packages/voice/models/smart-turn-v3.2-cpu.onnx"),
    });
  });

  test("every caller of a model file shares its one session", async () => {
    expect(sharedSession(SILERO_MODEL)).toBe(sharedSession(SILERO_MODEL));
    const [silero, smartTurn] = await Promise.all([
      sharedSession(SILERO_MODEL),
      sharedSession(SMART_TURN_MODEL),
    ]);
    expect(silero.outputNames).toEqual(["output", "stateN"]);
    expect(smartTurn.outputNames).toHaveLength(1);
  });

  test("a model that can't load isn't kept: the next caller tries again", async () => {
    const missing = "/nonexistent/model.onnx";
    const first = sharedSession(missing);
    await expect(first).rejects.toThrow();
    const second = sharedSession(missing);
    expect(second).not.toBe(first);
    await expect(second).rejects.toThrow();
  });

  test("runs a model on float32 and int64 inputs", async () => {
    const session = await sharedSession(SILERO_MODEL);
    const out = await session.run({
      input: { type: "float32", data: new Float32Array(576), dims: [1, 576] },
      state: { type: "float32", data: new Float32Array(256), dims: [2, 1, 128] },
      sr: { type: "int64", data: BigInt64Array.of(16000n), dims: [] },
    });
    expect(out.output).toBeInstanceOf(Float32Array);
    expect(out.stateN).toHaveLength(256);
  });
});
