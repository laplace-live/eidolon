import { CString, dlopen, FFIType } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PROJECT_ROOT } from "@eidolon/config";
import { sharedSession } from "../../src/input/onnx.ts";
import { voiceModels } from "../../src/models.ts";
import { SILERO_MODEL, SMART_TURN_MODEL } from "./speech.ts";

/** `name` as getenv reads it, which process.env doesn't change under Bun; null when unset. */
function cEnv(name: string): string | null {
  const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    getenv: { args: [FFIType.cstring], returns: FFIType.ptr },
  });
  try {
    const value = libc.symbols.getenv(Buffer.from(`${name}\0`));
    return value === null ? null : new CString(value).toString();
  } finally {
    libc.close();
  }
}

describe("onnx sessions", () => {
  test("the ORT build is the pinned 1.30.0: another shifts Smart Turn's probabilities", async () => {
    const mod: any = await import("onnxruntime-node");
    const ort = mod.InferenceSession ? mod : mod.default;
    expect(ort.env.versions).toEqual({ common: "1.30.0", node: "1.30.0" });
  });

  test("ORT's telemetry is off by the time it loads, where its getenv reads it", async () => {
    await sharedSession(SILERO_MODEL);
    expect(cEnv("ORT_DISABLE_TELEMETRY")).toBe("1");
  });

  test("an ORT_DISABLE_TELEMETRY the environment sets is kept", async () => {
    const onnx = join(import.meta.dir, "../../src/input/onnx.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `import { dlopen, FFIType, CString } from "bun:ffi";
const { sharedSession } = await import(${JSON.stringify(onnx)});
await sharedSession(${JSON.stringify(SILERO_MODEL)});
const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
  getenv: { args: [FFIType.cstring], returns: FFIType.ptr },
});
process.stdout.write(new CString(libc.symbols.getenv(Buffer.from("ORT_DISABLE_TELEMETRY\\0"))).toString());`,
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
