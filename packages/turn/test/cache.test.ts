import { describe, expect, test } from "bun:test";
import { CloudflareIceCache, type IcePayload } from "../src/index.ts";
import { blockNetwork, captureLogs, deferred, fakeFetch, lines } from "./support.ts";

const KEY = { keyId: "k", apiToken: "t" };
const PAYLOADS: Readonly<Record<string, IcePayload>> = {
  A: { iceServers: [{ urls: ["stun:a"] }], n: 1 },
  B: { iceServers: [{ urls: ["stun:b"] }], n: 2 },
  EMPTY: {},
};
const name = (got: IcePayload | null): string | null =>
  got === null
    ? null
    : (Object.entries(PAYLOADS).find(([, p]) => JSON.stringify(p) === JSON.stringify(got))?.[0] ??
      "?");
const minted = (ttl: number, refresh: number): string =>
  `INFO [WebRTC] Minted fresh Cloudflare TURN credentials (TTL ${ttl}s, refresh in ${refresh}s)`;

blockNetwork();
const logs = captureLogs();

// Recorded from bot.py's own _get_cloudflare_ice on a fake clock. Each row: clock, what the mint
// returns (null: HTTP 500), fetches made, what get() returned, the INFO line's refresh seconds.
type Step = readonly [number, string | null, number, string | null, number | null];
const PYTHON_TRACE: Readonly<Record<number, readonly Step[]>> = {
  3600: [
    [1000, "A", 1, "A", 3300],
    [4299.9, "B", 0, "A", null],
    [4300, "B", 1, "B", 3300],
    [4310, null, 0, "B", null],
    [7599.9, null, 0, "B", null],
    [7600, null, 1, "B", null],
    [7601, "A", 1, "A", 3300],
    [10901, "EMPTY", 1, "EMPTY", 3300],
    [10902, "B", 1, "B", 3300],
    [10903, null, 0, "B", null],
    [14202, "EMPTY", 1, "EMPTY", 3300],
    [14203, null, 1, "EMPTY", null],
    [14204, null, 1, "EMPTY", null],
    [14205, "A", 1, "A", 3300],
  ],
  100: [
    [20000, "A", 1, "A", 60],
    [20059.9, "B", 0, "A", null],
    [20060, "B", 1, "B", 60],
  ],
  30: [
    [30000, "A", 1, "A", 60],
    [30059, "B", 0, "A", null],
    [30060, "B", 1, "B", 60],
  ],
  [-5]: [[40000, "A", 1, "A", 60]],
  0: [
    [40000, "A", 1, "A", 60],
    [40059.9, "B", 0, "A", null],
    [40060, "B", 1, "B", 60],
  ],
};

