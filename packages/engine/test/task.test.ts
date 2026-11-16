// runTask beyond pi's loop: a transcript it resumes from, steering that skips a sequential batch,
// spend, stall and approval pauses, retries, and an outcome the runtime decides.
import { describe, expect, test } from "bun:test";
import { ProviderHttpError, type UsageRecord, usageRecord } from "@eidolon/providers";
import { runTask, type TaskEntry, type TaskEvent } from "../src/task.ts";
import {
  BRIEF,
  call,
  calls,
  deferred,
  drain,
  FakeMeter,
  MemoryStore,
  result,
  ScriptedMind,
  says,
  storedResults,
  taskRequest,
  tool,
  toolMessages,
  userLines,
} from "./task-fakes.ts";

const INTERRUPTED =
  "Interrupted by a restart before its result was recorded; check the files before trying again.";
const SKIPPED = "Skipped to process an incoming message.";

/** A tool recording each value it runs with. */
function recording(name: string, ran: unknown[], more: Parameters<typeof tool>[2] = {}) {
  return tool(
    name,
    async (args) => {
      ran.push(args.value);
      return result(`${name} ran ${String(args.value)}`);
    },
    more,
  );
}

/** A mind that calls `name` with a new value on every request; `after` runs as each ends. */
function forever(name: string, after?: () => void): ScriptedMind {
  const scripts = Array.from({ length: 20 }, (_, i) =>
    calls([call(`call-${i}`, name, { value: `file${i}` })]),
  );
  return new ScriptedMind(scripts, after === undefined ? {} : { after });
}

