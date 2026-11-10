import { describe, expect, test } from "bun:test";
import type { ChatEvent, ChatHeader, ChatStreamLine } from "@eidolon/chat";
import {
  callOn,
  IDLE,
  LATE_POLL_MS,
  type LiveAction,
  type LiveState,
  latePoll,
  mayRunOn,
  mergeEvents,
  reaches,
  reduceLive,
  Sends,
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
    expect(streaming.pending).toEqual([]);
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
    expect(refused.pending).toEqual([{ key: 1, after: 0, text: "hi", failed: true }]);
    expect(refused.error).toEqual({ code: "missing-key", message: "no key" });

    const again = run([{ type: "sending", key: 2, after: 0, text: "hi" }], refused);
    expect(again.pending).toEqual([{ key: 2, after: 0, text: "hi", failed: false }]);
    expect(again.error).toBeNull();
  });

  test("a line sent before another fails on its own, keeping its text", () => {
    const state = run([
      { type: "sending", key: 1, after: 2, text: "one" },
      { type: "sending", key: 2, after: 2, text: "two" },
      { type: "send-failed", key: 1, error: { code: "network", message: "offline" } },
      { type: "settled", key: 1, turn: null },
    ]);
    expect(state.pending).toEqual([
      { key: 1, after: 2, text: "one", failed: true },
      { key: 2, after: 2, text: "two", failed: false },
    ]);
  });

  test("a stored line clears its own pending line, whichever stream brings it first", () => {
    const state = run([
      { type: "sending", key: 1, after: 2, text: "one" },
      { type: "sending", key: 2, after: 2, text: "two" },
      { type: "events", events: [userLine(4, "two")] },
    ]);
    expect(state.pending.map((line) => line.text)).toEqual(["one"]);
  });

  test("an error line ends the turn and fails the line waiting", () => {
    const state = run([
      { type: "sending", key: 1, after: 0, text: "hi" },
      { type: "started", turn: "t1", persona: "mio" },
      { type: "error", code: "internal", message: "oops" },
    ]);
    expect(state.turn).toBeNull();
    expect(state.pending.map((line) => line.failed)).toEqual([true]);
    expect(state.error).toEqual({ code: "internal", message: "oops" });
  });

  test("a stream's end settles only its own line and turn", () => {
    const state = run([
      { type: "sending", key: 1, after: 0, text: "one" },
      { type: "sending", key: 2, after: 0, text: "two" },
      { type: "started", turn: "t2", persona: "mio" },
    ]);
    const first = run([{ type: "settled", key: 1, turn: "t1" }], state);
    expect(first.pending.map((line) => line.key)).toEqual([2]);
    expect(first.turn).toBe(state.turn);
    const settled = run([{ type: "settled", key: 2, turn: "t2" }], first);
    expect(settled.pending).toEqual([]);
    expect(settled.turn).toBeNull();
  });

  test("an older line of the viewer's, replayed, doesn't count as the one sent", () => {
    const state = run([
      { type: "sending", key: 1, after: 5, text: "new" },
      { type: "events", events: [userLine(4, "old")] },
    ]);
    expect(state.pending.map((line) => line.text)).toEqual(["new"]);
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

describe("a voice message", () => {
  const clip = { audio: new Blob(["x"], { type: "audio/webm" }), durationMs: 1200 };
  const voiceLine = (seq: number, text: string): ChatEvent => ({
    type: "message",
    seq,
    at: seq,
    id: `u${seq}`,
    speaker: { kind: "user" },
    text,
    modality: "voice",
    attachments: [{ kind: "audio", name: `${"c".repeat(64)}.webm`, mime: "audio/webm" }],
  });

  test("waits with its recording until the server stores it, whatever its transcript", () => {
    const sent = run([{ type: "sending", key: 1, after: 2, text: "", voice: clip }]);
    expect(sent.pending).toEqual([{ key: 1, after: 2, text: "", voice: clip, failed: false }]);
    expect(run([{ type: "events", events: [voiceLine(3, "你好")] }], sent).pending).toEqual([]);
  });

  test("and a typed line are each matched only by their own kind of message", () => {
    const both = run([
      { type: "sending", key: 1, after: 2, text: "", voice: clip },
      { type: "sending", key: 2, after: 2, text: "你好" },
    ]);
    expect(
      run([{ type: "events", events: [voiceLine(3, "你好")] }], both).pending.map(
        (line) => line.key,
      ),
    ).toEqual([2]);
    expect(
      run([{ type: "events", events: [userLine(3, "你好")] }], both).pending.map(
        (line) => line.key,
      ),
    ).toEqual([1]);
  });

  test("refused keeps its recording to send again, and says the refusal was of a voice message", () => {
    const refused = run([
      { type: "sending", key: 1, after: 0, text: "", voice: clip },
      { type: "send-failed", key: 1, error: { code: "missing-key", message: "no key" } },
      { type: "settled", key: 1, turn: null },
    ]);
    expect(refused.error).toEqual({ code: "missing-key", message: "no key", voice: true });
    expect(refused.pending).toMatchObject([{ key: 1, failed: true, voice: clip }]);
    const typed = run([
      { type: "sending", key: 2, after: 0, text: "hi" },
      { type: "send-failed", key: 2, error: { code: "missing-key", message: "mind" } },
    ]);
    expect(typed.error).toEqual({ code: "missing-key", message: "mind" });
  });
});

describe("Sends", () => {
  test("a send supersedes the streams open before it once the server accepts it", () => {
    const sends = new Sends();
    const live = sends.mark(null);
    const key = sends.issue();
    const own = sends.mark(key);
    expect(sends.superseded(live)).toBe(false);
    sends.accept(key);
    expect(sends.superseded(live)).toBe(true);
    expect(sends.superseded(own)).toBe(false);
  });

  test("a send refused before its stream starts supersedes nothing", () => {
    const sends = new Sends();
    const first = sends.issue();
    const reply = sends.mark(first);
    sends.accept(first);
    sends.issue();
    expect(sends.superseded(reply)).toBe(false);
  });

  test("a later accepted send supersedes an earlier one", () => {
    const sends = new Sends();
    const first = sends.issue();
    const mark = sends.mark(first);
    sends.accept(first);
    const second = sends.issue();
    sends.accept(second);
    expect(sends.superseded(mark)).toBe(true);
  });
});

describe("a stream a send superseded", () => {
  /** Lines in the order they arrive, each marked with whether its stream was superseded. */
  const arrive = (from: LiveState, lines: readonly (readonly [boolean, ChatStreamLine])[]) =>
    run(
      lines.flatMap(([superseded, line]) => (reaches(line, superseded) ? [line] : [])),
      from,
    );

  test("leaves her reply to the send's stream when it carries the same one", () => {
    // The page's GET live, answered only after the send started her reply, replays it too.
    const sent = run([{ type: "sending", key: 1, after: 2, text: "嗨" }]);
    const stored: ChatStreamLine = { type: "events", events: [userLine(3, "嗨"), decision(4, 3)] };
    const state = arrive(sent, [
      [false, stored],
      [false, { type: "started", turn: "t2", persona: "mio" }],
      [false, { type: "delta", turn: "t2", text: "哈" }],
      [true, stored],
      [true, { type: "started", turn: "t2", persona: "mio" }],
      [true, { type: "delta", turn: "t2", text: "哈" }],
      [false, { type: "delta", turn: "t2", text: "喽" }],
      [true, { type: "delta", turn: "t2", text: "喽" }],
    ]);
    expect(state.turn).toMatchObject({ id: "t2", text: "哈喽" });
    expect(state.pending).toEqual([]);
  });

  test("never lets the reply the send interrupted replace the new one", () => {
    const sent = run([{ type: "sending", key: 1, after: 2, text: "等等" }]);
    const state = arrive(sent, [
      [false, { type: "events", events: [userLine(4, "等等"), decision(5, 4)] }],
      [false, { type: "started", turn: "t2", persona: "mio" }],
      [false, { type: "delta", turn: "t2", text: "好" }],
      [true, { type: "started", turn: "t1", persona: "mio" }],
      [true, { type: "delta", turn: "t1", text: "我在" }],
      [true, { type: "events", events: [herLine(3, "我在", true)] }],
      [true, { type: "ended", turn: "t1" }],
    ]);
    expect(state.turn).toMatchObject({ id: "t2", text: "好" });
    expect(state.seen).toBe(5);
  });
});

describe("mergeEvents", () => {
  const log = {
    header: HEADER,
    events: [userLine(1, "a"), herLine(2, "b")],
    lateTools: [],
    hearingRefusal: null,
    call: null,
  };

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
    const contents = { header: HEADER, events: [], hearingRefusal: null, call: null };
    expect(latePoll({ ...contents, lateTools: [] })).toBe(false);
    expect(latePoll({ ...contents, lateTools: ["take_selfie"] })).toBe(LATE_POLL_MS);
  });
});

