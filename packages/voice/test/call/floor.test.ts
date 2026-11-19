// The Floor's transition table, by docs/voice-engine.md's row numbers, with its barge-in, tools,
// async results and results from outside, what a bound call adds to her replies, the end of a call
// and the mailbox's rules: on the real kit, emitter, Speaker and Mouth, with the caller, her turns,
// her voice and the clock scripted.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChatEventDraft } from "@eidolon/chat";
import { consoleSink, logger } from "@eidolon/config";
import type { LlmTool, ToolSchema } from "@eidolon/core";
import type { BackgroundTools, CallTurnRequest, PersonaParts, TurnExtras } from "@eidolon/engine";
import { SPEECH_STALL_MS, SPEECH_STALLED } from "@eidolon/providers/speech-stream";
import type { ReplyExtras } from "../../src/types.ts";
import { HOST, NUDGE, settle, spokenReply, startCall, VIEWER } from "./harness.ts";

let logs: string[];
beforeEach(() => {
  logs = [];
  logger.setSink((record) => logs.push(record.message));
});
afterEach(() => {
  logger.setSink(consoleSink);
});

const started = (callId: string): ChatEventDraft => ({
  type: "tool-result",
  persona: HOST,
  turn: "turn-1",
  callId,
  result: {},
  stage: "started",
});
const settled = (callId: string, stage: "final" | "cancelled"): ChatEventDraft => ({
  type: "tool-result",
  persona: HOST,
  turn: "turn-1",
  callId,
  result: stage === "final" ? { urls: ["https://x/1.png"] } : {},
  stage,
});

const schema = (name: string): ToolSchema => ({
  name,
  description: "",
  properties: {},
  required: [],
});
/** What a call bound to a chat adds to her replies: tools of the chat's, and a provider. */
const BACKGROUND: BackgroundTools = {
  tools: [
    {
      schema: schema("start_task"),
      cancelOnInterruption: false,
      timeoutSecs: null,
      run: async () => ({}),
    },
  ],
  hint: "（你能用电脑）",
};
const TOOLS: readonly LlmTool[] = [
  {
    schema: schema("stop_task"),
    cancelOnInterruption: true,
    timeoutSecs: null,
    run: async () => ({}),
  },
];
const PROVIDERS: PersonaParts["providers"] = [
  { label: "TaskStatus", provider: { onContext: async () => {}, errorMessage: () => "" } },
];
const EVERYTHING: TurnExtras = { background: BACKGROUND, tools: TOOLS, providers: PROVIDERS };

/** A plan that offers every reply EVERYTHING, recording whether each one it was asked for answers. */
function giving(asked: boolean[]): ReplyExtras {
  return (answers) => {
    asked.push(answers);
    return EVERYTHING;
  };
}

/** What the Floor added to a reply's turn. */
function added({ background, tools, providers }: CallTurnRequest): TurnExtras {
  return {
    ...(background === undefined ? {} : { background }),
    ...(tools === undefined ? {} : { tools }),
    ...(providers === undefined ? {} : { providers }),
  };
}

/** A task's end, which the chat hands the call: the result of a call made before it. */
const ended = (callId: string, stage: "final" | "cancelled" = "final"): ChatEventDraft => ({
  type: "tool-result",
  persona: HOST,
  turn: "chat-turn",
  callId,
  result: { task: callId, status: stage === "final" ? "succeeded" : "cancelled" },
  stage,
});
const ENDED = "（任务结束了）";

/** A start her interrupted turn left running, answered after the turn was cut. */
const lateStart = (callId: string): ChatEventDraft => ({
  type: "tool-result",
  persona: HOST,
  turn: "turn-1",
  callId,
  result: { task: callId, status: "running" },
  stage: "started",
});

describe("the client (rows 1, 30)", () => {
  test("client-ready gets bot-ready echoing its id, then the greeting starts", async () => {
    const call = startCall({ greet: true });
    await call.ready();
    expect(call.news()).toEqual(["bot-ready"]);
    expect(call.sent[0]?.id).toBe("c-ready");
    expect(call.turns).toHaveLength(1);
    const { request } = call.turn;
    expect(request).toMatchObject({
      persona: HOST,
      viewer: VIEWER,
      kickoff: true,
      mode: "call",
      usage: { source: "call", session: "call-1" },
    });
    expect(request.chat.events).toEqual([]);
  });

  test("an incompatible client gets error-response first, and the call goes on", async () => {
    const call = startCall();
    await call.rtvi("client-ready", { version: "1.0.0" }, "c1");
    expect(call.news()).toEqual([
      "error-response RTVI version 1.0.0 is not compatible with server protocol 2.2.0. " +
        "Compatibility issues may occur.",
      "bot-ready",
    ]);
    expect(call.sent.map((m) => m.id)).toEqual(["c1", "c1"]);
    await call.says("你好");
    expect(call.turns).toHaveLength(1);
  });

  test("without a greeting, nothing starts until the caller speaks", async () => {
    const call = startCall();
    await call.ready();
    expect(call.turns).toHaveLength(0);
  });

  test("client-message is ignored, other types get error-response, a bad envelope error", async () => {
    const call = startCall();
    await call.ready();
    call.news();
    await call.rtvi("client-message", { t: "hello", d: 1 });
    await call.rtvi("send-file", {}, "f1");
    call.kit.post({ source: "rtvi", message: { type: "malformed", error: "Invalid envelope" } });
    await settle();
    expect(call.news()).toEqual([
      "error-response Unsupported type send-file",
      "error Invalid envelope",
    ]);
    expect(call.sent.at(-2)?.id).toBe("f1");
  });
});

