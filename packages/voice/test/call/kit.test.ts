import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { consoleSink, logger } from "@eidolon/config";
import { CallKit, IDLE_TIMEOUT_MS, type LoopEvent } from "../../src/call/kit.ts";
import { FakeClock } from "../input/clock.ts";

let logs: string[];
beforeEach(() => {
  logs = [];
  logger.setSink((record) => logs.push(record.message));
});
afterEach(() => {
  logger.setSink(consoleSink);
});

/** Everything posted so far, read the way the Floor reads it. */
async function posted(kit: CallKit, count: number): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  if (count === 0) return events;
  for await (const event of kit.events) {
    events.push(event);
    if (events.length === count) break;
  }
  return events;
}

describe("CallKit", () => {
  test("a timer posts when it fires, and only its latest arming counts", async () => {
    const clock = new FakeClock(0);
    const kit = new CallKit(clock);
    kit.arm("drain-fallback", 3_000);
    clock.advance(3_000);
    kit.arm("drain-fallback", 3_000);
    clock.advance(3_000);
    const [stale, latest] = (await posted(kit, 2)) as Extract<LoopEvent, { source: "timer" }>[];
    expect(stale?.timer).toBe("drain-fallback");
    expect(kit.fired(stale as Extract<LoopEvent, { source: "timer" }>)).toBe(false);
    expect(kit.fired(latest as Extract<LoopEvent, { source: "timer" }>)).toBe(true);
    // Once handled, it is no longer armed.
    expect(kit.fired(latest as Extract<LoopEvent, { source: "timer" }>)).toBe(false);
  });

  test("a cancelled timer never posts", () => {
    const clock = new FakeClock(0);
    const kit = new CallKit(clock);
    kit.arm("disconnect", 10_000);
    kit.cancel("disconnect");
    expect(clock.pending).toBe(0);
  });

  test("the idle timeout counts from the last activity, with one timer", async () => {
    const clock = new FakeClock(0);
    const kit = new CallKit(clock);
    kit.active();
    clock.advance(200_000);
    kit.active();
    kit.active();
    expect(clock.pending).toBe(1);
    clock.advance(100_000);
    const [first] = (await posted(kit, 1)) as Extract<LoopEvent, { source: "timer" }>[];
    expect(kit.fired(first as Extract<LoopEvent, { source: "timer" }>)).toBe(true);
    expect(kit.idle()).toBe(false);
    clock.advance(IDLE_TIMEOUT_MS - 100_000 - 1);
    expect(clock.pending).toBe(1);
    clock.advance(1);
    const [second] = (await posted(kit, 1)) as Extract<LoopEvent, { source: "timer" }>[];
    expect(kit.fired(second as Extract<LoopEvent, { source: "timer" }>)).toBe(true);
    expect(kit.idle()).toBe(true);
  });

  test("once stopped, nothing posted reaches the Floor and no timer waits", async () => {
    const clock = new FakeClock(0);
    const kit = new CallKit(clock);
    kit.active();
    kit.stop();
    kit.post({ source: "shutdown" });
    expect(kit.stopped).toBe(true);
    expect(clock.pending).toBe(0);
    expect(await posted(kit, 1)).toEqual([]);
  });

  test("closes every stream it owns, and logs one that fails", async () => {
    const kit = new CallKit(new FakeClock(0));
    const closed: string[] = [];
    kit.own("her hearing", {
      close: async () => {
        closed.push("stt");
      },
    });
    kit.own("her voice", {
      close: async () => {
        throw new Error("socket gone");
      },
    });
    await kit.close();
    expect(closed).toEqual(["stt"]);
    expect(logs).toEqual(["[voice] Closing her voice failed: socket gone"]);
    await kit.close();
    expect(closed).toEqual(["stt"]);
  });
});
