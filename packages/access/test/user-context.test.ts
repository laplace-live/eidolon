import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ANONYMOUS,
  type FetchLike,
  parseValidateResponse,
  type UserContext,
  UserContextResolver,
  type UserContextResolverOptions,
  VALIDATE_PATH,
} from "../src/index.ts";
import { validateCacheKey } from "../src/user-context.ts";
import { EnvPatch, FakeClock, LogCapture } from "./helpers.ts";

const user = (mid: number, uname: string, face: string | null = null): UserContext => ({
  mid,
  uname,
  face,
  isLoggedIn: true,
});

type Reply = (init: RequestInit) => Promise<Response>;

/** A Workers stand-in: records each request and answers from a queue of planned replies. */
class StubWorkers {
  readonly calls: { url: string; init: RequestInit }[] = [];
  readonly #plan: Reply[] = [];

  readonly fetch: FetchLike = (url, init) => {
    this.calls.push({ url, init });
    const reply = this.#plan.shift();
    if (reply === undefined) return Promise.reject(new Error(`unplanned Workers call to ${url}`));
    return reply(init);
  };

  json(payload: unknown): this {
    return this.raw(JSON.stringify(payload), 200, "OK");
  }

  raw(body: BodyInit | null, status: number, statusText = ""): this {
    this.#plan.push(async () => new Response(body, { status, statusText }));
    return this;
  }

  networkError(error: unknown = new TypeError("fetch failed")): this {
    this.#plan.push(() => Promise.reject(error));
    return this;
  }