describe("runTask", () => {
  test("runs turns until a reply makes no calls, which is the report", async () => {
    const ran: unknown[] = [];
    const mind = new ScriptedMind([
      calls([call("c1", "read", { value: "a" })], "Looking first."),
      calls([call("c2", "read", { value: "b" }), call("c3", "read", { value: "c" })]),
      says("All done: index.html is in place."),
    ]);
    const request = taskRequest(mind, { tools: [recording("read", ran)] });
    const { outcome } = await drain(request);
    expect(outcome).toEqual({ status: "succeeded", report: "All done: index.html is in place." });
    expect(ran).toEqual(["a", "b", "c"]);
    expect(mind.requests).toHaveLength(3);
    expect(request.store.list.at(-1)).toMatchObject({ type: "end", outcome });
    expect(mind.requests[1]?.messages).toEqual([
      { role: "user", content: expect.stringContaining("Goal: Write a TodoMVC") },
      { role: "assistant", content: "Looking first." },
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read", arguments: '{"value":"a"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "read ran a" },
    ]);
  });

  test("starts on a store holding only its brief, and resumes on anything more", async () => {
    const started = taskRequest(new ScriptedMind([says("done")]));
    await drain(started);
    expect(started.store.types()).toEqual(["brief", "assistant", "end"]);

    const store = new MemoryStore(
      { type: "brief", brief: BRIEF },
      { type: "steer", text: "hurry" },
    );
    const resumed = taskRequest(new ScriptedMind([says("done")]), { store });
    await drain(resumed);
    expect(store.types()).toEqual(["brief", "steer", "resume", "assistant", "end"]);
    expect(userLines(resumed.mind.requests[0])).toContain("hurry");
  });

  test("throws when its store holds no brief", async () => {
    const request = taskRequest(new ScriptedMind([]), { store: new MemoryStore() });
    await expect(drain(request)).rejects.toThrow("Task task-1 has no brief");
  });

  test("stores every entry before showing it", async () => {
    const ran: unknown[] = [];
    const mind = new ScriptedMind([calls([call("c1", "read", { value: "a" })]), says("done")]);
    const request = taskRequest(mind, { tools: [recording("read", ran)] });
    const seen: boolean[] = [];
    for await (const event of runTask(request)) {
      if (event.type === "entry") seen.push(request.store.list.includes(event.entry));
    }
    expect(seen).toEqual([true, true, true, true, true]);
  });

  test("validates and coerces a call's arguments before it runs", async () => {
    const ran: unknown[] = [];
    const counted = tool(
      "count",
      async (args) => {
        ran.push(args.n);
        return result("counted");
      },
      { properties: { n: { type: "number" }, label: { type: "string" } }, required: ["n"] },
    );
    const mind = new ScriptedMind([
      calls([call("c1", "count", { n: "42" }), call("c2", "count", { label: "x" })]),
      says("done"),
    ]);
    const request = taskRequest(mind, { tools: [counted] });
    await drain(request);
    expect(ran).toEqual([42]);
    expect(storedResults(request.store).sort()).toEqual([
      ["c1", "counted"],
      [
        "c2",
        'Validation failed for tool "count":\n  - n: missing\n\nReceived arguments:\n{\n  "label": "x"\n}',
      ],
    ]);
    expect(request.store.of("tool-start").map((entry) => entry.callId)).toEqual(["c1"]);
  });

  test("answers a call to an unknown tool, and one whose tool throws, and goes on", async () => {
    const broken = tool("broken", async () => {
      throw new Error("disk on fire");
    });
    const mind = new ScriptedMind([
      calls([call("c1", "nope"), call("c2", "broken")]),
      says("Recovered."),
    ]);
    const request = taskRequest(mind, { tools: [broken] });
    const { outcome } = await drain(request);
    expect(request.store.of("tool-result")).toMatchObject([
      { callId: "c1", content: "Tool nope not found", isError: true },
      { callId: "c2", content: "disk on fire", isError: true },
    ]);
    expect(outcome).toEqual({ status: "succeeded", report: "Recovered." });
  });

  test("rebuilds results in the order of the calls, however they were stored", async () => {
    const store = new MemoryStore(
      { type: "brief", brief: BRIEF },
      { type: "assistant", text: "", calls: [call("c1", "read"), call("c2", "read")] },
      { type: "tool-start", callId: "c1", name: "read" },
      { type: "tool-start", callId: "c2", name: "read" },
      { type: "tool-result", callId: "c2", name: "read", content: "second", isError: false },
      { type: "tool-result", callId: "c1", name: "read", content: "first", isError: false },
    );
    const mind = new ScriptedMind([says("done")]);
    await drain(taskRequest(mind, { store, tools: [tool("read")] }));
    expect(toolMessages(mind.requests[0])).toEqual([
      ["c1", "first"],
      ["c2", "second"],
    ]);
  });

  test("bills its requests as source task, under its id", async () => {
    let record: UsageRecord | undefined;
    const mind = new ScriptedMind([
      () => {
        record = usageRecord({
          role: "assistant",
          provider: "openai",
          model: "gpt-x",
          units: { inputTokens: 1 },
          costUsd: 0,
        });
        return says("done");
      },
    ]);
    await drain(taskRequest(mind));
    expect(record).toMatchObject({ source: "task", session: "task-1" });
  });
});

describe("runTask's outcome", () => {
  test("fails a task whose last reply the output limit cut off", async () => {
    const mind = new ScriptedMind([
      [
        { type: "text", text: "<!doctype html><html" },
        { type: "done", finishReason: "max_tokens" },
      ],
    ]);
    const request = taskRequest(mind);
    const { outcome } = await drain(request);
    expect(outcome).toEqual({
      status: "failed",
      error: "The model's reply was cut off at its output limit",
    });
    expect(request.store.types()).toEqual(["brief", "assistant", "end"]);
  });

  test("fails a task whose last reply meant to call tools it couldn't make", async () => {
    const mind = new ScriptedMind([[{ type: "done", finishReason: "tool_calls" }]]);
    const { outcome } = await drain(taskRequest(mind));
    expect(outcome).toEqual({ status: "failed", error: "The model's tool calls couldn't be read" });
  });

  test("goes on past a cut-off reply when a line is queued", async () => {
    const mind = new ScriptedMind([
      [
        { type: "text", text: "<!doctype html><html" },
        { type: "done", finishReason: "length" },
      ],
      says("Wrote it in parts instead."),
    ]);
    const request = taskRequest(mind);
    request.inbox.followUps.push("Write it in smaller parts.");
    const { outcome } = await drain(request);
    expect(outcome).toEqual({ status: "succeeded", report: "Wrote it in parts instead." });
  });
});

