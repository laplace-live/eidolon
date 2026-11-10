import { describe, expect, test } from "bun:test";
import type { ChatEvent, ChatHeader } from "@eidolon/chat";
import {
  IDLE,
  LATE_POLL_MS,
  type LiveAction,
  type LiveState,
  latePoll,
  mergeEvents,
  reduceLive,
} from "./stream";

const HEADER: ChatHeader = {
  format: 1,
  id: "01900000-0000-7000-8000-000000000000",
  createdAt: 0,
  participants: ["mio"],
};

function userLine(seq: number, text: string): ChatEvent {
  return { type: "message", seq, at: seq, id: `u${seq}`, speaker: { kind: "user" }, text };
}

function herLine(seq: number, text: string, interrupted = false): ChatEvent {
  return {
    type: "message",
    seq,
    at: seq,
    id: `m${seq}`,
    speaker: { kind: "persona", id: "mio" },
    text,
    ...(interrupted ? { interrupted } : {}),
  };
}

function decision(seq: number, after: number): ChatEvent {
  return {
    type: "decision",
    seq,
    at: seq,
    after,
    replies: [{ persona: "mio", mode: "text" }],
    source: "single",
  };
}

const run = (actions: readonly LiveAction[], from: LiveState = IDLE) =>
  actions.reduce(reduceLive, from);

