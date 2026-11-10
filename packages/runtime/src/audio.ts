// Silero VAD and Smart Turn v3 on one explicit onnxruntime-node backend. pipedog's defaults pick
// a runtime by name at first use: onnxruntime-web when the native one can't load, and VAD-only
// turn ends (one warning) when @pipedog/audio-smart-turn can't. Either is a silent behavior
// change, so this module never takes a default.
import { dlopen, FFIType } from "bun:ffi";
import { fileURLToPath } from "node:url";
import { warmVoiceModels } from "@eidolon/voice";
import { defaultSileroModelUrl, SileroVADAnalyzer } from "@pipedog/audio-silero";
import {
  createLocalSmartTurnAnalyzerV3,
  defaultSmartTurnModelUrl,
  type LocalSmartTurnAnalyzerV3,
} from "@pipedog/audio-smart-turn";
import { TurnAnalyzerUserTurnStopStrategy } from "@pipedog/core/turns/user_stop/turn_analyzer_user_turn_stop_strategy";
import {
  defaultUserTurnStartStrategies,
  UserTurnStrategies,
} from "@pipedog/core/turns/user_turn_strategies";
import { createNativeBackend, type OnnxBackend, type OrtModuleLike } from "@pipedog/onnx";
import { voiceEngineFromEnv } from "./native/engine.ts";

let nativeBackend: Promise<OnnxBackend> | null = null;

/**
 * Sets ORT_DISABLE_TELEMETRY=1 in the C environment, unless it is set there already. ORT's Linux and
 * macOS builds upload telemetry to Microsoft by default, and on macOS the uploader aborts the process
 * as it exits (134, "A C++ exception occurred" under Bun) when a response lands during its teardown:
 * https://github.com/microsoft/onnxruntime/blob/main/docs/Privacy.md#disabling-telemetry,
 * https://github.com/dfrostar/neuralmind/issues/547. ORT reads the variable with getenv, which Bun's
 * process.env never reaches; Windows builds don't read it.
 */
function disableOrtTelemetry(): void {
  if (process.platform === "win32") return;
  const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    setenv: { args: [FFIType.cstring, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
  });
  try {
    libc.symbols.setenv(Buffer.from("ORT_DISABLE_TELEMETRY\0"), Buffer.from("1\0"), 0);
  } finally {
    libc.close();
  }
}

/**
 * The process's ONNX backend: the onnxruntime-node this package pins, since a different ORT
 * build shifts Smart Turn's probabilities. Rejects when it can't load; there is no fallback.
 */
export function onnxBackend(): Promise<OnnxBackend> {
  nativeBackend ??= (async () => {
    disableOrtTelemetry();
    const mod = await import("onnxruntime-node");
    const ort: OrtModuleLike = mod.InferenceSession ? mod : mod.default;
    return createNativeBackend({ ort });
  })();
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

/** The model files pipedog's analyzers load, which the native engine's Ear loads too. */
export function voiceModels(): { readonly silero: string; readonly smartTurn: string } {
  return {
    silero: fileURLToPath(defaultSileroModelUrl()),
    smartTurn: fileURLToPath(defaultSmartTurnModelUrl()),
  };
}

/**
 * Loads the Silero VAD and Smart Turn models before the first call needs them: pipedog's, and
 * under the native engine its own too, since nativeCanRun still sends some calls to pipedog.
 */
export async function warmAudioModels(): Promise<void> {
  await warmModels(await onnxBackend());
  if (voiceEngineFromEnv() === "native") await warmVoiceModels(voiceModels());
}
