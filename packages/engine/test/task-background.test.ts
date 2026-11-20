// runTask around its tools' background work: a run that would end waits while the work runs, and
// goes on with each end as a notice; steering, follow-ups, a cancel and a reader leaving all end
// the wait. Then the context's side: a notice is a user line, and a tool may say what masks it.
import { setTimeout as delay } from "node:timers/promises";
import { abortableSleep } from "@eidolon/config";
import { describe, expect, test } from "vitest";
import { contextMessages, taskContext } from "../src/task/context.ts";
import { runTask, type TaskBackground, type TaskEntry } from "../src/task.ts";
import {
  BRIEF,
  call,
  calls,
  drain,
  MemoryStore,
  result,
  ScriptedMind,
  says,
  taskRequest,
  tool,
  toolMessages,
  userLines,
} from "./task-fakes.ts";

const ENDED = "[Command 1 ended with code 0 after 3 s. bash_output with id 1 shows its output.]";

/** Background work that runs while `live` holds, and hands over `ended` when asked. */
class FakeBackground implements TaskBackground {
  live: boolean;
  readonly ended: string[] = [];
  /** Each takeEnded call. */
  takes = 0;

  constructor(live: boolean) {
    this.live = live;
  }

  running(): boolean {
    return this.live;
  }

  takeEnded(): readonly string[] {
    this.takes++;
    return this.ended.splice(0);
  }
}

/** A sleep that returns at once, after running `each` with the number of sleeps so far. */
function sleeps(each: (n: number) => void): (ms: number, signal: AbortSignal) => Promise<void> {
  let n = 0;
  return async (_ms, signal) => {
    each(++n);
    signal.throwIfAborted();
  };
}

describe("a run with background work", () => {
  test("waits while it runs, then goes on with its end as a notice and a user line", async () => {
    const background = new FakeBackground(true);
    const mind = new ScriptedMind([says("Waiting for the build."), says("It built.")]);
    const request = taskRequest(mind, {
      background,
      sleep: sleeps((n) => {
        if (n < 2) return;
        background.live = false;
        background.ended.push(ENDED);
      }),
    });
    const { events, outcome } = await drain(request);
    expect(outcome).toEqual({ status: "succeeded", report: "It built." });
    expect(request.store.types()).toEqual(["brief", "assistant", "notice", "assistant", "end"]);
    expect(request.store.of("notice")).toMatchObject([{ text: ENDED }]);
    expect(userLines(mind.requests[1]).at(-1)).toBe(ENDED);
    expect(events.filter((event) => event.type === "wait")).toHaveLength(2);
  });

  test("ends at once when nothing runs and no end waits", async () => {
    const mind = new ScriptedMind([says("Done.")]);
    const { events, outcome } = await drain(
      taskRequest(mind, { background: new FakeBackground(false) }),
    );
    expect(outcome).toEqual({ status: "succeeded", report: "Done." });
    expect(events.some((event) => event.type === "wait")).toBe(false);
    expect(mind.requests).toHaveLength(1);
  });

  test("a notice that comes during a sequential batch skips none of its calls", async () => {
    const background = new FakeBackground(false);
    const ran: string[] = [];
    const step = (name: string) =>
      tool(
        name,
        async () => {
          ran.push(name);
          if (name === "first") background.ended.push(ENDED);
          return result(`${name} done`);
        },
        { executionMode: "sequential" },
      );
    const mind = new ScriptedMind([
      calls([call("c1", "first"), call("c2", "second")]),
      says("Both ran."),
    ]);
    const request = taskRequest(mind, { tools: [step("first"), step("second")], background });
    expect((await drain(request)).outcome).toEqual({ status: "succeeded", report: "Both ran." });
    expect(ran).toEqual(["first", "second"]);
    expect(toolMessages(mind.requests[1])).toEqual([
      ["c1", "first done"],
      ["c2", "second done"],
    ]);
    expect(request.store.types()).toEqual([
      "brief",
      "assistant",
      "tool-start",
      "tool-result",
      "tool-start",
      "tool-result",
      "notice",
      "assistant",
      "end",
    ]);
  });

  test("a steering line ends the wait", async () => {
    const background = new FakeBackground(true);
    const mind = new ScriptedMind([says("Waiting."), says("Stopped waiting.")]);
    const request = taskRequest(mind, {
      background,
      sleep: sleeps(() => {
        request.inbox.steering.push("Don't wait for it");
        background.live = false;
      }),
    });
    expect((await drain(request)).outcome).toEqual({
      status: "succeeded",
      report: "Stopped waiting.",
    });
    expect(request.store.types()).toEqual(["brief", "assistant", "steer", "assistant", "end"]);
    expect(userLines(mind.requests[1]).at(-1)).toBe("Don't wait for it");
  });

  test("a follow-up ends the wait", async () => {
    const background = new FakeBackground(true);
    const mind = new ScriptedMind([says("Waiting."), says("Added the README too.")]);
    const request = taskRequest(mind, {
      background,
      sleep: sleeps(() => {
        request.inbox.followUps.push("Add a README");
        background.live = false;
      }),
    });
    await drain(request);
    expect(request.store.types()).toEqual(["brief", "assistant", "follow-up", "assistant", "end"]);
  });

  test("a cancel during the wait ends the task cancelled, with nothing after its end", async () => {
    const controller = new AbortController();
    const background = new FakeBackground(true);
    const request = taskRequest(new ScriptedMind([says("Waiting.")]), {
      background,
      signal: controller.signal,
      sleep: (_ms, signal) => {
        controller.abort();
        return abortableSleep(1000, signal);
      },
    });
    expect((await drain(request)).outcome).toEqual({ status: "cancelled" });
    expect(request.store.types()).toEqual(["brief", "assistant", "end"]);
    expect(request.store.list.at(-1)).toMatchObject({ outcome: { status: "cancelled" } });
  });

  test("a reader that leaves during the wait stops the run at its next wait, storing nothing", async () => {
    const background = new FakeBackground(true);
    const request = taskRequest(new ScriptedMind([says("Waiting.")]), {
      background,
      sleep: (_ms, signal) => abortableSleep(20, signal),
    });
    const run = runTask(request);
    for (;;) {
      const next = await run.next();
      if (next.done) throw new Error("The run ended before it waited");
      if (next.value.type === "wait") break;
    }
    // The manager's read is pending when it leaves, so return() waits behind it.
    const pending = run.next();
    const left = Date.now();
    const returned = await run.return({ status: "cancelled" });
    expect(Date.now() - left).toBeLessThan(1000);
    expect(returned.done).toBe(true);
    await pending;
    const takes = background.takes;
    await delay(60);
    expect(background.takes).toBe(takes);
    expect(request.store.types()).toEqual(["brief", "assistant"]);
  });

  test("a resume from a reply with no calls goes on when an end waits", async () => {
    const background = new FakeBackground(false);
    background.ended.push(ENDED);
    const store = new MemoryStore(
      { type: "brief", brief: BRIEF },
      { type: "assistant", text: "Waiting for the build.", calls: [], finishReason: "stop" },
    );
    const mind = new ScriptedMind([says("It built.")]);
    const { outcome } = await drain(taskRequest(mind, { store, background }));
    expect(outcome).toEqual({ status: "succeeded", report: "It built." });
    expect(store.types()).toEqual(["brief", "assistant", "resume", "notice", "assistant", "end"]);
    expect(userLines(mind.requests[0]).at(-1)).toBe(ENDED);
  });

  test("a resume from a reply with no calls waits for work still running", async () => {
    const background = new FakeBackground(true);
    const store = new MemoryStore(
      { type: "brief", brief: BRIEF },
      { type: "assistant", text: "Waiting.", calls: [], finishReason: "stop" },
    );
    const mind = new ScriptedMind([says("It built.")]);
    const request = taskRequest(mind, {
      store,
      background,
      sleep: sleeps(() => {
        background.live = false;
        background.ended.push(ENDED);
      }),
    });
    expect((await drain(request)).outcome).toEqual({ status: "succeeded", report: "It built." });
    expect(store.types()).toEqual(["brief", "assistant", "resume", "notice", "assistant", "end"]);
  });

  test("tells a running tool whether a steering line waits", async () => {
    const seen: (boolean | undefined)[] = [];
    const mind = new ScriptedMind([calls([call("c1", "peek")]), says("Done.")]);
    const request = taskRequest(mind, {
      tools: [
        tool("peek", async (_args, context) => {
          seen.push(context.steered?.());
          request.inbox.steering.push("Hurry");
          seen.push(context.steered?.());
          return result("peeked");
        }),
      ],
    });
    await drain(request);
    expect(seen).toEqual([false, true]);
  });
});