describe("the caller (rows 2-6)", () => {
  test("rows 3 and 4: what she hears goes out as it comes, and her line is stored", async () => {
    const call = startCall();
    await call.ready();
    call.news();
    await call.ear(
      { type: "user-started" },
      { type: "interim", text: "我想" },
      { type: "final", text: "我想问" },
      { type: "user-stopped", text: "我想问" },
    );
    expect(call.news()).toEqual([
      "user-started-speaking",
      "bot-interrupted",
      "user-input transcription 我想",
      "user-transcription 我想",
      "user-input transcription 我想问",
      "user-transcription 我想问",
      "user-llm-text 我想问",
      "user-stopped-speaking",
    ]);
    expect(call.sent.filter((m) => m.type === "user-input").map((m) => m.data?.final)).toEqual([
      false,
      true,
    ]);
    expect(call.events()).toMatchObject([
      { seq: 1, type: "message", speaker: { kind: "user" }, text: "我想问", modality: "call" },
    ]);
    expect(call.turn.request.chat.events).toEqual(call.events());
  });

  test("row 6: an empty turn while she is idle starts nothing", async () => {
    const call = startCall();
    await call.ready();
    call.news();
    await call.ear({ type: "user-started" }, { type: "user-stopped", text: null });
    expect(call.news()).toEqual([
      "user-started-speaking",
      "bot-interrupted",
      "user-stopped-speaking",
    ]);
    expect(call.turns).toHaveLength(0);
    expect(call.events()).toEqual([]);
  });

  test("row 5: an empty turn that cut her off gets the recovery prompt, once in a row", async () => {
    const call = startCall();
    await call.ready();
    await call.says("讲个故事");
    call.turn.mind("started");
    await settle();
    await call.ear({ type: "user-started" }, { type: "user-stopped", text: null });
    expect(call.turns).toHaveLength(2);
    expect(call.turn.request.nudge).toBe(NUDGE);
    expect(call.turns[0]?.request.nudge).toBeUndefined();

    // A second empty turn on the recovery reply doesn't ask again.
    call.turn.mind("started");
    await settle();
    await call.ear({ type: "user-started" }, { type: "user-stopped", text: null });
    expect(call.turns).toHaveLength(2);

    // A turn of words starts the count again.
    await call.says("然后呢");
    call.turn.mind("started");
    await settle();
    await call.ear({ type: "user-started" }, { type: "user-stopped", text: null });
    expect(call.turns).toHaveLength(4);
    expect(call.turn.request.nudge).toBe(NUDGE);
  });

  test("row 5: an empty turn while one of her sync tools runs gets no recovery", async () => {
    const call = startCall();
    await call.ready();
    await call.says("换个声音");
    call.turn.mind("started");
    call.turn.tool("c1", "running");
    await settle();
    await call.ear({ type: "user-started" }, { type: "user-stopped", text: null });
    expect(call.turns).toHaveLength(1);
    // The engine's cancelled line still closes the tool for the client.
    expect(call.news().slice(-1)).toEqual(["llm-function-call-stopped c1 cancelled"]);
  });

  test("row 2: a turn that starts while she is idle cuts nothing", async () => {
    const call = startCall();
    await call.ready();
    await call.says("你好");
    await spokenReply(call, "你好呀。");
    call.news();
    await call.ear({ type: "user-started" });
    expect(call.news()).toEqual(["user-started-speaking", "bot-interrupted"]);
    await call.ear({ type: "user-stopped", text: null });
    expect(call.turns).toHaveLength(1);
  });
});