describe("runTask's steering", () => {
  test("skips the calls of a sequential batch that haven't started", async () => {
    const ran: unknown[] = [];
    const mind = new ScriptedMind([
      calls([
        call("c1", "write", { value: "a" }),
        call("c2", "write", { value: "b" }),
        call("c3", "write", { value: "c" }),
      ]),
      says("done"),
    ]);
    const request = taskRequest(mind);
    const writing = tool(
      "write",
      async (args) => {
        ran.push(args.value);
        request.inbox.steering.push("Stop, use b.html instead");
        return result("wrote");
      },
      { executionMode: "sequential" },
    );
    const { events } = await drain({ ...request, tools: [writing] });
    expect(ran).toEqual(["a"]);
    expect(request.store.of("tool-result")).toMatchObject([
      { callId: "c1", content: "wrote", isError: false },
      {
        callId: "c2",
        content: SKIPPED,
        isError: true,
        details: { status: "skipped", deniedReason: "steering" },
      },
      { callId: "c3", content: SKIPPED, isError: true },
    ]);
    const ends = events.flatMap((e) => (e.type === "tool" && e.state === "end" ? [e.callId] : []));
    expect(ends).toEqual(["c1", "c2", "c3"]);
    expect(request.store.types().slice(-4)).toEqual(["tool-result", "steer", "assistant", "end"]);
    expect(userLines(mind.requests[1]).at(-1)).toBe("Stop, use b.html instead");
  });

  test("runs a sequential batch's first call even with steering waiting", async () => {
    const ran: unknown[] = [];
    const mind = new ScriptedMind([
      () => {
        request.inbox.steering.push("change of plan");
        return calls([call("c1", "write", { value: "a" }), call("c2", "write", { value: "b" })]);
      },
      says("done"),
    ]);
    const request = taskRequest(mind, {
      tools: [recording("write", ran, { executionMode: "sequential" })],
    });
    await drain(request);
    expect(ran).toEqual(["a"]);
    expect(storedResults(request.store)).toEqual([
      ["c1", "write ran a"],
      ["c2", SKIPPED],
    ]);
  });

  test("a line steering the last turn goes ahead of a queued follow-up", async () => {
    const mind = new ScriptedMind([
      () => {
        request.inbox.steering.push("use blue");
        return says("done");
      },
      says("blue it is"),
      says("and the follow-up"),
    ]);
    const request = taskRequest(mind);
    request.inbox.followUps.push("then add a footer");
    const { outcome } = await drain(request);
    expect(userLines(mind.requests[1]).slice(1)).toEqual(["use blue"]);
    expect(userLines(mind.requests[2]).slice(1)).toEqual(["use blue", "then add a footer"]);
    expect(outcome).toEqual({ status: "succeeded", report: "and the follow-up" });
  });
});

