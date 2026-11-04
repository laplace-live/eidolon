import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SileroVADAnalyzer } from "@pipedog/audio-silero";
import { LocalSmartTurnAnalyzerV3 } from "@pipedog/audio-smart-turn";
import { TurnAnalyzerUserTurnStopStrategy } from "@pipedog/core/turns/user_stop/turn_analyzer_user_turn_stop_strategy";
import type { OnnxBackend } from "@pipedog/onnx";
import {
  createSmartTurnAnalyzer,
  createUserTurnStrategies,
  createVadAnalyzer,
  onnxBackend,
  warmModels,
} from "../src/audio.ts";
import { captureLogs, type LogCapture } from "./support.ts";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

/** The real native backend, counting the sessions it creates. */
async function countingBackend(): Promise<{ backend: OnnxBackend; created: () => number }> {
  const native = await onnxBackend();
  let created = 0;
  return {
    backend: {
      name: native.name,
      createSession(model, options) {
        created++;
        return native.createSession(model, options);
      },
    },
    created: () => created,
  };
}

async function predict(backend: OnnxBackend): Promise<void> {
  const turn = createSmartTurnAnalyzer(backend);
  turn.setSampleRate(16000);
  turn.appendAudio(new Uint8Array(3200), true);
  await turn.analyzeEndOfTurn();
}

describe("audio models", () => {
  test("the backend is onnxruntime-node, shared by every caller", async () => {
    const backend = await onnxBackend();
    expect(backend.name).toBe("onnxruntime-node");
    expect(await onnxBackend()).toBe(backend);
  });

  test("the ORT build is the pinned 1.30.0: another shifts Smart Turn's probabilities", async () => {
    const mod: any = await import("onnxruntime-node");
    const ort = mod.InferenceSession ? mod : mod.default;
    expect(ort.env.versions).toEqual({ common: "1.30.0", node: "1.30.0" });
  });

  test("warming loads the very sessions a call's analyzers then reuse", async () => {
    const { backend, created } = await countingBackend();
    await warmModels(backend);
    expect(created()).toBe(2);
    await createVadAnalyzer(backend).ready();
    await predict(backend);
    expect(created()).toBe(2);
    expect(logs.messages("WARNING").filter((m) => m.includes("Smart Turn is unavailable"))).toEqual(
      [],
    );
  });

  test("a backend that can't load a model fails the warm-up", async () => {
    const broken: OnnxBackend = {
      name: "broken",
      createSession: async () => {
        throw new Error("model missing");
      },
    };
    await expect(warmModels(broken)).rejects.toThrow("model missing");
  });

  test("Smart Turn fails loudly too, rather than ending turns on VAD silence", async () => {
    const native = await onnxBackend();
    const smartTurnOnlyBroken: OnnxBackend = {
      name: native.name,
      createSession: async (model, options) => {
        if (String(model).includes("smart-turn")) throw new Error("smart turn missing");
        return native.createSession(model, options);
      },
    };
    await expect(warmModels(smartTurnOnlyBroken)).rejects.toThrow("smart turn missing");
  });

  test("the session strategies are pipedog's defaults with an explicit Smart Turn analyzer", async () => {
    const strategies = createUserTurnStrategies(await onnxBackend());
    expect(strategies.start.map((s) => s.constructor.name)).toEqual([
      "VADUserTurnStartStrategy",
      "TranscriptionUserTurnStartStrategy",
    ]);
    expect(strategies.stop).toHaveLength(1);
    const stop = strategies.stop[0] as TurnAnalyzerUserTurnStopStrategy;
    expect(stop).toBeInstanceOf(TurnAnalyzerUserTurnStopStrategy);
    expect((stop as any)._turnAnalyzer).toBeInstanceOf(LocalSmartTurnAnalyzerV3);
    expect(createVadAnalyzer(await onnxBackend())).toBeInstanceOf(SileroVADAnalyzer);
  });
});
