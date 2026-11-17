import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "@eidolon/chat";
import type { StartTaskFinal } from "@/lib/api";
import { reportStored, type TaskCall, taskCalls } from "./calls";

const TASK = "0196a3c0-0000-7000-8000-000000000001";

function said(seq: number, who: "user" | "mio", text = "…"): ChatEvent {
  return {
    type: "message",
    seq,
    at: seq,
    id: `m${seq}`,
    speaker: who === "user" ? { kind: "user" } : { kind: "persona", id: who },
    text,
  };
}

function call(seq: number, callId: string, args: Record<string, unknown> = {}): ChatEvent {
  return {
    type: "tool-call",
    seq,
    at: seq,
    persona: "mio",
    turn: "t1",
    callId,
    name: "start_task",
    arguments: { goal: "Write a TodoMVC", folder: "/Users/me/todo", ...args },
  };
}

function result(
  seq: number,
  callId: string,
  value: Record<string, unknown>,
  stage?: "started" | "final" | "cancelled",
): ChatEvent {
  return {
    type: "tool-result",
    seq,
    at: seq,
    persona: "mio",
    turn: "t1",
    callId,
    result: value,
    ...(stage === undefined ? {} : { stage }),
  };
}

const final: StartTaskFinal = {
  status: "succeeded",
  report: "Done.",
  files: ["/Users/me/todo/index.html"],
  spentUsd: 0.12,
};

describe("taskCalls", () => {
  test("each start_task call names the task its started result gives, and keeps its final", () => {
    const calls = taskCalls([
      said(1, "user", "Write me a TodoMVC"),
      call(2, "c1"),
      result(3, "c1", { task: TASK, status: "running" }, "started"),
      said(4, "mio", "On it!"),
      result(5, "c1", final, "final"),
    ]);
    expect(calls).toEqual([
      {
        seq: 2,
        callId: "c1",
        persona: "mio",
        goal: "Write a TodoMVC",
        folder: "/Users/me/todo",
        task: TASK,
        final: { seq: 5, result: final },
      },
    ]);
  });

  test("a call whose start was refused, or not yet stored, starts no task", () => {
    const calls = taskCalls([
      call(1, "c1", { folder: "/" }),
      result(2, "c1", { error: "A task can't be granted the whole disk." }),
      call(3, "c2"),
    ]);
    expect(calls.map((entry) => [entry.callId, entry.task])).toEqual([
      ["c1", null],
      ["c2", null],
    ]);
  });

  test("other tools, and results for calls it never saw, are left out", () => {
    const calls = taskCalls([
      { ...call(1, "c1"), name: "take_selfie" } as ChatEvent,
      result(2, "c1", { task: TASK, status: "running" }, "started"),
      result(3, "zz", { task: TASK, status: "running" }, "started"),
    ]);
    expect(calls).toEqual([]);
  });

  test("a call id used again belongs to the newest call with it", () => {
    const other = "0196a3c0-0000-7000-8000-000000000002";
    const calls = taskCalls([
      call(1, "c1"),
      result(2, "c1", { task: TASK, status: "running" }, "started"),
      call(3, "c1", { goal: "Sort my photos" }),
      result(4, "c1", { task: other, status: "awaiting-approval" }, "started"),
      result(5, "c1", final, "final"),
    ]);
    expect(calls.map((entry) => [entry.goal, entry.task, entry.final?.seq ?? null])).toEqual([
      ["Write a TodoMVC", TASK, null],
      ["Sort my photos", other, 5],
    ]);
  });

  test("a final it can't read is no final; text arguments only", () => {
    const [entry] = taskCalls([
      call(1, "c1", { goal: 42, folder: ["/x"] }),
      result(2, "c1", { task: TASK, status: "running" }, "started"),
      result(3, "c1", { status: "exploded" }, "final"),
    ]);
    expect(entry).toMatchObject({ goal: null, folder: null, task: TASK, final: null });
    const [loose] = taskCalls([
      call(1, "c1"),
      result(2, "c1", { task: TASK, status: "running" }, "started"),
      result(3, "c1", { status: "failed" }, "final"),
    ]);
    expect(loose?.final?.result).toEqual({ status: "failed", report: "", files: [], spentUsd: 0 });
  });
});

describe("reportStored", () => {
  const started: ChatEvent[] = [
    said(1, "user", "Write me a TodoMVC"),
    call(2, "c1"),
    result(3, "c1", { task: TASK, status: "running" }, "started"),
    said(4, "mio", "On it!"),
  ];
  const callOf = (events: readonly ChatEvent[]): TaskCall => {
    const [entry] = taskCalls(events);
    if (entry === undefined) throw new Error("no call");
    return entry;
  };

  test("waits for the final, then for her line after it", () => {
    expect(reportStored(started, callOf(started))).toBe(false);
    const ended = [...started, result(5, "c1", final, "final")];
    expect(reportStored(ended, callOf(ended))).toBe(false);
    const told = [...ended, said(6, "mio", "Done! Open index.html.")];
    expect(reportStored(told, callOf(told))).toBe(true);
  });

  test("a report turn that failed counts as her answer", () => {
    const events = [
      ...started,
      result(5, "c1", final, "final"),
      {
        type: "turn-failed",
        seq: 6,
        at: 6,
        persona: "mio",
        turn: "t9",
        error: "Timed out",
      } as const,
    ];
    expect(reportStored(events, callOf(events))).toBe(true);
  });

  test("a task the owner stopped gets its final and no turn", () => {
    const events = [...started, result(5, "c1", { ...final, status: "cancelled" }, "final")];
    expect(reportStored(events, callOf(events))).toBe(true);
  });

  test("her line after one of the owner's may answer the owner instead", () => {
    const events = [
      ...started,
      result(5, "c1", final, "final"),
      said(6, "user", "How is it going?"),
      said(7, "mio", "Almost there."),
    ];
    expect(reportStored(events, callOf(events))).toBe(false);
  });
});