describe("her reply (rows 9-15, 18-22)", () => {
  test("a spoken question gets her reply, spoken, and what was heard is stored", async () => {
    const call = startCall();
    await call.ready();
    await call.says("你好");
    call.news();
    await spokenReply(call, "你好呀。");
    expect(call.news()).toEqual([
      "bot-llm-started",
      "bot-llm-text 你好呀。",
      "bot-llm-stopped",
      "bot-transcription 你好呀。",
      "bot-tts-started",
      "bot-tts-stopped",
      "bot-started-speaking",
      "bot-output new 你好呀。",
      "bot-output completed 你好呀。",
      "bot-tts-text 你好呀。",
      "bot-stopped-speaking",
    ]);
    expect(call.events().at(-1)).toMatchObject({
      type: "message",
      speaker: { kind: "persona", id: HOST },
      text: "你好呀。",
      modality: "call",
    });
    expect(call.events().at(-1)).not.toHaveProperty("interrupted");
    expect(logs.filter((l) => l.startsWith("[voice] ttfb")).map((l) => l.split(" ")[2])).toEqual([
      "llm",
      "text",
      "speaking",
    ]);
  });

  test("rows 10-12: each sentence goes to her voice as it completes", async () => {
    const call = startCall();
    await call.ready();
    await call.says("你好");
    call.news();
    call.turn.mind("started");
    call.turn.delta("你好呀。今天");
    await settle();
    expect(call.news()).toEqual([
      "bot-llm-started",
      "bot-llm-text 你好呀。今天",
      "bot-transcription 你好呀。",
      "bot-tts-started",
    ]);
    expect(call.utterance().said).toEqual(["你好呀。"]);
    call.turn.delta("怎么样？");
    call.turn.mind("ended");
    await settle();
    expect(call.news()).toEqual([
      "bot-llm-text 怎么样？",
      "bot-llm-stopped",
      "bot-transcription 今天怎么样？",
    ]);
    expect(call.utterance().said).toEqual(["你好呀。", "今天怎么样？"]);
  });

  test("row 15: a failed mind request is stopped, then reported, and what she said is spoken", async () => {
    const call = startCall();
    await call.ready();
    await call.says("你好");
    call.news();
    call.turn.mind("started");
    call.turn.delta("我想想");
    call.turn.mind("ended", "Error during completion: boom");
    await settle();
    expect(call.news()).toEqual([
      "bot-llm-started",
      "bot-llm-text 我想想",
      "bot-llm-stopped",
      "error Error during completion: boom",
      "bot-transcription 我想想",
      "bot-tts-started",
    ]);
    expect(call.sent.find((m) => m.type === "error")?.data).toEqual({
      error: "Error during completion: boom",
      fatal: false,
    });
  });

  test("row 18: a provider's failure goes out as an error", async () => {
    const call = startCall();
    await call.ready();
    await call.says("你好");
    call.news();
    call.turn.push({ type: "notice", turn: "turn-1", text: "Mem0 is unreachable" });
    await settle();
    expect(call.news()).toEqual(["error Mem0 is unreachable"]);
  });

  test("row 14: played words go out as in-progress, and the segment completes at its end", async () => {
    const call = startCall();
    await call.ready();
    await call.says("你好");
    call.turn.round("你好呀，今天怎么样？");
    await settle();
    const utterance = call.utterance();
    utterance.words(1, [
      { chars: 3, startMs: 0 },
      { chars: 8, startMs: 100 },
    ]);
    utterance.pcm(1, 4800);
    utterance.segEnd(1);
    await settle();
    call.news();
    await call.play(240);
    await call.play(2400);
    await call.play(2160);
    expect(call.news()).toEqual([
      "bot-started-speaking",
      "bot-output new 你好呀，今天怎么样？",
      "bot-output in-progress 你好呀",
      "bot-output in-progress 你好呀，今天怎么样",
      "bot-output completed 你好呀，今天怎么样？",
      "bot-tts-text 你好呀，今天怎么样？",
    ]);
  });

  test("row 14: each segment goes out new as its audio starts and completed as it ends", async () => {
    const call = startCall();
    await call.ready();
    await call.says("你好");
    call.turn.round("第一句。第二句。");
    await settle();
    const ending = call.turn.end();
    await settle();
    for (const seg of [1, 2]) {
      call.utterance().pcm(seg, 480);
      call.utterance().segEnd(seg);
    }
    call.utterance().finish();
    await settle();
    call.news();
    await call.play(240);
    expect(call.news()).toEqual(["bot-started-speaking", "bot-output new 第一句。"]);
    await call.play(480);
    expect(call.news()).toEqual([
      "bot-output completed 第一句。",
      "bot-tts-text 第一句。",
      "bot-output new 第二句。",
    ]);
    await call.play(480);
    await ending;
    expect(call.news()).toEqual([
      "bot-output completed 第二句。",
      "bot-tts-text 第二句。",
      "bot-stopped-speaking",
    ]);
    expect(call.events().at(-1)).toMatchObject({ text: "第一句。第二句。" });
  });

  test("row 20: a voice at 44.1 kHz stops speaking when her last sentence has played", async () => {
    const call = startCall({ speechRate: 44_100 });
    await call.ready();
    await call.says("你好");
    call.turn.round("第一句。第二句。");
    await settle();
    const ending = call.turn.end();
    await settle();
    // Fish's sequence, sized to end her last sentence late in a 10 ms frame: the 138 samples the
    // resampler holds can't follow it in that frame.
    call.utterance().pcm(1, 4410);
    call.utterance().segEnd(1);
    call.utterance().pcm(2, 4000);
    call.utterance().segEnd(2);
    call.utterance().finish();
    await settle();
    call.news();
    // A frame per play, as the transport pulls: within one play, her turn can't end between the
    // last segment's end and `drained`.
    for (let frame = 0; frame < 20; frame++) await call.play(240);
    await ending;
    expect(call.news()).toEqual([
      "bot-started-speaking",
      "bot-output new 第一句。",
      "bot-output completed 第一句。",
      "bot-tts-text 第一句。",
      "bot-output new 第二句。",
      "bot-output completed 第二句。",
      "bot-tts-text 第二句。",
      "bot-stopped-speaking",
    ]);
  });

  test("row 21: drained mid-reply, she stops speaking after 3 s, and starts again", async () => {
    const call = startCall();
    await call.ready();
    await call.says("你好");
    call.turn.round("第一句。");
    await settle();
    call.utterance().pcm(1, 480);
    call.utterance().segEnd(1);
    await settle();
    call.news();
    await call.play(480);
    expect(call.news()).toEqual([
      "bot-started-speaking",
      "bot-output new 第一句。",
      "bot-output completed 第一句。",
      "bot-tts-text 第一句。",
    ]);
    await call.advance(2_999);
    expect(call.news()).toEqual([]);
    await call.advance(1);
    expect(call.news()).toEqual(["bot-stopped-speaking"]);

    call.turn.round("第二句。");
    await settle();
    call.utterance().pcm(2, 480);
    call.utterance().segEnd(2);
    await settle();
    call.news();
    await call.play(480);
    expect(call.news().slice(0, 2)).toEqual(["bot-started-speaking", "bot-output new 第二句。"]);

    // Her speech ends after the Speaker drained: she is done at once.
    const ending = call.turn.end();
    await settle();
    call.utterance().finish();
    await ending;
    await settle();
    expect(call.news()).toEqual(["bot-tts-stopped", "bot-stopped-speaking"]);
  });

  test("row 21: audio that resumes within 3 s keeps her speaking", async () => {
    const call = startCall();
    await call.ready();
    await call.says("你好");
    call.turn.round("第一句。");
    await settle();
    call.utterance().pcm(1, 480);
    call.utterance().segEnd(1);
    await settle();
    await call.play(480);
    await call.advance(1_000);
    call.turn.round("第二句。");
    await settle();
    call.utterance().pcm(2, 480);
    await settle();
    call.news();
    await call.play(240);
    await call.advance(5_000);
    expect(call.news()).toEqual(["bot-output new 第二句。"]);
  });

  test("row 8: a line typed to wait while she speaks is stored at once, for her next turn", async () => {
    const call = startCall();
    await call.ready();
    await call.says("你好");
    call.turn.mind("started");
    await settle();
    call.news();
    await call.rtvi("send-text", { content: "还有", options: { run_immediately: false } }, "t1");
    expect(call.news()).toEqual(["user-input chat 还有"]);
    expect(call.sent.at(-1)?.data).toMatchObject({ input_type: "chat", msg_id: "t1", final: true });
    expect(call.events().at(-1)).toMatchObject({ text: "还有", modality: "text" });
    call.turn.mind("ended");
    await call.turn.end();
    await settle();
    expect(call.turns).toHaveLength(1);
    await call.says("在吗");
    expect(call.turns).toHaveLength(2);
    expect(call.turn.request.chat.events.slice(-2)).toMatchObject([
      { text: "还有", modality: "text" },
      { text: "在吗", modality: "call" },
    ]);
  });

  test("row 8: a line typed to wait while she is idle starts no reply", async () => {
    const call = startCall();
    await call.ready();
    call.news();
    await call.rtvi("send-text", { content: "在吗", options: { run_immediately: false } });
    await call.advance(5_000);
    expect(call.news()).toEqual(["user-input chat 在吗"]);
    expect(call.turns).toHaveLength(0);
    await call.rtvi("send-text", { content: "说话呀" });
    expect(call.turns).toHaveLength(1);
    expect(call.turn.request.chat.events).toMatchObject([{ text: "在吗" }, { text: "说话呀" }]);
  });

  test("row 7: a line typed to run now while she is idle", async () => {
    const call = startCall();
    await call.ready();
    call.news();
    await call.rtvi("send-text", { content: "你在吗" }, "t1");
    expect(call.news()).toEqual([
      "bot-interrupted",
      "user-input chat 你在吗",
      "user-llm-text 你在吗",
    ]);
    expect(call.events()).toMatchObject([{ text: "你在吗", modality: "text" }]);
    expect(call.turns).toHaveLength(1);
  });

  test("row 7: audio_response false answers in text alone, its segments still reported", async () => {
    const call = startCall();
    await call.ready();
    await call.rtvi("send-text", { content: "打字回我", options: { audio_response: false } });
    call.news();
    call.turn.round("好的。");
    const heard = await call.turn.end();
    await settle();
    expect(heard).toEqual({ text: "好的。", complete: true });
    expect(call.speech.utterances).toEqual([]);
    expect(call.news()).toEqual([
      "bot-llm-started",
      "bot-llm-text 好的。",
      "bot-llm-stopped",
      "bot-transcription 好的。",
      "bot-output new 好的。",
    ]);
    expect(call.sent.at(-1)?.data).toEqual({
      text: "好的。",
      text_type: "sentence",
      aggregated_by: "sentence",
      segment_id: 1,
      spoken: false,
      will_be_spoken: false,
      spoken_status: "new",
    });
    expect(call.events().at(-1)).toMatchObject({ text: "好的。", modality: "call" });
  });
});

