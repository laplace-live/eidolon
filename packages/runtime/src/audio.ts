// Silero VAD and Smart Turn v3 on one explicit onnxruntime-node backend. pipedog's defaults pick
// a runtime by name at first use: onnxruntime-web when the native one can't load, and VAD-only
// turn ends (one warning) when @pipedog/audio-smart-turn can't. Either is a silent behavior
// change, so this module never takes a default.
import { SileroVADAnalyzer } from "@pipedog/audio-silero";
import {
  createLocalSmartTurnAnalyzerV3,
  type LocalSmartTurnAnalyzerV3,
} from "@pipedog/audio-smart-turn";
import { TurnAnalyzerUserTurnStopStrategy } from "@pipedog/core/turns/user_stop/turn_analyzer_user_turn_stop_strategy";
import {
  defaultUserTurnStartStrategies,
  UserTurnStrategies,
} from "@pipedog/core/turns/user_turn_strategies";
import { createNativeBackend, type OnnxBackend, type OrtModuleLike } from "@pipedog/onnx";

let nativeBackend: Promise<OnnxBackend> | null = null;

/**
 * The process's ONNX backend: the onnxruntime-node this package pins, since a different ORT
 * build shifts Smart Turn's probabilities. Rejects when it can't load; there is no fallback.
 */
export function onnxBackend(): Promise<OnnxBackend> {
  nativeBackend ??= import("onnxruntime-node").then((mod) => {
    const ort: OrtModuleLike = mod.InferenceSession ? mod : mod.default;
    return createNativeBackend({ ort });
  });
  return nativeBackend;
}

/** A session's VAD; the ONNX session is shared per backend. */
export function createVadAnalyzer(backend: OnnxBackend): SileroVADAnalyzer {
  return new SileroVADAnalyzer({ backend });
}

/** A session's Smart Turn analyzer; the ONNX session is shared per backend. */
export function createSmartTurnAnalyzer(backend: OnnxBackend): LocalSmartTurnAnalyzerV3 {
  return createLocalSmartTurnAnalyzerV3({ backend });
}

/** pipedog's default strategies, with the turn analyzer on `backend` instead of found by name. */
export function createUserTurnStrategies(backend: OnnxBackend): UserTurnStrategies {
  return new UserTurnStrategies({
    start: defaultUserTurnStartStrategies(),
    stop: [
      new TurnAnalyzerUserTurnStopStrategy({ turnAnalyzer: createSmartTurnAnalyzer(backend) }),
    ],
  });
}

/** Loads both models' shared sessions on `backend`, running one Smart Turn prediction. */
export async function warmModels(backend: OnnxBackend): Promise<void> {
  await createVadAnalyzer(backend).ready();
  const turn = createSmartTurnAnalyzer(backend);
  turn.setSampleRate(16000);
  turn.appendAudio(new Uint8Array(3200), true);
  await turn.analyzeEndOfTurn();
}

/** Loads the Silero VAD and Smart Turn models before the first call needs them. */
export async function warmAudioModels(): Promise<void> {
  await warmModels(await onnxBackend());
}
