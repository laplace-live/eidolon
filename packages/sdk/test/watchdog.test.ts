import { beforeEach, describe, expect, test } from "bun:test";
import { STUCK_DELAY_MS, THINKING_DELAY_MS, type WaitState, Watchdog } from "../src/index.ts";

/** A clock the test moves by hand. */
class FakeScheduler {
  now = 0;
  #next = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();

  set = (callback: () => void, ms: number): number => {
    const handle = ++this.#next;
    this.timers.set(handle, { at: this.now + ms, callback });
    return handle;
  };

  clear = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= until);
      if (due.length === 0) break;
      const [handle, timer] = due.sort(([, a], [, b]) => a.at - b.at)[0]!;
      this.timers.delete(handle);
      this.now = timer.at;
      timer.callback();
    }
    this.now = until;
  }
}

let scheduler: FakeScheduler;
let changes: WaitState[];
let watchdog: Watchdog;

beforeEach(() => {
  scheduler = new FakeScheduler();
  changes = [];
  watchdog = new Watchdog((state) => changes.push(state), scheduler);
});

const last = () => changes.at(-1) ?? { thinking: false, stuck: false };

describe("Watchdog", () => {
  test("thinking shows 600 ms after the turn, and stuck 8 s after it", () => {
    expect(THINKING_DELAY_MS).toBe(600);
    expect(STUCK_DELAY_MS).toBe(8000);
    watchdog.arm();
    scheduler.advance(599);
    expect(changes).toEqual([]);
    scheduler.advance(1);
    expect(last()).toEqual({ thinking: true, stuck: false });
    scheduler.advance(STUCK_DELAY_MS - THINKING_DELAY_MS - 1);
    expect(last().stuck).toBe(false);
    scheduler.advance(1);
    expect(last()).toEqual({ thinking: true, stuck: true });
  });

  test("the LLM starting rules out stuck but keeps thinking", () => {
    watchdog.arm();
    scheduler.advance(1000);
    watchdog.llmStarted();
    scheduler.advance(60_000);
    expect(last()).toEqual({ thinking: true, stuck: false });
    expect(scheduler.timers.size).toBe(0);
  });

  test("a stuck hint goes away when the LLM starts after all", () => {
    watchdog.arm();
    scheduler.advance(STUCK_DELAY_MS);
    expect(last().stuck).toBe(true);
    watchdog.llmStarted();
    expect(last()).toEqual({ thinking: true, stuck: false });
  });

  test("clear takes both down and leaves no timer behind", () => {
    watchdog.arm();
    scheduler.advance(700);
    watchdog.clear();
    expect(last()).toEqual({ thinking: false, stuck: false });
    expect(scheduler.timers.size).toBe(0);
    scheduler.advance(60_000);
    expect(last()).toEqual({ thinking: false, stuck: false });
  });

  test("a fast answer never shows thinking", () => {
    watchdog.arm();
    scheduler.advance(400);
    watchdog.clear();
    scheduler.advance(60_000);
    expect(changes).toEqual([]);
  });

  test("arming again restarts the wait instead of stacking timers", () => {
    watchdog.arm();
    scheduler.advance(500);
    watchdog.arm();
    expect(scheduler.timers.size).toBe(2);
    scheduler.advance(500);
    expect(changes).toEqual([]);
    scheduler.advance(100);
    expect(last()).toEqual({ thinking: true, stuck: false });
    watchdog.arm();
    expect(last()).toEqual({ thinking: false, stuck: false });
  });

  test("it reports changes only", () => {
    watchdog.clear();
    watchdog.llmStarted();
    expect(changes).toEqual([]);
  });
});