describe("runTask's pauses", () => {
  test("pauses for spend at the next threshold, and a resume goes on to the one after", async () => {
    const meter = new FakeMeter();
    const mind = forever("read", () => {
      meter.spent += 0.6;
      if (mind.requests.length === 2) request.inbox.steering.push("one more thing");
    });
    const request = taskRequest(mind, {
      meter,
      tools: [tool("read")],
      limits: { contextTokens: 128_000, spendPauseUsd: 1 },
    });
    const first = await drain(request);
    expect(first.outcome).toEqual({
      status: "paused",
      reason: "spend",
      detail: "Spent $1.20; it pauses at every $1.00.",
    });
    expect(mind.requests).toHaveLength(2);
    expect(request.store.list.at(-1)).toMatchObject({ type: "pause", reason: "spend" });
    expect(request.inbox.steering).toEqual(["one more thing"]);

    const second = await drain(request);
    expect(second.outcome).toMatchObject({ status: "paused", reason: "spend" });
    expect(mind.requests).toHaveLength(4);
    expect(meter.spent).toBeCloseTo(2.4);
    expect(request.store.types().filter((type) => type === "resume")).toHaveLength(1);
    expect(userLines(mind.requests[2]).at(-1)).toBe("one more thing");
  });

  test("never pauses for spend with a step of 0", async () => {
    const mind = new ScriptedMind([says("done")]);
    const request = taskRequest(mind);
    request.meter.spent = 50;
    expect((await drain(request)).outcome).toMatchObject({ status: "succeeded" });
  });

  test("pauses when a turn makes the calls of the two before it", async () => {
    const ran: unknown[] = [];
    const same = (id: string, args: Record<string, unknown>) => calls([call(id, "grep", args)]);
    const mind = new ScriptedMind([
      same("c1", { value: "todo", path: "src" }),
      same("c2", { path: "src", value: "todo" }),
      same("c3", { value: "todo", path: "src" }),
      says("never asked"),
    ]);
    const grep = recording("grep", ran, {
      properties: { value: { type: "string" }, path: { type: "string" } },
    });
    const request = taskRequest(mind, { tools: [grep] });
    const { outcome } = await drain(request);
    expect(outcome).toEqual({
      status: "paused",
      reason: "stall",
      detail: 'The same calls 3 turns running:\ngrep {"path":"src","value":"todo"}',
    });
    expect(mind.requests).toHaveLength(3);
    expect(ran).toHaveLength(3);
  });

  test("doesn't pause for calls that differ", async () => {
    const mind = new ScriptedMind([
      calls([call("c1", "read", { value: "a" })]),
      calls([call("c2", "read", { value: "a" })]),
      calls([call("c3", "read", { value: "b" })]),
      says("done"),
    ]);
    const { outcome } = await drain(taskRequest(mind, { tools: [tool("read")] }));
    expect(outcome).toMatchObject({ status: "succeeded" });
  });

  test("the gate's pause holds its call, and the resume gates and runs it", async () => {
    const ran: unknown[] = [];
    const asked: string[] = [];
    const mind = new ScriptedMind([
      calls([call("c1", "write", { value: "~/notes.md" })]),
      says("Wrote it."),
    ]);
    let allowed = false;
    const request = taskRequest(mind, {
      tools: [recording("write", ran)],
      gate: async (gated) => {
        asked.push(gated.id);
        return allowed ? null : { pause: "write ~/notes.md, outside the folder" };
      },
    });
    const first = await drain(request);
    expect(first.outcome).toEqual({
      status: "paused",
      reason: "approval",
      detail: "write ~/notes.md, outside the folder",
    });
    expect(ran).toEqual([]);
    expect(request.store.types()).toEqual(["brief", "assistant", "pause"]);

    allowed = true;
    const second = await drain(request);
    expect(second.outcome).toEqual({ status: "succeeded", report: "Wrote it." });
    expect(asked).toEqual(["c1", "c1"]);
    expect(ran).toEqual(["~/notes.md"]);
    expect(request.store.types().slice(3)).toEqual([
      "resume",
      "tool-start",
      "tool-result",
      "assistant",
      "end",
    ]);
  });

  test("a refused path pauses the task, with pauseOnRefused", async () => {
    const refusing = tool("write", async () =>
      result("/etc/hosts is outside the folders this task may write", {
        isError: true,
        refused: { path: "/etc/hosts", access: "write" },
      }),
    );
    const script = () =>
      new ScriptedMind([calls([call("c1", "write", { value: "/etc/hosts" })]), says("done")]);
    const asked = taskRequest(script(), { tools: [refusing], pauseOnRefused: true });
    expect((await drain(asked)).outcome).toEqual({
      status: "paused",
      reason: "approval",
      detail: "write access to /etc/hosts",
    });
    expect(asked.store.of("tool-result")).toMatchObject([
      { refused: { path: "/etc/hosts", access: "write" }, isError: true },
    ]);

    const told = taskRequest(script(), { tools: [refusing] });
    expect((await drain(told)).outcome).toEqual({ status: "succeeded", report: "done" });
  });
});

