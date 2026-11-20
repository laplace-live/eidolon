// A task's context in its requests: old results masked, the rest compacted into a summary past
// the context's threshold, and a provider's overflow compacted and retried.
import { ProviderHttpError } from "@eidolon/providers";
import { describe, expect, test } from "vitest";
import type { TaskEntryDraft, TaskEvent, TaskTool } from "../src/task.ts";
import type { MindChunk, MindRequest } from "../src/types.ts";
import {
  BRIEF,
  call,
  calls,
  drain,
  FakeMeter,
  MemoryStore,
  result,
  ScriptedMind,
  SUMMARY_SYSTEM,
  says,
  storedResults,
  taskRequest,
  tool,
  toolMessages,
} from "./task-fakes.ts";

const SUMMARY_OPENING =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";

/** A read whose result is `size` characters, and which reports the file it read. */
function reader(size: number): TaskTool {
  return tool("read", async (args) =>
    result("x".repeat(size), { files: { read: [`/tmp/todo/${String(args.value)}.txt`] } }),
  );
}

/** A turn reading each of `values` in order, then `final`. */
function reads(values: readonly string[], final = "done"): MindChunk[][] {
  return [...values.map((value) => calls([call(`c-${value}`, "read", { value })])), says(final)];
}

function opening(request: MindRequest | undefined): string {
  const first = request?.messages[0] as { content?: unknown } | undefined;
  return String(first?.content);
}

function stub(value: string, size: number): string {
  return (
    `[Result elided to save context: read {"value":"${value}"} returned ${size} characters. ` +
    "Run it again if you need them.]"
  );
}

