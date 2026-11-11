// The Floor on the real turn engine over a scripted mind and tools: her voice switches between
// her words where she wrote it, her speech ends only once all of them reached it, her stored line
// is what was heard, and an async selfie's result brings the follow-up reply.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { consoleSink, logger } from "@eidolon/config";
import type { LlmTool } from "@eidolon/core";
import {
  type EngineDeps,
  type Mind,
  type MindChunk,
  type MindRequest,
  runTurn,
} from "@eidolon/engine";
import { settle, startCall } from "./harness.ts";

let logs: string[];
beforeEach(() => {
  logs = [];
  logger.setSink((record) => logs.push(record.message));
});
afterEach(() => {
  logger.setSink(consoleSink);
});

const DONE: MindChunk = { type: "done", finishReason: "stop" };

function scriptedMind(...rounds: (readonly MindChunk[])[]): {
  mind: Mind;
  requests: MindRequest[];
} {
  const requests: MindRequest[] = [];
  return {
    requests,
    mind: {
      async *stream(request) {
        requests.push(request);
        yield* rounds[requests.length - 1] ?? [DONE];
      },
    },
  };
}

const voiceTool: LlmTool = {
  schema: { name: "change_voice_style", description: "", properties: {}, required: [] },
  cancelOnInterruption: true,
  timeoutSecs: null,
  async run({ arguments: args }, effects) {
    await effects.switchVoice(String(args.style));
    return { ok: true };
  },
};

/** A selfie that resolves when the test says. */
function selfieTool() {
  const shot = Promise.withResolvers<void>();
  const tool: LlmTool = {
    schema: { name: "take_selfie", description: "", properties: {}, required: [] },
    cancelOnInterruption: false,
    timeoutSecs: 120,
    async run(_call, effects) {
      await shot.promise;
      await effects.sendServerMessage({ type: "selfie", urls: ["https://x/1.png"] });
      return { ok: true };
    },
  };
  return { tool, shoot: () => shot.resolve() };
}

function engine(mind: Mind, tools: readonly LlmTool[]): EngineDeps {
  let n = 0;
  return {
    createMind: () => mind,
    parts: async () => ({
      systemInstruction: "SYSTEM",
      providers: [],
      gate: null,
      tools,
      memories: async () => [],
    }),
    saveAttachment: async () => {
      throw new Error("a call saves no files");
    },
    fetchImage: async () => {
      throw new Error("a call fetches no images");
    },
    newId: () => `e-${++n}`,
    speech: {
      canSpeak: () => false,
      synthesize: () => Promise.reject(new Error("a call speaks no voice messages")),
      transcribe: () => Promise.reject(new Error("a call hears no voice messages")),
    },
  };
}