describe("barge-in", () => {
  async function speaking() {
    const call = startCall();
    await call.ready();
    await call.says("讲个故事");
    call.turn.round("从前有座山。山里有座庙。");
    await settle();
    const utterance = call.utterance();
    utterance.pcm(1, 480);
    utterance.segEnd(1);
    utterance.pcm(2, 480);
    await settle();
    await call.play(720);
    call.news();
    return call;
  }

  test("row 2: her audio stops at once, the client hears her close, and she keeps what was heard", async () => {
    const call = await speaking();
    const turn = call.turn;
    await call.ear({ type: "user-started" });
    expect(call.news()).toEqual([
      "user-started-speaking",
      "bot-interrupted",
      "bot-tts-stopped",
      "bot-stopped-speaking",
    ]);
    expect(call.speaker.pull(240).every((sample) => sample === 0)).toBe(true);
    expect(turn.request.signal.aborted).toBe(true);
    expect(call.utterance().cancelled).toBe(true);
    expect(turn.request.asyncSignal?.aborted).toBe(false);
    expect(call.events().at(-1)).toMatchObject({
      text: "从前有座山。",
      modality: "call",
      interrupted: true,
    });
  });

  test("before her first audio, only her open mind request closes, and its late text is dropped", async () => {
    const call = startCall();
    await call.ready();
    await call.says("讲个故事");
    call.turn.mind("started");
    call.turn.delta("嗯，");
    await settle();
    call.news();
    call.kit.post({ source: "ear", event: { type: "user-started" } });
    call.turn.delta("从前");
    call.turn.mind("ended");
    await settle();
    expect(call.news()).toEqual(["user-started-speaking", "bot-interrupted", "bot-llm-stopped"]);
    expect(call.events().filter((e) => e.type === "message")).toHaveLength(1);
  });

  test("row 7: a line typed to run now cuts her off, and goes after what she said", async () => {
    const call = await speaking();
    await call.rtvi("send-text", { content: "停一下" });
    expect(call.news()).toEqual([
      "bot-interrupted",
      "bot-tts-stopped",
      "bot-stopped-speaking",
      "user-input chat 停一下",
      "user-llm-text 停一下",
    ]);
    expect(call.turns).toHaveLength(2);
    const lines = call.events().map((e) => (e.type === "message" ? e.text : e.type));
    expect(lines).toEqual(["讲个故事", "从前有座山。", "停一下"]);
    expect(call.turn.request.chat.events).toEqual(call.events());
  });

  test("a turn that ends before her cut reply has stored it waits for it", async () => {
    const call = startCall({ stubborn: true });
    await call.ready();
    await call.says("讲个故事");
    const cut = call.turn;
    cut.round("从前有座山。");
    await settle();
    await call.says("等等");
    expect(call.turns).toHaveLength(1);
    expect(call.events().map((e) => e.type === "message" && e.text)).toEqual(["讲个故事"]);
    await cut.end();
    await settle();
    expect(call.turns).toHaveLength(2);
    const lines = call.events().map((e) => (e.type === "message" ? e.text : e.type));
    expect(lines).toEqual(["讲个故事", "等等"]);
    expect(call.turn.request.chat.events).toEqual(call.events());
  });
});