describe("masking", () => {
  test("stubs results older than the newest maskAfterTokens, in the request only", async () => {
    const mind = new ScriptedMind(reads(["a", "b"]));
    const request = taskRequest(mind, {
      tools: [reader(2000)],
      limits: { contextTokens: 128_000, spendPauseUsd: 0, maskAfterTokens: 100 },
    });
    await drain(request);
    expect(toolMessages(mind.requests[1])).toEqual([["c-a", "x".repeat(2000)]]);
    expect(toolMessages(mind.requests[2])).toEqual([
      ["c-a", stub("a", 2000)],
      ["c-b", "x".repeat(2000)],
    ]);
    expect(storedResults(request.store)).toEqual([
      ["c-a", "x".repeat(2000)],
      ["c-b", "x".repeat(2000)],
    ]);
  });

  test("stubs nothing within the default 40,000 tokens", async () => {
    const mind = new ScriptedMind(reads(["a", "b", "c"]));
    await drain(taskRequest(mind, { tools: [reader(40_000)] }));
    expect(toolMessages(mind.requests[3]).map(([, content]) => content.length)).toEqual([
      40_000, 40_000, 40_000,
    ]);
  });

  test("leaves a result shorter than its stub whole", async () => {
    const mind = new ScriptedMind(reads(["a", "b"]));
    await drain(
      taskRequest(mind, {
        tools: [reader(10)],
        limits: { contextTokens: 128_000, spendPauseUsd: 0, maskAfterTokens: 0 },
      }),
    );
    expect(toolMessages(mind.requests[2])).toEqual([
      ["c-a", "x".repeat(10)],
      ["c-b", "x".repeat(10)],
    ]);
  });

  test("moves its boundary a step at a time, so most requests only add to the one before", async () => {
    // Each result is 2,000 tokens: the boundary steps 20,000 at a time, every ten turns.
    const values = Array.from({ length: 60 }, (_, n) => `n${n}`);
    const mind = new ScriptedMind(reads(values));
    await drain(taskRequest(mind, { tools: [reader(8_000)] }));
    const sent = mind.requests.map((request) => request.messages.map((m) => JSON.stringify(m)));
    const edited = sent.filter((messages, at) =>
      (sent[at - 1] ?? []).some((message, i) => messages[i] !== message),
    );
    expect(edited.length).toBeGreaterThan(0);
    expect(edited.length).toBeLessThanOrEqual(5);
    const whole = toolMessages(mind.requests.at(-1)).filter(
      ([, content]) => content.length === 8_000,
    );
    expect(whole.length).toBeGreaterThanOrEqual(10);
    expect(whole.length).toBeLessThanOrEqual(20);
    expect(mind.summaryRequests).toHaveLength(0);
  });

  test("counts a Chinese character as a token, so masking holds the context to its budget", async () => {
    const han = /\p{Script=Han}/gu;
    const meter = new FakeMeter();
    const counted: number[] = [];
    // The provider's count: a token a Chinese character, as Claude's tokenizer comes close to.
    const mind = new ScriptedMind(reads(Array.from({ length: 25 }, (_, n) => `n${n}`)), {
      after: (request) => {
        const text = request.system + JSON.stringify(request.messages);
        const chinese = text.match(han)?.length ?? 0;
        meter.input = chinese + Math.ceil((text.length - chinese) / 4);
        counted.push(meter.input);
      },
    });
    const notes = "我们今天把笔记整理一下这个项目的目标是让助手帮主人处理文件并且汇报结果";
    const read = tool("read", async () => result(notes.repeat(300).slice(0, 10_000)));
    await drain(taskRequest(mind, { tools: [read], meter }));
    expect(mind.summaryRequests).toHaveLength(0);
    expect(Math.max(...counted)).toBeLessThan(70_000);
  });

  test("keeps a context that fits once masked from compacting", async () => {
    // 50,000 tokens before it compacts: the six results, 10,000 each, fit only once masked.
    const mind = new ScriptedMind(reads(["a", "b", "c", "d", "e", "f"]));
    await drain(
      taskRequest(mind, {
        tools: [reader(40_000)],
        limits: { contextTokens: 66_384, spendPauseUsd: 0 },
      }),
    );
    expect(mind.summaryRequests).toHaveLength(0);
    const sent = toolMessages(mind.requests[6]);
    expect(sent.slice(0, 3)).toEqual([
      ["c-a", stub("a", 40_000)],
      ["c-b", stub("b", 40_000)],
      ["c-c", stub("c", 40_000)],
    ]);
    expect(sent.slice(3).map(([, content]) => content.length)).toEqual([40_000, 40_000, 40_000]);
  });

  test("never keeps more than the newest 40,000 tokens whole, so a smaller window masks before it compacts", async () => {
    for (const contextTokens of [61_440, 65_536, 73_728, 77_824]) {
      const values = Array.from({ length: 60 }, (_, n) => `n${n}`);
      const mind = new ScriptedMind(reads(values), {
        summaries: values.map(() => says("SUMMARY")),
      });
      const request = taskRequest(mind, {
        // About the worker's prompt and tool schemas: 1,600 tokens.
        system: "S".repeat(6_400),
        tools: [reader(8_000)],
        limits: { contextTokens, spendPauseUsd: 0 },
      });
      const { outcome } = await drain(request);
      expect([contextTokens, outcome, mind.summaryRequests.length]).toEqual([
        contextTokens,
        { status: "succeeded", report: "done" },
        0,
      ]);
      for (const sent of mind.requests) {
        const whole = toolMessages(sent).filter(([, content]) => content.length === 8_000);
        expect(whole.length).toBeLessThanOrEqual(20);
      }
    }
  });
});

