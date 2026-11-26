// A task's meter, which its runner and the loop share: the spend its mind's usage records add up
// to, and the pause before the next request once a request couldn't be counted.
import { consoleSink, type LogRecord, logger } from "@eidolon/config";
import { ProviderHttpError, type UsageRecord } from "@eidolon/providers";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { estimateTokens } from "../src/task/context.ts";
import { type TaskEntryDraft, UsageMeter } from "../src/task.ts";
import type { MindChunk } from "../src/types.ts";
import {
  BRIEF,
  call,
  calls,
  drain,
  FakeMeter,
  MemoryStore,
  result,
  type Script,
  ScriptedMind,
  says,
  storedResults,
  taskRequest,
  tool,
} from "./task-fakes.ts";

const UNPRICED = "No price is known for test/model at openrouter";
const UNREPORTED = "No usage was reported for test/model at openrouter";

/** The unpriced pause's detail, with spend pauses at every $1. */
const detail = (why: string): string =>
  `${why}, so its spend can't count toward the pause at every $1.00.`;

/** A request's usage as createMind's tap hands it on; a null cost is one no price was known for. */
function record(
  costUsd: number | null,
  units: UsageRecord["units"] = { inputTokens: 100 },
): UsageRecord {
  return {
    role: "assistant",
    provider: "openrouter",
    model: "test/model",
    units,
    category: "llm",
    at: 0,
    source: "task",
    session: "task-1",
    costUsd,
    costSource: costUsd === null ? "unpriced" : "reported",
  };
}

function meter(spentUsd = 0): UsageMeter {
  return new UsageMeter({ account: "openrouter", model: "test/model", spentUsd });
}

/** A mind answering `scripts`, each request reporting `costUsd` to `counted`; "none" reports nothing. */
function billed(
  counted: UsageMeter,
  costUsd: number | null | "none",
  scripts: readonly Script[],
  summaries: readonly Script[] = [],
): ScriptedMind {
  return new ScriptedMind(scripts, {
    summaries,
    after: () => {
      if (costUsd !== "none") counted.tap(record(costUsd));
    },
  });
}

/** A task several reads in, as a restart left it. */
function history(turns: readonly string[] = ["a", "b", "c"], chars = 40_000): MemoryStore {
  const drafts: TaskEntryDraft[] = [{ type: "brief", brief: BRIEF }];
  for (const value of turns) {
    drafts.push(
      { type: "assistant", text: "", calls: [call(`c-${value}`, "read", { value })] },
      { type: "tool-start", callId: `c-${value}`, name: "read" },
      {
        type: "tool-result",
        callId: `c-${value}`,
        name: "read",
        content: "x".repeat(chars),
        isError: false,
      },
    );
  }
  return new MemoryStore(...drafts);
}

const overflow = () =>
  new ProviderHttpError("anthropic", 400, "prompt is too long: 213462 tokens > 200000 maximum");

let logs: LogRecord[] = [];

beforeEach(() => {
  logs = [];
  logger.setSink((entry) => logs.push(entry));
});

afterEach(() => {
  logger.setSink(consoleSink);
});

const warnings = (): string[] =>
  logs.filter((entry) => entry.level === "WARNING").map((entry) => entry.message);

