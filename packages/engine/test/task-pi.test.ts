// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/agent/test/agent-loop.test.ts@ac78a60 and packages/agent/test/agent.test.ts@ac78a60
//
// pi's loop cases on runTask: the task's inbox stands in for pi's queues, its gate for
// beforeToolCall, and a resumed store for continue().
import { describe, expect, test } from "bun:test";
import { ProviderHttpError } from "@eidolon/providers";
import { briefText } from "../src/task/context.ts";
import { runTask, type TaskEvent, type TaskToolContext } from "../src/task.ts";
import {
  BRIEF,
  call,
  calls,
  DONE,
  deferred,
  drain,
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

function label(event: TaskEvent): string {
  switch (event.type) {
    case "entry":
      return `entry:${event.entry.type}`;
    case "run":
    case "turn":
    case "request":
      return `${event.type}:${event.state}`;
    case "tool":
      return `tool:${event.state}:${event.callId}`;
    case "delta":
      return "delta";
  }
}

function toolEvents(events: readonly TaskEvent[], state: "start" | "update" | "end"): string[] {
  return events.flatMap((event) =>
    event.type === "tool" && event.state === state ? [event.callId] : [],
  );
}

/** A tool that echoes `value`, recording each run. */
function echo(executed: unknown[], more: Parameters<typeof tool>[2] = {}) {
  return tool(
    "echo",
    async (args) => {
      executed.push(args.value);
      return { content: `echoed: ${String(args.value)}`, details: { value: args.value } };
    },
    more,
  );
}

const both = calls([
  call("tool-1", "echo", { value: "first" }),
  call("tool-2", "echo", { value: "second" }),
]);

describe("runTask, as pi's agentLoop", () => {
  test("emits a run's events in order and ends with the reply", async () => {
    const mind = new ScriptedMind([says("Hi there!")]);
    const request = taskRequest(mind);
    const { events, outcome } = await drain(request);
    expect(outcome).toEqual({ status: "succeeded", report: "Hi there!" });
    expect(events.map(label)).toEqual([
      "run:start",
      "turn:start",
      "request:start",
      "delta",
      "request:end",
      "entry:assistant",
      "turn:end",
      "entry:end",
      "run:end",
    ]);
    expect(request.store.types()).toEqual(["brief", "assistant", "end"]);
  });

  test("builds each request from the transcript alone", async () => {
    const mind = new ScriptedMind([says("done")]);
    await drain(taskRequest(mind));
    expect(mind.requests[0]?.system).toBe("You do the work.");
    expect(mind.requests[0]?.messages).toEqual([{ role: "user", content: briefText(BRIEF) }]);
  });

  test("runs tool calls and stores their results", async () => {
    const executed: unknown[] = [];
    let observed: unknown;
    const mind = new ScriptedMind([
      calls([call("tool-1", "echo", { value: "hello" })]),
      says("done"),
    ]);
    const request = taskRequest(mind, {
      tools: [echo(executed, { required: ["value"] })],
      afterToolCall: async (_call, settled) => {
        observed = settled.details;
        return { details: { value: "patched" } };
      },
    });
    const { events, outcome } = await drain(request);
    expect(executed).toEqual(["hello"]);
    expect(toolEvents(events, "start")).toEqual(["tool-1"]);
    expect(events.find((event) => event.type === "tool" && event.state === "end")).toMatchObject({
      name: "echo",
      isError: false,
    });
    expect(observed).toEqual({ value: "hello" });
    expect(request.store.of("tool-result")).toMatchObject([
      { callId: "tool-1", content: "echoed: hello", details: { value: "patched" }, isError: false },
    ]);
    expect(outcome).toEqual({ status: "succeeded", report: "done" });
  });

  test("runs none of the calls of a reply the output limit cut off", async () => {
    const executed: unknown[] = [];
    const mind = new ScriptedMind([
      [
        { type: "tool-calls", calls: [call("tool-1", "echo", { value: "hel" })] },
        { type: "done", finishReason: "length" },
      ],
      says("done"),
    ]);
    const request = taskRequest(mind, { tools: [echo(executed)] });
    const { events, outcome } = await drain(request);
    expect(executed).toEqual([]);
    expect(events.find((event) => event.type === "tool" && event.state === "end")).toMatchObject({
      isError: true,
    });
    expect(request.store.of("tool-result")[0]?.content).toContain("output token limit");
    expect(mind.requests).toHaveLength(2);
    expect(outcome).toEqual({ status: "succeeded", report: "done" });
  });

  test("runs a call with the arguments the gate changed, without validating them again", async () => {
    const executed: unknown[] = [];
    const mind = new ScriptedMind([
      calls([call("tool-1", "echo", { value: "hello" })]),
      says("done"),
    ]);
    await drain(
      taskRequest(mind, {
        tools: [echo(executed)],
        gate: async (gated) => {
          (gated.arguments as Record<string, unknown>).value = 123;
          return null;
        },
      }),
    );
    expect(executed).toEqual([123]);
  });

  test("prepares a call's arguments before validating them", async () => {
    const executed: unknown[] = [];
    const edit = tool(
      "edit",
      async (args) => {
        executed.push(args.edits);
        return { content: `edited ${(args.edits as unknown[]).length}` };
      },
      {
        properties: {
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: { oldText: { type: "string" }, newText: { type: "string" } },
              required: ["oldText", "newText"],
            },
          },
        },
        required: ["edits"],
        prepareArguments(args) {
          if (typeof args.oldText !== "string" || typeof args.newText !== "string") return args;
          const edits = Array.isArray(args.edits) ? args.edits : [];
          return { edits: [...edits, { oldText: args.oldText, newText: args.newText }] };
        },
      },
    );
    const mind = new ScriptedMind([
      calls([call("tool-1", "edit", { oldText: "before", newText: "after" })]),
      says("done"),
    ]);
    await drain(taskRequest(mind, { tools: [edit] }));
    expect(executed).toEqual([[{ oldText: "before", newText: "after" }]]);
  });

  test("ends calls as they finish, and sends their results in call order", async () => {
    const released = deferred();
    let firstDone = false;
    let parallel = false;
    const slow = tool("echo", async (args) => {
      if (args.value === "first") {
        await released.promise;
        firstDone = true;
      } else {
        parallel = !firstDone;
        setTimeout(() => released.resolve(), 5);
      }
      return { content: `echoed: ${String(args.value)}` };
    });
    const mind = new ScriptedMind([both, says("done")]);
    const request = taskRequest(mind, { tools: [slow] });
    const { events } = await drain(request);
    expect(parallel).toBe(true);
    expect(toolEvents(events, "end")).toEqual(["tool-2", "tool-1"]);
    expect(storedResults(request.store).map(([id]) => id)).toEqual(["tool-2", "tool-1"]);
    expect(toolMessages(mind.requests[1]).map(([id]) => id)).toEqual(["tool-1", "tool-2"]);
  });

  test("takes steering only after every call of a parallel batch", async () => {
    const executed: unknown[] = [];
    const mind = new ScriptedMind([both, says("done")]);
    const request = taskRequest(mind);
    const echoing = tool("echo", async (args) => {
      executed.push(args.value);
      if (args.value === "first") request.inbox.steering.push("interrupt");
      return { content: `ok:${String(args.value)}` };
    });
    const { events } = await drain({ ...request, tools: [echoing] });
    expect(executed).toEqual(["first", "second"]);
    const ends = events.filter((event) => event.type === "tool" && event.state === "end");
    expect(ends).toMatchObject([{ isError: false }, { isError: false }]);
    expect(request.store.types().slice(1, -2)).toEqual([
      "assistant",
      "tool-start",
      "tool-start",
      "tool-result",
      "tool-result",
      "steer",
    ]);
    expect(userLines(mind.requests[1])).toContain("interrupt");
  });

  test("runs a batch one call at a time when its tool is sequential", async () => {
    const released = deferred();
    let firstDone = false;
    let parallel = false;
    const slow = tool(
      "slow",
      async (args) => {
        if (args.value === "first") {
          setTimeout(() => released.resolve(), 5);
          await released.promise;
          firstDone = true;
        } else {
          parallel = !firstDone;
        }
        return { content: `slow: ${String(args.value)}` };
      },
      { executionMode: "sequential" },
    );
    const mind = new ScriptedMind([
      calls([
        call("tool-1", "slow", { value: "first" }),
        call("tool-2", "slow", { value: "second" }),
      ]),
      says("done"),
    ]);
    const request = taskRequest(mind, { tools: [slow] });
    await drain(request);
    expect(parallel).toBe(false);
    expect(storedResults(request.store).map(([id]) => id)).toEqual(["tool-1", "tool-2"]);
  });

  test("runs the whole batch one at a time when one of its tools is sequential", async () => {
    const order: string[] = [];
    const released = deferred();
    const slow = tool(
      "slow",
      async (args) => {
        order.push(`slow:${String(args.value)}`);
        setTimeout(() => released.resolve(), 5);
        await released.promise;
        return { content: "slow" };
      },
      { executionMode: "sequential" },
    );
    const fast = tool("fast", async (args) => {
      order.push(`fast:${String(args.value)}`);
      return { content: "fast" };
    });
    const mind = new ScriptedMind([
      calls([call("tool-1", "slow", { value: "a" }), call("tool-2", "fast", { value: "b" })]),
      says("done"),
    ]);
    await drain(taskRequest(mind, { tools: [slow, fast] }));
    expect(order).toEqual(["slow:a", "fast:b"]);
  });

  test("runs a batch in parallel when every tool is parallel", async () => {
    const released = deferred();
    let firstDone = false;
    let parallel = false;
    const echoing = tool(
      "echo",
      async (args) => {
        if (args.value === "first") {
          await released.promise;
          firstDone = true;
        } else {
          parallel = !firstDone;
          released.resolve();
        }
        return { content: "ok" };
      },
      { executionMode: "parallel" },
    );
    await drain(taskRequest(new ScriptedMind([both, says("done")]), { tools: [echoing] }));
    expect(parallel).toBe(true);
  });

  test("a cancel during a sequential batch runs no later call and stores nothing after its end", async () => {
    const controller = new AbortController();
    const executed: unknown[] = [];
    const slow = tool(
      "slow",
      async (args) => {
        executed.push(args.value);
        controller.abort();
        throw new Error("interrupted");
      },
      { executionMode: "sequential" },
    );
    const mind = new ScriptedMind([
      calls(
        ["first", "second", "third"].map((value, i) => call(`tool-${i + 1}`, "slow", { value })),
      ),
    ]);
    const request = taskRequest(mind, { tools: [slow], signal: controller.signal });
    const { events, outcome } = await drain(request);
    expect(outcome).toEqual({ status: "cancelled" });
    expect(executed).toEqual(["first"]);
    expect(toolEvents(events, "start")).toEqual(["tool-1"]);
    expect(request.store.types()).toEqual(["brief", "assistant", "tool-start", "end"]);
    expect(request.store.list.at(-1)).toMatchObject({ outcome: { status: "cancelled" } });
  });

  test("a cancel while the gate decides asks it about no later call", async () => {
    const controller = new AbortController();
    const executed: unknown[] = [];
    const gated: string[] = [];
    const mind = new ScriptedMind([
      calls(
        ["first", "second", "third"].map((value, i) => call(`tool-${i + 1}`, "echo", { value })),
      ),
    ]);
    const request = taskRequest(mind, {
      tools: [echo(executed)],
      signal: controller.signal,
      gate: async (asked) => {
        gated.push(asked.id);
        if (asked.id === "tool-2") controller.abort();
        return null;
      },
    });
    const { outcome } = await drain(request);
    expect(outcome).toEqual({ status: "cancelled" });
    expect(executed).toEqual([]);
    expect(gated).toEqual(["tool-1", "tool-2"]);
    expect(request.store.types()).toEqual(["brief", "assistant", "end"]);
  });

  test("ends the run after a batch whose every result terminates", async () => {
    const terminating = tool("echo", async () => ({ content: "echoed", terminate: true }));
    const mind = new ScriptedMind([
      calls([call("tool-1", "echo", { value: "hello" })], "On it."),
      says("should not run"),
    ]);
    const request = taskRequest(mind, { tools: [terminating] });
    const { events, outcome } = await drain(request);
    expect(mind.requests).toHaveLength(1);
    expect(outcome).toEqual({ status: "succeeded", report: "On it." });
    expect(request.store.types()).toEqual([
      "brief",
      "assistant",
      "tool-start",
      "tool-result",
      "end",
    ]);
    expect(events.filter((event) => event.type === "turn" && event.state === "end")).toHaveLength(
      1,
    );
  });

  test("ends the run after a call the gate blocked with terminate", async () => {
    const executed: unknown[] = [];
    const mind = new ScriptedMind([
      calls([call("tool-1", "echo", { value: "hello" })]),
      says("should not run"),
    ]);
    const request = taskRequest(mind, {
      tools: [echo(executed)],
      gate: async () => ({ block: "Blocked by policy", terminate: true }),
    });
    await drain(request);
    expect(executed).toEqual([]);
    expect(mind.requests).toHaveLength(1);
    expect(request.store.of("tool-result")).toMatchObject([
      { content: "Blocked by policy", isError: true },
    ]);
  });

  test("goes on after a batch with one terminating blocked call", async () => {
    const executed: unknown[] = [];
    const mind = new ScriptedMind([both, says("done")]);
    await drain(
      taskRequest(mind, {
        tools: [echo(executed)],
        gate: async (asked) =>
          asked.arguments.value === "first" ? { block: "Blocked first", terminate: true } : null,
      }),
    );
    expect(executed).toEqual(["second"]);
    expect(mind.requests).toHaveLength(2);
  });

  test("goes on after a parallel batch when not every result terminates", async () => {
    const mixed = tool("echo", async (args) => ({
      content: "echoed",
      terminate: args.value === "first",
    }));
    const mind = new ScriptedMind([both, says("done")]);
    const request = taskRequest(mind, { tools: [mixed] });
    await drain(request);
    expect(mind.requests).toHaveLength(2);
    expect(request.store.of("tool-result")).toHaveLength(2);
    expect(request.store.types().at(-2)).toBe("assistant");
  });

  test("lets afterToolCall make a batch terminate", async () => {
    const executed: unknown[] = [];
    const mind = new ScriptedMind([calls([call("tool-1", "echo", { value: "hello" })])]);
    await drain(
      taskRequest(mind, {
        tools: [echo(executed)],
        afterToolCall: async () => ({ terminate: true }),
      }),
    );
    expect(mind.requests).toHaveLength(1);
  });
});