describe("the context around background work", () => {
  test("a notice is a user line, where the run stored it", () => {
    const entries = [
      { type: "brief", brief: BRIEF },
      { type: "notice", text: ENDED },
    ].map((draft, at) => ({ ...draft, seq: at + 1, at: 1000 + at })) as TaskEntry[];
    expect(contextMessages(taskContext(entries), 40_000)).toEqual([
      { role: "user", content: expect.stringContaining("Goal: Write a TodoMVC") },
      { role: "user", content: ENDED },
    ]);
  });

  test("a masked result is its tool's own stub where it has one, and pi's otherwise", async () => {
    const command = tool("bash", async () => result("x".repeat(2000), { details: { id: 7 } }), {
      elided: (details, characters) =>
        `[command ${(details as { id: number }).id} returned ${characters} characters]`,
    });
    const quiet = tool("quiet", async () => result("q".repeat(2000)), { elided: () => undefined });
    const read = tool("read", async () => result("y".repeat(2000)));
    const mind = new ScriptedMind([
      calls([call("c-a", "bash", { value: "npm test" })]),
      calls([call("c-b", "quiet", { value: "b" })]),
      calls([call("c-c", "read", { value: "c" })]),
      calls([call("c-d", "read", { value: "d" })]),
      says("done"),
    ]);
    await drain(
      taskRequest(mind, {
        tools: [command, quiet, read],
        limits: { contextTokens: 128_000, spendPauseUsd: 0, maskAfterTokens: 500 },
      }),
    );
    const piStub = (name: string, value: string) =>
      `[Result elided to save context: ${name} {"value":"${value}"} returned 2000 characters. ` +
      "Run it again if you need them.]";
    expect(toolMessages(mind.requests[4])).toEqual([
      ["c-a", "[command 7 returned 2000 characters]"],
      ["c-b", piStub("quiet", "b")],
      ["c-c", piStub("read", "c")],
      ["c-d", "y".repeat(2000)],
    ]);
  });
});