describe("reduceLive", () => {
  test("a reply streams in, and her stored message takes its place", () => {
    const streaming = run([
      { type: "sending", key: 1, after: 2, text: "你好" },
      { type: "events", events: [userLine(3, "你好")] },
      { type: "events", events: [decision(4, 3)] },
      { type: "started", turn: "t1", persona: "mio" },
      { type: "delta", turn: "t1", text: "[开心]哈" },
      { type: "delta", turn: "t1", text: "喽" },
    ]);
    expect(streaming.pending).toBeNull();
    expect(streaming.turn).toEqual({
      id: "t1",
      persona: "mio",
      after: 4,
      text: "[开心]哈喽",
      tool: null,
    });

    const stored = run([{ type: "events", events: [herLine(5, "[开心]哈喽")] }], streaming);
    expect(stored.turn).toBeNull();
    expect(run([{ type: "ended", turn: "t1" }], stored)).toEqual(stored);
  });

  test("a tool shows while it runs, and only for the turn running it", () => {
    const started = run([{ type: "started", turn: "t1", persona: "mio" }]);
    const running = run(
      [{ type: "tool", turn: "t1", name: "take_selfie", state: "running" }],
      started,
    );
    expect(running.turn?.tool).toBe("take_selfie");
    expect(run([{ type: "tool", turn: "t0", name: "x", state: "running" }], started)).toEqual(
      started,
    );
    expect(
      run([{ type: "tool", turn: "t1", name: "take_selfie", state: "failed" }], running).turn?.tool,
    ).toBeNull();
  });

  test("the interrupted reply's tail, arriving after the next reply started, leaves it alone", () => {
    const first = run([
      { type: "started", turn: "a", persona: "mio" },
      { type: "delta", turn: "a", text: "我在" },
    ]);
    // The viewer sends: her line is stored after seq 9, then the new reply starts.
    const second = run(
      [
        { type: "sending", key: 1, after: 9, text: "等等" },
        { type: "events", events: [userLine(11, "等等"), decision(12, 11)] },
        { type: "started", turn: "b", persona: "mio" },
        { type: "delta", turn: "b", text: "好" },
      ],
      first,
    );
    const tail = run(
      [
        { type: "events", events: [herLine(10, "我在", true)] },
        { type: "delta", turn: "a", text: "说" },
        { type: "ended", turn: "a" },
      ],
      second,
    );
    expect(tail.turn).toEqual({ id: "b", persona: "mio", after: 12, text: "好", tool: null });
  });

  test("a turn-failed event ends its turn", () => {
    const started = run([{ type: "started", turn: "t1", persona: "mio" }]);
    const failed = run(
      [
        {
          type: "events",
          events: [
            { type: "turn-failed", seq: 3, at: 3, persona: "mio", turn: "t1", error: "boom" },
          ],
        },
      ],
      started,
    );
    expect(failed.turn).toBeNull();
  });

  test("a refused send keeps the line, marked failed, with the reason", () => {
    const refused = run([
      { type: "sending", key: 1, after: 0, text: "hi" },
      { type: "send-failed", key: 1, error: { code: "missing-key", message: "no key" } },
      { type: "settled", key: 1, turn: null },
    ]);
    expect(refused.pending).toEqual({ key: 1, after: 0, text: "hi", failed: true });
    expect(refused.error).toEqual({ code: "missing-key", message: "no key" });

    const again = run([{ type: "sending", key: 2, after: 0, text: "hi" }], refused);
    expect(again.pending).toEqual({ key: 2, after: 0, text: "hi", failed: false });
    expect(again.error).toBeNull();
  });

  test("an error line ends the turn and fails the line waiting", () => {
    const state = run([
      { type: "sending", key: 1, after: 0, text: "hi" },
      { type: "started", turn: "t1", persona: "mio" },
      { type: "error", code: "internal", message: "oops" },
    ]);
    expect(state.turn).toBeNull();
    expect(state.pending?.failed).toBe(true);
    expect(state.error).toEqual({ code: "internal", message: "oops" });
  });

  test("a stream's end settles only its own line and turn", () => {
    const state = run([
      { type: "sending", key: 1, after: 0, text: "one" },
      { type: "sending", key: 2, after: 0, text: "two" },
      { type: "started", turn: "t2", persona: "mio" },
    ]);
    expect(run([{ type: "settled", key: 1, turn: "t1" }], state)).toEqual(state);
    const settled = run([{ type: "settled", key: 2, turn: "t2" }], state);
    expect(settled.pending).toBeNull();
    expect(settled.turn).toBeNull();
  });

  test("an older line of the viewer's, replayed, doesn't count as the one sent", () => {
    const state = run([
      { type: "sending", key: 1, after: 5, text: "new" },
      { type: "events", events: [userLine(4, "old")] },
    ]);
    expect(state.pending?.text).toBe("new");
    expect(state.seen).toBe(4);
  });

  test("a group's reply follows one persona's turn with another's, and is followed in between", () => {
    const ken: ChatEvent = {
      type: "message",
      seq: 4,
      at: 4,
      id: "k4",
      speaker: { kind: "persona", id: "ken" },
      text: "我先说",
    };
    const first = run([
      { type: "follow" },
      { type: "sending", key: 1, after: 0, text: "大家好" },
      { type: "events", events: [userLine(1, "大家好")] },
      { type: "started", turn: "a", persona: "ken" },
      { type: "delta", turn: "a", text: "我先说" },
    ]);
    // Her own message ends only her turn: another persona's doesn't finish Mio's.
    const between = run(
      [
        { type: "events", events: [ken] },
        { type: "ended", turn: "a" },
      ],
      first,
    );
    expect(between.turn).toBeNull();
    expect(between.following).toBe(1);
    const second = run(
      [
        { type: "started", turn: "b", persona: "mio" },
        { type: "events", events: [herLine(5, "ken说得对")] },
      ],
      between,
    );
    expect(second.turn).toBeNull();
    const started = run(
      [
        { type: "started", turn: "c", persona: "mio" },
        { type: "events", events: [{ ...ken, seq: 6 }] },
      ],
      second,
    );
    expect(started.turn?.persona).toBe("mio");
    expect(run([{ type: "unfollow" }, { type: "unfollow" }], second).following).toBe(0);
  });
});

describe("mergeEvents", () => {
  const log = { header: HEADER, events: [userLine(1, "a"), herLine(2, "b")], lateTools: [] };

  test("appends what continues the log, skipping what it already has", () => {
    const merged = mergeEvents(log, [herLine(2, "b"), userLine(3, "c"), herLine(4, "d")]);
    expect(merged.gap).toBe(false);
    expect(merged.log.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
  });

  test("keeps the log as it was when nothing is new", () => {
    expect(mergeEvents(log, [herLine(2, "b")]).log).toBe(log);
  });

  test("sorts a batch, and stops at a gap", () => {
    const merged = mergeEvents(log, [herLine(4, "d"), userLine(3, "c"), herLine(6, "f")]);
    expect(merged.gap).toBe(true);
    expect(merged.log.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(mergeEvents(log, [herLine(5, "e")])).toEqual({ log, gap: true });
  });
});

describe("latePoll", () => {
  test("reads the chat again only while a tool her interrupted turn left running is out", () => {
    expect(latePoll(undefined)).toBe(false);
    expect(latePoll({ header: HEADER, events: [], lateTools: [] })).toBe(false);
    expect(latePoll({ header: HEADER, events: [], lateTools: ["take_selfie"] })).toBe(LATE_POLL_MS);
  });
});