describe("runTask's retries", () => {
  test("retries a 429, a 5xx and a network error after 1, 4 and 15 seconds, then fails", async () => {
    const waits: number[] = [];
    const mind = new ScriptedMind([
      new ProviderHttpError("openai", 429, "Rate limited"),
      new ProviderHttpError("openai", 503, "Service unavailable"),
      new TypeError("fetch failed"),
      new ProviderHttpError("anthropic", 200, "Overloaded"),
    ]);
    const request = taskRequest(mind, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const { events, outcome } = await drain(request);
    expect(waits).toEqual([1000, 4000, 15000]);
    const ends = events.filter((event) => event.type === "request" && event.state === "end");
    expect(ends).toEqual([
      {
        type: "request",
        state: "end",
        error: "openai answered 429: Rate limited",
        retryInMs: 1000,
      },
      {
        type: "request",
        state: "end",
        error: "openai answered 503: Service unavailable",
        retryInMs: 4000,
      },
      { type: "request", state: "end", error: "fetch failed", retryInMs: 15000 },
      { type: "request", state: "end", error: "anthropic answered 200: Overloaded" },
    ]);
    expect(outcome).toEqual({ status: "failed", error: "anthropic answered 200: Overloaded" });
    expect(request.store.list.at(-1)).toMatchObject({ type: "end", outcome });
  });

  test("goes on when a retry succeeds", async () => {
    const waits: number[] = [];
    const mind = new ScriptedMind([new TypeError("fetch failed"), says("done")]);
    const { outcome } = await drain(
      taskRequest(mind, {
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
    );
    expect(waits).toEqual([1000]);
    expect(outcome).toEqual({ status: "succeeded", report: "done" });
  });

  test("doesn't retry a quota that ran out", async () => {
    const mind = new ScriptedMind([
      new ProviderHttpError("openai", 429, "You exceeded your current quota: insufficient_quota"),
    ]);
    const { outcome } = await drain(taskRequest(mind, { sleep: async () => {} }));
    expect(mind.requests).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "failed" });
  });

  test("a cancel during the wait ends the task cancelled", async () => {
    const controller = new AbortController();
    const mind = new ScriptedMind([new TypeError("fetch failed")]);
    const request = taskRequest(mind, {
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
    });
    expect((await drain(request)).outcome).toEqual({ status: "cancelled" });
  });
});

describe("runTask's cancel", () => {
  test("mid-stream, it stores the end and nothing of the reply", async () => {
    const controller = new AbortController();
    const mind = new ScriptedMind([
      async function* (request) {
        yield { type: "text", text: "Starting" };
        await new Promise((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason));
        });
      },
    ]);
    const request = taskRequest(mind, { signal: controller.signal });
    const events: TaskEvent[] = [];
    for await (const event of runTask(request)) {
      events.push(event);
      if (event.type === "delta") controller.abort();
    }
    expect(request.store.types()).toEqual(["brief", "end"]);
    expect(request.store.list.at(-1)).toMatchObject({ outcome: { status: "cancelled" } });
    expect(events.filter((event) => event.type === "request").at(-1)).toEqual({
      type: "request",
      state: "end",
    });
  });

  test("mid-tool, it stores the end at once, and nothing after it once the tool ends", async () => {
    const controller = new AbortController();
    const running = deferred();
    const finish = deferred<string>();
    const stuck = tool("stuck", async () => {
      running.resolve();
      return result(await finish.promise);
    });
    const mind = new ScriptedMind([calls([call("c1", "stuck")])]);
    const request = taskRequest(mind, { tools: [stuck], signal: controller.signal });
    const done = drain(request);
    await running.promise;
    controller.abort();
    expect((await done).outcome).toEqual({ status: "cancelled" });
    finish.resolve("too late");
    await Bun.sleep(1);
    expect(request.store.types()).toEqual(["brief", "assistant", "tool-start", "end"]);
  });

  test("a cancel while a call's start is stored keeps the call from running", async () => {
    const controller = new AbortController();
    const ran: unknown[] = [];
    const store = new MemoryStore({ type: "brief", brief: BRIEF });
    const append = store.append.bind(store);
    store.append = async (draft) => {
      if (draft.type === "tool-start") controller.abort();
      return append(draft);
    };
    const mind = new ScriptedMind([calls([call("c1", "write", { value: "a" })])]);
    const request = taskRequest(mind, {
      store,
      tools: [recording("write", ran)],
      signal: controller.signal,
    });
    expect((await drain(request)).outcome).toEqual({ status: "cancelled" });
    expect(ran).toEqual([]);
    expect(store.types()).toEqual(["brief", "assistant", "tool-start", "end"]);
  });

  test("a reader that stops reading stops the run, storing nothing more", async () => {
    const aborted = deferred();
    const hanging = tool("hang", async (_args, context) => {
      if (!context.signal.aborted) {
        await new Promise((resolve) => context.signal.addEventListener("abort", resolve));
      }
      aborted.resolve();
      return result("late");
    });
    const mind = new ScriptedMind([calls([call("c1", "hang")])]);
    const request = taskRequest(mind, { tools: [hanging] });
    for await (const event of runTask(request)) {
      if (event.type === "entry" && event.entry.type === "tool-start") break;
    }
    await aborted.promise;
    await Bun.sleep(1);
    expect(request.store.types()).toEqual(["brief", "assistant", "tool-start"]);
  });
});