describe("CloudflareIceCache", () => {
  for (const [ttl, steps] of Object.entries(PYTHON_TRACE)) {
    test(`replays bot.py's cache at TTL ${ttl}`, async () => {
      let clock = 0;
      let next: string | null = null;
      const { fetch, calls } = fakeFetch(() =>
        next === null
          ? new Response("", { status: 500, statusText: "Internal Server Error" })
          : Response.json(PAYLOADS[next], { status: 201 }),
      );
      const cache = new CloudflareIceCache({
        key: KEY,
        ttlSec: Number(ttl),
        fetch,
        now: () => clock,
      });
      for (const [at, mint, fetches, got, refresh] of steps) {
        clock = at;
        next = mint;
        calls.length = 0;
        logs.length = 0;
        const result = name(await cache.get());
        const infos = lines(logs).filter((line) => line.startsWith("INFO"));
        expect([at, calls.length, result, infos]).toEqual([
          at,
          fetches,
          got,
          refresh === null ? [] : [minted(Number(ttl), refresh)],
        ]);
      }
    });
  }

  test("a stale payload is the very object minted earlier", async () => {
    let clock = 0;
    let fail = false;
    const { fetch } = fakeFetch(() =>
      fail ? new Response("", { status: 503 }) : Response.json(PAYLOADS.A, { status: 201 }),
    );
    const cache = new CloudflareIceCache({ key: KEY, ttlSec: 3600, fetch, now: () => clock });
    const first = await cache.get();
    clock = 3300;
    fail = true;
    expect(await cache.get()).toBe(first);
  });

  test("logs the refresh interval exactly, whatever the clock's rounding", async () => {
    const at = 796.0547;
    expect(Math.trunc(at + 3300 - at)).toBe(3299);
    const { fetch } = fakeFetch(() => Response.json(PAYLOADS.A, { status: 201 }));
    await new CloudflareIceCache({ key: KEY, ttlSec: 3600, fetch, now: () => at }).get();
    expect(lines(logs)).toEqual([minted(3600, 3300)]);
  });

  test("concurrent callers share one mint", async () => {
    const gate = deferred<Response>();
    const { fetch, calls } = fakeFetch(() => gate.promise);
    const cache = new CloudflareIceCache({ key: KEY, ttlSec: 3600, fetch, now: () => 0 });
    const pending = [cache.get(), cache.get(), cache.get()];
    gate.resolve(Response.json(PAYLOADS.A, { status: 201 }));
    const [a, b, c] = await Promise.all(pending);
    expect(calls).toHaveLength(1);
    expect(name(a ?? null)).toBe("A");
    expect(b).toBe(a as IcePayload);
    expect(c).toBe(a as IcePayload);
    expect(await cache.get()).toBe(a as IcePayload);
    expect(calls).toHaveLength(1);
    expect(lines(logs)).toEqual([minted(3600, 3300)]);
  });

  test("callers during a failing refresh share the stale payload, then the next call retries", async () => {
    let clock = 0;
    const answers = [Response.json(PAYLOADS.A, { status: 201 })];
    const gate = deferred<Response>();
    const { fetch, calls } = fakeFetch(() => answers.shift() ?? gate.promise);
    const cache = new CloudflareIceCache({ key: KEY, ttlSec: 3600, fetch, now: () => clock });
    const stale = await cache.get();
    clock = 3300;
    const pending = [cache.get(), cache.get(), cache.get()];
    gate.resolve(new Response("", { status: 500, statusText: "Internal Server Error" }));
    expect(await Promise.all(pending)).toEqual([stale, stale, stale]);
    expect(calls).toHaveLength(2);
    answers.push(Response.json(PAYLOADS.B, { status: 201 }));
    expect(name(await cache.get())).toBe("B");
    expect(calls).toHaveLength(3);
  });

  test("callers during a first failing mint all get null", async () => {
    const gate = deferred<Response>();
    const { fetch, calls } = fakeFetch(() => gate.promise);
    const cache = new CloudflareIceCache({ key: KEY, ttlSec: 3600, fetch, now: () => 0 });
    const pending = [cache.get(), cache.get(), cache.get()];
    gate.reject(new TypeError("fetch failed"));
    expect(await Promise.all(pending)).toEqual([null, null, null]);
    expect(calls).toHaveLength(1);
    expect(lines(logs)).toEqual([
      "WARNING [WebRTC] Cloudflare TURN mint failed: TypeError: fetch failed",
    ]);
  });

  test("without a key it resolves null and never fetches", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json(PAYLOADS.A, { status: 201 }));
    const cache = new CloudflareIceCache({ key: null, ttlSec: 3600, fetch, now: () => 0 });
    for (let i = 0; i < 3; i++) expect(await cache.get()).toBeNull();
    expect(calls).toHaveLength(0);
    expect(logs).toEqual([]);
  });

  test("defaults to the monotonic clock", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json(PAYLOADS.A, { status: 201 }));
    const cache = new CloudflareIceCache({ key: KEY, ttlSec: 3600, fetch });
    await cache.get();
    await cache.get();
    expect(calls).toHaveLength(1);
  });
});
