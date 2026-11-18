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

  test("herStart and untoldEnds hand a call her start_task call without the words she said before it, which its seed holds", () => {
    seq = 0;
    const call = at({ ...callOf("c1"), said: "好嘞，我去弄" });
    const started = resultOf("c1", "started", { task: "t1", status: "running" });
    const final = resultOf("c1", "final", SUCCEEDED);
    const { said: _, ...unsaid } = call;
    expect(herStart([call, started], HER, "c1")).toEqual(drafted(unsaid, started));
    expect(untoldEnds([call, started, final], HER)).toEqual([
      { callId: "c1", drafts: drafted(unsaid, started, final) },
    ]);
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
    // An owner's line after it doesn't tell it; hers does, typed or spoken.
    expect(untoldEnds([...events, line(null, "好了吗")], HER)).toHaveLength(1);
    for (const modality of [undefined, "voice"] as const) {
      expect(untoldEnds([...events, line(HER, "做好了", modality)], HER)).toEqual([]);
    }
    // An empty line of hers, as a call's cut-off reply leaves, tells nothing.
    expect(untoldEnds([...events, line(HER, "  ")], HER)).toHaveLength(1);
  });

  test("her line on a call tells none: the call's call-ended tells those it names as told", () => {
    seq = 0;
    const events = [
      callOf("c1"),
      resultOf("c1", "started", { task: "t1", status: "running" }),
      callOf("c2"),
      resultOf("c2", "started", { task: "t2", status: "running" }),
      line(HER, "交给我吧"),
      at({ type: "call-started", call: "k1", persona: HER }),
      resultOf("c1", "final", SUCCEEDED),
      resultOf("c2", "final", SUCCEEDED),
      line(HER, "我们聊点别的吧", "call"),
    ];
    expect(untoldEnds(events, HER).map((end) => end.callId)).toEqual(["c1", "c2"]);
    const ended = (told?: string[]) =>
      at({ type: "call-ended", call: "k1", reason: "hangup", ...(told ? { told } : {}) });
    expect(untoldEnds([...events, ended()], HER).map((end) => end.callId)).toEqual(["c1", "c2"]);
    expect(untoldEnds([...events, ended(["c2"])], HER).map((end) => end.callId)).toEqual(["c1"]);
    expect(untoldEnds([...events, ended(["c1", "c2"])], HER)).toEqual([]);
    // Only a call-ended after the final: one before it named an earlier end.
    expect(untoldEnds([ended(["c1"]), ...events], HER).map((end) => end.callId)).toEqual([
      "c1",
      "c2",
    ]);
  });

  test("a line answering her report turn's nudge tells that end alone; the latest nudge since her last line counts", () => {
    seq = 0;
    const events = [
      callOf("c1"),
      resultOf("c1", "started", { task: "t1", status: "running" }),
      callOf("c2"),
      resultOf("c2", "started", { task: "t2", status: "running" }),
      line(HER, "交给我吧"),
      resultOf("c1", "final", SUCCEEDED),
      resultOf("c2", "final", SUCCEEDED),
      block(HER, taskEndedNudge("c1")),
      // Her report turn's providers record their blocks after her nudge.
      block(HER, `${TASKS_BLOCK_PREFIX}\n任务1……做完了`),
    ];
    const ids = (log: ChatEvent[]) => untoldEnds(log, HER).map((end) => end.callId);
    // Cut off after part of a line, or told whole, it answered c1's nudge alone.
    expect(ids([...events, line(HER, "第一个做")])).toEqual(["c2"]);
    const told = [...events, line(HER, "第一个做好了")];
    expect(ids([...told, block(HER, taskEndedNudge("c2")), line(HER, "第二个也好了")])).toEqual([]);
    // Her next line, with no nudge of hers since the last, tells every end, as any line does.
    expect(ids([...told, line(null, "还有呢"), line(HER, "都好了")])).toEqual([]);
    // Two nudges before her line: the latest is the one she answers.
    expect(ids([...events, block(HER, taskEndedNudge("c2")), line(HER, "第二个好了")])).toEqual([
      "c1",
    ]);
    // A nudge on an end already told is no tell's she answers, nor is another persona's.
    expect(ids([...told, block(HER, taskEndedNudge("c1")), line(HER, "嗯")])).toEqual([]);
    expect(
      ids([...told.slice(0, -3), block(OTHER, taskEndedNudge("c1")), line(HER, "嗯")]),
    ).toEqual([]);
    // Nor does a nudge outlast a line of hers on a call.
    expect(ids([...events, line(HER, "在呢", "call"), line(HER, "都好了")])).toEqual([]);
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
