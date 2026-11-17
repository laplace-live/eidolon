// What a call takes of her tasks from its chat: a seed without the stored status block or her task
// nudges, a group call's views without them, her start_task calls as drafts for the call's log, and
// the ends she never told.
import { describe, expect, test } from "bun:test";
import type { ChatEvent, ChatEventDraft, ViewMessage } from "@eidolon/chat";
import {
  herStart,
  staleTaskContext,
  untoldEnds,
  withoutTaskContext,
} from "../../src/local/tasks/calls.ts";
import { TASKS_BLOCK_PREFIX } from "../../src/local/tasks/status.ts";
import { taskEndedNudge, taskWaitingNudge } from "../../src/local/tasks/tool.ts";

const HER = "milky-green";
const OTHER = "second-persona";

describe("withoutTaskContext", () => {
  test("drops the status block and her task nudges, and keeps every other message", () => {
    const seed: ViewMessage[] = [
      { role: "developer", content: "记住：对方喜欢猫" },
      { role: "user", content: "帮我写个网页" },
      { role: "assistant", content: "交给我吧" },
      { role: "developer", content: `${TASKS_BLOCK_PREFIX}\n任务1……正在做` },
      { role: "user", content: "弄好了吗" },
      { role: "developer", content: taskEndedNudge("call_1") },
      { role: "developer", content: taskWaitingNudge("call_2") },
      { role: "system", content: `${TASKS_BLOCK_PREFIX}一段系统块` },
      { role: "user", content: `${TASKS_BLOCK_PREFIX}对方自己打的字` },
      { role: "assistant", content: taskEndedNudge("call_9") },
    ];
    expect(withoutTaskContext(seed)).toEqual([
      { role: "developer", content: "记住：对方喜欢猫" },
      { role: "user", content: "帮我写个网页" },
      { role: "assistant", content: "交给我吧" },
      { role: "user", content: "弄好了吗" },
      { role: "system", content: `${TASKS_BLOCK_PREFIX}一段系统块` },
      { role: "user", content: `${TASKS_BLOCK_PREFIX}对方自己打的字` },
      { role: "assistant", content: taskEndedNudge("call_9") },
    ]);
  });
});

let seq = 0;

function at<E extends ChatEventDraft>(draft: E): E & { seq: number; at: number } {
  seq++;
  return { ...draft, seq, at: 1000 + seq };
}

const line = (who: string | null, text: string, modality?: "call" | "voice"): ChatEvent =>
  at({
    type: "message",
    id: `m${seq}`,
    speaker: who === null ? { kind: "user" } : { kind: "persona", id: who },
    text,
    ...(modality === undefined ? {} : { modality }),
  });

const callOf = (callId: string, persona = HER, name = "start_task") =>
  at({
    type: "tool-call",
    persona,
    turn: "t1",
    callId,
    name,
    arguments: { goal: "写一个网页", folder: "~/site" },
  } as const);

const resultOf = (
  callId: string,
  stage: "started" | "final" | "cancelled",
  result: Record<string, unknown>,
  persona = HER,
) => at({ type: "tool-result", persona, turn: "t1", callId, result, stage } as const);

const drafted = (...events: ChatEvent[]): ChatEventDraft[] =>
  events.map(({ seq: _, at: __, ...draft }) => draft as ChatEventDraft);

const SUCCEEDED = { status: "succeeded", report: "Done.", files: [], spentUsd: 0.1 };

const block = (persona: string, content: string, role: "developer" | "system" = "developer") =>
  at({ type: "context", persona, turn: "t1", position: 0, role, content } as const);

describe("staleTaskContext", () => {
  test("takes each persona's stored status blocks and task nudges out of her view, and nothing else", () => {
    seq = 0;
    const old = block(HER, `${TASKS_BLOCK_PREFIX}\n任务1……还没开始`);
    const events: ChatEvent[] = [
      line(null, "帮我写个网页"),
      old,
      at({ type: "context-removed", persona: HER, turn: "t2", seqs: [old.seq] }),
      block(HER, `${TASKS_BLOCK_PREFIX}\n任务1……正在做`),
      block(HER, taskEndedNudge("c1")),
      block(HER, "记住：对方喜欢猫"),
      block(HER, `${TASKS_BLOCK_PREFIX}一段系统块`, "system"),
      block(OTHER, taskWaitingNudge("c2")),
      line(HER, "做好啦"),
    ];
    expect(staleTaskContext(events, "call-1")).toEqual([
      { type: "context-removed", persona: HER, turn: "call-1", seqs: [4, 5] },
      { type: "context-removed", persona: OTHER, turn: "call-1", seqs: [8] },
    ]);
    expect(staleTaskContext(events.slice(0, 3), "call-1")).toEqual([]);
  });
});

