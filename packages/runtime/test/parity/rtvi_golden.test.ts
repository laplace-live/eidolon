// The native RTVI codec and emitter against pipedog's RTVIProcessor and RTVIObserver, each built as
// a production session builds them, fed the same inputs: every message must reach the data
// channel as the same bytes.
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  AggregatedTextFrame,
  AggregatedTextProgressFrame,
  BotStartedSpeakingFrame,
  BotStoppedSpeakingFrame,
  type Frame,
  FunctionCallCancelFrame,
  FunctionCallFromLLM,
  FunctionCallInProgressFrame,
  FunctionCallResultFrame,
  FunctionCallsStartedFrame,
  InputTransportMessageFrame,
  InterimTranscriptionFrame,
  InterruptionFrame,
  LLMContextFrame,
  LLMFullResponseEndFrame,
  LLMFullResponseStartFrame,
  LLMTextFrame,
  TextType,
  TranscriptionFrame,
  TTSStartedFrame,
  TTSStoppedFrame,
  TTSTextFrame,
  UserStartedSpeakingFrame,
  UserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import { FramePushed } from "@pipedog/core/observers/base_observer";
import type { BotCapabilities } from "@pipedog/core/pipeline/capabilities";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineParams, PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import {
  RTVISendTextFrame,
  RTVIServerMessageFrame,
} from "@pipedog/core/processors/frameworks/rtvi/frames";
import type * as RTVI from "@pipedog/core/processors/frameworks/rtvi/models";
import type { RTVIObserver } from "@pipedog/core/processors/frameworks/rtvi/observer";
import { BaseOutputTransport } from "@pipedog/core/transports/base_output";
import { TransportParams } from "@pipedog/core/transports/base_transport";
import { pyJsonDumps } from "@pipedog/core/utils/py_json";
import { timeNowIso8601 } from "@pipedog/core/utils/time";
import type { SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import { SmallWebRTCTransport } from "@pipedog/transport-smallwebrtc/transport";
import { readRtvi } from "../../../voice/src/rtvi/codec.ts";
import { RtviEmitter } from "../../../voice/src/rtvi/emitter.ts";
import type { Tag } from "../../../voice/src/types.ts";
import { BOT_ABOUT } from "../../src/index.ts";
import { LaplaceRTVIProcessor } from "../../src/rtvi.ts";
import { captureLogs, type LogCapture } from "../support.ts";

/** What `bot-ready` advertises in production: runSession's transport and worker params. */
function productionCapabilities(): BotCapabilities {
  const connection = { eventHandler() {} } as unknown as SmallWebRTCConnection;
  const transport = new SmallWebRTCTransport(
    connection,
    new TransportParams({ audioInEnabled: true, audioOutEnabled: true }),
  );
  const worker = new PipelineWorker(new Pipeline([transport.input(), transport.output()]), {
    params: new PipelineParams({ enableMetrics: true, enableUsageMetrics: true }),
    observers: [],
    rtviProcessor: new LaplaceRTVIProcessor(),
  });
  return worker.capabilities;
}

const CLIENT_READY = {
  label: "rtvi-ai",
  type: "client-ready",
  id: "c1",
  data: {
    version: "2.3.0",
    about: { library: "@pipecat-ai/client-js", library_version: "1.16.0" },
  },
};

/** pipedog's processor and default observer, with what they push to the transport captured. */
class Pipedog {
  readonly sent: Record<string, unknown>[] = [];
  readonly rtvi = new LaplaceRTVIProcessor();
  readonly observer: RTVIObserver;
  readonly #output = new BaseOutputTransport(new TransportParams());

  constructor(capabilities: BotCapabilities) {
    Object.defineProperty(this.rtvi, "pipelineWorker", { value: { capabilities } });
    this.rtvi.pushTransportMessage = async (model, excludeNone = true) => {
      this.sent.push(model.modelDump({ excludeNone }));
    };
    // The message task's queue exists only once the pipeline starts; deliver to it directly.
    const rtvi = this.rtvi as unknown as Record<string, any>;
    rtvi._messageQueue = {
      put: ([m, userId]: [RTVI.Message, string | null]) => rtvi._handleMessage(m, userId),
    };
    // The worker answers on_client_ready with setBotReady, in a task of its own.
    const setClientReady = this.rtvi.setClientReady.bind(this.rtvi);
    this.rtvi.setClientReady = async () => {
      await setClientReady();
      await this.rtvi.setBotReady();
    };
    this.observer = this.rtvi.createRtviObserver();
  }

  /** An app message off the data channel. */
  async receive(message: unknown): Promise<void> {
    const rtvi = this.rtvi as unknown as Record<string, any>;
    await rtvi._handleTransportMessage(new InputTransportMessageFrame({ message }));
  }

  /** A frame as the output transport pushes it downstream. */
  async push(...frames: Frame[]): Promise<void> {
    for (const frame of frames) {
      await this.observer.onPushFrame(
        new FramePushed({
          source: this.#output,
          destination: this.#output,
          frame,
          direction: FrameDirection.DOWNSTREAM,
          timestamp: 0,
          firstPush: true,
        }),
      );
    }
  }
}

/** The native emitter, answering inbound messages as the Floor's rows 1 and 30 do. */
class Native {
  readonly sent: Record<string, unknown>[] = [];
  readonly rtvi = new RtviEmitter((message) => this.sent.push(message), BOT_ABOUT);

  receive(message: unknown): void {
    const read = readRtvi(message);
    if (read.type === "client-ready") {
      if (read.versionError !== null) this.rtvi.errorResponse(read.id, read.versionError);
      this.rtvi.botReady(read.id);
    } else if (read.type === "rejected") {
      this.rtvi.errorResponse(read.id, read.error);
    } else if (read.type === "malformed") {
      this.rtvi.error(read.error);
    }
  }
}

const bytes = (messages: readonly Record<string, unknown>[]) => messages.map((m) => pyJsonDumps(m));
const json = (messages: readonly Record<string, unknown>[]) =>
  messages.map((m) => JSON.stringify(m));

function expectSameWire(native: Native, pipedog: Pipedog): void {
  expect(pipedog.sent.length).toBeGreaterThan(0);
  expect(bytes(native.sent)).toEqual(bytes(pipedog.sent));
  expect(json(native.sent)).toEqual(json(pipedog.sent));
}

let capabilities: BotCapabilities;
let logs: LogCapture;
let pipedog: Pipedog;
let native: Native;
beforeEach(async () => {
  logs = captureLogs();
  setSystemTime(new Date("2026-11-09T00:41:18.588Z"));
  capabilities ??= productionCapabilities();
  pipedog = new Pipedog(capabilities);
  native = new Native();
});
afterEach(() => {
  setSystemTime();
  logs.restore();
});

/** Both sides past client-js's client-ready, with that exchange forgotten. */
async function ready(): Promise<void> {
  await pipedog.receive(CLIENT_READY);
  native.receive(CLIENT_READY);
  pipedog.sent.length = 0;
  native.sent.length = 0;
}

const TAG: Tag = { reply: "r1", persona: "milky-green", seg: 0 };

/** An AggregatedTextFrame whose frame id is the native segment id it should match. */
function spokenSegment(text: string, id: number): AggregatedTextFrame {
  const frame = new AggregatedTextFrame({ text, textType: TextType.SENTENCE });
  frame.willBeSpoken = true;
  frame.id = id;
  return frame;
}

describe("inbound messages and their answers", () => {
  const msg = (type: string, data?: unknown, extra: Record<string, unknown> = {}) => ({
    label: "rtvi-ai",
    type,
    id: "m1",
    ...(data === undefined ? {} : { data }),
    ...extra,
  });

  test("client-js's client-ready gets bot-ready", async () => {
    await pipedog.receive(CLIENT_READY);
    native.receive(CLIENT_READY);
    expectSameWire(native, pipedog);
    expect(native.sent.map((m) => m.type)).toEqual(["bot-ready"]);
  });

  test.each([
    ["another major", { version: "3.0.0" }],
    ["a bad version", { version: "2.x.0" }],
    ["a short version", { version: "2.0" }],
    ["no version", { about: { library: "x" } }],
    ["no data", undefined],
  ])("client-ready with %s gets error-response, then bot-ready", async (_, data) => {
    await pipedog.receive(msg("client-ready", data));
    native.receive(msg("client-ready", data));
    expectSameWire(native, pipedog);
    expect(native.sent.map((m) => m.type)).toEqual(["error-response", "bot-ready"]);
  });

  test.each([
    ["an unsupported type", msg("describe-config", {})],
    ["send-text without data", msg("send-text")],
    ["send-text with bad options", msg("send-text", { options: { run_immediately: "yes" } })],
    ["send-text with options not a dict", msg("send-text", { content: "hi", options: 1 })],
    ["client-message without t", msg("client-message", { d: {} })],
    ["client-message without data", msg("client-message")],
    ["an envelope without an id", msg("send-text", { content: "hi" }, { id: undefined })],
    ["an envelope of wrong types", { label: "rtvi-ai", type: 1, id: 2, data: [] }],
  ])("%s", async (_, message) => {
    await ready();
    await pipedog.receive(message);
    native.receive(message);
    expectSameWire(native, pipedog);
  });

  test.each([
    ["a foreign message", { label: "other", type: "client-ready", id: "m1" }],
    ["disconnect-bot", msg("disconnect-bot")],
    ["a valid client-message", msg("client-message", { t: "ping", d: null })],
  ])("%s gets no answer from either", async (_, message) => {
    await ready();
    await pipedog.receive(message);
    native.receive(message);
    expect(native.sent).toEqual([]);
    expect(pipedog.sent).toEqual([]);
  });
});

describe("outbound messages", () => {
  test("a spoken user turn", async () => {
    await ready();
    const at = timeNowIso8601();
    const context = new LLMContext({ messages: [{ role: "user", content: "我想问 你的猫" }] });
    await pipedog.push(
      new UserStartedSpeakingFrame(),
      new InterruptionFrame(),
      new InterimTranscriptionFrame({ text: "我想问", userId: "", timestamp: at }),
      new TranscriptionFrame({ text: "我想问你的猫", userId: "", timestamp: at }),
      new UserStoppedSpeakingFrame(),
      new LLMContextFrame({ context }),
    );
    native.rtvi.userStartedSpeaking();
    native.rtvi.botInterrupted();
    native.rtvi.userTranscription("我想问", false);
    native.rtvi.userTranscription("我想问你的猫", true);
    native.rtvi.userStoppedSpeaking();
    native.rtvi.userLlmText("我想问 你的猫");
    expectSameWire(native, pipedog);
  });

  test("a typed turn", async () => {
    await ready();
    const context = new LLMContext({ messages: [{ role: "user", content: "你好" }] });
    await pipedog.push(
      new InterruptionFrame(),
      new RTVISendTextFrame({ msgId: "5ef602d7", text: "你好", userId: null }),
      new LLMContextFrame({ context }),
    );
    native.rtvi.botInterrupted();
    native.rtvi.userTyped("你好", "5ef602d7");
    native.rtvi.userLlmText("你好");
    expectSameWire(native, pipedog);
  });

  // The order production sent on 2026-11-09 (.cache/eidolon-port/e2e-prod-after-pr25.json).
  test("a reply spoken without word timings, as Fish speaks", async () => {
    await ready();
    const text = "[散漫地，带着笑意] 早啊……周一这一大早的，怎么跑来看我啦，嗯？";
    const deltas = ["[散漫地，带着笑意] 早", "啊……周一这一大早的，怎么跑来看我啦，嗯？"];
    const said = new TTSTextFrame({ text, textType: TextType.SENTENCE, segmentId: 1 });
    said.willBeSpoken = true;
    await pipedog.push(
      new LLMFullResponseStartFrame(),
      ...deltas.map((delta) => new LLMTextFrame({ text: delta })),
      new LLMFullResponseEndFrame(),
      new TTSStartedFrame(),
      new BotStartedSpeakingFrame(),
      spokenSegment(text, 1),
      said,
      new BotStoppedSpeakingFrame(),
      new TTSStoppedFrame(),
    );
    native.rtvi.botLlmStarted();
    for (const delta of deltas) native.rtvi.botLlmText(delta);
    native.rtvi.segment(TAG, text);
    native.rtvi.botLlmStopped();
    native.rtvi.botTtsStarted();
    native.rtvi.botStartedSpeaking();
    native.rtvi.segmentStarted(TAG);
    native.rtvi.segmentEnded(TAG);
    native.rtvi.botStoppedSpeaking();
    native.rtvi.botTtsStopped();
    expectSameWire(native, pipedog);
  });

  // pipedog sends a word provider's bot-tts-text per word; the native emitter sends one per segment,
  // with its "completed", so only the bot-output messages are compared.
  test("a segment spoken with word timings", async () => {
    await ready();
    const text = "Hi there.";
    const progress = (accumulatedText: string, remainingText: string) =>
      new AggregatedTextProgressFrame({
        segmentId: 1,
        contextId: null,
        text,
        textType: TextType.SENTENCE,
        accumulatedText,
        remainingText,
      });
    await pipedog.push(
      new BotStartedSpeakingFrame(),
      spokenSegment(text, 1),
      progress("Hi", " there."),
      progress("Hi there.", ""),
    );
    native.rtvi.segment(TAG, text);
    native.rtvi.segmentStarted(TAG);
    native.rtvi.segmentProgress(TAG, 2);
    native.rtvi.segmentProgress(TAG, text.length);
    const output = (sent: Record<string, unknown>[]) => sent.filter((m) => m.type === "bot-output");
    expect(bytes(output(native.sent))).toEqual(bytes(output(pipedog.sent)));
    expect(output(native.sent)).toHaveLength(3);
  });

  test("tool calls", async () => {
    await ready();
    const call = { functionName: "take_selfie", toolCallId: "call_1", arguments: { mood: "a" } };
    await pipedog.push(
      new FunctionCallsStartedFrame({
        functionCalls: [new FunctionCallFromLLM({ ...call, context: null })],
      }),
      new FunctionCallInProgressFrame(call),
      new FunctionCallResultFrame({ ...call, result: { ok: true } }),
      new FunctionCallCancelFrame({ functionName: "recall_streams", toolCallId: "call_2" }),
    );
    native.rtvi.toolStarted();
    native.rtvi.toolInProgress("call_1");
    native.rtvi.toolStopped("call_1", false);
    native.rtvi.toolStopped("call_2", true);
    expectSameWire(native, pipedog);
  });

  test("a server message and a provider error", async () => {
    await ready();
    const data = { type: "selfie", urls: ["/api/selfie/a.png"], note: null };
    await pipedog.push(new RTVIServerMessageFrame({ data }));
    await pipedog.rtvi.sendError("Error during completion: boom");
    native.rtvi.serverMessage(data);
    native.rtvi.error("Error during completion: boom");
    expectSameWire(native, pipedog);
  });
});
