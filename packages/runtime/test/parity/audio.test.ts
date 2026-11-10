// The native engine's input DSP against the pipedog it ports, on the same audio and the same ORT:
// identical VAD confidences, volumes, states and edges, Smart Turn probabilities within 1e-6, and
// identical loudness.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSileroModelUrl, type SileroVADAnalyzer } from "@pipedog/audio-silero";
import { defaultSmartTurnModelUrl, type LocalSmartTurnAnalyzerV3 } from "@pipedog/audio-smart-turn";
import { EndOfTurnState } from "@pipedog/core/audio/turn/base_turn_analyzer";
import { computeWhisperLogMelFeatures as pipedogFeatures } from "@pipedog/core/audio/turn/smart_turn/_whisper_features";
import { calculateAudioVolume as pipedogVolume } from "@pipedog/core/audio/utils";
import { VADState } from "@pipedog/core/audio/vad/vad_analyzer";
import { VADController } from "@pipedog/core/audio/vad/vad_controller";
import { AudioVolumeTracker as PipedogTracker } from "@pipedog/core/audio/volume";
import { InputAudioRawFrame } from "@pipedog/core/frames/frames";
import type { TurnMetricsData } from "@pipedog/core/metrics/metrics";
import { AudioVolumeTracker, calculateAudioVolume } from "../../../voice/src/input/loudness.ts";
import { SmartTurn } from "../../../voice/src/input/smart_turn.ts";
import { Vad, type VadEdge, type VadState } from "../../../voice/src/input/vad.ts";
import { computeWhisperLogMelFeatures } from "../../../voice/src/input/whisper_features.ts";
import { frames } from "../../../voice/test/input/speech.ts";
import { createSmartTurnAnalyzer, createVadAnalyzer, onnxBackend } from "../../src/audio.ts";
import { callAudio, turnSegments } from "./fixtures/audio.ts";

// The model files pipedog loads by default, which the native engine is given until it ships its own.
const SILERO_MODEL = fileURLToPath(defaultSileroModelUrl());
const SMART_TURN_MODEL = fileURLToPath(defaultSmartTurnModelUrl());

const STATE_NAMES: Record<VADState, VadState> = {
  [VADState.QUIET]: "quiet",
  [VADState.STARTING]: "starting",
  [VADState.SPEAKING]: "speaking",
  [VADState.STOPPING]: "stopping",
};

function bytes(pcm: Int16Array): Uint8Array {
  return new Uint8Array(pcm.slice().buffer);
}

/** pipedog's VAD as the session builds it, behind its real controller, recording every window. */
async function pipedogVad() {
  const analyzer: SileroVADAnalyzer = createVadAnalyzer(await onnxBackend());
  analyzer.setSampleRate(16000);
  const confidences: number[] = [];
  const voiceConfidence = analyzer.voiceConfidence.bind(analyzer);
  analyzer.voiceConfidence = async (buffer) => {
    const confidence = await voiceConfidence(buffer);
    confidences.push(confidence);
    return confidence;
  };
  let state: VadState = "quiet";
  const analyzeAudio = analyzer.analyzeAudio.bind(analyzer);
  analyzer.analyzeAudio = async (buffer) => {
    const s = await analyzeAudio(buffer);
    state = STATE_NAMES[s];
    return s;
  };
  const controller = new VADController(analyzer);
  let edge: VadEdge | null = null;
  controller.addEventHandler("on_speech_started", async () => {
    edge = "started";
  });
  controller.addEventHandler("on_speech_stopped", async () => {
    edge = "stopped";
  });
  return {
    confidences,
    async push(pcm: Int16Array): Promise<VadStep> {
      edge = null;
      await controller.processFrame(
        new InputAudioRawFrame({ audio: bytes(pcm), sampleRate: 16000, numChannels: 1 }),
      );
      const volume = (analyzer as unknown as { _prevVolume: number })._prevVolume;
      return { state, edge, volume };
    },
  };
}