describe("callOn", () => {
  const started: ChatEvent = { type: "call-started", seq: 3, at: 3, call: "c1", persona: "mio" };
  const log = {
    header: HEADER,
    events: [userLine(1, "a"), herLine(2, "b"), started],
    lateTools: [],
    hearingRefusal: null,
    call: { id: "c1", persona: "mio" },
  };

  test("is the call the server said is on", () => {
    expect(callOn(log)).toEqual({ id: "c1", persona: "mio" });
    expect(callOn({ ...log, call: null })).toBeNull();
  });

  test("ends once a stream merges the call's end, before the next read says so", () => {
    const ended: ChatEvent = { type: "call-ended", seq: 4, at: 4, call: "c1", reason: "client" };
    expect(callOn(mergeEvents(log, [ended]).log)).toBeNull();
  });

  test("but not at an earlier call's end", () => {
    const earlier: ChatEvent = { type: "call-ended", seq: 4, at: 4, call: "c0", reason: "client" };
    expect(callOn(mergeEvents(log, [earlier]).log)).toEqual({ id: "c1", persona: "mio" });
  });
});

describe("mayRunOn", () => {
  const broke = { turn: null, ended: false, broke: true, received: true };

  test("a stream that broke while the director decided, before any turn, may have more", () => {
    expect(mayRunOn(broke)).toBe(true);
  });

  test("so may one that broke after a turn ended, or closed before one did", () => {
    expect(mayRunOn({ ...broke, turn: "t1", ended: true })).toBe(true);
    expect(mayRunOn({ ...broke, turn: "t1", broke: false })).toBe(true);
  });

  test("but not one refused before its first line, or closed at the reply's end", () => {
    expect(mayRunOn({ ...broke, received: false })).toBe(false);
    expect(mayRunOn({ ...broke, broke: false })).toBe(false);
    expect(mayRunOn({ ...broke, turn: "t1", ended: true, broke: false })).toBe(false);
  });
});
