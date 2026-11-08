import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { monotonicSeconds, quotaFromEnv, SlidingWindowQuota } from "../src/index.ts";
import { EnvPatch, FakeClock, LogCapture } from "./helpers.ts";

const result = (allowed: boolean, remaining: number, retryAfterSeconds: number) => ({
  allowed,
  remaining,
  retryAfterSeconds,
});

const env = new EnvPatch();
afterEach(() => env.restore());

describe("SlidingWindowQuota", () => {
  test("max=3, window=60 row by row, as Python's AnonymousIpQuota answered", () => {
    const clock = new FakeClock(1000);
    const quota = new SlidingWindowQuota(3, 60, clock.now);
    const rows: [number, "peek" | "consume", boolean, number, number][] = [
      [1000, "peek", true, 3, 0],
      [1000, "consume", true, 2, 0],
      [1010, "consume", true, 1, 0],
      [1020, "consume", true, 0, 0],
      [1020, "peek", false, 0, 40],
      [1020, "consume", false, 0, 40],
      // int(0.5) = 0, floored at 1.
      [1059.5, "consume", false, 0, 1],
      // The oldest attempt is exactly 60 s old and still counts.
      [1060, "consume", false, 0, 1],
      [1060.0001, "consume", true, 0, 0],
    ];
    for (const [t, op, allowed, remaining, retry] of rows) {
      clock.t = t;
      const got = op === "peek" ? quota.peek("ip") : quota.tryConsume("ip");
      expect({ t, op, ...got }).toEqual({ t, op, ...result(allowed, remaining, retry) });
    }
    // The window now holds [1010, 1020, 1060.0001].
    clock.t = 1070;
    expect(quota.peek("ip")).toEqual(result(false, 0, 1));
    clock.t = 1070.5;
    expect(quota.peek("ip")).toEqual(result(true, 1, 0));
  });

  test("a peek never adds a key; only a recorded attempt does", () => {
    const quota = new SlidingWindowQuota(3, 60, new FakeClock(1000).now);
    const set = spyOn(Map.prototype, "set");
    try {
      for (let i = 0; i < 5; i++) quota.peek(`203.0.113.${i}`);
      expect(set).not.toHaveBeenCalled();
      quota.tryConsume("203.0.113.9");
      expect(set).toHaveBeenCalledTimes(1);
    } finally {
      set.mockRestore();
    }
  });

  test("max=0 refuses everyone and reports the whole window", () => {
    const quota = new SlidingWindowQuota(0, 60, new FakeClock(5).now);
    expect(quota.peek("a")).toEqual(result(false, 0, 60));
    expect(quota.tryConsume("a")).toEqual(result(false, 0, 60));
  });

  test("the constructor clamps max to 0 and the window to 1", () => {
    const quota = new SlidingWindowQuota(-5, 0);
    expect([quota.maxPerWindow, quota.windowSeconds]).toEqual([0, 1]);
  });

  test("a sub-second wait still reports a retry of 1", () => {
    const clock = new FakeClock(5000);
    const quota = new SlidingWindowQuota(1, 1, clock.now);
    expect(quota.tryConsume("a")).toEqual(result(true, 0, 0));
    clock.t = 5000.9;
    expect(quota.tryConsume("a")).toEqual(result(false, 0, 1));
  });

  test("retry truncates toward zero and floors at 1", () => {
    const clock = new FakeClock(0);
    const quota = new SlidingWindowQuota(1, 3600, clock.now);
    expect(quota.tryConsume("a")).toEqual(result(true, 0, 0));
    clock.t = 0.4;
    expect(quota.tryConsume("a")).toEqual(result(false, 0, 3599));
    clock.t = 3599.5;
    expect(quota.tryConsume("a")).toEqual(result(false, 0, 1));
  });

  test("a fractional clock against a 7 s window", () => {
    const clock = new FakeClock(100.25);
    const quota = new SlidingWindowQuota(1, 7, clock.now);
    quota.tryConsume("k");
    clock.t = 103.9;
    expect(quota.peek("k")).toEqual(result(false, 0, 3));
  });

  test("simultaneous attempts cannot both pass a full bucket", async () => {
    const quota = new SlidingWindowQuota(2, 3600, new FakeClock(10).now);
    const got = await Promise.all(Array.from({ length: 5 }, async () => quota.tryConsume("same")));
    expect(got).toEqual([
      result(true, 1, 0),
      result(true, 0, 0),
      result(false, 0, 3600),
      result(false, 0, 3600),
      result(false, 0, 3600),
    ]);
  });

  test("keys are independent", () => {
    const quota = new SlidingWindowQuota(1, 60, new FakeClock(1).now);
    expect(quota.tryConsume("a").allowed).toBe(true);
    expect(quota.tryConsume("a").allowed).toBe(false);
    expect(quota.tryConsume("b")).toEqual(result(true, 0, 0));
  });

  test("peek never changes what a later tryConsume answers", () => {
    const clock = new FakeClock(1);
    const peeked = new SlidingWindowQuota(2, 60, clock.now);
    const untouched = new SlidingWindowQuota(2, 60, clock.now);
    for (let i = 0; i < 4; i++) peeked.peek("ip");
    for (let i = 0; i < 3; i++) {
      clock.t += 1;
      expect(peeked.tryConsume("ip")).toEqual(untouched.tryConsume("ip"));
      expect(peeked.peek("ip")).toEqual(untouched.peek("ip"));
    }
  });

  test("results are frozen", () => {
    const got = new SlidingWindowQuota(1, 60).tryConsume("x");
    expect(Object.isFrozen(got)).toBe(true);
  });

  test("the default clock is monotonic seconds", () => {
    const before = monotonicSeconds();
    expect(Math.abs(before - performance.now() / 1000)).toBeLessThan(1);
    expect(monotonicSeconds()).toBeGreaterThanOrEqual(before);
    const quota = new SlidingWindowQuota(1, 60);
    expect(quota.tryConsume("x")).toEqual(result(true, 0, 0));
    const refused = quota.tryConsume("x");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(59);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  // MCP's anonymous rate limit, at the quota seam MCP builds its tiers on.
  test("an anonymous tier of 2 refuses the third call", () => {
    const quota = new SlidingWindowQuota(2, 3600);
    expect([1, 2, 3].map(() => quota.tryConsume("203.0.113.9").allowed)).toEqual([
      true,
      true,
      false,
    ]);
  });
});

describe("quotaFromEnv", () => {
  test("reads both vars when called, then clamps", () => {
    env
      .set("EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR", "-3")
      .set("EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC", "0");
    const clamped = quotaFromEnv(
      "EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR",
      20,
      "EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC",
      3600,
    );
    expect([clamped.maxPerWindow, clamped.windowSeconds]).toEqual([0, 1]);

    env
      .set("EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR", " 42 ")
      .set("EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC", "1_800");
    const set = quotaFromEnv(
      "EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR",
      20,
      "EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC",
      3600,
    );
    expect([set.maxPerWindow, set.windowSeconds]).toEqual([42, 1800]);
  });

  test("blank is unset and garbage warns, both falling back to the defaults", () => {
    const logs = new LogCapture();
    try {
      env
        .set("EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR", "")
        .set("EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC", "1h");
      const quota = quotaFromEnv(
        "EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR",
        120,
        "EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC",
        3600,
      );
      expect([quota.maxPerWindow, quota.windowSeconds]).toEqual([120, 3600]);
      const lines = logs.take();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toStartWith("WARNING|EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC=");
    } finally {
      logs.restore();
    }
  });
});