/** What a VAD says after a frame: its state, the edge it reported, its smoothed volume. */
interface VadStep {
  readonly state: VadState;
  readonly edge: VadEdge | null;
  readonly volume: number;
}

/** The native VAD, recording every window. */
function nativeVad() {
  const vad = new Vad(SILERO_MODEL);
  const confidences: number[] = [];
  const voiceConfidence = vad.voiceConfidence.bind(vad);
  vad.voiceConfidence = async (window) => {
    const confidence = await voiceConfidence(window);
    confidences.push(confidence);
    return confidence;
  };
  return {
    vad,
    confidences,
    async push(pcm: Int16Array): Promise<VadStep> {
      const edge = await vad.push(pcm);
      return { state: vad.state, edge, volume: vad.volume };
    },
  };
}

function pipedogTurnBuffer(turn: LocalSmartTurnAnalyzerV3): number {
  return (turn as unknown as { _audioBuffer: unknown[] })._audioBuffer.length;
}

function nativeTurnBuffer(turn: SmartTurn): number {
  return (turn as unknown as { buffer: unknown[] }).buffer.length;
}

async function pipedogAnalyze(turn: LocalSmartTurnAnalyzerV3) {
  const [state, metrics] = await turn.analyzeEndOfTurn();
  return {
    state: state === EndOfTurnState.COMPLETE ? "complete" : "incomplete",
    probability: (metrics as TurnMetricsData | null)?.probability ?? null,
  };
}

/** Two results agree: the same state, and probabilities within 1e-6 (or both absent). */
function expectSameTurn(
  pipedog: { state: string; probability: number | null },
  native: { state: string; probability: number | null },
  at: string,
): void {
  expect(native.state, at).toBe(pipedog.state);
  if (pipedog.probability === null) {
    expect(native.probability, at).toBeNull();
  } else {
    expect(Math.abs((native.probability as number) - pipedog.probability), at).toBeLessThan(1e-6);
  }
}

describe("ONNX", () => {
  test("both engines load the one pinned onnxruntime-node", async () => {
    const voice = join(dirname(fileURLToPath(import.meta.url)), "../../../voice");
    const runtime = join(dirname(fileURLToPath(import.meta.url)), "../..");
    expect(realpathSync(Bun.resolveSync("onnxruntime-node", voice))).toBe(
      realpathSync(Bun.resolveSync("onnxruntime-node", runtime)),
    );
    const mod: any = await import("onnxruntime-node");
    const ort = mod.InferenceSession ? mod : mod.default;
    expect(ort.env.versions).toEqual({ common: "1.30.0", node: "1.30.0" });
  });
});