describe("the Floor on the real engine", () => {
  test("a voice switch lands between her words where she wrote it, and she keeps what was heard", async () => {
    const { mind } = scriptedMind(
      [
        { type: "text", text: "好的，" },
        { type: "text", text: "我换个声音。" },
        {
          type: "tool-calls",
          calls: [{ id: "c1", name: "change_voice_style", arguments: { style: "whisper" } }],
        },
        DONE,
      ],
      [{ type: "text", text: "现在是悄悄话。" }, DONE],
    );
    const deps = engine(mind, [voiceTool]);
    const call = startCall({ turn: (request) => runTurn(request, deps) });
    await call.ready();
    await call.says("换个声音");
    await settle();
    const [before, after] = call.speech.utterances;
    expect(before).toMatchObject({ voice: null, said: ["好的，我换个声音。"], ended: true });
    expect(after).toMatchObject({ voice: "whisper", said: ["现在是悄悄话。"], ended: true });
    expect(call.news().slice(-13)).toEqual([
      "bot-llm-started",
      "bot-llm-text 好的，",
      "bot-llm-text 我换个声音。",
      "llm-function-call-started",
      "bot-llm-stopped",
      "llm-function-call-in-progress c1",
      "bot-transcription 好的，我换个声音。",
      "bot-tts-started",
      "llm-function-call-stopped c1",
      "bot-llm-started",
      "bot-llm-text 现在是悄悄话。",
      "bot-llm-stopped",
      "bot-transcription 现在是悄悄话。",
    ]);

    before?.pcm(1, 240);
    before?.segEnd(1);
    before?.finish();
    after?.pcm(2, 240);
    after?.segEnd(2);
    after?.finish();
    await settle();
    await call.play(480);
    await settle();
    const message = call.events().at(-1);
    expect(message).toMatchObject({
      type: "message",
      text: "好的，我换个声音。现在是悄悄话。",
      modality: "call",
    });
    expect(message).not.toHaveProperty("interrupted");
    expect(logs.some((l) => l.includes("Text came after"))).toBe(false);
  });

  test("her speech ends only once every word of her last round has reached it", async () => {
    const { mind } = scriptedMind([
      { type: "text", text: "第一句。" },
      { type: "text", text: "第二句。" },
      DONE,
    ]);
    const deps = engine(mind, []);
    const call = startCall({ turn: (request) => runTurn(request, deps) });
    await call.ready();
    await call.says("说两句");
    await settle();
    const utterance = call.utterance();
    expect(utterance).toMatchObject({ said: ["第一句。", "第二句。"], ended: true });
    utterance.pcm(1, 240);
    utterance.segEnd(1);
    utterance.pcm(2, 240);
    utterance.segEnd(2);
    utterance.finish();
    await settle();
    await call.play(480);
    await settle();
    expect(call.events().at(-1)).toMatchObject({ text: "第一句。第二句。", modality: "call" });
    expect(logs.some((l) => l.includes("Text came after"))).toBe(false);
  });

  test("cut off mid-reply, she keeps only what was heard", async () => {
    const { mind } = scriptedMind([
      { type: "text", text: "从前有座山。" },
      { type: "text", text: "山里有座庙。" },
      DONE,
    ]);
    const deps = engine(mind, []);
    const call = startCall({ turn: (request) => runTurn(request, deps) });
    await call.ready();
    await call.says("讲个故事");
    await settle();
    const utterance = call.utterance();
    utterance.pcm(1, 480);
    utterance.segEnd(1);
    utterance.pcm(2, 480);
    await settle();
    await call.play(720);
    await call.ear({ type: "user-started" });
    await settle();
    expect(call.events().at(-1)).toMatchObject({
      text: "从前有座山。",
      modality: "call",
      interrupted: true,
    });
  });

  test("a turn that fails before its mind request tells the client, a failed request only once", async () => {
    const failing: Mind = {
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error("502 Bad Gateway")),
        }),
      }),
    };
    let made = 0;
    const deps: EngineDeps = {
      ...engine(failing, []),
      createMind: () => {
        if (++made === 1) throw new Error("OpenRouter needs an API key");
        return failing;
      },
    };
    const call = startCall({ turn: (request) => runTurn(request, deps) });
    await call.ready();
    const told = () => call.news().filter((l) => /^(error|bot-llm)/.test(l));
    call.news();

    await call.says("你好");
    await settle();
    expect(told()).toEqual(["error OpenRouter needs an API key"]);
    expect(call.events().at(-1)).toMatchObject({
      type: "turn-failed",
      error: "OpenRouter needs an API key",
    });

    await call.says("还在吗");
    await settle();
    expect(told()).toEqual([
      "bot-llm-started",
      "bot-llm-stopped",
      "error Error during completion: 502 Bad Gateway",
    ]);
  });

  test("an async selfie's result, landing once she is done, brings her follow-up reply", async () => {
    const selfie = selfieTool();
    const { mind, requests } = scriptedMind(
      [
        { type: "text", text: "我拍一张。" },
        { type: "tool-calls", calls: [{ id: "s1", name: "take_selfie", arguments: {} }] },
        DONE,
      ],
      [{ type: "text", text: "拍好啦。" }, DONE],
    );
    const deps = engine(mind, [selfie.tool]);
    const call = startCall({ turn: (request) => runTurn(request, deps) });
    await call.ready();
    await call.says("拍张照");
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.system).toContain("ASYNC TOOLS:");
    call.utterance().pcm(1, 240);
    call.utterance().segEnd(1);
    call.utterance().finish();
    await settle();
    await call.play(240);
    await settle();
    call.news();

    selfie.shoot();
    await settle();
    expect(call.news().slice(0, 3)).toEqual([
      "server-message",
      "llm-function-call-stopped s1",
      "bot-llm-started",
    ]);
    expect(requests).toHaveLength(2);
    const stages = call.events().flatMap((e) => (e.type === "tool-result" ? [e.stage] : []));
    expect(stages).toEqual(["started", "final"]);
  });
});
