import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PROJECT_ROOT } from "@eidolon/config";
import { sharedSession } from "../../src/input/onnx.ts";
import { voiceModels } from "../../src/models.ts";
import { SILERO_MODEL, SMART_TURN_MODEL } from "./speech.ts";

describe("onnx sessions", () => {
  test("the ORT build is the pinned 1.30.0: another shifts Smart Turn's probabilities", async () => {
    // Through sharedSession first, so ORT loads as the bot loads it: after its telemetry is off.
    await sharedSession(SILERO_MODEL);
    const mod: any = await import("onnxruntime-node");
    const ort = mod.InferenceSession ? mod : mod.default;
    expect(ort.env.versions).toEqual({ common: "1.30.0", node: "1.30.0" });
  });

  test("ORT's telemetry is off by the time it loads, where its getenv reads it", async () => {
    const onnx = join(import.meta.dir, "../../src/input/onnx.ts");
    const getenv = join(import.meta.dir, "getenv.ts");
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.ORT_DISABLE_TELEMETRY;
    // A stand-in ORT records what its getenv would read as it loads.
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `const { cEnv } = await import(${JSON.stringify(getenv)});
let seen = "never loaded";
Bun.plugin({
  setup(build) {
    build.module("onnxruntime-node", () => {
      seen = String(cEnv("ORT_DISABLE_TELEMETRY"));
      return { exports: { InferenceSession: { create: async () => ({ outputNames: [] }) } }, loader: "object" };
    });
  },
});
const { sharedSession } = await import(${JSON.stringify(onnx)});
await sharedSession("model.onnx");
process.stdout.write(seen);`,
      ],
      { env, stdout: "pipe", stderr: "inherit" },
    );
    expect([await child.exited, await new Response(child.stdout).text()]).toEqual([0, "1"]);
  });

  test("an ORT_DISABLE_TELEMETRY the environment sets is kept", async () => {
    const onnx = join(import.meta.dir, "../../src/input/onnx.ts");
    const getenv = join(import.meta.dir, "getenv.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `const { cEnv } = await import(${JSON.stringify(getenv)});
const { sharedSession } = await import(${JSON.stringify(onnx)});
await sharedSession(${JSON.stringify(SILERO_MODEL)});
process.stdout.write(String(cEnv("ORT_DISABLE_TELEMETRY")));`,
      ],
      { env: { ...process.env, ORT_DISABLE_TELEMETRY: "0" }, stdout: "pipe", stderr: "inherit" },
    );
    expect([await child.exited, await new Response(child.stdout).text()]).toEqual([0, "0"]);
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