describe("tools and async results (rows 16, 17, 23)", () => {
  test("rows 16 and 17: a sync tool's lines", async () => {
    const call = startCall();
    await call.ready();
    await call.says("换个声音");
    call.news();
    call.turn.tool("c1", "running");
    call.turn.tool("c1", "done");
    call.turn.tool("c2", "running");
    call.turn.tool("c2", "cancelled");
    await settle();
    expect(call.news()).toEqual([
      "llm-function-call-started",
      "llm-function-call-in-progress c1",
      "llm-function-call-stopped c1",
      "llm-function-call-started",
      "llm-function-call-in-progress c2",
      "llm-function-call-stopped c2 cancelled",
    ]);
    expect(call.sent.at(-1)?.data).toEqual({ tool_call_id: "c2", cancelled: true });
  });

  test("row 17: a tool she doesn't have stops after its in-progress, as pipedog's does", async () => {
    const call = startCall();
    await call.ready();
    await call.says("帮我浇浇花");
    call.news();
    // The engine settles a call naming no tool of hers before its round's mind ends.
    call.turn.mind("started");
    call.turn.tool("a", "running", false, "water_the_plants");
    call.turn.tool("a", "failed", false, "water_the_plants");
    call.turn.tool("b", "running", false, "feed_the_cat");
    call.turn.tool("b", "failed", false, "feed_the_cat");
    await settle();
    expect(call.news()).toEqual([
      "bot-llm-started",
      "llm-function-call-started",
      "llm-function-call-started",
    ]);
    call.turn.mind("ended");
    await settle();
    expect(call.news()).toEqual([
      "bot-llm-stopped",
      "llm-function-call-in-progress a",
      "llm-function-call-stopped a",
      "llm-function-call-in-progress b",
      "llm-function-call-stopped b",
    ]);
    // Neither held the floor: an empty turn that cuts her off still gets the recovery prompt.
    await call.ear({ type: "user-started" }, { type: "user-stopped", text: null });
    expect(call.turn.request.nudge).toBe(NUDGE);
  });

  test("a barge-in before the round ends drops the stop with its in-progress", async () => {
    const call = startCall();
    await call.ready();
    await call.says("帮我浇浇花");
    call.news();
    call.turn.mind("started");
    call.turn.tool("a", "running", false, "water_the_plants");
    call.turn.tool("a", "failed", false, "water_the_plants");
    await settle();
    await call.ear({ type: "user-started" });
    call.turns[0]?.mind("ended");
    await settle();
    expect(call.news()).toEqual([
      "bot-llm-started",
      "llm-function-call-started",
      "user-started-speaking",
      "bot-interrupted",
      "bot-llm-stopped",
    ]);
  });

  test("change_voice_style speaks what follows in the new voice, and keeps it", async () => {
    const call = startCall();
    await call.ready();
    await call.says("换个声音");
    call.turn.mind("started");
    call.turn.delta("好的");
    call.turn.mind("ended");
    call.turn.tool("c1", "running");
    await settle();
    await call.turn.request.effects.switchVoice("whisper");
    call.turn.tool("c1", "done");
    call.turn.round("换好了。");
    await settle();
    const [before, after] = call.speech.utterances;
    expect(before).toMatchObject({ voice: null, said: ["好的"], ended: true });
    expect(after).toMatchObject({ voice: "whisper", said: ["换好了。"] });

    const ending = call.turn.end();
    await settle();
    before?.pcm(1, 240);
    before?.segEnd(1);
    before?.finish();
    after?.pcm(2, 240);
    after?.segEnd(2);
    after?.finish();
    await settle();
    await call.play(480);
    await ending;
    await call.says("再说一句");
    call.turn.round("嗯。");
    await settle();
    expect(call.utterance().voice).toBe("whisper");
  });

  test("a voice switch that reaches the Floor after a barge-in cut her turn is dropped", async () => {
    const call = startCall();
    await call.ready();
    await call.says("换个声音");
    const cut = call.turn;
    cut.round("好的");
    cut.tool("c1", "running");
    await settle();
    // The caller's speech is in the mailbox before her tool's effect: the barge-in cancels the tool.
    call.kit.post({ source: "ear", event: { type: "user-started" } });
    await cut.request.effects.switchVoice("whisper");
    await settle();
    await call.ear({ type: "final", text: "算了" }, { type: "user-stopped", text: "算了" });
    expect(call.turn).not.toBe(cut);
    call.turn.round("好。");
    await settle();
    expect(call.utterance().voice).toBeNull();
  });

  test("a server message goes to the client", async () => {
    const call = startCall();
    await call.ready();
    await call.says("拍张照");
    call.news();
    await call.turn.request.effects.sendServerMessage({ type: "selfie", urls: ["u"] });
    await settle();
    expect(call.news()).toEqual(["server-message"]);
    expect(call.sent.at(-1)?.data).toEqual({ type: "selfie", urls: ["u"] });
  });

  test("row 23: an async result that lands while she is idle is stored and answered", async () => {
    const call = startCall();
    await call.ready();
    await call.says("拍张照");
    call.turn.tool("s1", "running", true, "take_selfie");
    call.turn.events(started("s1"));
    await call.turn.end();
    await settle();
    call.news();
    call.turns[0]?.request.onAsyncResult([settled("s1", "final")]);
    await settle();
    expect(call.news()).toEqual(["llm-function-call-stopped s1"]);
    expect(call.turns).toHaveLength(2);
    expect(call.turn.request.chat.events.at(-1)).toMatchObject({ stage: "final", callId: "s1" });
  });

  test("row 16: an async tool counts as no sync tool", async () => {
    const call = startCall();
    await call.ready();
    await call.says("拍张照");
    call.turn.mind("started");
    call.turn.tool("s1", "running", true, "take_selfie");
    await settle();
    await call.ear({ type: "user-started" }, { type: "user-stopped", text: null });
    // Interrupting her with nothing said asks her to go on, since no sync tool held the floor.
    expect(call.turn.request.nudge).toBe(NUDGE);
  });

  test("row 23: one that lands while she speaks is owed until her reply ends", async () => {
    const call = startCall();
    await call.ready();
    await call.says("拍张照");
    const first = call.turn;
    first.round("稍等。");
    await settle();
    first.request.onAsyncResult([settled("s1", "final")]);
    await settle();
    expect(call.turns).toHaveLength(1);
    expect(call.events().at(-1)).toMatchObject({ stage: "final" });
    const ending = first.end();
    await settle();
    call.utterance().pcm(1, 240);
    call.utterance().segEnd(1);
    call.utterance().finish();
    await settle();
    await call.play(240);
    await ending;
    await settle();
    expect(call.turns).toHaveLength(2);
  });

  test("row 23: one that lands while the caller speaks goes with her turn's reply", async () => {
    const call = startCall();
    await call.ready();
    await call.says("拍张照");
    await call.turn.end();
    await call.ear({ type: "user-started" });
    call.turns[0]?.request.onAsyncResult([settled("s1", "final")]);
    await settle();
    expect(call.turns).toHaveLength(1);
    await call.ear({ type: "final", text: "好了吗" }, { type: "user-stopped", text: "好了吗" });
    expect(call.turns).toHaveLength(2);
    const types = call.turn.request.chat.events.map((e) => e.type);
    expect(types.slice(-2)).toEqual(["tool-result", "message"]);
    await call.turn.end();
    await settle();
    expect(call.turns).toHaveLength(2);
  });

  test("row 23: one that lands while the caller says nothing is answered once she stops", async () => {
    const call = startCall();
    await call.ready();
    await call.says("拍张照");
    await call.turn.end();
    await call.ear({ type: "user-started" });
    call.turns[0]?.request.onAsyncResult([settled("s1", "cancelled")]);
    await settle();
    expect(call.news().at(-1)).toBe("llm-function-call-stopped s1 cancelled");
    await call.ear({ type: "user-stopped", text: null });
    expect(call.turns).toHaveLength(2);
  });

  test("row 23: a late started result goes after her cut message, and owes no reply", async () => {
    const call = startCall({ stubborn: true });
    await call.ready();
    await call.says("帮我做个网页");
    const cut = call.turn;
    cut.round("好的。");
    cut.tool("t1", "running", false, "start_task");
    await settle();
    call.utterance().pcm(1, 480);
    call.utterance().segEnd(1);
    await settle();
    await call.play(480);
    await call.ear({ type: "user-started" });
    // The start her turn left running answers while that turn still stores what was heard.
    cut.request.onAsyncResult([lateStart("t1")]);
    cut.tool("t1", "cancelled", false, "start_task");
    await settle();
    await call.ear({ type: "final", text: "等等" }, { type: "user-stopped", text: "等等" });
    await cut.end();
    await settle();
    expect(call.turns).toHaveLength(2);
    const lines = call.events().map((e) => (e.type === "message" ? e.text : e.type));
    expect(lines).toEqual(["帮我做个网页", "好的。", "tool-result", "等等"]);
    await spokenReply(call, "好。");
    call.news();
    // One that answers once she is idle starts nothing; its RTVI call ended with the cut turn.
    cut.request.onAsyncResult([lateStart("t2")]);
    await settle();
    expect(call.events().at(-1)).toMatchObject({ callId: "t2", stage: "started" });
    expect(call.news()).toEqual([]);
    expect(call.turns).toHaveLength(2);
  });

  test("row 23: a late result she waited for owes no reply either", async () => {
    const call = startCall();
    await call.ready();
    await call.says("别做了");
    const first = call.turn;
    await spokenReply(call, "好。");
    call.news();
    first.request.onAsyncResult([
      { type: "tool-result", persona: HOST, turn: "turn-1", callId: "s1", result: { ok: true } },
    ]);
    await settle();
    expect(call.events().at(-1)).toMatchObject({ type: "tool-result", callId: "s1" });
    expect(call.events().at(-1)).not.toHaveProperty("stage");
    expect(call.news()).toEqual([]);
    expect(call.turns).toHaveLength(1);
  });
});