describe("herStart", () => {
  test("her start_task call and its started result, as drafts; the latest with the id", () => {
    seq = 0;
    const old = callOf("c1");
    const oldStart = resultOf("c1", "started", { task: "t-old", status: "running" });
    const call = callOf("c1");
    const started = resultOf("c1", "started", { task: "t1", status: "awaiting-approval" });
    const events = [line(null, "帮我写个网页"), old, oldStart, call, started, line(HER, "好")];
    expect(herStart(events, HER, "c1")).toEqual(drafted(call, started));
    expect(herStart(events, OTHER, "c1")).toEqual([]);
    expect(herStart(events, HER, "c9")).toEqual([]);
    // A start the manager is still answering has no started result yet.
    const lone = callOf("c2");
    expect(herStart([lone], HER, "c2")).toEqual(drafted(lone));
    // Nor is another tool's call hers to start a task with.
    expect(herStart([callOf("c3", HER, "take_selfie")], HER, "c3")).toEqual([]);
  });
});

describe("untoldEnds", () => {
  test("a final of hers no line of hers came after, with its call and started result", () => {
    seq = 0;
    const call = callOf("c1");
    const started = resultOf("c1", "started", { task: "t1", status: "running" });
    const final = resultOf("c1", "final", SUCCEEDED);
    const events = [line(null, "帮我写个网页"), call, started, line(HER, "交给我吧"), final];
    expect(untoldEnds(events, HER)).toEqual([
      { callId: "c1", drafts: drafted(call, started, final) },
    ]);
    // An owner's line after it doesn't tell it; hers does, typed, spoken or on a call.
    expect(untoldEnds([...events, line(null, "好了吗")], HER)).toHaveLength(1);
    for (const modality of [undefined, "voice", "call"] as const) {
      expect(untoldEnds([...events, line(HER, "做好了", modality)], HER)).toEqual([]);
    }
    // An empty line of hers, as a call's cut-off reply leaves, tells nothing.
    expect(untoldEnds([...events, line(HER, "  ")], HER)).toHaveLength(1);
  });

  test("never a cancelled end, another persona's, or another tool's", () => {
    seq = 0;
    const events = [
      callOf("c1"),
      resultOf("c1", "started", { task: "t1", status: "running" }),
      resultOf("c1", "final", { status: "cancelled", report: "", files: [], spentUsd: 0 }),
      callOf("c2", OTHER),
      resultOf("c2", "started", { task: "t2", status: "running" }, OTHER),
      resultOf("c2", "final", SUCCEEDED, OTHER),
      callOf("c3", HER, "take_selfie"),
      resultOf("c3", "started", {}),
      resultOf("c3", "final", { status: "succeeded" }),
      resultOf("c4", "final", SUCCEEDED),
    ];
    expect(untoldEnds(events, HER)).toEqual([]);
    expect(untoldEnds(events, OTHER).map((each) => each.callId)).toEqual(["c2"]);
  });

  test("each untold one, in the order they ended, a start with no started result as its call", () => {
    seq = 0;
    const first = callOf("c1");
    const firstStarted = resultOf("c1", "started", { task: "t1", status: "running" });
    const second = callOf("c2");
    const told = callOf("c0");
    const events = [
      told,
      resultOf("c0", "final", SUCCEEDED),
      line(HER, "上一个做好了"),
      first,
      firstStarted,
      second,
      resultOf("c2", "final", { status: "failed", report: "No model", files: [], spentUsd: 0 }),
      resultOf("c1", "final", SUCCEEDED),
    ];
    const ends = untoldEnds(events, HER);
    expect(ends.map((each) => each.callId)).toEqual(["c2", "c1"]);
    expect(ends[0]?.drafts.map((each) => each.type)).toEqual(["tool-call", "tool-result"]);
    expect(ends[1]?.drafts.slice(0, 2)).toEqual(drafted(first, firstStarted));
  });
});
