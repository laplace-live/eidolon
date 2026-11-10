// The turn rules pipedog 0.10.0 runs a call with (a VAD or transcript start, the Smart Turn stop,
// the 5 s watchdog), on scripted timelines and a fake clock.
import { describe, expect, test } from "bun:test";
import { TurnDetector } from "../../src/input/turn.ts";
import type { EarEvent } from "../../src/types.ts";
import { FakeClock } from "./clock.ts";

const SONIOX_P99 = 0.35;
const OPENAI_P99 = 1.66;
const STOP_TIMEOUT_MS = 5_000;

function describeEvent(event: EarEvent): string {
  switch (event.type) {
    case "interim":
    case "final":
      return `${event.type} ${event.text}`;
    case "user-stopped":
      return `user-stopped ${event.text}`;
    case "stt-error":
      return `stt-error ${event.message}`;
    default:
      return event.type;
  }
}

/** A detector, its clock, what it posted and how often it cleared Smart Turn. */
function detector(ttfsP99 = SONIOX_P99) {
  const clock = new FakeClock(1_000);
  const events: string[] = [];
  const counts = { cleared: 0 };
  const turn = new TurnDetector({
    clock,
    ttfsP99,
    join: (parts) => parts.join("|"),
    post: (event) => events.push(describeEvent(event)),
    clearAnalyzer: () => {
      counts.cleared++;
    },
  });
  return { turn, clock, events, counts };
}

describe("a spoken turn", () => {
  test("starts on the VAD's start and ends on a finalized final once Smart Turn says complete", () => {
    const { turn, clock, events, counts } = detector();
    turn.speechStarted();
    clock.advance(400);
    turn.interim("你");
    clock.advance(800);
    turn.speechStopped();
    clock.advance(90);
    turn.analyzed("complete");
    expect(events).toEqual(["user-started", "interim 你"]);
    turn.final("你好", true);
    expect(events).toEqual(["user-started", "interim 你", "final 你好", "user-stopped 你好"]);
    expect(counts.cleared).toBe(1);
    expect(clock.pending).toBe(0);
  });

  test("a finalized final that beats the verdict ends the turn as the verdict comes", () => {
    const { turn, events } = detector();
    turn.speechStarted();
    turn.speechStopped();
    turn.final("你好", true);
    expect(events).toEqual(["user-started", "final 你好"]);
    turn.analyzed("complete");
    expect(events.at(-1)).toBe("user-stopped 你好");
  });

  test("an unfinalized final waits for the recognizer's p99 from the end of speech", () => {
    const { turn, clock, events } = detector(OPENAI_P99);
    turn.speechStarted();
    turn.speechStopped();
    // The speech ended the VAD's 0.2 s before its stop: the deadline is 1.46 s after the stop.
    clock.advance(90);
    turn.analyzed("complete");
    clock.advance(300);
    turn.final("hello", false);
    clock.advance(1_069);
    expect(events).toEqual(["user-started", "final hello"]);
    clock.advance(1);
    expect(events.at(-1)).toBe("user-stopped hello");
  });

  test("a deadline already past when the verdict comes fires at once", () => {
    const { turn, clock, events } = detector();
    turn.speechStarted();
    turn.final("好", false);
    turn.speechStopped();
    clock.advance(400);
    turn.analyzed("complete");
    expect(events.at(-1)).toBe("final 好");
    clock.advance(0);
    expect(events.at(-1)).toBe("user-stopped 好");
  });

  test("a final after the p99 has passed ends the turn at once", () => {
    const { turn, clock, events } = detector();
    turn.speechStarted();
    turn.speechStopped();
    turn.analyzed("complete");
    clock.advance(2_000);
    expect(events).toEqual(["user-started"]);
    turn.final("迟到", false);
    expect(events).toEqual(["user-started", "final 迟到", "user-stopped 迟到"]);
  });

  test("an incomplete verdict holds the turn, and its finals join the next part's", () => {
    const { turn, clock, events } = detector();
    turn.speechStarted();
    turn.speechStopped();
    turn.analyzed("incomplete");
    turn.final("我想问", true);
    clock.advance(600);
    turn.speechStarted();
    clock.advance(900);
    turn.speechStopped();
    turn.analyzed("complete");
    turn.final("今天天气", true);
    expect(events).toEqual([
      "user-started",
      "final 我想问",
      "final 今天天气",
      "user-stopped 我想问|今天天气",
    ]);
  });

  test("Smart Turn's 3 s of silence completes a turn the model held", () => {
    const { turn, clock, events } = detector();
    turn.speechStarted();
    turn.speechStopped();
    turn.analyzed("incomplete");
    turn.final("嗯", true);
    clock.advance(3_000);
    expect(events).toEqual(["user-started", "final 嗯"]);
    turn.silenceComplete();
    expect(events.at(-1)).toBe("user-stopped 嗯");
  });

  test("an interim after a finalized final makes the turn wait for the p99 again", () => {
    const finalizedThenSilent = detector();
    finalizedThenSilent.turn.speechStarted();
    finalizedThenSilent.turn.final("one", true);
    finalizedThenSilent.turn.speechStopped();
    finalizedThenSilent.turn.analyzed("complete");
    expect(finalizedThenSilent.events.at(-1)).toBe("user-stopped one");

    const { turn, clock, events } = detector();
    turn.speechStarted();
    turn.final("one", true);
    turn.interim("two");
    turn.speechStopped();
    turn.analyzed("complete");
    clock.advance(149);
    expect(events.at(-1)).toBe("interim two");
    clock.advance(1);
    expect(events.at(-1)).toBe("user-stopped one");
  });

  test("speech resuming drops a pending stop", () => {
    const { turn, clock, events } = detector();
    turn.speechStarted();
    turn.speechStopped();
    turn.analyzed("complete");
    turn.final("等一下", false);
    clock.advance(100);
    turn.speechStarted();
    clock.advance(1_000);
    expect(events).toEqual(["user-started", "final 等一下"]);
    turn.speechStopped();
    turn.analyzed("complete");
    clock.advance(150);
    expect(events.at(-1)).toBe("user-stopped 等一下");
  });

  test("never ends while the VAD hears speech", () => {
    const { turn, clock, events } = detector();
    turn.final("先说", false);
    clock.advance(100);
    turn.speechStarted();
    clock.advance(4 * STOP_TIMEOUT_MS);
    turn.silenceComplete();
    expect(events).toEqual(["user-started", "final 先说"]);
    turn.speechStopped();
    turn.analyzed("complete");
    clock.advance(150);
    expect(events.at(-1)).toBe("user-stopped 先说");
  });

  test("a blank final ends the turn with no text", () => {
    const { turn, events } = detector();
    turn.speechStarted();
    turn.speechStopped();
    turn.analyzed("complete");
    turn.final(" ", true);
    expect(events).toEqual(["user-started", "final  ", "user-stopped null"]);
  });
});

