// A task's meter, which its runner and the loop share: the spend its mind's usage records add up
// to, and the pause before the next request once a request couldn't be counted.
import { consoleSink, type LogRecord, logger } from "@eidolon/config";
import { ProviderHttpError, type UsageRecord } from "@eidolon/providers";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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

  test("counts the last request's whole input, what its provider cached included", () => {
    const counted = meter();
    expect(counted.lastInputTokens()).toBeNull();
    counted.tap(record(0, { inputTokens: 300, cachedTokens: 9000, cacheWriteTokens: 700 }));
    expect(counted.lastInputTokens()).toBe(10_000);
    counted.tap(record(0, { inputTokens: 40, outputTokens: 5 }));
    expect(counted.lastInputTokens()).toBe(40);
    counted.tap(record(0, { outputTokens: 5 }));
    expect(counted.lastInputTokens()).toBeNull();
  });

  test("a request that ended with no usage record is one it can't count, its input unknown", () => {
    const counted = meter(0.5);
    counted.tap(record(0.25, { inputTokens: 40 }));
    counted.requestEnded();
    expect([counted.unpriced(), counted.lastInputTokens()]).toEqual([null, 40]);
    // A server that ignores stream_options.include_usage.
    counted.requestEnded();
    expect([counted.unpriced(), counted.lastInputTokens()]).toEqual([UNREPORTED, null]);
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
});