  /** Never answers; rejects only when the request's signal aborts, as fetch does. */
  hang(): this {
    this.#plan.push(
      (init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    return this;
  }

  /** The body of request `i`, parsed. */
  body(i: number): unknown {
    return JSON.parse(String(this.calls[i]?.init.body));
  }

  header(i: number, name: string): string | null {
    return new Headers(this.calls[i]?.init.headers).get(name);
  }
}

let logs: LogCapture;
const env = new EnvPatch();
beforeEach(() => {
  logs = new LogCapture();
});
afterEach(() => {
  logs.restore();
  env.restore();
});

function resolver(
  workers: StubWorkers,
  clock: FakeClock,
  options: UserContextResolverOptions = {},
): UserContextResolver {
  return new UserContextResolver({
    ttlSeconds: 60,
    workersBaseUrl: () => "https://w.example",
    wafBypassToken: "",
    fetch: workers.fetch,
    now: clock.now,
    ...options,
  });
}

describe("parseValidateResponse", () => {
  // Every row was answered by Python's _parse_response; [mid, uname, face, is_logged_in].
  const rows: [string, unknown, [number | null, string | null, string | null, boolean]][] = [
    ["a string", "x", [null, null, null, false]],
    ["a list", [], [null, null, null, false]],
    ["null", null, [null, null, null, false]],
    ["code -101", { code: -101 }, [null, null, null, false]],
    ['code "0"', { code: "0", data: { mid: 1, uname: "a" } }, [null, null, null, false]],
    ["code false", { code: false, data: { mid: 1, uname: "a" } }, [1, "a", null, true]],
    ["code true", { code: true, data: { mid: 1, uname: "a" } }, [null, null, null, false]],
    ["code missing", { data: { mid: 1, uname: "a" } }, [null, null, null, false]],
    ["data a list", { code: 0, data: [1] }, [null, null, null, false]],
    ["data missing", { code: 0 }, [null, null, null, false]],
    ['mid "123"', { code: 0, data: { mid: "123", uname: "a" } }, [123, "a", null, true]],
    ['mid " 123 "', { code: 0, data: { mid: " 123 ", uname: "a" } }, [123, "a", null, true]],
    ['mid "1_000"', { code: 0, data: { mid: "1_000", uname: "a" } }, [1000, "a", null, true]],
    ["mid 12.9", { code: 0, data: { mid: 12.9, uname: "a" } }, [12, "a", null, true]],
    ["mid -0.5", { code: 0, data: { mid: -0.5, uname: "a" } }, [0, "a", null, true]],
    ["mid true", { code: 0, data: { mid: true, uname: "a" } }, [1, "a", null, true]],
    ["mid false", { code: 0, data: { mid: false, uname: "a" } }, [0, "a", null, true]],
    ["mid 0", { code: 0, data: { mid: 0, uname: "a" } }, [0, "a", null, true]],
    ['mid "12.5"', { code: 0, data: { mid: "12.5", uname: "a" } }, [null, null, null, false]],
    ["mid [5]", { code: 0, data: { mid: [5], uname: "a" } }, [null, null, null, false]],
    ["mid {}", { code: 0, data: { mid: {}, uname: "a" } }, [null, null, null, false]],
    ['mid ""', { code: 0, data: { mid: "", uname: "a" } }, [null, null, null, false]],
    ['mid "+7"', { code: 0, data: { mid: "+7", uname: "a" } }, [7, "a", null, true]],
    ['mid "-3"', { code: 0, data: { mid: "-3", uname: "a" } }, [-3, "a", null, true]],
    ['mid "007"', { code: 0, data: { mid: "007", uname: "a" } }, [7, "a", null, true]],
    ['mid "0x10"', { code: 0, data: { mid: "0x10", uname: "a" } }, [null, null, null, false]],
    ['mid "1__0"', { code: 0, data: { mid: "1__0", uname: "a" } }, [null, null, null, false]],
    ['mid "10_"', { code: 0, data: { mid: "10_", uname: "a" } }, [null, null, null, false]],
    ['mid "- 5"', { code: 0, data: { mid: "- 5", uname: "a" } }, [null, null, null, false]],
    [
      "mid in Arabic-Indic digits",
      { code: 0, data: { mid: "٤٢", uname: "a" } },
      [42, "a", null, true],
    ],
    [
      "mid in fullwidth digits",
      { code: 0, data: { mid: "１２", uname: "a" } },
      [12, "a", null, true],
    ],
    [
      "mid in mathematical digits",
      { code: 0, data: { mid: "\u{1d7d9}\u{1d7ec}", uname: "a" } },
      [10, "a", null, true],
    ],
    [
      "mid padded with U+3000",
      { code: 0, data: { mid: " 12　", uname: "a" } },
      [12, "a", null, true],
    ],
    [
      "mid padded with \\x1c, which int() does not skip",
      { code: 0, data: { mid: "\x1c12\x85", uname: "a" } },
      [null, null, null, false],
    ],
    [
      "mid null falls back to fetcher",
      { code: 0, data: { mid: null, fetcher: 456, uname: "a" } },
      [456, "a", null, true],
    ],
    [
      'mid missing, fetcher "789"',
      { code: 0, data: { fetcher: "789", uname: "a" } },
      [789, "a", null, true],
    ],
    [
      "an invalid mid does not fall back to fetcher",
      { code: 0, data: { mid: "x", fetcher: 456, uname: "a" } },
      [null, null, null, false],
    ],
    ['uname ""', { code: 0, data: { mid: 1, uname: "" } }, [null, null, null, false]],
    ["uname 0", { code: 0, data: { mid: 1, uname: 0 } }, [null, null, null, false]],
    ["uname missing", { code: 0, data: { mid: 1 } }, [null, null, null, false]],
    ["uname []", { code: 0, data: { mid: 1, uname: [] } }, [null, null, null, false]],
    ["uname {}", { code: 0, data: { mid: 1, uname: {} } }, [null, null, null, false]],
    ["uname 123", { code: 0, data: { mid: 1, uname: 123 } }, [1, "123", null, true]],
    ["uname true", { code: 0, data: { mid: 1, uname: true } }, [1, "True", null, true]],
    ["uname a list", { code: 0, data: { mid: 1, uname: ["a", 1] } }, [1, "['a', 1]", null, true]],
    [
      "uname a dict",
      { code: 0, data: { mid: 1, uname: { k: null } } },
      [1, "{'k': None}", null, true],
    ],
    ["uname 12.5", { code: 0, data: { mid: 1, uname: 12.5 } }, [1, "12.5", null, true]],
    ['face ""', { code: 0, data: { mid: 1, uname: "a", face: "" } }, [1, "a", null, true]],
    ["face 0", { code: 0, data: { mid: 1, uname: "a", face: 0 } }, [1, "a", null, true]],
    [
      "face a URL",
      { code: 0, data: { mid: 1, uname: "a", face: "https://i0.hdslb.com/x.jpg" } },
      [1, "a", "https://i0.hdslb.com/x.jpg", true],
    ],
    ["face 7", { code: 0, data: { mid: 1, uname: "a", face: 7 } }, [1, "a", "7", true]],
    [
      "a 16-digit UID",
      { code: 0, data: { mid: 3493118494325534, uname: "奶糖花" } },
      [3493118494325534, "奶糖花", null, true],
    ],
    [
      "a real Workers answer",
      {
        code: 0,
        message: "0",
        data: {
          isLogin: true,
          face: "https://i0.hdslb.com/bfs/face/x.jpg",
          mid: 12345678,
          uname: "奶绿粉丝",
          fetchMode: "login-sync",
          fetcher: 12345678,
        },
      },
      [12345678, "奶绿粉丝", "https://i0.hdslb.com/bfs/face/x.jpg", true],
    ],
  ];

  test.each(rows)("%s", (_name, payload, [mid, uname, face, isLoggedIn]) => {
    const ctx = parseValidateResponse(payload);
    expect([ctx.mid, ctx.uname, ctx.face, ctx.isLoggedIn]).toEqual([mid, uname, face, isLoggedIn]);
    if (!isLoggedIn) expect(ctx).toBe(ANONYMOUS);
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  test("a mid JSON.parse overflows to Infinity is anonymous", () => {
    expect(parseValidateResponse(JSON.parse('{"code":0,"data":{"mid":1e400,"uname":"a"}}'))).toBe(
      ANONYMOUS,
    );
  });

  test("ANONYMOUS is frozen", () => {
    expect(Object.isFrozen(ANONYMOUS)).toBe(true);
  });
});

describe("UserContextResolver", () => {
  test("the Python oracle's sequence, step by step", async () => {
    const workers = new StubWorkers();
    const clock = new FakeClock(100);
    const resolve = resolver(workers, clock, {
      workersBaseUrl: () => "https://w.example///",
      wafBypassToken: "bypass-secret",
    });
    const url = `https://w.example${VALIDATE_PATH}`;
    const validating = `INFO|[user-context] Validating token against Workers at ${url}`;
    const good = user(42, "u", "f");

    const step = async (t: number, token: string | null, expected: UserContext) => {
      clock.t = t;
      const before = workers.calls.length;
      const ctx = await resolve.resolve(token);
      expect(ctx).toEqual(expected);
      return { fetched: workers.calls.length - before, logs: logs.take() };
    };

    expect(await step(100, null, ANONYMOUS)).toEqual({
      fetched: 0,
      logs: ["INFO|[user-context] No loginSyncToken; viewer is anonymous"],
    });
    expect(await step(100, "   ", ANONYMOUS)).toEqual({
      fetched: 0,
      logs: ["INFO|[user-context] No loginSyncToken; viewer is anonymous"],
    });

    workers.json({ code: 0, data: { mid: 42, uname: "u", face: "f" } });
    expect(await step(100, "  tok  ", good)).toEqual({
      fetched: 1,
      logs: [validating, "INFO|[user-context] Resolved viewer mid=42 uname='u'"],
    });
    const first = workers.calls[0];
    expect(first?.url).toBe(url);
    expect(first?.init.method).toBe("POST");
    expect(first?.init.redirect).toBe("manual");
    expect(first?.init.signal).toBeInstanceOf(AbortSignal);
    expect(first?.init.body).toBe('{"token":"tok"}');
    expect(workers.header(0, "content-type")).toBe("application/json");
    expect(workers.header(0, "x-laplace-cf-waf-bypass")).toBe("bypass-secret");

    expect(await step(130, "tok", good)).toEqual({
      fetched: 0,
      logs: ["INFO|[user-context] Cache hit (logged_in=True, mid=42); skipping Workers call"],
    });

    // Past the TTL every failure serves the stale entry.
    workers.networkError();
    expect(await step(161, "tok", good)).toEqual({
      fetched: 1,
      logs: [
        validating,
        "WARNING|[user-context] Workers validation request failed (TypeError: fetch failed); " +
          "falling back to stale cache",
      ],
    });
    workers.raw("down", 503, "Service Unavailable");
    expect(await step(162, "tok", good)).toEqual({
      fetched: 1,
      logs: [
        validating,
        "WARNING|[user-context] Workers validation request failed (HTTPStatusError: Server error " +
          `'503 Service Unavailable' for url '${url}'); falling back to stale cache`,
      ],
    });
    workers.raw(null, 301, "Moved Permanently");
    expect(await step(163, "tok", good)).toEqual({
      fetched: 1,
      logs: [
        validating,
        "WARNING|[user-context] Workers validation request failed (HTTPStatusError: Redirect " +
          `response '301 Moved Permanently' for url '${url}'); falling back to stale cache`,
      ],
    });

    // A 2xx that isn't JSON is anonymous, not stale, and leaves the entry for later failures.
    workers.raw("<html>", 200);
    const html = await step(164, "tok", ANONYMOUS);
    expect(html.fetched).toBe(1);
    expect(html.logs[0]).toBe(validating);
    expect(html.logs[1]).toStartWith("WARNING|[user-context] Workers returned non-JSON (");
    expect(html.logs[1]).toEndWith("); treating viewer as anonymous");
    workers.networkError();
    expect((await step(165, "tok", good)).logs[1]).toEndWith("falling back to stale cache");

    // A parsed refusal is cached like a success.
    workers.json({ code: -101, message: "账号未登录" });
    expect(await step(166, "bad", ANONYMOUS)).toEqual({
      fetched: 1,
      logs: [
        validating,
        "INFO|[user-context] Token did not resolve to a logged-in user (code=-101)",
      ],
    });
    expect(await step(170, "bad", ANONYMOUS)).toEqual({
      fetched: 0,
      logs: ["INFO|[user-context] Cache hit (logged_in=False, mid=None); skipping Workers call"],
    });

    // An HTTP error is not cached.
    workers.raw("err", 500, "Internal Server Error").raw("err", 500, "Internal Server Error");
    const failed = await step(171, "other", ANONYMOUS);
    expect(failed.logs[1]).toEndWith("falling back to anonymous");
    expect((await step(172, "other", ANONYMOUS)).fetched).toBe(1);

    workers.json([1, 2]);
    expect(await step(173, "lst", ANONYMOUS)).toEqual({
      fetched: 1,
      logs: [validating, "INFO|[user-context] Token did not resolve to a logged-in user (code=?)"],
    });
    expect((await step(174, "lst", ANONYMOUS)).fetched).toBe(0);

    workers.json({ code: null });
    expect((await step(175, "nul", ANONYMOUS)).logs[1]).toBe(
      "INFO|[user-context] Token did not resolve to a logged-in user (code=None)",
    );
    workers.json({ message: "no code" });
    expect((await step(176, "missing", ANONYMOUS)).logs[1]).toBe(
      "INFO|[user-context] Token did not resolve to a logged-in user (code=None)",
    );
  });

  test("no WORKERS_BASE_URL is anonymous without a fetch, even over a warm cache", async () => {
    const workers = new StubWorkers().json({ code: 0, data: { mid: 1, uname: "a" } });
    let base: string | undefined = "https://w.example";
    const resolve = resolver(workers, new FakeClock(1), { workersBaseUrl: () => base });
    expect(await resolve.resolve("tok")).toEqual(user(1, "a"));
    logs.take();
    for (const blank of [undefined, "", "///"]) {
      base = blank;
      expect(await resolve.resolve("tok")).toBe(ANONYMOUS);
      expect(logs.take()).toEqual([
        "WARNING|[user-context] WORKERS_BASE_URL not set; cannot validate token; treating viewer " +
          "as anonymous",
      ]);
    }
    expect(workers.calls).toHaveLength(1);
  });

  test("the base URL is read on every call", async () => {
    env.set("WORKERS_BASE_URL", undefined);
    const workers = new StubWorkers().json({ code: 0, data: { mid: 1, uname: "a" } });
    const resolve = new UserContextResolver({
      fetch: workers.fetch,
      now: new FakeClock(1).now,
      wafBypassToken: "",
    });
    expect(await resolve.resolve("tok")).toBe(ANONYMOUS);
    env.set("WORKERS_BASE_URL", "https://late.example/");
    expect(await resolve.resolve("tok")).toEqual(user(1, "a"));
    expect(workers.calls[0]?.url).toBe(`https://late.example${VALIDATE_PATH}`);
  });

  test("an expired entry is gone once a write lands a further TTL later", async () => {
    const workers = new StubWorkers();
    const clock = new FakeClock(0);
    const resolve = resolver(workers, clock);
    const login = async (t: number, token: string) => {
      clock.t = t;
      workers.json({ code: 0, data: { mid: t, uname: token } });
      await resolve.resolve(token);
    };
    await login(160, "gc-a");
    await login(220, "gc-b");
    // At 280 the cutoff is 220 and gc-a expires at exactly 220, so it survives this write...
    await login(280, "gc-c");
    clock.t = 280.5;
    workers.networkError();
    expect(await resolve.resolve("gc-a")).toEqual(user(160, "gc-a"));
    // ...and not the one at 281.
    await login(281, "gc-d");
    clock.t = 282;
    workers.networkError().networkError();
    expect(await resolve.resolve("gc-a")).toBe(ANONYMOUS);
    expect(await resolve.resolve("gc-b")).toEqual(user(220, "gc-b"));
  });

  test("the TTL and bypass token come from the env at construction", async () => {
    env.set("EIDOLON_VALIDATE_TTL_SEC", "5").set("CF_WAF_BYPASS_TOKEN", "from-env");
    const workers = new StubWorkers();
    const clock = new FakeClock(0);
    const resolve = new UserContextResolver({
      workersBaseUrl: () => "https://w.example",
      fetch: workers.fetch,
      now: clock.now,
    });
    env.set("EIDOLON_VALIDATE_TTL_SEC", "600").set("CF_WAF_BYPASS_TOKEN", "rolled");
    workers
      .json({ code: 0, data: { mid: 1, uname: "a" } })
      .json({ code: 0, data: { mid: 1, uname: "a" } });
    await resolve.resolve("tok");
    clock.t = 4.9;
    await resolve.resolve("tok");
    expect(workers.calls).toHaveLength(1);
    clock.t = 5;
    await resolve.resolve("tok");
    expect(workers.calls).toHaveLength(2);
    expect(workers.header(1, "x-laplace-cf-waf-bypass")).toBe("from-env");
  });

  test("no bypass header without a token", async () => {
    env.set("CF_WAF_BYPASS_TOKEN", "");
    const workers = new StubWorkers().json({}).json({});
    const options = { workersBaseUrl: () => "https://w.example", fetch: workers.fetch };
    await new UserContextResolver(options).resolve("a");
    await new UserContextResolver({ ...options, wafBypassToken: "" }).resolve("b");
    expect(workers.header(0, "x-laplace-cf-waf-bypass")).toBeNull();
    expect(workers.header(1, "x-laplace-cf-waf-bypass")).toBeNull();
  });

  test("a request that never answers times out and fails open", async () => {
    const workers = new StubWorkers()
      .json({ code: 0, data: { mid: 7, uname: "a" } })
      .hang()
      .hang();
    const clock = new FakeClock(0);
    const resolve = resolver(workers, clock, { timeoutMs: 20 });
    await resolve.resolve("tok");
    clock.t = 61;
    logs.take();
    expect(await resolve.resolve("tok")).toEqual(user(7, "a"));
    expect(logs.take()[1]).toMatch(/\(TimeoutError: .+\); falling back to stale cache$/);
    expect(await resolve.resolve("fresh")).toBe(ANONYMOUS);
    expect(workers.calls[2]?.init.signal?.aborted).toBe(true);
  });

  test("a body that fails mid-read is a transport failure", async () => {
    const broken = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"code":0'));
        controller.error(new Error("connection reset"));
      },
    });
    const workers = new StubWorkers()
      .json({ code: 0, data: { mid: 7, uname: "a" } })
      .raw(broken, 200);
    const clock = new FakeClock(0);
    const resolve = resolver(workers, clock);
    await resolve.resolve("tok");
    clock.t = 61;
    logs.take();
    expect(await resolve.resolve("tok")).toEqual(user(7, "a"));
    expect(logs.take()[1]).toEndWith("falling back to stale cache");
  });

  test("a reply that isn't UTF-8 takes the non-JSON path", async () => {
    const body = new Uint8Array([
      ...new TextEncoder().encode('{"code":0,"data":{"mid":1,"uname":"'),
      0xff,
      0x22,
      0x7d,
      0x7d,
    ]);
    const workers = new StubWorkers().raw(body, 200);
    const resolve = resolver(workers, new FakeClock(0));
    expect(await resolve.resolve("tok")).toBe(ANONYMOUS);
    expect(logs.lines()[1]).toStartWith("WARNING|[user-context] Workers returned non-JSON (");
  });

  test("a leading BOM is dropped before parsing", async () => {
    const json = new TextEncoder().encode('{"code":0,"data":{"mid":5,"uname":"bom"}}');
    const workers = new StubWorkers().raw(new Uint8Array([0xef, 0xbb, 0xbf, ...json]), 200);
    expect(await resolver(workers, new FakeClock(0)).resolve("tok")).toEqual(user(5, "bom"));
  });

  test("a rejected fetch fails open, whatever it rejects with", async () => {
    const workers = new StubWorkers()
      .networkError(new TypeError("fetch() URL is invalid"))
      .networkError("not an Error");
    const resolve = resolver(workers, new FakeClock(0));
    expect(await resolve.resolve("a")).toBe(ANONYMOUS);
    expect(await resolve.resolve("b")).toBe(ANONYMOUS);
    expect(logs.lines().filter((l) => l.startsWith("WARNING"))).toEqual([
      "WARNING|[user-context] Workers validation request failed (TypeError: fetch() URL is " +
        "invalid); falling back to anonymous",
      "WARNING|[user-context] Workers validation request failed (not an Error); falling back to " +
        "anonymous",
    ]);
  });

  test("the default fetch fails open on a URL it cannot parse", async () => {
    const resolve = new UserContextResolver({
      workersBaseUrl: () => "http://[::1",
      wafBypassToken: "",
      now: new FakeClock(0).now,
    });
    expect(await resolve.resolve("tok")).toBe(ANONYMOUS);
    expect(logs.lines()[1]).toEndWith("falling back to anonymous");
  });

  test("two concurrent misses for one token make two requests", async () => {
    const workers = new StubWorkers()
      .json({ code: 0, data: { mid: 1, uname: "a" } })
      .json({ code: 0, data: { mid: 1, uname: "a" } });
    const resolve = resolver(workers, new FakeClock(0));
    const got = await Promise.all([resolve.resolve("tok"), resolve.resolve("tok")]);
    expect(got).toEqual([user(1, "a"), user(1, "a")]);
    expect(workers.calls).toHaveLength(2);
  });

  test("TTL 0 never hits but still leaves a stale fallback", async () => {
    const workers = new StubWorkers()
      .json({ code: 0, data: { mid: 1, uname: "a" } })
      .networkError();
    const resolve = resolver(workers, new FakeClock(0), { ttlSeconds: 0 });
    await resolve.resolve("tok");
    expect(await resolve.resolve("tok")).toEqual(user(1, "a"));
    expect(workers.calls).toHaveLength(2);
  });

  test("a negative TTL never crashes and keeps nothing", async () => {
    const workers = new StubWorkers()
      .json({ code: 0, data: { mid: 1, uname: "a" } })
      .networkError();
    const resolve = resolver(workers, new FakeClock(0), { ttlSeconds: -5 });
    expect(await resolve.resolve("tok")).toEqual(user(1, "a"));
    expect(await resolve.resolve("tok")).toBe(ANONYMOUS);
  });

  test("the cache key is sha256 of the stripped token", async () => {
    expect(validateCacheKey("tok")).toBe(
      "1a7674eb4ee78df7e1ac439a93c3fa8e3c945784d4dec9fd8e3011738b2f1d62",
    );
    const workers = new StubWorkers().json({ code: 0, data: { mid: 1, uname: "a" } });
    const resolve = resolver(workers, new FakeClock(0));
    await resolve.resolve("　tok\x1c");
    expect(await resolve.resolve("tok")).toEqual(user(1, "a"));
    expect(workers.calls).toHaveLength(1);
    expect(workers.body(0)).toEqual({ token: "tok" });
  });
});