describe("what a bound call adds to her replies (rows 1, 4, 5, 7, 23)", () => {
  test("rows 4 and 7: a reply to the caller's line, spoken or typed, gets all the plan adds", async () => {
    const asked: boolean[] = [];
    const call = startCall({ extras: giving(asked) });
    await call.ready();
    await call.says("帮我做个网页");
    expect(asked).toEqual([true]);
    expect(added(call.turn.request)).toEqual(EVERYTHING);
    await spokenReply(call, "好。");
    await call.rtvi("send-text", { content: "再做一个" });
    expect(asked).toEqual([true, true]);
    expect(added(call.turn.request)).toEqual(EVERYTHING);
  });

  test("her greeting, a recovery and a follow-up get the plan's providers alone", async () => {
    const asked: boolean[] = [];
    const call = startCall({ greet: true, extras: giving(asked) });
    await call.ready();
    expect(call.turn.request.kickoff).toBe(true);
    expect(added(call.turn.request)).toEqual({ providers: PROVIDERS });
    await spokenReply(call, "你好。");

    await call.says("讲个故事");
    call.turn.mind("started");
    await settle();
    await call.ear({ type: "user-started" }, { type: "user-stopped", text: null });
    expect(call.turn.request.nudge).toBe(NUDGE);
    expect(added(call.turn.request)).toEqual({ providers: PROVIDERS });
    await spokenReply(call, "你说什么？");

    call.turns[1]?.request.onAsyncResult([settled("s1", "final")]);
    await settle();
    expect(call.turns).toHaveLength(4);
    expect(added(call.turn.request)).toEqual({ providers: PROVIDERS });
    expect(asked).toEqual([false, true, false, false]);
  });

  test("it is asked as the reply starts: one that waits for her cut reply, once that has ended", async () => {
    const asked: boolean[] = [];
    const call = startCall({ stubborn: true, extras: giving(asked) });
    await call.ready();
    await call.says("讲个故事");
    const cut = call.turn;
    cut.round("从前有座山。");
    await settle();
    await call.says("等等");
    expect(asked).toEqual([true]);
    await cut.end();
    await settle();
    expect(call.turns).toHaveLength(2);
    expect(asked).toEqual([true, true]);
    expect(added(call.turn.request)).toEqual(EVERYTHING);
  });

  test("a plan that adds nothing adds nothing; one that throws is logged, and the reply goes on", async () => {
    let failing = false;
    const call = startCall({
      extras: () => {
        if (failing) throw new Error("the chat is gone");
        return null;
      },
    });
    await call.ready();
    await call.says("你好");
    expect(added(call.turn.request)).toEqual({});
    await spokenReply(call, "你好呀。");
    failing = true;
    await call.says("在吗");
    expect(call.turns).toHaveLength(2);
    expect(added(call.turn.request)).toEqual({});
    expect(logs).toContain("[voice] Reply id-4's extras failed: the chat is gone");
  });
});