describe("a call's input, frame by frame", () => {
  // Smart Turn stamps each chunk with the clock: both engines read this one, advanced by the audio.
  let clockMs = 0;
  let nowSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    clockMs = 1_000_000;
    nowSpy = spyOn(performance, "now").mockImplementation(() => clockMs);
  });
  afterEach(() => nowSpy.mockRestore());

  test("VAD confidences, volumes, states and edges are identical; Smart Turn agrees at every turn end", async () => {
    const pipedog = await pipedogVad();
    const native = nativeVad();
    const pipedogTurn = createSmartTurnAnalyzer(await onnxBackend());
    pipedogTurn.setSampleRate(16000);
    const nativeTurn = new SmartTurn(SMART_TURN_MODEL, { now: () => clockMs });
    let pipedogSpeaking = false;

    const edges: string[] = [];
    const outcomes: string[] = [];
    let index = 0;
    for (const frame of frames(callAudio())) {
      clockMs += 20;
      const at = `frame ${index++}`;
      const a = await pipedog.push(frame);
      const b = await native.push(frame);
      expect(b, at).toEqual(a);

      if (a.edge === "started") {
        pipedogTurn.updateVadStartSecs(0.2);
        pipedogSpeaking = true;
      } else if (a.edge === "stopped") {
        pipedogSpeaking = false;
      }
      if (a.edge) edges.push(`${at}:${a.edge}`);
      expect(native.vad.speaking, at).toBe(pipedogSpeaking);

      const appendedA = pipedogTurn.appendAudio(bytes(frame), pipedogSpeaking);
      const appendedB = nativeTurn.append(frame, native.vad.speaking);
      expect(appendedB, at).toBe(appendedA === EndOfTurnState.COMPLETE ? "complete" : "incomplete");
      expect(nativeTurnBuffer(nativeTurn), at).toBe(pipedogTurnBuffer(pipedogTurn));

      if (a.edge === "stopped" || appendedB === "complete") {
        const result = await nativeTurn.analyze();
        expectSameTurn(await pipedogAnalyze(pipedogTurn), result, at);
        expect(nativeTurnBuffer(nativeTurn), at).toBe(pipedogTurnBuffer(pipedogTurn));
        const by = a.edge === "stopped" ? "vad" : "silence";
        outcomes.push(`${by}:${result.state}${result.probability === null ? ":unasked" : ""}`);
      }
    }

    expect(native.confidences).toEqual(pipedog.confidences);
    // Each speech run, the pause inside the question and the fade's two crossings of the volume gate
    // reached both edges, and every way a turn can end ran: the model's verdict either way, and the
    // 3 s stop after an unfinished fragment.
    expect(edges.filter((e) => e.endsWith("started"))).toHaveLength(6);
    expect(edges.filter((e) => e.endsWith("stopped"))).toHaveLength(6);
    expect(new Set(outcomes)).toEqual(
      new Set(["vad:complete", "vad:incomplete", "silence:incomplete:unasked"]),
    );
  });
});

describe("Smart Turn", () => {
  test("probabilities agree within 1e-6 on segments shorter and longer than its window", async () => {
    const pipedogTurn = createSmartTurnAnalyzer(await onnxBackend());
    pipedogTurn.setSampleRate(16000);
    const nativeTurn = new SmartTurn(SMART_TURN_MODEL);
    const predictA = (pipedogTurn as any)._predictEndpoint.bind(pipedogTurn);
    const predictB = (nativeTurn as any).predict.bind(nativeTurn);
    for (const [name, segment] of Object.entries(turnSegments())) {
      const { probability } = await predictA(segment.slice());
      const native: number = await predictB(segment.slice());
      expect(Math.abs(native - probability), name).toBeLessThan(1e-6);
    }
  });

  test("the log-mel features are bit-identical", () => {
    for (const [name, segment] of Object.entries(turnSegments())) {
      for (const doNormalize of [true, false]) {
        expect(computeWhisperLogMelFeatures(segment, { doNormalize }), name).toEqual(
          pipedogFeatures(segment, { doNormalize }),
        );
      }
    }
  });
});

describe("loudness", () => {
  test("the rolling volume is identical after every frame", () => {
    const pipedog = new PipedogTracker();
    const native = new AudioVolumeTracker();
    const a: number[] = [];
    const b: number[] = [];
    for (const frame of frames(callAudio())) {
      pipedog.update(bytes(frame), 16000);
      native.update(frame, 16000);
      a.push(pipedog.volume);
      b.push(native.volume);
    }
    expect(b).toEqual(a);
    expect(new Set(a).size).toBeGreaterThan(100);
  });

  test("one block's volume is identical at every rate", () => {
    const audio = callAudio();
    for (const rate of [8000, 16000, 22050, 24000, 44100, 48000]) {
      for (const start of [0, 13 * 16000, 20 * 16000]) {
        const block = audio.slice(start, start + rate);
        expect(calculateAudioVolume(block, rate), `${rate} Hz at ${start}`).toBe(
          pipedogVolume(bytes(block), rate),
        );
      }
    }
  });
});