describe("runTask's resume", () => {
  test("after a crash, a safe call reruns, a never call is interrupted, an unstarted one runs", async () => {
    const ran: unknown[] = [];
    const asked: string[] = [];
    const store = new MemoryStore(
      { type: "brief", brief: BRIEF },
      {
        type: "assistant",
        text: "Three things.",
        calls: [
          call("s", "fetch", { value: "safe" }),
          call("n", "write", { value: "never" }),
          call("u", "fetch", { value: "unstarted" }),
        ],
      },
      { type: "tool-start", callId: "s", name: "fetch" },
      { type: "tool-start", callId: "n", name: "write" },
    );
    const mind = new ScriptedMind([says("Recovered.")]);
    const request = taskRequest(mind, {
      store,
      tools: [recording("fetch", ran), recording("write", ran, { replay: "never" })],
      gate: async (gated) => {
        asked.push(gated.id);
        return null;
      },
    });
    const { events, outcome } = await drain(request);
    expect(outcome).toEqual({ status: "succeeded", report: "Recovered." });
    expect(ran).toEqual(["safe", "unstarted"]);
    expect(asked).toEqual(["u"]);
    expect(storedResults(store).sort()).toEqual([
      ["n", INTERRUPTED],
      ["s", "fetch ran safe"],
      ["u", "fetch ran unstarted"],
    ]);
    expect(store.of("tool-start").map((entry) => entry.callId)).toEqual(["s", "n", "s", "u"]);
    expect(store.types().slice(4, 5)).toEqual(["resume"]);
    expect(toolMessages(mind.requests[0])).toEqual([
      ["s", "fetch ran safe"],
      ["n", INTERRUPTED],
      ["u", "fetch ran unstarted"],
    ]);
    const turns = events.flatMap((e) => (e.type === "turn" ? [`${e.state} ${e.turn}`] : []));
    expect(turns).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  });

  test("a request a crash cut short is made again", async () => {
    const store = new MemoryStore(
      { type: "brief", brief: BRIEF },
      { type: "assistant", text: "", calls: [call("c1", "read")] },
      { type: "tool-start", callId: "c1", name: "read" },
      { type: "tool-result", callId: "c1", name: "read", content: "ok", isError: false },
    );
    const mind = new ScriptedMind([says("done")]);
    const { outcome } = await drain(taskRequest(mind, { store, tools: [tool("read")] }));
    expect(outcome).toEqual({ status: "succeeded", report: "done" });
    expect(toolMessages(mind.requests[0])).toEqual([["c1", "ok"]]);
    expect(store.types().slice(4)).toEqual(["resume", "assistant", "end"]);
  });

  test("entries carry their store's numbering", async () => {
    const mind = new ScriptedMind([says("done")]);
    const request = taskRequest(mind);
    const entries: TaskEntry[] = [];
    for await (const event of runTask(request))
      if (event.type === "entry") entries.push(event.entry);
    expect(entries.map((entry) => entry.seq)).toEqual([2, 3]);
  });
});
