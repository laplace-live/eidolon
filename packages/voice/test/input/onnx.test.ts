import { describe, expect, test } from "bun:test";
import { sharedSession } from "../../src/input/onnx.ts";
import { SILERO_MODEL, SMART_TURN_MODEL } from "./speech.ts";

describe("onnx sessions", () => {
  test("the ORT build is the pinned 1.30.0: another shifts Smart Turn's probabilities", async () => {
    const mod: any = await import("onnxruntime-node");
    const ort = mod.InferenceSession ? mod : mod.default;
    expect(ort.env.versions).toEqual({ common: "1.30.0", node: "1.30.0" });
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
