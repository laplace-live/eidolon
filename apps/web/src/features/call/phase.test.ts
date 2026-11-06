import { describe, expect, test } from "bun:test";
import {
  type CallPhase,
  connectEnd,
  endOf,
  IDLE,
  IDLE_TIMEOUT_MS,
  type PhaseEvent,
  reducePhase,
  sessionErrorSince,
} from "./phase";

function run(...events: PhaseEvent[]): CallPhase {
  return events.reduce(reducePhase, IDLE);
}

const dropped = { kind: "dropped", byBot: false } as const;

describe("reducePhase", () => {
  test("a call goes from starting to live, is answered once, and ends", () => {
    expect(run({ type: "start", at: 1 })).toEqual({ name: "starting", startedAt: 1 });
    const live = run({ type: "start", at: 1 }, { type: "dial" }, { type: "ready" });
    expect(live).toEqual({ name: "live", startedAt: 1, answeredAt: null });
    const answered = run(
      { type: "start", at: 1 },
      { type: "dial" },
      { type: "ready" },
      { type: "answered", at: 5 },
      { type: "answered", at: 9 },
    );
    expect(answered).toEqual({ name: "live", startedAt: 1, answeredAt: 5 });
    expect(reducePhase(answered, { type: "disconnected", at: 20, end: dropped })).toEqual({
      name: "ended",
      startedAt: 1,
      answeredAt: 5,
      endedAt: 20,
      end: dropped,
    });
  });

  test("a call that fails before it is live says why", () => {
    const mic = { kind: "mic", problem: "denied" } as const;
    expect(run({ type: "start", at: 1 }, { type: "failed", at: 2, end: mic })).toMatchObject({
      name: "ended",
      end: mic,
      answeredAt: null,
    });
    const refused = { kind: "connect", status: 500, detail: "HTTP 500" } as const;
    expect(
      run({ type: "start", at: 1 }, { type: "dial" }, { type: "failed", at: 3, end: refused }),
    ).toMatchObject({ name: "ended", end: refused });
  });

  test("a session that drops before bot-ready ends the call, and whichever end comes first wins", () => {
    const connecting = run({ type: "start", at: 1 }, { type: "dial" });
    const gone = reducePhase(connecting, { type: "disconnected", at: 2, end: dropped });
    expect(gone).toEqual({
      name: "ended",
      startedAt: 1,
      answeredAt: null,
      endedAt: 2,
      end: dropped,
    });
    const late = { kind: "connect", status: 500, detail: "HTTP 500" } as const;
    expect(reducePhase(gone, { type: "failed", at: 3, end: late })).toBe(gone);
  });

  test("a hang-up at any stage ends as hung up, whatever the transport says next", () => {
    for (const before of [
      [{ type: "start", at: 1 }],
      [{ type: "start", at: 1 }, { type: "dial" }],
      [{ type: "start", at: 1 }, { type: "dial" }, { type: "ready" }],
    ] as PhaseEvent[][]) {
      const ending = run(...before, { type: "hang-up" });
      expect(ending.name).toBe("ending");
      for (const echo of [
        { type: "failed", at: 9, end: { kind: "connect", status: null, detail: "" } },
        { type: "disconnected", at: 9, end: dropped },
      ] as PhaseEvent[]) {
        expect(reducePhase(ending, echo)).toMatchObject({
          name: "ended",
          end: { kind: "hung-up" },
        });
      }
    }
  });

  test("a hang-up keeps when the call was answered", () => {
    const ending = run(
      { type: "start", at: 1 },
      { type: "dial" },
      { type: "ready" },
      { type: "answered", at: 4 },
      { type: "hang-up" },
    );
    expect(ending).toEqual({ name: "ending", startedAt: 1, answeredAt: 4 });
  });

  test("events out of turn change nothing", () => {
    expect(run({ type: "dial" }, { type: "ready" }, { type: "hang-up" })).toBe(IDLE);
    const live = run({ type: "start", at: 1 }, { type: "dial" }, { type: "ready" });
    expect(reducePhase(live, { type: "start", at: 5 })).toBe(live);
    expect(reducePhase(live, { type: "failed", at: 5, end: dropped })).toBe(live);
    const ended = reducePhase(live, { type: "disconnected", at: 6, end: dropped });
    expect(reducePhase(ended, { type: "disconnected", at: 7, end: { kind: "silence" } })).toBe(
      ended,
    );
  });

  test("an ended call can start again", () => {
    const ended = run(
      { type: "start", at: 1 },
      { type: "failed", at: 2, end: { kind: "ice", detail: "HTTP 500" } },
    );
    expect(reducePhase(ended, { type: "start", at: 10 })).toEqual({
      name: "starting",
      startedAt: 10,
    });
  });
});

describe("endOf", () => {
  test("the bot leaving after five quiet minutes is the idle timeout", () => {
    expect(endOf(true, IDLE_TIMEOUT_MS)).toEqual({ kind: "silence" });
    expect(endOf(true, IDLE_TIMEOUT_MS - 10_000)).toEqual({ kind: "silence" });
  });

  test("anything sooner, or a dropped connection, is not", () => {
    expect(endOf(true, 60_000)).toEqual({ kind: "dropped", byBot: true });
    expect(endOf(false, IDLE_TIMEOUT_MS * 2)).toEqual({ kind: "dropped", byBot: false });
  });
});

describe("connectEnd", () => {
  test("reads the offer's status off the transport's error", () => {
    const error = Object.assign(new Error("WebRTC offer rejected with status 401"), {
      status: 401,
    });
    expect(connectEnd(error)).toEqual({ kind: "connect", status: 401, detail: "HTTP 401" });
  });

  test("falls back to the message without one", () => {
    expect(connectEnd(new Error("Offer request failed."))).toEqual({
      kind: "connect",
      status: null,
      detail: "Offer request failed.",
    });
    expect(connectEnd(Object.assign(new Error("x"), { status: undefined }))).toMatchObject({
      status: null,
    });
    expect(connectEnd("nope")).toEqual({ kind: "connect", status: null, detail: "" });
  });
});

describe("sessionErrorSince", () => {
  const started = Date.parse("2026-11-05T10:00:00.500Z");

  test("a failure during the call explains it", () => {
    const error = { message: "SONIOX_API_KEY environment variable is required", at: "" };
    expect(sessionErrorSince({ ...error, at: "2026-11-05T10:00:03.000Z" }, started)).toBe(
      error.message,
    );
    expect(sessionErrorSince({ ...error, at: "2026-11-05T10:00:00Z" }, started)).toBe(
      error.message,
    );
  });

  test("an older failure, a bad date or none explains nothing", () => {
    expect(sessionErrorSince({ message: "old", at: "2026-11-05T09:59:00Z" }, started)).toBeNull();
    expect(sessionErrorSince({ message: "bad", at: "yesterday" }, started)).toBeNull();
    expect(sessionErrorSince(null, started)).toBeNull();
  });
});
