// The adapters with the sibling packages' real code instead of fakes. Nothing here touches the
// network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildGreetingKickoff,
  DEFAULT_GATE_MODEL,
  GATE_FRAME_KEY,
  type GateDecision,
  RetrievalGate,
} from "@eidolon/context";
import { createVoiceTool, loadVoiceStyles } from "@eidolon/tools";
import { createTask } from "@pipedog/asyncio";
import { type Frame, LLMContextFrame, TTSUpdateSettingsFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { FunctionCallParams, type LLMService } from "@pipedog/core/services/llm_service";
import { runTest } from "@pipedog/core/tests/utils";
import type { FishAudioTTSSettings } from "@pipedog/fish/tts";
import { OpenRouterLLMService } from "@pipedog/openrouter/llm";
import { RetrievalGateProcessor } from "../src/adapters/context.ts";
import { SessionTools } from "../src/adapters/tools.ts";
import { LaplaceRTVIProcessor } from "../src/rtvi.ts";
import { installGreeting } from "../src/session/session.ts";
import { captureLogs, type LogCapture, PassThrough, setEnv, until } from "./support.ts";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  logs.restore();
});

describe("RetrievalGateProcessor with context's RetrievalGate", () => {
  test("asks once per user turn, and both frames of a turn carry one decision", async () => {
    const bodies: { model: string; state: { viewer_latest_message: string } }[] = [];
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const score = body.state.viewer_latest_message.includes("坚果") ? 0.9 : 0.05;
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((name) => [name, { type: "noul", noul: score }]),
      );
      return Response.json({ answers });
    }) as typeof fetch;
    const gate = new RetrievalGate({ apiKey: "test-key", fetch: fakeFetch });
    const context = new LLMContext({ messages: [{ role: "user", content: "哈哈哈哈" }] });
    const first = new LLMContextFrame({ context });
    const second = new LLMContextFrame({ context });
    const later = new LLMContext({
      messages: [
        { role: "user", content: "哈哈哈哈" },
        { role: "assistant", content: "嘿嘿" },
        { role: "user", content: "坚果几岁了？" },
      ],
    });
    const third = new LLMContextFrame({ context: later });
    const [down] = await runTest(new RetrievalGateProcessor(gate), {
      framesToSend: [first, second, third],
    });
    const decisions = (down as Frame[]).map((f) => f.metadata[GATE_FRAME_KEY] as GateDecision);
    expect(decisions[0]).toBe(decisions[1] as GateDecision);
    expect(decisions[2]).not.toBe(decisions[0] as GateDecision);
    const verdicts = await Promise.all(decisions.map((d) => d.value()));
    expect(verdicts.map((v) => v?.retrieve)).toEqual([false, false, true]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.model).toBe(DEFAULT_GATE_MODEL);
  });
});

describe("the greeting with context's kickoff", () => {
  test("mentions up to three truthy memories, newest first", async () => {
    const worker = new PipelineWorker(new Pipeline([new PassThrough("p")]), {
      rtviProcessor: new LaplaceRTVIProcessor(),
    });
    worker.rtvi.setBotReady = async () => {};
    let queued = 0;
    worker.queueFrames = async () => {
      queued++;
    };
    const context = new LLMContext();
    const memories = [
      { memory: "a" },
      { memory: "" },
      { memory: "b" },
      { memory: "c" },
      { memory: "d" },
    ];
    installGreeting(worker, context, { newestFirst: async () => memories }, buildGreetingKickoff);
    await (worker.rtvi as any)._callEventHandler("on_client_ready", worker.rtvi);
    await until(() => queued === 1);
    expect(context.getMessages()).toEqual([
      {
        role: "user",
        content:
          "用一两句话简短自然地打个招呼。你之前跟ta聊过这些事：a; b; c。如果合适的话自然地提一两件，不要全念出来。",
      },
    ]);
  });
});

describe("SessionTools with tools' change_voice_style", () => {
  test("switches this session's TTS voice ahead of the acknowledgment", async () => {
    const restore = setEnv({
      FISH_VOICE_ID: "voice-default",
      FISH_VOICE_ID_GENTLE: "voice-gentle",
    });
    try {
      const voice = createVoiceTool(loadVoiceStyles());
      expect(voice).not.toBeNull();
      const llm = new OpenRouterLLMService({ apiKey: "test-key" });
      const tts = new PassThrough("tts");
      const tools = new SessionTools(llm, tts);
      tools.register(voice!);
      const events: [string, unknown][] = [];
      const params = new FunctionCallParams({
        functionName: "change_voice_style",
        toolCallId: "call-1",
        arguments: { style: "gentle" },
        llm: {
          pushFrame: async (frame: Frame) => {
            events.push(["push", frame]);
          },
        } as unknown as LLMService<any>,
        pipelineWorker: null as never,
        context: new LLMContext(),
        resultCallback: async (result) => {
          events.push(["result", result]);
        },
      });
      const handler = (llm as any)._functions.get("change_voice_style").handler;
      await createTask(() => handler(params), "function-call");
      expect(events.map(([kind]) => kind)).toEqual(["push", "result"]);
      const frame = events[0]?.[1] as TTSUpdateSettingsFrame;
      expect(frame).toBeInstanceOf(TTSUpdateSettingsFrame);
      expect((frame.delta as FishAudioTTSSettings).voice).toBe("voice-gentle");
      expect(frame.service).toBe(tts);
      expect(events[1]?.[1]).toEqual({ ok: true, style: "gentle" });
    } finally {
      restore();
    }
  });
});