describe("results from outside the call (row 31)", () => {
  test("stored at once; with a nudge, answered by a follow-up while she is idle", async () => {
    const asked: boolean[] = [];
    const call = startCall({ extras: giving(asked) });
    await call.ready();
    await call.says("帮我做个网页");
    await spokenReply(call, "交给我吧。");
    call.news();
    await call.outside({ drafts: [ended("t1")], nudge: ENDED });
    // No call of this one's: the client hears nothing of it.
    expect(call.news()).toEqual([]);
    expect(call.turns).toHaveLength(2);
    const { request } = call.turn;
    expect(request.nudge).toBe(ENDED);
    expect(request.chat.events.at(-1)).toMatchObject({ callId: "t1", stage: "final" });
    expect(added(request)).toEqual({ providers: PROVIDERS });
    expect(asked).toEqual([true, false]);
    await spokenReply(call, "网页做好了。");
    expect(call.turns).toHaveLength(2);
  });

  test("ones that land while she speaks wait for her reply's end, and go together", async () => {
    const call = startCall({ extras: giving([]) });
    await call.ready();
    await call.says("讲个故事");
    const first = call.turn;
    first.round("从前有座山。");
    await settle();
    await call.outside({ drafts: [ended("t1")], nudge: "一" });
    await call.outside({ drafts: [ended("t2")], nudge: "二" });
    expect(call.turns).toHaveLength(1);
    // Her open reply stores its line first: its turn placed its blocks by the log it read.
    expect(call.events().map((e) => e.type)).toEqual(["message"]);
    const ending = first.end();
    await settle();
    call.utterance().pcm(1, 240);
    call.utterance().segEnd(1);
    call.utterance().finish();
    await settle();
    await call.play(240);
    await ending;
    await settle();
    const lines = call.events().map((e) => (e.type === "message" ? e.text : e.type));
    expect(lines).toEqual(["讲个故事", "从前有座山。", "tool-result", "tool-result"]);
    expect(call.events().slice(-2)).toMatchObject([{ callId: "t1" }, { callId: "t2" }]);
    expect(call.turns).toHaveLength(2);
    expect(call.turn.request.nudge).toBe("一\n\n二");
  });

  test("one that lands while the caller speaks skips her reply to them, which has the plan's tools, for a follow-up after it", async () => {
    const asked: boolean[] = [];
    const call = startCall({ extras: giving(asked) });
    await call.ready();
    await call.ear({ type: "user-started" });
    await call.outside({ drafts: [ended("t1")], nudge: ENDED });
    expect(call.turns).toHaveLength(0);
    await call.ear({ type: "final", text: "好了吗" }, { type: "user-stopped", text: "好了吗" });
    expect(call.turns).toHaveLength(1);
    const answer = call.turn.request;
    expect(answer.nudge).toBeUndefined();
    expect(added(answer)).toEqual(EVERYTHING);
    // It still reads the result, stored before the line it answers.
    const types = answer.chat.events.map((e) => e.type);
    expect(types).toEqual(["tool-result", "message"]);
    await spokenReply(call, "我看看。");
    expect(call.turns).toHaveLength(2);
    expect(call.turn.request.nudge).toBe(ENDED);
    expect(added(call.turn.request)).toEqual({ providers: PROVIDERS });
    expect(asked).toEqual([true, false]);
    await spokenReply(call, "做好了。");
    expect(call.turns).toHaveLength(2);
  });

  test("a reply to the caller's line that the plan offers no tools takes it", async () => {
    const call = startCall({ extras: () => ({ providers: PROVIDERS }) });
    await call.ready();
    await call.ear({ type: "user-started" });
    await call.outside({ drafts: [ended("t1")], nudge: ENDED });
    await call.ear({ type: "final", text: "好了吗" }, { type: "user-stopped", text: "好了吗" });
    expect(call.turn.request.nudge).toBe(ENDED);
    await spokenReply(call, "做好了。");
    expect(call.turns).toHaveLength(1);
  });

  test("a recovery takes it after its own nudge", async () => {
    const call = startCall({ extras: giving([]) });
    await call.ready();
    await call.says("讲个故事");
    call.turn.mind("started");
    await settle();
    await call.ear({ type: "user-started" });
    await call.outside({ drafts: [ended("t1")], nudge: ENDED });
    await call.ear({ type: "user-stopped", text: null });
    expect(call.turns).toHaveLength(2);
    expect(call.turn.request.nudge).toBe(`${NUDGE}\n\n${ENDED}`);
    await spokenReply(call, "你说什么？");
    expect(call.turns).toHaveLength(2);
  });

  test("one that comes before client-ready goes with her greeting", async () => {
    const call = startCall({ greet: true, extras: giving([]) });
    await call.outside({ drafts: [ended("t1")], nudge: ENDED });
    expect(call.turns).toHaveLength(0);
    expect(call.events()).toMatchObject([{ callId: "t1", stage: "final" }]);
    await call.ready();
    expect(call.news()).toEqual(["bot-ready"]);
    expect(call.turns).toHaveLength(1);
    expect(call.turn.request).toMatchObject({ kickoff: true, nudge: ENDED });
    await spokenReply(call, "欢迎回来，网页做好了。");
    expect(call.turns).toHaveLength(1);
  });

  test("a greeting cut before its turn records the nudge it took leaves it for a follow-up after her answer", async () => {
    const asked: boolean[] = [];
    const call = startCall({ greet: true, extras: giving(asked) });
    await call.outside({ drafts: [ended("t1")], nudge: ENDED });
    await call.ready();
    expect(call.turn.request.nudge).toBe(ENDED);
    await call.says("喂");
    expect(call.turns).toHaveLength(2);
    expect(call.turn.request.nudge).toBeUndefined();
    await spokenReply(call, "在的。");
    expect(call.turns).toHaveLength(3);
    expect(call.turn.request.nudge).toBe(ENDED);
    expect(asked).toEqual([false, true, false]);
  });

  test("a reply cut once its turn has recorded the nudge leaves nothing for another", async () => {
    const call = startCall({ greet: true, extras: giving([]) });
    await call.outside({ drafts: [ended("t1")], nudge: ENDED });
    await call.ready();
    const greeting = call.turn;
    // As the engine records it, before it asks her mind.
    greeting.events({
      type: "context",
      persona: HOST,
      turn: greeting.id,
      position: 1,
      role: "developer",
      content: ENDED,
    });
    await settle();
    await call.says("喂");
    await spokenReply(call, "在的，网页也做好了。");
    await call.advance(5_000);
    expect(call.turns).toHaveLength(2);
  });

  test("one no longer due when her reply would take it is dropped: the end alone is told", async () => {
    const call = startCall({ extras: giving([]) });
    await call.ready();
    await call.says("今天天气怎么样");
    // Her answer, offered the plan's tools, is under way when a task pauses.
    let paused = true;
    await call.outside({ drafts: [], nudge: "（停下来了）", due: () => paused });
    // The owner answers its card, and it ends, before her answer does.
    paused = false;
    await call.outside({ drafts: [ended("t1")], nudge: ENDED });
    await spokenReply(call, "今天是晴天哦。");
    expect(call.turns).toHaveLength(2);
    expect(call.turn.request.nudge).toBe(ENDED);
  });

  test("her greeting takes only the nudges still due as it starts", async () => {
    const call = startCall({ greet: true, extras: giving([]) });
    let paused = true;
    await call.outside({ drafts: [], nudge: "（停下来了）", due: () => paused });
    await call.outside({ drafts: [ended("t1")], nudge: ENDED });
    // The owner answers the card before the call is up.
    paused = false;
    await call.ready();
    expect(call.turn.request).toMatchObject({ kickoff: true, nudge: ENDED });
  });

  test("a follow-up owed only to nudges no longer due never starts; one still due starts it", async () => {
    const call = startCall({ extras: giving([]) });
    await call.ready();
    await call.says("今天天气怎么样");
    let paused = true;
    await call.outside({ drafts: [], nudge: "（停下来了）", due: () => paused });
    paused = false;
    await spokenReply(call, "今天是晴天哦。");
    await call.advance(5_000);
    expect(call.turns).toHaveLength(1);
    await call.outside({ drafts: [], nudge: "（又停下来了）", due: () => true });
    expect(call.turns).toHaveLength(2);
    expect(call.turn.request.nudge).toBe("（又停下来了）");
  });

  test("one without a nudge is stored, and owes nothing", async () => {
    const call = startCall();
    await call.ready();
    await call.outside({ drafts: [ended("t1", "cancelled")] });
    expect(call.events()).toMatchObject([{ callId: "t1", stage: "cancelled" }]);
    await call.advance(5_000);
    expect(call.turns).toHaveLength(0);
  });

  test("its lines wait behind the message of her reply a barge-in cut", async () => {
    const call = startCall({ stubborn: true });
    await call.ready();
    await call.says("讲个故事");
    const cut = call.turn;
    cut.round("从前有座山。山里有座庙。");
    await settle();
    call.utterance().pcm(1, 480);
    call.utterance().segEnd(1);
    call.utterance().pcm(2, 480);
    await settle();
    await call.play(720);
    await call.ear({ type: "user-started" });
    await call.outside({ drafts: [ended("t1")], nudge: ENDED });
    expect(call.events().map((e) => e.type)).toEqual(["message"]);
    await cut.end();
    await settle();
    const lines = call.events().map((e) => (e.type === "message" ? e.text : e.type));
    expect(lines).toEqual(["讲个故事", "从前有座山。", "tool-result"]);
  });

  test("once disconnect-bot has come, its lines are stored and no reply starts", async () => {
    const call = startCall();
    await call.ready();
    await call.says("再见");
    call.turn.round("拜拜。");
    await settle();
    call.utterance().pcm(1, 480);
    await settle();
    await call.play(240);
    await call.rtvi("disconnect-bot");
    await call.outside({ drafts: [ended("t1")], nudge: ENDED });
    await call.play(240);
    await settle();
    expect(call.endings).toEqual(["bot"]);
    expect(call.events().at(-1)).toMatchObject({ callId: "t1" });
    expect(call.turns).toHaveLength(1);
  });

  test("one after the call's end is neither stored nor answered", async () => {
    const call = startCall({ stubborn: true });
    await call.ready();
    await call.says("讲个故事");
    call.kit.post({ source: "shutdown" });
    await settle();
    // The call has ended, and still waits for her cut reply.
    expect(call.floor.finished).toBeNull();
    await call.outside({ drafts: [ended("t1")], nudge: ENDED });
    await call.advance(2_000);
    expect(await call.loop).toBe("shutdown");
    expect(call.events().map((e) => e.type)).toEqual(["message"]);
    expect(call.turns).toHaveLength(1);
  });
});

describe("timers (rows 21, 26)", () => {
  test("row 26: 300 s with nothing heard or played ends the call", async () => {
    const call = startCall();
    await call.ready();
    await call.advance(299_999);
    expect(call.endings).toEqual([]);
    await call.advance(1);
    expect(call.endings).toEqual(["idle"]);
    expect(await call.loop).toBe("idle");
  });

  test("row 26: the caller's speech and her playing audio push it back", async () => {
    const call = startCall();
    await call.ready();
    await call.advance(200_000);
    await call.ear({ type: "user-speaking" });
    await call.advance(299_999);
    expect(call.endings).toEqual([]);
    await call.says("讲个长故事");
    call.turn.round("很久很久以前。");
    await settle();
    call.utterance().pcm(1, 24_000);
    await settle();
    await call.play(240);
    await call.advance(400_000);
    expect(call.endings).toEqual([]);
    expect(call.speaker.isSpeaking()).toBe(true);
  });
});