describe("UsageMeter", () => {
  test("sums the records' costs from where the task stood, and warns once of one it can't price", () => {
    const counted = meter(0.5);
    counted.tap(record(0.25));
    counted.tap(record(null));
    counted.tap(record(null));
    counted.tap({ ...record(0.1), costSource: "estimated" });
    expect(counted.spentUsd()).toBeCloseTo(0.85, 10);
    expect(counted.unpriced()).toBe(UNPRICED);
    expect(warnings()).toEqual([`${UNPRICED}, so the task's spend pauses can't count it`]);
  });

  test("counts the last request's whole input, what its provider cached included, plus output tokens", () => {
    const counted = meter();
    expect([counted.lastInputTokens(), counted.lastOutputTokens()]).toEqual([null, null]);
    counted.tap(record(0, { inputTokens: 300, cachedTokens: 9000, cacheWriteTokens: 700 }));
    expect([counted.lastInputTokens(), counted.lastOutputTokens()]).toEqual([10_000, null]);
    counted.tap(record(0, { inputTokens: 40, outputTokens: 5 }));
    expect([counted.lastInputTokens(), counted.lastOutputTokens()]).toEqual([40, 5]);
    counted.tap(record(0, { outputTokens: 5 }));
    expect([counted.lastInputTokens(), counted.lastOutputTokens()]).toEqual([null, 5]);
  });

  test("requestStarted clears per-attempt input, output, and record count without losing spend", () => {
    const counted = meter(0.5);
    counted.tap(record(0.25, { inputTokens: 1_000, outputTokens: 500 }));
    counted.requestStarted();
    expect([counted.lastInputTokens(), counted.lastOutputTokens()]).toEqual([null, null]);
    counted.requestEnded();
    expect(counted.unpriced()).toBe(UNREPORTED);
    expect(counted.spentUsd()).toBeCloseTo(0.75, 10);
  });

  test("a request that ended with no usage record is one it can't count, its input unknown", () => {
    const counted = meter(0.5);
    counted.tap(record(0.25, { inputTokens: 40, outputTokens: 12 }));
    counted.requestEnded();
    expect([counted.unpriced(), counted.lastInputTokens(), counted.lastOutputTokens()]).toEqual([
      null,
      40,
      12,
    ]);
    // A server that ignores stream_options.include_usage.
    counted.requestEnded();
    expect([counted.unpriced(), counted.lastInputTokens(), counted.lastOutputTokens()]).toEqual([
      UNREPORTED,
      null,
      null,
    ]);
    // The first it couldn't count says why.
    counted.tap(record(null));
    counted.requestEnded();
    counted.requestEnded();
    expect(counted.unpriced()).toBe(UNREPORTED);
    expect(counted.spentUsd()).toBeCloseTo(0.75, 10);
    expect(warnings()).toEqual([`${UNREPORTED}, so the task's spend pauses can't count it`]);
  });

  test("counts every request a priced model reports", () => {
    const counted = meter();
    for (const cost of [0.01, 0, 0.02]) {
      counted.tap(record(cost));
      counted.requestEnded();
    }
    expect(counted.unpriced()).toBeNull();
    expect(counted.spentUsd()).toBeCloseTo(0.03, 10);
    expect(warnings()).toEqual([]);
  });

  /** A web search's record, as its searcher hands it to the meter's charge. */
  const search = (costUsd: number | null): UsageRecord => ({
    ...record(costUsd, { inputTokens: 1668, outputTokens: 186, searches: 1 }),
    role: "search",
    category: "search",
    model: "exa",
  });

  test("a charge adds to the spend and leaves the context's size alone", () => {
    const counted = meter(0.5);
    counted.tap(record(0.25, { inputTokens: 40_000 }));
    counted.charge(search(0.0073));
    expect(counted.spentUsd()).toBeCloseTo(0.7573, 10);
    expect(counted.lastInputTokens()).toBe(40_000);
    expect(counted.unpriced()).toBeNull();
  });

  test("a charge with no cost makes the task's spend uncountable, naming what it couldn't price", () => {
    const counted = meter();
    counted.charge(search(null));
    expect(counted.unpriced()).toBe("No price is known for exa at openrouter");
    expect(counted.spentUsd()).toBe(0);
  });

  test("a request outside its mind's that came back with no usage, a review's, can't be counted", () => {
    const counted = meter();
    counted.charge(record(0.01, { inputTokens: 900 }));
    expect(counted.unpriced()).toBeNull();
    counted.unreported();
    expect(counted.unpriced()).toBe(UNREPORTED);
    expect(counted.spentUsd()).toBeCloseTo(0.01, 10);
  });

  test("a charge between requests doesn't stand for a request that reported no usage", () => {
    const counted = meter();
    counted.tap(record(0.01, { inputTokens: 900 }));
    counted.requestEnded();
    // A search runs among the reply's calls, then the next request reports nothing.
    counted.charge(search(0.0073));
    counted.requestEnded();
    expect(counted.unpriced()).toBe(UNREPORTED);
    expect(counted.lastInputTokens()).toBeNull();
    expect(counted.spentUsd()).toBeCloseTo(0.0173, 10);
  });
});