describe("runTask, as pi's Agent", () => {
  test("a request that fails ends the run failed, through its whole lifecycle", async () => {
    const mind = new ScriptedMind([new ProviderHttpError("openai", 400, "provider exploded")]);
    const request = taskRequest(mind);
    const { events, outcome } = await drain(request);
    expect(events.map(label)).toEqual([
      "run:start",
      "turn:start",
      "request:start",
      "request:end",
      "turn:end",
      "entry:end",
      "run:end",
    ]);
    expect(events[3]).toMatchObject({ error: "openai answered 400: provider exploded" });
    expect(outcome).toEqual({ status: "failed", error: "openai answered 400: provider exploded" });
    expect(request.store.list.at(-1)).toMatchObject({ type: "end", outcome });
  });

  test("ignores a tool's updates after its call settles", async () => {
    let update: TaskToolContext["onUpdate"] | undefined;
    const tracked = tool("delayed", async (_args, context) => {
      update = context.onUpdate;
      context.onUpdate("running");
      return { content: "ok", terminate: true };
    });
    const mind = new ScriptedMind([calls([call("call-1", "delayed")])]);
    const { events } = await drain(taskRequest(mind, { tools: [tracked] }));
    const counted = events.length;
    update?.("late");
    await Bun.sleep(0);
    expect(toolEvents(events, "update")).toEqual(["call-1"]);
    expect(events).toHaveLength(counted);
  });

  test("ignores a settled call's update while another of its batch still runs", async () => {
    const slowStarted = deferred();
    const releaseSlow = deferred();
    let settledUpdate: TaskToolContext["onUpdate"] | undefined;
    const events: TaskEvent[] = [];
    const settled = tool("settled", async (_args, context) => {
      settledUpdate = context.onUpdate;
      return { content: "done", terminate: true };
    });
    const slow = tool("slow", async () => {
      slowStarted.resolve();
      await releaseSlow.promise;
      return { content: "done", terminate: true };
    });
    const mind = new ScriptedMind([calls([call("call-1", "settled"), call("call-2", "slow")])]);
    const run = runTask(taskRequest(mind, { tools: [settled, slow] }));
    const reading = (async () => {
      for await (const event of run) events.push(event);
    })();
    await slowStarted.promise;
    while (!events.some((event) => event.type === "tool" && event.state === "end")) {
      await Bun.sleep(1);
    }
    const counted = events.length;
    settledUpdate?.("late");
    await Bun.sleep(0);
    expect(events).toHaveLength(counted);
    releaseSlow.resolve();
    await reading;
    expect(toolEvents(events, "update")).toEqual([]);
  });

  for (const mode of ["one-at-a-time", "all"] as const) {
    test(`takes ${mode} steering at a run's start`, async () => {
      const mind = new ScriptedMind([says("done"), says("done")]);
      const request = taskRequest(mind, { steeringMode: mode });
      request.inbox.steering.push("first", "second");
      await drain(request);
      expect(mind.requests).toHaveLength(mode === "all" ? 1 : 2);
      expect(userLines(mind.requests[0])).toContain("first");
      if (mode === "all") {
        expect(userLines(mind.requests[0])).toContain("second");
      } else {
        expect(userLines(mind.requests[0])).not.toContain("second");
        expect(userLines(mind.requests[1])).toContain("second");
      }
    });

    test(`takes ${mode} follow-ups only once the run would end`, async () => {
      const mind = new ScriptedMind([says("one"), says("two"), says("three")]);
      const request = taskRequest(mind, { followUpMode: mode });
      request.inbox.followUps.push("first", "second");
      const { outcome } = await drain(request);
      expect(userLines(mind.requests[0])).not.toContain("first");
      if (mode === "all") {
        expect(mind.requests).toHaveLength(2);
        expect(userLines(mind.requests[1])).toEqual([briefText(BRIEF), "first", "second"]);
        expect(outcome).toEqual({ status: "succeeded", report: "two" });
      } else {
        expect(mind.requests).toHaveLength(3);
        expect(userLines(mind.requests[1])).toEqual([briefText(BRIEF), "first"]);
        expect(userLines(mind.requests[2])).toEqual([briefText(BRIEF), "first", "second"]);
        expect(outcome).toEqual({ status: "succeeded", report: "three" });
      }
    });

    test(`resumed on its own reply, a task keeps ${mode} steering`, async () => {
      const mind = new ScriptedMind([says("Processed"), says("Processed")]);
      const store = new MemoryStore(
        { type: "brief", brief: BRIEF },
        { type: "assistant", text: "Initial response", calls: [] },
        { type: "end", outcome: { status: "succeeded", report: "Initial response" } },
      );
      const request = taskRequest(mind, { store, steeringMode: mode });
      request.inbox.steering.push("Steering 1", "Steering 2");
      await drain(request);
      expect(mind.requests).toHaveLength(mode === "all" ? 1 : 2);
      expect(userLines(mind.requests[0])).toContain("Steering 1");
      expect(userLines(mind.requests[0]).includes("Steering 2")).toBe(mode === "all");
    });
  }

  test("keeps steering ahead of a follow-up", async () => {
    const mind = new ScriptedMind([says("done"), says("done")]);
    const request = taskRequest(mind);
    request.inbox.steering.push("steering");
    request.inbox.followUps.push("follow-up");
    await drain(request);
    expect(mind.requests).toHaveLength(2);
    expect(userLines(mind.requests[0])).toContain("steering");
    expect(userLines(mind.requests[0])).not.toContain("follow-up");
    expect(userLines(mind.requests[1])).toContain("follow-up");
  });

  test("resumed on its own reply, a task takes a queued follow-up", async () => {
    const mind = new ScriptedMind([says("Processed")]);
    const store = new MemoryStore(
      { type: "brief", brief: BRIEF },
      { type: "assistant", text: "Initial response", calls: [] },
      { type: "end", outcome: { status: "succeeded", report: "Initial response" } },
    );
    const request = taskRequest(mind, { store });
    request.inbox.followUps.push("Queued follow-up");
    const { outcome } = await drain(request);
    expect(userLines(mind.requests[0])).toContain("Queued follow-up");
    expect(outcome).toEqual({ status: "succeeded", report: "Processed" });
    expect(store.types().slice(3)).toEqual(["resume", "follow-up", "assistant", "end"]);
  });

  test("resumed on its own reply with nothing queued, a task ends on that reply", async () => {
    const mind = new ScriptedMind([]);
    const store = new MemoryStore(
      { type: "brief", brief: BRIEF },
      { type: "assistant", text: "Initial response", calls: [] },
    );
    const { outcome } = await drain(taskRequest(mind, { store }));
    expect(mind.requests).toHaveLength(0);
    expect(outcome).toEqual({ status: "succeeded", report: "Initial response" });
    expect(store.types()).toEqual(["brief", "assistant", "resume", "end"]);
  });

  test("keeps the queued lines when a request fails", async () => {
    const mind = new ScriptedMind([]);
    const request = taskRequest(mind);
    const failing = new ScriptedMind([
      () => {
        request.inbox.steering.push("steering");
        throw new ProviderHttpError("openai", 400, "bad request");
      },
    ]);
    request.inbox.followUps.push("follow-up");
    const { outcome } = await drain({ ...request, mind: failing });
    expect(outcome).toMatchObject({ status: "failed" });
    expect(request.inbox.steering).toEqual(["steering"]);
    expect(request.inbox.followUps).toEqual(["follow-up"]);
  });

  test("keeps the queued lines when the run is cancelled", async () => {
    const controller = new AbortController();
    const request = taskRequest(new ScriptedMind([]), { signal: controller.signal });
    const mind = new ScriptedMind([
      () => {
        request.inbox.steering.push("steering");
        controller.abort();
        return [DONE];
      },
    ]);
    request.inbox.followUps.push("follow-up");
    const { outcome } = await drain({ ...request, mind });
    expect(outcome).toEqual({ status: "cancelled" });
    expect(request.inbox.steering).toEqual(["steering"]);
    expect(request.inbox.followUps).toEqual(["follow-up"]);
  });
});