describe("compaction", () => {
  // 50,000 tokens before it compacts, and the newest 20,000 kept: each result is 10,000.
  const limits = { contextTokens: 66_384, spendPauseUsd: 0, maskAfterTokens: 1e9 };

  test("past its threshold, summarizes all but the newest ~20,000 tokens, kept whole", async () => {
    const mind = new ScriptedMind(reads(["a", "b", "c", "d", "e", "f", "g", "h"]), {
      summaries: [says("SUMMARY-1"), says("SUMMARY-2")],
    });
    const request = taskRequest(mind, { tools: [reader(40_000)], limits });
    const { events, outcome } = await drain(request);
    expect(outcome).toEqual({ status: "succeeded", report: "done" });
    expect(mind.summaryRequests).toHaveLength(2);

    const [first, second] = request.store.of("compaction");
    const keptFirst = request.store.of("assistant")[3];
    expect(first).toMatchObject({
      summary: "SUMMARY-1",
      firstKeptSeq: keptFirst?.seq,
      files: {
        read: ["/tmp/todo/a.txt", "/tmp/todo/b.txt", "/tmp/todo/c.txt"],
        written: [],
      },
    });
    expect(first?.tokensBefore).toBeGreaterThan(50_000);

    const asked = mind.summaryRequests[0];
    expect(asked?.system).toBe(SUMMARY_SYSTEM);
    expect(asked?.tools).toEqual([]);
    expect(asked?.messages).toHaveLength(1);
    const prompt = opening(asked);
    expect(prompt).toStartWith("<conversation>\n[User]: Goal: Write a TodoMVC");
    expect(prompt).toContain('[Assistant tool calls]: read(value="c")');
    expect(prompt).toContain(
      `[Tool result]: ${"x".repeat(2000)}\n\n[... 38000 more characters truncated]`,
    );
    expect(prompt).not.toContain('read(value="d")');
    expect(prompt).not.toContain("<previous-summary>");
    expect(prompt).toEndWith(
      "</conversation>\n\n<read-files>\n/tmp/todo/a.txt\n/tmp/todo/b.txt\n/tmp/todo/c.txt\n" +
        "</read-files>\n\nSummarize the task so far.",
    );

    const after = mind.requests[5];
    expect(opening(after)).toBe(
      `${SUMMARY_OPENING}SUMMARY-1\n\n<read-files>\n/tmp/todo/a.txt\n/tmp/todo/b.txt\n` +
        "/tmp/todo/c.txt\n</read-files>\n</summary>",
    );
    expect(after?.messages.slice(1)).toEqual([
      {
        role: "assistant",
        tool_calls: [
          { id: "c-d", type: "function", function: { name: "read", arguments: '{"value":"d"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c-d", content: "x".repeat(40_000) },
      {
        role: "assistant",
        tool_calls: [
          { id: "c-e", type: "function", function: { name: "read", arguments: '{"value":"e"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c-e", content: "x".repeat(40_000) },
    ]);

    expect(second).toMatchObject({ summary: "SUMMARY-2" });
    expect(second?.files.read).toHaveLength(6);
    expect(opening(mind.summaryRequests[1])).toContain(
      "<previous-summary>\nSUMMARY-1\n</previous-summary>",
    );
    expect(opening(mind.requests[8])).toStartWith(`${SUMMARY_OPENING}SUMMARY-2`);
    expect(toolMessages(mind.requests[8]).map(([id]) => id)).toEqual(["c-g", "c-h"]);
    expect(events.filter((event) => event.type === "request")).toHaveLength(18);
  });

  test("leaves a small window room to work: a short task in 8,192 or 16,384 tokens never compacts", async () => {
    for (const contextTokens of [8_192, 16_384]) {
      const mind = new ScriptedMind(reads(["a", "b", "c", "d"]), {
        summaries: [says("SUMMARY"), says("SUMMARY"), says("SUMMARY"), says("SUMMARY")],
      });
      const request = taskRequest(mind, {
        // About the worker's prompt and tool schemas: 1,600 tokens.
        system: "S".repeat(6_400),
        tools: [reader(400)],
        limits: { contextTokens, spendPauseUsd: 0 },
      });
      const { outcome } = await drain(request);
      expect([contextTokens, outcome, mind.summaryRequests.length]).toEqual([
        contextTokens,
        { status: "succeeded", report: "done" },
        0,
      ]);
      expect(opening(mind.requests.at(-1))).toStartWith("Goal: Write a TodoMVC");
    }
  });

  test("goes by the provider's count of the last request, when it reports one", async () => {
    // 1,001 tokens before it compacts, a quarter of the window left for the reply.
    const tight = { contextTokens: 1_334, spendPauseUsd: 0, maskAfterTokens: 1e9 };
    const estimated = new ScriptedMind(reads(["a", "b", "c", "d"]), {
      summaries: [says("SUMMARY")],
    });
    await drain(taskRequest(estimated, { tools: [reader(1000)], limits: tight }));
    const counted = new FakeMeter();
    const reported = new ScriptedMind(reads(["a", "b", "c", "d"]), {
      summaries: [says("SUMMARY")],
      after: () => {
        counted.input = 5000;
      },
    });
    await drain(taskRequest(reported, { tools: [reader(1000)], limits: tight, meter: counted }));
    const compactedBefore = (mind: ScriptedMind) =>
      mind.requests.findIndex((request) => opening(request).startsWith(SUMMARY_OPENING));
    expect(compactedBefore(estimated)).toBe(4);
    expect(compactedBefore(reported)).toBe(2);
  });

  test("a summary the output limit cut off fails the task, never standing in for the context", async () => {
    const mind = new ScriptedMind(reads(["a", "b", "c", "d", "e"]), {
      summaries: [
        [
          { type: "text", text: "## Goal\nWrite a TodoMVC\n## Progr" },
          { type: "done", finishReason: "length" },
        ],
      ],
    });
    const request = taskRequest(mind, { tools: [reader(40_000)], limits });
    expect((await drain(request)).outcome).toEqual({
      status: "failed",
      error: "Compaction failed. The model's reply was cut off at its output limit",
    });
    expect(request.store.of("compaction")).toHaveLength(0);
  });

  test("a summary request that fails fails the task", async () => {
    const mind = new ScriptedMind(reads(["a", "b", "c", "d", "e"]), {
      summaries: [says("  ")],
    });
    const request = taskRequest(mind, { tools: [reader(40_000)], limits });
    expect((await drain(request)).outcome).toEqual({
      status: "failed",
      error: "Compaction returned no summary",
    });
    expect(request.store.of("compaction")).toHaveLength(0);
  });
});

describe("a context overflow", () => {
  const overflow = () =>
    new ProviderHttpError("anthropic", 400, "prompt is too long: 213462 tokens > 200000 maximum");

  /** A task three big reads in, as a restart left it. */
  function history(): MemoryStore {
    const drafts: TaskEntryDraft[] = [{ type: "brief", brief: BRIEF }];
    for (const value of ["a", "b", "c"]) {
      drafts.push(
        { type: "assistant", text: "", calls: [call(`c-${value}`, "read", { value })] },
        { type: "tool-start", callId: `c-${value}`, name: "read" },
        {
          type: "tool-result",
          callId: `c-${value}`,
          name: "read",
          content: "x".repeat(40_000),
          isError: false,
          files: { read: [`/tmp/todo/${value}.txt`] },
        },
      );
    }
    return new MemoryStore(...drafts);
  }

  test("compacts once and retries", async () => {
    const mind = new ScriptedMind([overflow(), says("done")], { summaries: [says("SUMMARY")] });
    const request = taskRequest(mind, { store: history(), tools: [reader(10)] });
    const { events, outcome } = await drain(request);
    expect(outcome).toEqual({ status: "succeeded", report: "done" });
    const labels = events.flatMap((event: TaskEvent) => {
      if (event.type === "request") return [`request:${event.state}${event.error ? ":error" : ""}`];
      return event.type === "entry" ? [`entry:${event.entry.type}`] : [];
    });
    expect(labels).toEqual([
      "entry:resume",
      "request:start",
      "request:end:error",
      "entry:compaction",
      "request:start",
      "request:end",
      "entry:assistant",
      "entry:end",
    ]);
    expect(events.find((event) => event.type === "request" && event.error)).not.toHaveProperty(
      "retryInMs",
    );
    expect(request.store.of("compaction")).toMatchObject([
      { summary: "SUMMARY", files: { read: ["/tmp/todo/a.txt"], written: [] } },
    ]);
    expect(opening(mind.requests[1])).toStartWith(`${SUMMARY_OPENING}SUMMARY`);
    expect(toolMessages(mind.requests[1]).map(([id]) => id)).toEqual(["c-b", "c-c"]);
  });

  test("fails the task when the retry overflows too", async () => {
    const mind = new ScriptedMind([overflow(), overflow()], { summaries: [says("SUMMARY")] });
    const { outcome } = await drain(taskRequest(mind, { store: history() }));
    expect(outcome).toEqual({
      status: "failed",
      error: "anthropic answered 400: prompt is too long: 213462 tokens > 200000 maximum",
    });
    expect(mind.summaryRequests).toHaveLength(1);
  });

  test("fails the task when there is nothing to compact", async () => {
    const mind = new ScriptedMind([overflow()]);
    const { outcome } = await drain(taskRequest(mind));
    expect(outcome).toMatchObject({ status: "failed" });
    expect(mind.summaryRequests).toHaveLength(0);
    expect(mind.requests).toHaveLength(1);
  });
});