describe("the end of a call (rows 24, 25, 27-29)", () => {
  test("row 24: a fatal STT error is reported, then ends the call", async () => {
    const call = startCall();
    await call.ready();
    call.news();
    await call.ear({ type: "stt-error", message: "reconnecting", fatal: false });
    expect(call.endings).toEqual([]);
    await call.ear({ type: "stt-error", message: "Soniox gave up", fatal: true });
    expect(call.news()).toEqual(["error reconnecting", "error Soniox gave up"]);
    expect(call.endings).toEqual(["error"]);
    expect(await call.loop).toBe("error");
  });

  test("row 25: her voice failing drops her queued audio, and the reply goes on in text", async () => {
    const call = startCall();
    await call.ready();
    await call.says("讲个故事");
    call.turn.round("从前有座山。山里有座庙。");
    await settle();
    call.utterance().pcm(1, 480);
    call.utterance().segEnd(1);
    call.utterance().pcm(2, 480);
    await settle();
    await call.play(600);
    call.news();
    call.utterance().finish({ kind: "error", message: "Fish closed the socket" });
    await settle();
    expect(call.news()).toEqual([
      "error Fish closed the socket",
      "bot-tts-stopped",
      "bot-stopped-speaking",
    ]);
    expect(call.speaker.isSpeaking()).toBe(false);
    call.turn.round("老和尚说。");
    await settle();
    expect(call.news()).toEqual(["bot-llm-started", "bot-llm-text 老和尚说。", "bot-llm-stopped"]);
    const heard = await call.turn.end();
    expect(heard).toEqual({ text: "从前有座山。", complete: false });
  });

  test("row 25: her voice stalling 15 s is the same failure", async () => {
    const call = startCall();
    await call.ready();
    await call.says("你好");
    call.turn.round("你好呀。");
    await settle();
    call.news();
    await call.advance(15_000);
    expect(call.news()).toEqual([
      "error No speech audio arrived within 15 seconds",
      "bot-tts-stopped",
    ]);
    expect(call.utterance().cancelled).toBe(true);
  });

  test("row 25: a stall her voice reports too, in the same tick, is reported once", async () => {
    // Fish's flush arms its own 15 s stall as the Mouth arms its: just after it, or just before.
    for (const lead of [0, 1]) {
      const call = startCall();
      await call.ready();
      await call.says("你好");
      call.turn.round("你好呀。");
      await settle();
      const utterance = call.utterance();
      call.clock.setTimer(SPEECH_STALL_MS - lead, () =>
        utterance.finish({ kind: "error", message: SPEECH_STALLED }),
      );
      call.news();
      await call.advance(SPEECH_STALL_MS);
      expect(call.news()).toEqual([
        "error No speech audio arrived within 15 seconds",
        "bot-tts-stopped",
      ]);
    }
  });

  test("row 27: disconnect-bot while she is idle ends the call at once", async () => {
    const call = startCall();
    await call.ready();
    await call.rtvi("disconnect-bot");
    expect(call.endings).toEqual(["bot"]);
    expect(await call.loop).toBe("bot");
  });

  test("row 27: disconnect-bot lets her audio play out, and starts nothing", async () => {
    const call = startCall();
    await call.ready();
    await call.says("再见");
    call.turn.round("拜拜。");
    await settle();
    call.utterance().pcm(1, 480);
    await settle();
    await call.play(240);
    await call.rtvi("disconnect-bot");
    call.turn.request.onAsyncResult([settled("s1", "final")]);
    await settle();
    expect(call.endings).toEqual([]);
    expect(call.turns).toHaveLength(1);
    await call.play(240);
    expect(call.endings).toEqual(["bot"]);
  });

  test("row 27: it waits 10 s at most", async () => {
    const call = startCall();
    await call.ready();
    await call.says("再见");
    call.turn.round("拜拜。");
    await settle();
    call.utterance().pcm(1, 24_000);
    await settle();
    await call.play(240);
    await call.rtvi("disconnect-bot");
    await call.advance(9_999);
    expect(call.endings).toEqual([]);
    await call.advance(1);
    expect(call.endings).toEqual(["bot"]);
  });

  test("rows 28 and 29: the client leaving, and the server shutting down", async () => {
    const left = startCall();
    left.kit.post({ source: "transport" });
    expect(await left.loop).toBe("client");
    const shut = startCall();
    shut.kit.post({ source: "shutdown" });
    expect(await shut.loop).toBe("shutdown");
  });

  test("mid-reply, she is cut silently, her async tools stop, and her line is stored", async () => {
    const call = startCall();
    await call.ready();
    await call.says("讲个故事");
    const turn = call.turn;
    turn.round("从前有座山。山里有座庙。");
    await settle();
    call.utterance().pcm(1, 480);
    call.utterance().segEnd(1);
    call.utterance().pcm(2, 480);
    await settle();
    await call.play(600);
    call.news();
    call.kit.post({ source: "transport" });
    expect(await call.loop).toBe("client");
    expect(call.news()).toEqual([]);
    expect(call.endings).toEqual(["client"]);
    expect(turn.request.signal.aborted).toBe(true);
    expect(turn.request.asyncSignal?.aborted).toBe(true);
    expect(call.events().at(-1)).toMatchObject({ text: "从前有座山。", interrupted: true });
  });

  test("the end waits 2 s at most for her reply to end", async () => {
    const call = startCall({ stubborn: true });
    await call.ready();
    await call.says("讲个故事");
    call.kit.post({ source: "shutdown" });
    await settle();
    expect(call.floor.finished).toBeNull();
    await call.advance(2_000);
    expect(await call.loop).toBe("shutdown");
  });
});

describe("the mailbox", () => {
  test("the Floor handles an event without awaiting anything", async () => {
    const call = startCall();
    const result: unknown = call.floor.handle({ source: "ear", event: { type: "user-speaking" } });
    expect(result).toBeUndefined();
  });

  test("the Speaker, a timer and the client only post: the Floor acts when it reads them", async () => {
    const call = startCall();
    await call.ready();
    await call.says("你好");
    call.turn.round("你好呀。");
    await settle();
    call.utterance().pcm(1, 480);
    await settle();
    call.news();
    call.speaker.pull(240);
    expect(call.news()).toEqual([]);
    await settle();
    expect(call.news()).toEqual(["bot-started-speaking", "bot-output new 你好呀。"]);

    await call.rtvi("disconnect-bot");
    call.clock.advance(10_000);
    expect(call.endings).toEqual([]);
    await settle();
    expect(call.endings).toEqual(["bot"]);
  });

  test("one producer's events are handled in the order it posted them", async () => {
    const call = startCall();
    await call.ready();
    call.news();
    await call.ear(
      { type: "user-started" },
      { type: "interim", text: "一" },
      { type: "interim", text: "一二" },
      { type: "final", text: "一二三" },
    );
    expect(call.news().filter((l) => l.startsWith("user-transcription"))).toEqual([
      "user-transcription 一",
      "user-transcription 一二",
      "user-transcription 一二三",
    ]);
  });
});