describe("a turn a transcript starts", () => {
  test("an interim while quiet starts a turn before it is posted", () => {
    const { turn, events } = detector();
    turn.interim("hello");
    expect(events).toEqual(["user-started", "interim hello"]);
  });

  test("a final with no VAD stop is complete after the p99, less no stop delay before any VAD stop", () => {
    const { turn, clock, events } = detector();
    turn.final("hi", false);
    clock.advance(349);
    expect(events).toEqual(["user-started", "final hi"]);
    clock.advance(1);
    expect(events.at(-1)).toBe("user-stopped hi");
  });

  test("after a VAD stop, the p99 less its 0.2 s", () => {
    const { turn, clock, events } = detector();
    turn.speechStarted();
    turn.speechStopped();
    turn.analyzed("complete");
    turn.final("first", true);
    turn.final("again", false);
    expect(events.slice(-2)).toEqual(["user-started", "final again"]);
    clock.advance(149);
    expect(events.at(-1)).toBe("final again");
    clock.advance(1);
    expect(events.at(-1)).toBe("user-stopped again");
  });

  test("a final arriving after the turn ended starts the next one", () => {
    const { turn, clock, events } = detector();
    turn.speechStarted();
    turn.speechStopped();
    turn.analyzed("complete");
    turn.final("问题", true);
    turn.final("尾巴", true);
    expect(events).toEqual([
      "user-started",
      "final 问题",
      "user-stopped 问题",
      "user-started",
      "final 尾巴",
    ]);
    clock.advance(150);
    expect(events.at(-1)).toBe("user-stopped 尾巴");
  });
});

describe("the watchdog", () => {
  test("ends a turn with no final 5 s after the VAD's stop, with no text", () => {
    const { turn, clock, events, counts } = detector();
    turn.speechStarted();
    clock.advance(700);
    turn.speechStopped();
    turn.analyzed("complete");
    clock.advance(STOP_TIMEOUT_MS - 1);
    expect(events).toEqual(["user-started"]);
    clock.advance(1);
    expect(events).toEqual(["user-started", "user-stopped null"]);
    expect(counts.cleared).toBe(1);
  });

  test("waits while the VAD hears speech, then counts from its stop", () => {
    const { turn, clock, events } = detector();
    turn.speechStarted();
    clock.advance(12_000);
    turn.speechStopped();
    turn.analyzed("incomplete");
    clock.advance(STOP_TIMEOUT_MS - 1);
    expect(events).toEqual(["user-started"]);
    clock.advance(1);
    expect(events.at(-1)).toBe("user-stopped null");
  });

  test("counts from the last transcript", () => {
    const { turn, clock, events } = detector();
    turn.speechStarted();
    turn.speechStopped();
    turn.analyzed("incomplete");
    clock.advance(4_000);
    turn.interim("嗯");
    clock.advance(STOP_TIMEOUT_MS - 1);
    expect(events.at(-1)).toBe("interim 嗯");
    clock.advance(1);
    expect(events.at(-1)).toBe("user-stopped null");
  });
});

test("close cancels every timer", () => {
  const { turn, clock } = detector();
  turn.speechStarted();
  turn.speechStopped();
  turn.analyzed("complete");
  expect(clock.pending).toBe(2);
  turn.close();
  expect(clock.pending).toBe(0);
});
