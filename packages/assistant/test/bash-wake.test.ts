// A task's run around its commands, on the real loop and real processes: a worker that ends its
// reply while a command runs is woken by how it ended, and a server stopping during that wait
// leaves the end for the run that resumes.
import { setTimeout as delay } from "node:timers/promises";
import { abortableSleep } from "@eidolon/config";
import {
  type Mind,
  type MindChunk,
  type MindRequest,
  type MindToolCall,
  runTask,
  type TaskBackground,
  type TaskEvent,
  type TaskOutcome,
  type TaskRequest,
  type TaskStore,
} from "@eidolon/engine";
import { afterAll, describe, expect, test } from "vitest";
import { createBashTools } from "../src/tools/bash.ts";
import { BashJobs } from "../src/tools/jobs.ts";
import { bashOffered } from "../src/tools/shell.ts";
import { openTaskStore } from "../src/transcript.ts";
import { folderGuard, removeTempFolders, tempFolder } from "./tool-folder.ts";

afterAll(removeTempFolders);

/** Answers its nth request with `replies[n]`, and with a bare reply after them. */
class ScriptedMind implements Mind {
  readonly requests: MindRequest[] = [];
  readonly #replies: readonly MindChunk[][];

  constructor(replies: readonly MindChunk[][]) {
    this.#replies = replies;
  }

  async *stream(request: MindRequest): AsyncGenerator<MindChunk> {
    this.requests.push(request);
    yield* this.#replies[this.requests.length - 1] ?? [{ type: "done", finishReason: "stop" }];
  }
}

function calls(...made: MindToolCall[]): MindChunk[] {
  return [
    { type: "tool-calls", calls: made },
    { type: "done", finishReason: "tool_calls" },
  ];
}

function says(text: string): MindChunk[] {
  return [
    { type: "text", text },
    { type: "done", finishReason: "stop" },
  ];
}

function userLines(request: MindRequest | undefined): string[] {
  return (request?.messages ?? []).flatMap((message) => {
    const { role, content } = message as Record<string, unknown>;
    return role === "user" ? [String(content)] : [];
  });
}

function toolMessages(request: MindRequest | undefined): string[] {
  return (request?.messages ?? []).flatMap((message) => {
    const { role, content } = message as Record<string, unknown>;
    return role === "tool" ? [String(content)] : [];
  });
}

interface Task {
  readonly dir: string;
  readonly folder: string;
}

async function newTask(): Promise<Task> {
  const dir = await tempFolder();
  const folder = await tempFolder();
  await openTaskStore(dir).append({
    type: "brief",
    brief: { goal: "Build it", deliverable: "dist/", folder, check: "It builds" },
  });
  return { dir, folder };
}

function request(
  task: Task,
  mind: Mind,
  jobs: BashJobs,
  more: { store?: TaskStore; background?: TaskBackground } = {},
): TaskRequest {
  return {
    id: "task-1",
    mind,
    system: "You do the work.",
    tools: createBashTools(folderGuard(task.folder), jobs),
    store: more.store ?? openTaskStore(task.dir),
    inbox: { hasSteering: () => false, takeSteering: () => [], takeFollowUps: () => [] },
    meter: {
      spentUsd: () => 0,
      lastInputTokens: () => null,
      unpriced: () => null,
      requestEnded() {},
    },
    limits: { contextTokens: 128_000, spendPauseUsd: 0 },
    compaction: { system: "You summarize.", instructions: "Summarize." },
    background: more.background ?? jobs,
    signal: new AbortController().signal,
    sleep: (_ms, signal) => abortableSleep(50, signal),
  };
}

async function drain(
  reader: AsyncGenerator<TaskEvent, TaskOutcome>,
): Promise<{ events: TaskEvent[]; outcome: TaskOutcome }> {
  const events: TaskEvent[] = [];
  for (;;) {
    const next = await reader.next();
    if (next.done) return { events, outcome: next.value };
    events.push(next.value);
  }
}

describe.skipIf(!bashOffered())("a task's run around its commands", () => {
  test("waits for a command in the background, then goes on with how it ended", async () => {
    const task = await newTask();
    const jobs = await BashJobs.open(task.dir, { yieldMs: 200 });
    const mind = new ScriptedMind([
      calls({
        id: "c1",
        name: "bash",
        arguments: { command: "echo started; sleep 0.6; echo finished" },
      }),
      says("Waiting for the build."),
      calls({ id: "c2", name: "bash_output", arguments: { id: 1 } }),
      says("It built."),
    ]);
    const { events, outcome } = await drain(runTask(request(task, mind, jobs)));
    expect(outcome).toEqual({ status: "succeeded", report: "It built." });
    expect(toolMessages(mind.requests[1])[0]).toStartWith(
      "Command 1 is still running after 0.2 s, so it moved to the background.",
    );
    const notice = userLines(mind.requests[2]).at(-1);
    expect(notice).toMatch(
      /^\[Command 1 ended with code 0 after [\d.]+ s\. bash_output with id 1 shows its output\.\]$/,
    );
    expect(toolMessages(mind.requests[3]).at(-1)).toMatch(/\n\nstarted\nfinished\n$/);
    expect(events.some((event) => event.type === "wait")).toBe(true);
    const stored = await openTaskStore(task.dir).entries();
    expect(stored.map((entry) => entry.type)).toEqual([
      "brief",
      "assistant",
      "tool-start",
      "tool-result",
      "assistant",
      "notice",
      "assistant",
      "tool-start",
      "tool-result",
      "assistant",
      "end",
    ]);
  });

  test("a stop during the wait stores nothing, and the resumed run hears the command was stopped", async () => {
    const task = await newTask();
    const jobs = await BashJobs.open(task.dir, { yieldMs: 200 });
    const leave = new AbortController();
    const store = openTaskStore(task.dir);
    // The manager's: a store that takes nothing once the run is left.
    const untilLeft: TaskStore = {
      entries: () => store.entries(),
      append: (draft) =>
        leave.signal.aborted
          ? Promise.reject(new Error("The task was interrupted"))
          : store.append(draft),
    };
    const mind = new ScriptedMind([
      calls({ id: "c1", name: "bash", arguments: { command: "sleep 30" } }),
      says("Waiting for the server."),
    ]);
    const reader = runTask(
      request(task, mind, jobs, { store: untilLeft, background: jobs.forRun(leave.signal) }),
    );
    for (;;) {
      const next = await reader.next();
      if (next.done) throw new Error("The run ended before it waited");
      if (next.value.type === "wait") break;
    }
    // As the manager's stop does: its read is pending when it leaves, and only then returns.
    const pending = reader.next().catch(() => {});
    leave.abort();
    const returned = reader.return({ status: "cancelled" }).catch(() => {});
    await jobs.killAll("shutdown");
    await Promise.race([Promise.all([pending, returned]), delay(2000)]);
    const before = (await store.entries()).map((entry) => entry.type);
    expect(before).toEqual(["brief", "assistant", "tool-start", "tool-result", "assistant"]);

    const resumed = new ScriptedMind([says("The server stopped with Eidolon; I'll leave it.")]);
    const next = await BashJobs.open(task.dir, { yieldMs: 200 });
    const { outcome } = await drain(runTask(request(task, resumed, next)));
    expect(outcome).toEqual({
      status: "succeeded",
      report: "The server stopped with Eidolon; I'll leave it.",
    });
    expect(userLines(resumed.requests[0]).at(-1)).toBe(
      "[Command 1 was stopped when Eidolon stopped; run it again if it's still needed.]",
    );
  });
});