describe("runTask's unpriced pause", () => {
  const limits = { contextTokens: 128_000, spendPauseUsd: 1 };
  const count = tool("count", async (args) => result(`counted ${String(args.n)}`), {
    properties: { n: { type: "number" } },
    required: ["n"],
  });

  test("comes before the request after one with no price, whatever that reply's calls did", async () => {
    const replies: Record<string, readonly MindChunk[]> = {
      "a call that ran": calls([call("c1", "count", { n: 1 })]),
      "a call to an unknown tool": calls([call("c1", "nope")]),
      "a call with invalid arguments": calls([call("c1", "count", { label: "x" })]),
      "a call whose arguments aren't JSON": [
        {
          type: "tool-calls",
          calls: [{ id: "c1", name: "count", arguments: {}, unparsed: "{n:" }],
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      "a call the output limit cut off": [
        {
          type: "tool-calls",
          calls: [{ id: "c1", name: "count", arguments: {}, unparsed: '{"n' }],
        },
        { type: "done", finishReason: "length" },
      ],
    };
    for (const [made, reply] of Object.entries(replies)) {
      const counted = meter();
      const mind = billed(counted, null, [reply, says("Never asked.")]);
      const request = taskRequest(mind, { tools: [count], meter: counted, limits });
      const { outcome } = await drain(request);
      expect([made, outcome]).toEqual([
        made,
        { status: "paused", reason: "unpriced", detail: detail(UNPRICED) },
      ]);
      expect([made, mind.requests.length]).toEqual([made, 1]);
      expect([made, request.store.types().slice(-2)]).toEqual([made, ["tool-result", "pause"]]);
      expect(request.store.list.at(-1)).toMatchObject({
        type: "pause",
        reason: "unpriced",
        detail: detail(UNPRICED),
      });
    }
  });

  test("comes the same way after a request that ended with no usage record", async () => {
    const counted = meter();
    const mind = billed(counted, "none", [
      calls([call("c1", "count", { n: 1 })]),
      says("Never asked."),
    ]);
    const request = taskRequest(mind, { tools: [count], meter: counted, limits });
    expect((await drain(request)).outcome).toEqual({
      status: "paused",
      reason: "unpriced",
      detail: detail(UNREPORTED),
    });
    expect(mind.requests).toHaveLength(1);
    expect(storedResults(request.store)).toEqual([["c1", "counted 1"]]);
  });

  test("never comes on a priced model, though an attempt that failed reported nothing", async () => {
    const counted = meter();
    const paid =
      (reply: readonly MindChunk[]): Script =>
      () => {
        counted.tap(record(0.001));
        return reply;
      };
    const mind = new ScriptedMind([
      paid(calls([call("c1", "nope")])),
      // No finish reason: a failed attempt, retried, with no usage of its own.
      [{ type: "text", text: "Counting" }],
      paid(calls([call("c2", "count", { n: 2 })])),
      paid(says("Counted.")),
    ]);
    const request = taskRequest(mind, {
      tools: [count],
      meter: counted,
      limits,
      sleep: async () => {},
    });
    expect((await drain(request)).outcome).toEqual({ status: "succeeded", report: "Counted." });
    expect(mind.requests).toHaveLength(4);
    expect(counted.unpriced()).toBeNull();
    expect(request.store.of("pause")).toEqual([]);
  });

  test("never comes with spend pauses off", async () => {
    const counted = meter();
    const mind = billed(counted, null, [calls([call("c1", "count", { n: 1 })]), says("Counted.")]);
    const request = taskRequest(mind, { tools: [count], meter: counted });
    expect((await drain(request)).outcome).toEqual({ status: "succeeded", report: "Counted." });
    expect(counted.unpriced()).toBe(UNPRICED);
  });

  test("a compaction counts as a request: one it couldn't count pauses before the turn's own", async () => {
    const counted = meter();
    // 22,500 tokens before it compacts: the three results, 10,000 each, are past it.
    const tight = { contextTokens: 30_000, spendPauseUsd: 1, maskAfterTokens: 1e9 };
    const mind = new ScriptedMind([says("done")], { summaries: [says("SUMMARY")] });
    const request = taskRequest(mind, {
      store: history(),
      tools: [tool("read")],
      meter: counted,
      limits: tight,
    });
    expect((await drain(request)).outcome).toEqual({
      status: "paused",
      reason: "unpriced",
      detail: detail(UNREPORTED),
    });
    expect([mind.summaryRequests.length, mind.requests.length]).toEqual([1, 0]);
    expect(request.store.types().slice(-3)).toEqual(["resume", "compaction", "pause"]);

    // Gone on with no spend pauses: the summary stands, and the turn's request goes.
    const { outcome } = await drain({ ...request, limits: { ...tight, spendPauseUsd: 0 } });
    expect(outcome).toEqual({ status: "succeeded", report: "done" });
    expect([mind.summaryRequests.length, mind.requests.length]).toEqual([1, 1]);

    // A summary an overflow called for, before the request is sent again.
    const again = meter();
    const overflowed = new ScriptedMind([overflow(), says("done")], {
      summaries: [says("SUMMARY")],
    });
    const retried = taskRequest(overflowed, {
      store: history(),
      tools: [tool("read")],
      meter: again,
      limits,
    });
    expect((await drain(retried)).outcome).toEqual({
      status: "paused",
      reason: "unpriced",
      detail: detail(UNREPORTED),
    });
    expect([overflowed.requests.length, overflowed.summaryRequests.length]).toEqual([1, 1]);
  });

  test("a summary whose cost reaches the spend pause pauses before the turn's request too", async () => {
    const spending = new FakeMeter();
    const mind = new ScriptedMind([says("done")], {
      summaries: [says("SUMMARY")],
      after: () => {
        spending.spent += 1;
      },
    });
    const request = taskRequest(mind, {
      store: history(),
      tools: [tool("read")],
      meter: spending,
      limits: { contextTokens: 30_000, spendPauseUsd: 1, maskAfterTokens: 1e9 },
    });
    expect((await drain(request)).outcome).toEqual({
      status: "paused",
      reason: "spend",
      detail: "Spent $1.00; it pauses at every $1.00.",
    });
    expect([mind.summaryRequests.length, mind.requests.length]).toEqual([1, 0]);
  });

  test("hears of each request whose reply came back whole, a summary's included, never a failed attempt's", async () => {
    const counted = new FakeMeter();
    const seen: number[] = [];
    const noting =
      (reply: readonly MindChunk[] | Error): Script =>
      () => {
        seen.push(counted.ended);
        if (reply instanceof Error) throw reply;
        return reply;
      };
    const mind = new ScriptedMind(
      [
        noting(overflow()),
        noting(new TypeError("fetch failed")),
        noting([{ type: "text", text: "Rea" }]),
        noting(calls([call("c1", "read")])),
        noting(says("done")),
      ],
      { summaries: [noting(says("SUMMARY"))] },
    );
    const request = taskRequest(mind, {
      store: history(),
      tools: [tool("read")],
      meter: counted,
      sleep: async () => {},
    });
    expect((await drain(request)).outcome).toEqual({ status: "succeeded", report: "done" });
    // The overflow, the summary, a network error, a reply with no finish reason, the calls, the report.
    expect(seen).toEqual([0, 0, 1, 1, 1, 2]);
    expect(counted.ended).toBe(3);
  });

  test("pauses before compacting when a model_context_window_exceeded reply crosses spend pause or goes unpriced", async () => {
    const cut = [
      { type: "text", text: "partial" },
      { type: "done", finishReason: "model_context_window_exceeded" },
    ] satisfies MindChunk[];

    const spend = meter(0.95);
    const overSpend = billed(spend, 0.1, [cut, says("done")], [says("SUMMARY")]);
    const spendOutcome = (
      await drain(
        taskRequest(overSpend, { store: history(), tools: [tool("read")], meter: spend, limits }),
      )
    ).outcome;
    expect(spendOutcome).toEqual({
      status: "paused",
      reason: "spend",
      detail: "Spent $1.05; it pauses at every $1.00.",
    });
    expect(overSpend.summaryRequests).toHaveLength(0);

    const missing = meter();
    const unpriced = billed(missing, "none", [cut, says("done")], [says("SUMMARY")]);
    const unpricedOutcome = (
      await drain(
        taskRequest(unpriced, {
          store: history(),
          tools: [tool("read")],
          meter: missing,
          limits,
        }),
      )
    ).outcome;
    expect(unpricedOutcome).toEqual({
      status: "paused",
      reason: "unpriced",
      detail: detail(UNREPORTED),
    });
    expect(unpriced.summaryRequests).toHaveLength(0);
  });

  test("pauses between summary chunks once the first chunk crosses the spend pause", async () => {
    const drafts: TaskEntryDraft[] = [{ type: "brief", brief: BRIEF }];
    for (let i = 0; i < 60; i++) {
      const id = `c-${i}`;
      drafts.push(
        { type: "assistant", text: "", calls: [call(id, "read", { value: String(i) })] },
        { type: "tool-start", callId: id, name: "read" },
        {
          type: "tool-result",
          callId: id,
          name: "read",
          content: "x".repeat(8_000),
          isError: false,
        },
      );
    }
    const store = new MemoryStore(...drafts);
    const counted = meter(0);
    let summaries = 0;
    const mind = new ScriptedMind([says("done")], {
      summaries: [says("SUMMARY-1"), says("SUMMARY-2"), says("SUMMARY-3")],
      after: (req) => {
        if (req.system === "You summarize.") {
          summaries++;
          counted.tap(record(summaries === 1 ? 1.0 : 0.1));
        }
      },
    });
    const outcome = (
      await drain(
        taskRequest(mind, {
          store,
          tools: [tool("read")],
          meter: counted,
          limits: { contextTokens: 4_096, spendPauseUsd: 1, maskAfterTokens: 1_000 },
        }),
      )
    ).outcome;
    expect(outcome).toEqual({
      status: "paused",
      reason: "spend",
      detail: "Spent $1.00; it pauses at every $1.00.",
    });
    expect(mind.summaryRequests).toHaveLength(1);
    expect(mind.requests).toHaveLength(0);
    expect(store.of("compaction")).toMatchObject([{ summary: "SUMMARY-1" }]);
  });

  test("does not leak outputTokens from a failed attempt into a retry's model_context_window_exceeded ceiling", async () => {
    const counted = meter();
    const reader = tool("read", async () => result("x".repeat(40_000)));
    const cut: readonly MindChunk[] = [
      { type: "text", text: "partial" },
      { type: "done", finishReason: "model_context_window_exceeded" },
    ];
    const mind = new ScriptedMind(
      [
        calls([call("c-a", "read", { value: "a" })]),
        calls([call("c-b", "read", { value: "b" })]),
        () => {
          counted.tap(record(0.01, { inputTokens: 20_000, outputTokens: 20_000 }));
          throw new TypeError("fetch failed");
        },
        cut,
        calls([call("c-c", "read", { value: "c" })]),
        says("done"),
      ],
      {
        summaries: [says("SUMMARY-1"), says("SUMMARY-2")],
        after: (req) => {
          if (req.system === "You summarize.") counted.tap(record(0.01, { inputTokens: 500 }));
        },
      },
    );
    const { outcome } = await drain(
      taskRequest(mind, {
        tools: [reader],
        meter: counted,
        sleep: async () => {},
        limits: { contextTokens: 0, spendPauseUsd: 0, maskAfterTokens: 1e9 },
      }),
    );
    expect(outcome).toEqual({ status: "succeeded", report: "done" });
    // Retry emitted no usage, so #ceiling came from view.sized (~20k) without Attempt 1's 20k
    // output tokens -> compactAbove (~15k) triggers proactive SUMMARY-2 before c-c's follow-up.
    expect(mind.summaryRequests).toHaveLength(2);
  });

  test("persists partial slice summary and offset across spend pauses so continuing finishes the oversized turn without repeating slices", async () => {
    const calls25 = Array.from({ length: 25 }, (_, i) =>
      call(`r-${i}`, "read", { value: `t${i}` }),
    );
    const store = new MemoryStore({ type: "brief", brief: BRIEF });
    const counted = meter(0);
    const sizedReader = tool("read", async (args) => {
      const value = String(args.value);
      const size = value === "keep" ? 20_000 : 2_000;
      return result(`${value}:${"x".repeat(size)}`, {
        files: { read: [`/tmp/todo/${value}.txt`] },
      });
    });
    const mind = new ScriptedMind(
      [
        calls(calls25),
        calls([call("c-keep", "read", { value: "keep" })]),
        new ProviderHttpError("anthropic", 400, "prompt is too long: 16000 tokens > 8192 maximum"),
        says("done"),
      ],
      {
        summaries: Array.from({ length: 10 }, (_, i) => says(`SUMMARY-${i + 1}`)),
        after: (req) => {
          counted.tap(record(req.system === "You summarize." ? 1.0 : 0, {}));
        },
      },
    );
    const req = taskRequest(mind, {
      store,
      tools: [sizedReader],
      meter: counted,
      limits: { contextTokens: 0, spendPauseUsd: 1, maskAfterTokens: 1e9 },
    });

    const p1 = await drain(req);
    expect(p1.outcome).toEqual({
      status: "paused",
      reason: "spend",
      detail: "Spent $1.00; it pauses at every $1.00.",
    });
    const bigTurnSeq = store.of("assistant")[0]?.seq;
    const keepSeq = store.of("assistant")[1]?.seq;
    expect(store.of("compaction").at(-1)).toMatchObject({
      summary: "SUMMARY-1",
      firstKeptSeq: bigTurnSeq,
      learned: { tokens: 8_192, model: "openrouter/test/model" },
    });
    expect(store.of("compaction").at(-1)?.slice).toBeUndefined();

    const p2 = await drain(req);
    expect(p2.outcome).toEqual({
      status: "paused",
      reason: "spend",
      detail: "Spent $2.00; it pauses at every $1.00.",
    });
    const slice1Offset = store.of("compaction").at(-1)?.slice?.offset ?? 0;
    expect(slice1Offset).toBeGreaterThan(0);
    expect(store.of("compaction").at(-1)?.firstKeptSeq).toBe(bigTurnSeq);

    const p3 = await drain(req);
    expect(p3.outcome).toEqual({
      status: "paused",
      reason: "spend",
      detail: "Spent $3.00; it pauses at every $1.00.",
    });
    const slice2Offset = store.of("compaction").at(-1)?.slice?.offset ?? 0;
    expect(slice2Offset).toBeGreaterThan(slice1Offset);
    expect(store.of("compaction").at(-1)?.firstKeptSeq).toBe(bigTurnSeq);

    let final = p3;
    while (final.outcome.status === "paused") final = await drain(req);
    expect(final.outcome).toEqual({ status: "succeeded", report: "done" });
    expect(store.of("compaction").at(-1)?.slice).toBeUndefined();
    expect(store.of("compaction").at(-1)?.firstKeptSeq).toBe(keepSeq);

    const prompts = mind.summaryRequests.map((entry) =>
      String((entry.messages[0] as { content?: string } | undefined)?.content),
    );
    expect(prompts.filter((p) => p.includes("[Tool result]: t0:"))).toHaveLength(1);
    expect(prompts.some((p) => p.includes("[Tool result]: t24:"))).toBe(true);
  });

  test("scopes persisted ceilings to overflow-learned limits on the same model, ignoring configured caps and model switches", async () => {
    // Part A: compaction under a configured cap (30_000) does not restrict a later unlimited resume.
    const configStore = history();
    const countedA = meter(0);
    const configMind = new ScriptedMind(
      [
        says("paused turn"),
        calls([call("c-d", "read", { value: "d" })]),
        calls([call("c-e", "read", { value: "e" })]),
        says("done"),
      ],
      {
        summaries: [says("SUMMARY-CFG")],
        after: (req) => {
          countedA.tap(record(req.system === "You summarize." ? 1.0 : 0, {}));
        },
      },
    );
    const cfgReader = tool("read", async () => result("x".repeat(80_000)));
    const firstPause = await drain(
      taskRequest(configMind, {
        store: configStore,
        tools: [cfgReader],
        meter: countedA,
        limits: { contextTokens: 30_000, spendPauseUsd: 1, maskAfterTokens: 1e9 },
      }),
    );
    expect(firstPause.outcome).toMatchObject({ status: "paused", reason: "spend" });
    expect(configStore.of("compaction").at(-1)?.learned).toBeUndefined();

    const resumedUnlimited = await drain(
      taskRequest(
        new ScriptedMind(
          [
            calls([call("c-d", "read", { value: "d" })]),
            calls([call("c-e", "read", { value: "e" })]),
            says("done"),
          ],
          { summaries: [says("SHOULD-NOT-RUN")] },
        ),
        {
          store: configStore,
          tools: [cfgReader],
          meter: countedA,
          limits: { contextTokens: 0, spendPauseUsd: 0, maskAfterTokens: 1e9 },
        },
      ),
    );
    expect(resumedUnlimited.outcome).toEqual({ status: "succeeded", report: "done" });
    expect(configStore.of("compaction")).toHaveLength(1);

    // Part B: overflow-learned limit is restored on the same model, ignored on a different model.
    const smallMeter = new UsageMeter({ account: "openrouter", model: "small-8k" });
    const smallStore = new MemoryStore({ type: "brief", brief: BRIEF });
    const mediumReader = tool("read", async () => result("x".repeat(20_000)));
    const overflowMind = new ScriptedMind(
      [
        calls([call("c-a", "read", { value: "a" })]),
        calls([call("c-b", "read", { value: "b" })]),
        new ProviderHttpError("anthropic", 400, "prompt is too long: 9000 tokens > 8192 maximum"),
      ],
      {
        summaries: [says("SUMMARY-8K")],
        after: (req) => {
          smallMeter.tap(record(req.system === "You summarize." ? 1.0 : 0, {}));
        },
      },
    );
    const learnedPause = await drain(
      taskRequest(overflowMind, {
        store: smallStore,
        tools: [mediumReader],
        meter: smallMeter,
        limits: { contextTokens: 0, spendPauseUsd: 1, maskAfterTokens: 1e9 },
      }),
    );
    expect(learnedPause.outcome).toMatchObject({ status: "paused", reason: "spend" });
    expect(smallStore.of("compaction").at(-1)?.learned).toEqual({
      tokens: 8_192,
      model: "openrouter/small-8k",
    });

    const sameModelStore = new MemoryStore(...smallStore.list);
    const sameModelMind = new ScriptedMind(
      [
        calls([call("c-c", "read", { value: "c" })]),
        calls([call("c-d", "read", { value: "d" })]),
        says("done"),
      ],
      { summaries: [says("SUMMARY-SAME-1"), says("SUMMARY-SAME-2")] },
    );
    const sameModelOutcome = await drain(
      taskRequest(sameModelMind, {
        store: sameModelStore,
        tools: [mediumReader],
        meter: new UsageMeter({ account: "openrouter", model: "small-8k", spentUsd: 1 }),
        limits: { contextTokens: 0, spendPauseUsd: 0, maskAfterTokens: 1e9 },
      }),
    );
    expect(sameModelOutcome.outcome).toEqual({ status: "succeeded", report: "done" });
    expect(sameModelMind.summaryRequests).toHaveLength(2);

    const switchedModelStore = new MemoryStore(...smallStore.list);
    const switchedModelMind = new ScriptedMind(
      [
        calls([call("c-c", "read", { value: "c" })]),
        calls([call("c-d", "read", { value: "d" })]),
        says("done"),
      ],
      { summaries: [says("SHOULD-NOT-RUN")] },
    );
    const switchedOutcome = await drain(
      taskRequest(switchedModelMind, {
        store: switchedModelStore,
        tools: [mediumReader],
        meter: new UsageMeter({ account: "openrouter", model: "large-200k", spentUsd: 1 }),
        limits: { contextTokens: 0, spendPauseUsd: 0, maskAfterTokens: 1e9 },
      }),
    );
    expect(switchedOutcome.outcome).toEqual({ status: "succeeded", report: "done" });
    expect(switchedModelMind.summaryRequests).toHaveLength(0);

    // Part C: positive contextTokens exceeding the model's real window restores the same-model
    // learned ceiling across Continue so compaction summarizes older turns rather than failing.
    const capStore = history(["a", "b"], 10_000);
    const countedCap = meter(0);
    const capCut: readonly MindChunk[] = [
      { type: "text", text: "partial" },
      { type: "done", finishReason: "model_context_window_exceeded" },
    ];
    const capOverflowMind = new ScriptedMind([capCut], {
      after: () => countedCap.tap(record(1.0, { inputTokens: 5_000, outputTokens: 3_192 })),
    });
    const capPause = await drain(
      taskRequest(capOverflowMind, {
        store: capStore,
        meter: countedCap,
        limits: { contextTokens: 128_000, spendPauseUsd: 1, maskAfterTokens: 1e9 },
      }),
    );
    expect(capPause.outcome).toMatchObject({ status: "paused", reason: "spend" });
    expect(capStore.of("pause").at(-1)).toMatchObject({
      learned: { tokens: 8_192, model: "openrouter/test/model" },
      compact: { inputTokens: 5_000, model: "openrouter/test/model" },
    });

    const capResumedMind = new ScriptedMind([says("done")], {
      summaries: [says("SUMMARY-POS-CAP")],
    });
    const capResumedOutcome = await drain(
      taskRequest(capResumedMind, {
        store: capStore,
        meter: meter(1.0),
        limits: { contextTokens: 128_000, spendPauseUsd: 0, maskAfterTokens: 1e9 },
      }),
    );
    expect(capResumedOutcome.outcome).toEqual({ status: "succeeded", report: "done" });
    expect(capResumedMind.summaryRequests).toHaveLength(1);
  });

  test("persists learned ceiling and pending compaction when model_context_window_exceeded pauses before compacting", async () => {
    const cut: readonly MindChunk[] = [
      { type: "text", text: "partial" },
      { type: "done", finishReason: "model_context_window_exceeded" },
    ];
    // Part A: overflow + spend pause on same turn; view.sized (30k) <= compactAbove(50k) = 37.5k,
    // so Continue must still honor compact before resending, then compact proactively from 50k.
    const storeA = history();
    const meterA = meter(0);
    let step = 0;
    const mind = new ScriptedMind(
      [cut, calls([call("c-d", "read", { value: "d" })]), says("done")],
      {
        summaries: [says("SUMMARY-1"), says("SUMMARY-2")],
        after: () => {
          step++;
          if (step === 1) {
            meterA.tap(record(1.0, { inputTokens: 30_000, outputTokens: 20_000 }));
          } else {
            meterA.tap(record(0.1, {}));
          }
        },
      },
    );
    const reader = tool("read", async () => result("x".repeat(80_000)));
    const limitsUnlimited = { contextTokens: 0, spendPauseUsd: 1, maskAfterTokens: 1e9 };

    const pause1 = await drain(
      taskRequest(mind, { store: storeA, tools: [reader], meter: meterA, limits: limitsUnlimited }),
    );
    expect(pause1.outcome).toEqual({
      status: "paused",
      reason: "spend",
      detail: "Spent $1.00; it pauses at every $1.00.",
    });
    expect(mind.summaryRequests).toHaveLength(0);
    expect(storeA.of("pause").at(-1)).toMatchObject({
      learned: { tokens: 50_000, model: "openrouter/test/model" },
      compact: { inputTokens: 30_000, model: "openrouter/test/model" },
    });

    const resumed = await drain(
      taskRequest(mind, { store: storeA, tools: [reader], meter: meterA, limits: limitsUnlimited }),
    );
    expect(resumed.outcome).toEqual({ status: "succeeded", report: "done" });
    expect(mind.summaryRequests).toHaveLength(2);
    expect(
      String((mind.requests[1]?.messages[0] as { content?: string } | undefined)?.content),
    ).toContain("<summary>\nSUMMARY-1");

    // Part B: uncompactable Turn 1 pauses on spend; same-model resume fails immediately without
    // resending the failing request, while switching models retries cleanly.
    const storeB = new MemoryStore({ type: "brief", brief: BRIEF });
    const meterB = meter(0);
    const mindB1 = new ScriptedMind([cut], {
      after: () => meterB.tap(record(1.0, { inputTokens: 1_000, outputTokens: 1_000 })),
    });
    const pauseB = await drain(
      taskRequest(mindB1, { store: storeB, meter: meterB, limits: limitsUnlimited }),
    );
    expect(pauseB.outcome).toMatchObject({ status: "paused", reason: "spend" });

    const sameModelStore = new MemoryStore(...storeB.list);
    const sameModelMind = new ScriptedMind([says("should-not-send")]);
    const sameFailed = await drain(
      taskRequest(sameModelMind, {
        store: sameModelStore,
        meter: meter(1.0),
        limits: { contextTokens: 0, spendPauseUsd: 0 },
      }),
    );
    expect(sameFailed.outcome).toEqual({
      status: "failed",
      error: "The model's context window was exceeded",
    });
    expect(sameModelMind.requests).toHaveLength(0);

    const switchedStore = new MemoryStore(...storeB.list);
    const switchedMind = new ScriptedMind([says("done")]);
    const switchedOk = await drain(
      taskRequest(switchedMind, {
        store: switchedStore,
        meter: new UsageMeter({ account: "openrouter", model: "large-200k", spentUsd: 1.0 }),
        limits: { contextTokens: 0, spendPauseUsd: 0 },
      }),
    );
    expect(switchedOk.outcome).toEqual({ status: "succeeded", report: "done" });
    expect(switchedMind.requests).toHaveLength(1);
  });

  test("persists shrunk summary budget when a summary reply hits model_context_window_exceeded at a spend pause, and ignores model-less pause metadata", async () => {
    const cut: readonly MindChunk[] = [
      { type: "text", text: "partial" },
      { type: "done", finishReason: "model_context_window_exceeded" },
    ];
    const storeA = history(
      Array.from({ length: 10 }, (_, i) => `t${i}`),
      8_000,
    );
    const countedA = meter(0);
    let attempt = 0;
    const mindA = new ScriptedMind([says("done")], {
      summaries: [cut, ...Array.from({ length: 12 }, (_, i) => says(`SUMMARY-${i + 1}`))],
      after: () => {
        attempt++;
        if (attempt === 1) {
          countedA.tap(record(1.0, { inputTokens: 5_000, outputTokens: 3_192 }));
        } else {
          countedA.tap(record(0.1, {}));
        }
      },
    });
    const limitsA = { contextTokens: 8_192, spendPauseUsd: 1, maskAfterTokens: 1e9 };

    const pausedA = await drain(
      taskRequest(mindA, { store: storeA, meter: countedA, limits: limitsA }),
    );
    expect(pausedA.outcome).toEqual({
      status: "paused",
      reason: "spend",
      detail: "Spent $1.00; it pauses at every $1.00.",
    });
    const compactMeta = storeA.of("pause").at(-1)?.compact;
    expect(compactMeta).toMatchObject({
      model: "openrouter/test/model",
      summaryOverflows: 1,
    });
    expect(compactMeta?.summaryBudget).toBeLessThan(4_000);
    expect(mindA.summaryRequests).toHaveLength(1);
    expect(mindA.requests).toHaveLength(0);

    const resumedA = await drain(
      taskRequest(mindA, { store: storeA, meter: countedA, limits: limitsA }),
    );
    expect(resumedA.outcome).toEqual({ status: "succeeded", report: "done" });
    const summaryPrompts = mindA.summaryRequests.map((entry) =>
      String((entry.messages[0] as { content?: string } | undefined)?.content),
    );
    expect(summaryPrompts.length).toBeGreaterThan(2);
    for (const prompt of summaryPrompts.slice(1)) {
      expect(estimateTokens(prompt)).toBeLessThanOrEqual(compactMeta?.summaryBudget ?? 0);
    }

    // Part B: model-less pause metadata must not match an unknown-model resume (`undefined === undefined`).
    const unknownStore = new MemoryStore(
      { type: "brief", brief: BRIEF },
      {
        type: "pause",
        reason: "spend",
        detail: "Spent $1.00; it pauses at every $1.00.",
        compact: { inputTokens: 1_000 } as never,
      },
    );
    const unknownMind = new ScriptedMind([says("done")]);
    const unknownResumed = await drain(
      taskRequest(unknownMind, {
        store: unknownStore,
        meter: new FakeMeter(),
        limits: { contextTokens: 0, spendPauseUsd: 0 },
      }),
    );
    expect(unknownResumed.outcome).toEqual({ status: "succeeded", report: "done" });
    expect(unknownMind.requests).toHaveLength(1);
  });
});