describe("runTask, as pi's runToolCall", () => {
  test("validates, gates and runs each call, and answers failures with error results", async () => {
    const hooks: string[] = [];
    const updates: string[] = [];
    const echoing = tool(
      "echo",
      async (args, context) => {
        context.onUpdate("partial");
        return result(String(args.value));
      },
      { executionMode: "sequential" },
    );
    const failing = tool(
      "failing",
      async () => result("bad", { isError: true, details: { partial: true } }),
      {
        properties: {},
      },
    );
    const mind = new ScriptedMind([
      calls([
        call("a", "echo", { value: "a" }),
        call("b", "echo", { value: { nested: true } }),
        call("c", "echo", { value: "blocked" }),
        call("d", "missing"),
        call("e", "failing"),
      ]),
      says("done"),
    ]);
    const request = taskRequest(mind, {
      tools: [echoing, failing],
      gate: async (asked) => {
        hooks.push(`before ${asked.id}`);
        return asked.arguments.value === "blocked" ? { block: "nope" } : null;
      },
      afterToolCall: async (asked) => {
        hooks.push(`after ${asked.id}`);
        return undefined;
      },
    });
    const { events } = await drain(request);
    for (const event of events) if (event.type === "tool" && event.text) updates.push(event.text);
    expect(request.store.of("tool-result")).toMatchObject([
      { callId: "a", content: "a", isError: false },
      { callId: "b", isError: true },
      { callId: "c", content: "nope", isError: true },
      { callId: "d", content: "Tool missing not found", isError: true },
      { callId: "e", content: "bad", isError: true, details: { partial: true } },
    ]);
    expect(request.store.of("tool-result")[1]?.content).toStartWith(
      'Validation failed for tool "echo":\n  - value: expected string, got object',
    );
    expect(updates).toEqual(["partial"]);
    expect(hooks).toEqual(["before a", "after a", "before c", "before e", "after e"]);
  });

  test("afterToolCall replaces only what it returns", async () => {
    const overrides = [
      { content: "redacted" },
      { details: { note: "kept" } },
      { isError: true },
      {},
    ];
    const seen: unknown[] = [];
    for (const override of overrides) {
      const mind = new ScriptedMind([
        calls([call("x", "echo", { value: "original" })]),
        says("done"),
      ]);
      const echoing = tool("echo", async () =>
        result("original", { details: { value: "original" } }),
      );
      const request = taskRequest(mind, {
        tools: [echoing],
        afterToolCall: async () => override,
      });
      await drain(request);
      const [stored] = request.store.of("tool-result");
      seen.push({ content: stored?.content, details: stored?.details, isError: stored?.isError });
    }
    expect(seen).toEqual([
      { content: "redacted", details: { value: "original" }, isError: false },
      { content: "original", details: { note: "kept" }, isError: false },
      { content: "original", details: { value: "original" }, isError: true },
      { content: "original", details: { value: "original" }, isError: false },
    ]);
  });
});
