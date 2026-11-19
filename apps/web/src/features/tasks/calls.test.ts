import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "@eidolon/chat";
import type { StartTaskFinal } from "@/lib/api";
import { taskEndedNudge } from "../../../../bot/src/local/tasks/tool.ts";
import { reportStored, type TaskCall, taskCalls } from "./calls";

const TASK = "0196a3c0-0000-7000-8000-000000000001";

function said(seq: number, who: "user" | "mio", text = "…", modality?: "call"): ChatEvent {
  return {
    type: "message",
    seq,
    at: seq,
    id: `m${seq}`,
    speaker: who === "user" ? { kind: "user" } : { kind: "persona", id: who },
    text,
    ...(modality === undefined ? {} : { modality }),
  };
}

/** Her report turn's nudge on call `callId`, as the runner stores it before her line. */
function nudged(seq: number, callId: string, persona = "mio"): ChatEvent {
  const content = taskEndedNudge(callId);
  return {
    type: "context",
    seq,
    at: seq,
    persona,
    turn: "t9",
    position: 4,
    role: "developer",
    content,
  };
}

function callEnded(seq: number, told?: string[]): ChatEvent {
  return {
    type: "call-ended",
    seq,
    at: seq,
    call: "k1",
    reason: "hangup",
    ...(told === undefined ? {} : { told }),
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

  test("waits for the final, then for her line after her report turn's nudge", () => {
    expect(reportStored(started, callOf(started))).toBe(false);
    const ended = [...started, result(5, "c1", final, "final")];
    expect(reportStored(ended, callOf(ended))).toBe(false);
    const asked = [...ended, nudged(6, "c1")];
    expect(reportStored(asked, callOf(asked))).toBe(false);
    const told = [...asked, said(7, "mio", "Done! Open index.html.")];
    expect(reportStored(told, callOf(told))).toBe(true);
  });

  test("a report turn that failed counts as her answer; her answer to the owner failing doesn't", () => {
    const failed = (seq: number): ChatEvent => ({
      type: "turn-failed",
      seq,
      at: seq,
      persona: "mio",
      turn: "t9",
      error: "Timed out",
    });
    const events = [...started, result(5, "c1", final, "final"), nudged(6, "c1"), failed(7)];
    expect(reportStored(events, callOf(events))).toBe(true);
    const answer = [...started, result(5, "c1", final, "final"), said(6, "user", "Hi"), failed(7)];
    expect(reportStored(answer, callOf(answer))).toBe(false);
    // Told one at a time after a call, the first's failed report turn leaves the second's to come.
    const two = [
      ...started,
      call(5, "c2"),
      result(6, "c2", { task: `${TASK.slice(0, -1)}2`, status: "running" }, "started"),
      result(7, "c1", final, "final"),
      result(8, "c2", final, "final"),
      callEnded(9),
      nudged(10, "c1"),
      failed(11),
    ];
    const [first, second] = taskCalls(two) as [TaskCall, TaskCall];
    expect(reportStored(two, first)).toBe(true);
    expect(reportStored(two, second)).toBe(false);
  });

  test("her words before a tool call after the nudge are her report, though no line of hers follows", () => {
    const before = (seq: number, words: string, persona = "mio"): ChatEvent => ({
      type: "tool-call",
      seq,
      at: seq,
      persona,
      turn: "t9",
      callId: `s${seq}`,
      name: "recall_streams",
      arguments: {},
      said: words,
    });
    const ended = [...started, result(5, "c1", final, "final")];
    const asked = [...ended, nudged(6, "c1")];
    const cut = [...asked, before(7, "Done! Let me find what you asked for.")];
    expect(reportStored(cut, callOf(cut))).toBe(true);
    // Not before the nudge, nor only whitespace, nor another persona's.
    const early = [...ended, before(6, "Hmm, let me look.")];
    expect(reportStored(early, callOf(early))).toBe(false);
    expect(reportStored([...asked, before(7, "  ")], callOf(asked))).toBe(false);
    expect(reportStored([...asked, before(7, "Done!", "bea")], callOf(asked))).toBe(false);
  });

  test("a message of hers with no words after the nudge isn't her report", () => {
    // A selfie her interrupted turn left rendering, stored through the chat's queue as it lands.
    const photos: ChatEvent = {
      type: "message",
      seq: 7,
      at: 7,
      id: "m7",
      speaker: { kind: "persona", id: "mio" },
      text: "",
      attachments: [{ kind: "image", name: `${"a".repeat(64)}.png`, mime: "image/png" }],
    };
    const asked = [...started, result(5, "c1", final, "final"), nudged(6, "c1")];
    expect(reportStored([...asked, photos], callOf(asked))).toBe(false);
    expect(reportStored([...asked, said(7, "mio", " \n")], callOf(asked))).toBe(false);
    const told = [...asked, photos, said(8, "mio", "Done! Open index.html.")];
    expect(reportStored(told, callOf(told))).toBe(true);
  });

  test("a task the owner stopped gets its final and no turn", () => {
    const events = [...started, result(5, "c1", { ...final, status: "cancelled" }, "final")];
    expect(reportStored(events, callOf(events))).toBe(true);
  });

  test("her line answering the owner's isn't her report, unless her report turn's nudge came first", () => {
    const events = [
      ...started,
      result(5, "c1", final, "final"),
      said(6, "user", "How is it going?"),
      said(7, "mio", "Almost there."),
    ];
    expect(reportStored(events, callOf(events))).toBe(false);
    // The owner's line cut her report turn short: nothing more is coming.
    const cut = [...started, result(5, "c1", final, "final"), nudged(6, "c1"), ...events.slice(-2)];
    expect(reportStored(cut, callOf(cut))).toBe(true);
  });

  test("her lines on a call don't report it; the call's end naming it as told does, else her report turn after", () => {
    // Her answer to another line, under way as the task ended, then the hang-up.
    const hers = [
      ...started,
      result(5, "c1", final, "final"),
      said(6, "mio", "Sunny!", "call"),
      callEnded(7),
    ];
    expect(reportStored(hers, callOf(hers))).toBe(false);
    const during = [
      ...started,
      result(5, "c1", final, "final"),
      said(6, "user", "What's the weather like?", "call"),
      said(7, "mio", "Sunny!", "call"),
    ];
    const untold = [...during, callEnded(8)];
    expect(reportStored(untold, callOf(untold))).toBe(false);
    const other = [...during, callEnded(8, ["c9"])];
    expect(reportStored(other, callOf(other))).toBe(false);
    const toldThere = [...during, callEnded(8, ["c1"])];
    expect(reportStored(toldThere, callOf(toldThere))).toBe(true);
    // After a call that left it untold, the owner's line and her answer come before her report.
    const answered = [...untold, said(9, "user", "Hi again"), said(10, "mio", "Hi!")];
    expect(reportStored(answered, callOf(answered))).toBe(false);
    const reported = [...answered, nudged(11, "c1"), said(12, "mio", "The page is done.")];
    expect(reportStored(reported, callOf(reported))).toBe(true);
    // Her report turn cut by a call before she wrote: the call is handed the end.
    const redialed = [...untold, nudged(9, "c1"), said(10, "mio", "Hi again!", "call")];
    expect(reportStored(redialed, callOf(redialed))).toBe(false);
    // Nor does her answer in text after that call: its seed held no nudge.
    const after = [...redialed, callEnded(11), said(12, "user", "Hi"), said(13, "mio", "Hello!")];
    expect(reportStored(after, callOf(after))).toBe(false);
  });

  test("another task's report, or another persona's nudge, doesn't end the wait", () => {
    const events = [
      said(1, "user", "Write me two pages"),
      call(2, "c1"),
      result(3, "c1", { task: TASK, status: "running" }, "started"),
      call(4, "c2"),
      result(5, "c2", { task: `${TASK.slice(0, -1)}2`, status: "running" }, "started"),
      said(6, "mio", "On it!"),
      result(7, "c1", final, "final"),
      result(8, "c2", final, "final"),
      nudged(9, "c1"),
      said(10, "mio", "The first is done."),
    ];
    const second = taskCalls(events)[1] as TaskCall;
    expect(reportStored(events, second)).toBe(false);
    const elsewhere = [...events, nudged(11, "c2", "bea"), said(12, "mio", "…")];
    expect(reportStored(elsewhere, second)).toBe(false);
    const told = [...events, nudged(11, "c2"), said(12, "mio", "So is the second.")];
    expect(reportStored(told, second)).toBe(true);
  });
});
