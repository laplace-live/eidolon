import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ContextProvider, ContextTurn, FrameMetadata } from "@eidolon/core";
import { CancelledError, currentTask } from "@pipedog/asyncio";
import {
  ErrorFrame,
  type Frame,
  InterruptionFrame,
  LLMContextFrame,
  TextFrame,
} from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import { FrameDirection, type FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { runTest, SleepFrame } from "@pipedog/core/tests/utils";
import { ContextProviderProcessor, RetrievalGateProcessor } from "../src/adapters/context.ts";
import { captureLogs, deferred, type LogCapture, until } from "./support.ts";

// The frame-metadata keys @eidolon/context's gate and providers share.
const GATE = "retrieval_gate";
const OVERVIEW = "stream_archive_overview";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

const conversation = (context: LLMContext) => ({
  getMessages: () => context.getMessages(),
  setMessages: (messages: unknown[]) => context.setMessages(messages as never),
  setHiddenTools: () => {},
});

function provider(
  label: string,
  onContext: (turn: ContextTurn) => Promise<void>,
): ContextProvider & { label: string } {
  return {
    label,
    onContext,
    errorMessage: (e) => `${label} error: ${e instanceof Error ? e.message : String(e)}`,
  };
}

function processorFor(p: ContextProvider & { label: string }): ContextProviderProcessor {
  return new ContextProviderProcessor(p, { label: p.label, conversation });
}

function contextFrame(...userTexts: string[]): LLMContextFrame {
  return new LLMContextFrame({
    context: new LLMContext({ messages: userTexts.map((content) => ({ role: "user", content })) }),
  });
}

describe("ContextProviderProcessor", () => {
  test("hands the provider the live context and frame metadata, then pushes the frame down", async () => {
    const turns: ContextTurn[] = [];
    const frame = contextFrame("你好");
    frame.metadata.marker = 1;
    const p = provider("StreamArchiveService", async (turn) => {
      turns.push(turn);
      turn.context.setMessages([
        { role: "system", content: "block" },
        ...turn.context.getMessages(),
      ]);
    });
    const [down, up] = await runTest(processorFor(p), { framesToSend: [frame] });
    expect(down).toEqual([frame]);
    expect(up).toEqual([]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.metadata).toBe(frame.metadata);
    expect(turns[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(frame.context.getMessages()).toEqual([
      { role: "system", content: "block" },
      { role: "user", content: "你好" },
    ]);
  });

  test("a provider error goes upstream as an ErrorFrame and the frame still goes down", async () => {
    const frame = contextFrame("hi");
    const p = provider("StreamArchiveService", async () => {
      throw new Error("boom");
    });
    const [down, up] = await runTest(processorFor(p), { framesToSend: [frame] });
    expect(down).toEqual([frame]);
    expect(up).toHaveLength(1);
    expect(up[0]).toBeInstanceOf(ErrorFrame);
    expect((up[0] as ErrorFrame).error).toBe("StreamArchiveService error: boom");
    expect(((up[0] as ErrorFrame).exception as Error).message).toBe("boom");
    expect(logs.messages("ERROR")).toEqual([
      expect.stringMatching(
        /^StreamArchiveService#\d+ exception: StreamArchiveService error: boom$/,
      ),
    ]);
  });

  test("other frames pass in their own direction, untouched", async () => {
    let calls = 0;
    const p = provider("PersonaFactsService", async () => {
      calls++;
    });
    const text = new TextFrame({ text: "x" });
    const [, up] = await runTest(processorFor(p), {
      framesToSend: [text],
      framesToSendDirection: FrameDirection.UPSTREAM,
    });
    expect(up).toEqual([text]);
    const down = new TextFrame({ text: "y" });
    const [received] = await runTest(processorFor(p), { framesToSend: [down] });
    expect(received).toEqual([down]);
    expect(calls).toBe(0);
  });

  test("an interruption aborts the turn's signal and drops the frame, with no ErrorFrame", async () => {
    const started = deferred<AbortSignal>();
    const aborted = deferred<unknown>();
    const p = provider("PersonaFactsService", (turn) => {
      started.resolve(turn.signal);
      return new Promise((_, reject) => {
        turn.signal.addEventListener("abort", () => {
          aborted.resolve(turn.signal.reason);
          reject(turn.signal.reason);
        });
      });
    });
    const frame = contextFrame("hi");
    const [down, up] = await runTest(processorFor(p), {
      framesToSend: [frame, new SleepFrame({ sleep: 0.05 }), new InterruptionFrame()],
    });
    expect((await started.promise).aborted).toBe(true);
    expect(await aborted.promise).toBeInstanceOf(CancelledError);
    expect(down.filter((f) => f instanceof LLMContextFrame)).toEqual([]);
    expect(up.filter((f) => f instanceof ErrorFrame)).toEqual([]);
  });

  test("a provider that ignores its signal still cancels inside pipedog's timeout", async () => {
    const p = provider("StreamArchiveService", () => new Promise<void>(() => {}));
    const [down] = await runTest(processorFor(p), {
      framesToSend: [contextFrame("hi"), new SleepFrame({ sleep: 0.05 }), new InterruptionFrame()],
    });
    expect(down.filter((f) => f instanceof LLMContextFrame)).toEqual([]);
    expect(logs.messages("WARNING").filter((m) => m.includes("timed out waiting"))).toEqual([]);
  });

  test("spawn runs past the turn, outside its signal, and its failures are logged", async () => {
    const finished = deferred<{ signal: AbortSignal | undefined }>();
    let turnSignal: AbortSignal | undefined;
    const p = provider("LaplaceMem0MemoryService", async (turn) => {
      turnSignal = turn.signal;
      turn.spawn("mem0_store", async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished.resolve({ signal: currentTask()?.signal });
      });
      turn.spawn("mem0_store", async () => {
        throw new Error("store failed");
      });
    });
    await runTest(processorFor(p), { framesToSend: [contextFrame("hi")] });
    const job = await finished.promise;
    expect(job.signal).toBeDefined();
    expect(job.signal).not.toBe(turnSignal);
    await until(() => logs.messages("ERROR").some((m) => m.includes("store failed")));
    expect(logs.messages("ERROR")).toContainEqual(
      expect.stringMatching(
        /^LaplaceMem0MemoryService#\d+::mem0_store unexpected exception: store failed$/,
      ),
    );
  });
});

describe("RetrievalGateProcessor", () => {
  test("attaches to every context frame and keeps every frame's direction", async () => {
    const seen: { messages: readonly unknown[]; metadata: FrameMetadata }[] = [];
    const gate = {
      attach(messages: readonly unknown[], metadata: FrameMetadata) {
        seen.push({ messages, metadata });
        metadata[GATE] = "decision";
      },
    };
    const first = contextFrame("我今天加班好累啊。");
    const second = contextFrame("我今天加班好累啊。");
    const [down] = await runTest(new RetrievalGateProcessor(gate), {
      framesToSend: [first, new TextFrame({ text: "t" }), second],
    });
    expect(down.map((f) => f.constructor.name)).toEqual([
      "LLMContextFrame",
      "TextFrame",
      "LLMContextFrame",
    ]);
    expect(seen.map((s) => s.metadata)).toEqual([first.metadata, second.metadata]);
    expect(seen[0]?.messages).toBe(first.context.getMessages());
    expect(first.metadata[GATE]).toBe("decision");

    const upward = new TextFrame({ text: "u" });
    const [, up] = await runTest(new RetrievalGateProcessor(gate), {
      framesToSend: [upward],
      framesToSendDirection: FrameDirection.UPSTREAM,
    });
    expect(up).toEqual([upward]);
  });
});

describe("gate → archive → facts through the adapters", () => {
  const SKIP = { verdict: false };
  const RETRIEVE = { verdict: true };

  function chain(searches: { tier: string; query: string }[]) {
    const gate = {
      attach(messages: readonly unknown[], metadata: FrameMetadata) {
        const last = messages.at(-1) as { content: string };
        metadata[GATE] = last.content.endsWith("？") ? RETRIEVE : SKIP;
      },
    };
    const tier = (label: string) =>
      provider(label, async ({ context, metadata }) => {
        if (metadata[GATE] === SKIP) return;
        if (label === "PersonaFactsService" && metadata[OVERVIEW]) return;
        const last = context.getMessages().at(-1) as { content: string };
        searches.push({ tier: label, query: last.content });
        if (label === "StreamArchiveService" && last.content.includes("上周")) {
          metadata[OVERVIEW] = true;
        }
      });
    const processors: FrameProcessor[] = [
      new RetrievalGateProcessor(gate),
      processorFor(tier("StreamArchiveService")),
      processorFor(tier("PersonaFactsService")),
    ];
    return new Pipeline(processors);
  }

  test("a skipped turn searches neither tier; a retrieved one searches both", async () => {
    const searches: { tier: string; query: string }[] = [];
    const [down] = await runTest(chain(searches), {
      framesToSend: [contextFrame("我今天加班好累啊。"), contextFrame("你最喜欢吃什么呀？")],
    });
    expect(down).toHaveLength(2);
    expect(searches).toEqual([
      { tier: "StreamArchiveService", query: "你最喜欢吃什么呀？" },
      { tier: "PersonaFactsService", query: "你最喜欢吃什么呀？" },
    ]);
  });

  test("an archive recap reaches facts through the same frame's metadata", async () => {
    const searches: { tier: string; query: string }[] = [];
    const recap = contextFrame("上周播了什么？");
    const [down] = await runTest(chain(searches), {
      framesToSend: [recap, contextFrame("What is your favorite food？")],
    });
    expect((down as Frame[])[0]).toBe(recap);
    expect(recap.metadata[OVERVIEW]).toBe(true);
    expect(searches).toEqual([
      { tier: "StreamArchiveService", query: "上周播了什么？" },
      { tier: "StreamArchiveService", query: "What is your favorite food？" },
      { tier: "PersonaFactsService", query: "What is your favorite food？" },
    ]);
  });
});
