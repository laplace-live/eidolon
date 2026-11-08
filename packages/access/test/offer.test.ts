import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ANON_QUOTA_EXHAUSTED_ERROR,
  ANONYMOUS,
  type AudioQualitySettings,
  admitOffer,
  type JsonObject,
  loginSyncTokenFrom,
  type OfferAdmission,
  type OfferGuardDeps,
  offerRequestData,
  parseOfferBody,
  preflightOffer,
  SlidingWindowQuota,
  type UserContext,
} from "../src/index.ts";
import { FakeClock, LogCapture } from "./helpers.ts";

const AUDIO: AudioQualitySettings = {
  presetsBps: { best: 192000, medium: 96000, low: 64000, lowest: 8000 },
  defaultBitrateBps: 96000,
};
const FAN: UserContext = { mid: 12345678, uname: "奶绿粉丝", face: null, isLoggedIn: true };
const IP = "203.0.113.7";

// The offer's 429 bytes (json.dumps, ensure_ascii=False) and the preflight's (Starlette's compact
// JSONResponse).
const OFFER_429 = '{"error": "匿名用户每小时通话次数已达上限，请登录后再试", "retry_after": 3599}';
const PREFLIGHT_429 =
  '{"ok":false,"anonymous":true,"error":"匿名用户每小时通话次数已达上限，请登录后再试",' +
  '"retry_after":3599}';

let logs: LogCapture;
beforeEach(() => {
  logs = new LogCapture();
});
afterEach(() => logs.restore());

function guard(max = 2, start = 1000) {
  const clock = new FakeClock(start);
  const quota = new SlidingWindowQuota(max, 3600, clock.now);
  const seenTokens: string[] = [];
  const deps: OfferGuardDeps = {
    quota,
    audio: AUDIO,
    resolveUser: async (token) => {
      seenTokens.push(token);
      return token === "good" ? FAN : ANONYMOUS;
    },
  };
  const offer = (body: unknown, clientIp = IP) =>
    admitOffer(
      { bodyText: typeof body === "string" ? body : JSON.stringify(body), clientIp },
      deps,
    );
  const preflight = (body: unknown, clientIp = IP) =>
    preflightOffer(
      { bodyText: typeof body === "string" ? body : JSON.stringify(body), clientIp },
      deps,
    );
  return { clock, quota, deps, seenTokens, offer, preflight };
}

async function wire(response: Response) {
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    retryAfter: response.headers.get("retry-after"),
    body: await response.text(),
  };
}

function rejected(admission: OfferAdmission): Response {
  if (admission.allowed) throw new Error("expected a refused offer");
  return admission.response;
}

describe("the Python oracle's offer and preflight sequence (quota 2)", () => {
  test("every step answers and logs as offer_middleware.py did", async () => {
    const g = guard();

    expect(await wire(await g.preflight({ requestData: {} }))).toEqual({
      status: 200,
      contentType: "application/json",
      retryAfter: null,
      body: '{"ok":true,"anonymous":true,"remaining":2}',
    });
    expect(await wire(await g.preflight({ requestData: { loginSyncToken: "good" } }))).toEqual({
      status: 200,
      contentType: "application/json",
      retryAfter: null,
      body: '{"ok":true,"anonymous":false}',
    });
    expect((await wire(await g.preflight(""))).body).toBe(
      '{"ok":true,"anonymous":true,"remaining":2}',
    );

    const best = await g.offer({ sdp: "x", type: "offer", requestData: { audioQuality: "best" } });
    expect(best).toEqual({
      allowed: true,
      user: ANONYMOUS,
      token: null,
      body: { sdp: "x", type: "offer", requestData: { audioQuality: "best" } },
      requestData: { audioQuality: "best" },
      opusBitrateBps: 192000,
      clientIp: IP,
      quota: { allowed: true, remaining: 1, retryAfterSeconds: 0 },
    });

    g.clock.t = 1000.5;
    const bad = await g.offer({ sdp: "x", type: "offer", requestData: { loginSyncToken: "bad" } });
    expect(bad).toMatchObject({
      allowed: true,
      user: ANONYMOUS,
      token: "bad",
      opusBitrateBps: 96000,
      quota: { allowed: true, remaining: 0, retryAfterSeconds: 0 },
    });

    g.clock.t = 1001;
    const none = await g.offer({ sdp: "x", type: "offer", requestData: {} });
    expect(none).toMatchObject({
      allowed: false,
      user: ANONYMOUS,
      clientIp: IP,
      quota: { allowed: false, remaining: 0, retryAfterSeconds: 3599 },
    });
    expect(await wire(rejected(none))).toEqual({
      status: 429,
      contentType: "application/json; charset=utf-8",
      retryAfter: "3599",
      body: OFFER_429,
    });

    expect(await wire(await g.preflight({ requestData: {} }))).toEqual({
      status: 429,
      contentType: "application/json",
      retryAfter: "3599",
      body: PREFLIGHT_429,
    });

    const good = await g.offer({
      sdp: "x",
      type: "offer",
      requestData: { loginSyncToken: " good ", audioQuality: "lowest" },
    });
    expect(good).toMatchObject({
      allowed: true,
      user: FAN,
      token: "good",
      opusBitrateBps: 8000,
      quota: null,
    });
    // The bypass touched no slot: the bucket reads exactly as before.
    expect(g.quota.peek(IP)).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 3599 });

    expect((await wire(await g.preflight({}))).status).toBe(429);
    expect(await wire(rejected(await g.offer("junk")))).toMatchObject({
      status: 429,
      body: OFFER_429,
    });
    expect(
      await wire(rejected(await g.offer({ requestData: { loginSyncToken: "bad" } }))),
    ).toMatchObject({ status: 429, body: OFFER_429 });

    expect(g.seenTokens).toEqual(["good", "bad", "good", "bad"]);
    expect(logs.lines()).toEqual([
      "INFO|[offer-middleware] audioQuality='best' → Opus bitrate 192 kbps for this session",
      `DEBUG|[offer-rate-limit] Anonymous offer allowed for ip=${IP}; remaining=1/2`,
      "INFO|[offer-middleware] Token present but did not validate (len=3); falling through to " +
        "anonymous quota",
      `DEBUG|[offer-rate-limit] Anonymous offer allowed for ip=${IP}; remaining=0/2`,
      `INFO|[offer-rate-limit] Anonymous quota exhausted for ip=${IP}; rejecting offer ` +
        "(retry_after=3599s, window=3600s, max=2)",
      "INFO|[offer-middleware] audioQuality='lowest' → Opus bitrate 8 kbps for this session",
      "INFO|[offer-middleware] Logged-in offer (validated mid=12345678, len=4); bypassing rate " +
        "limit",
      `INFO|[offer-rate-limit] Anonymous quota exhausted for ip=${IP}; rejecting offer ` +
        "(retry_after=3599s, window=3600s, max=2)",
      "INFO|[offer-middleware] Token present but did not validate (len=3); falling through to " +
        "anonymous quota",
      `INFO|[offer-rate-limit] Anonymous quota exhausted for ip=${IP}; rejecting offer ` +
        "(retry_after=3599s, window=3600s, max=2)",
    ]);
  });
});

describe("admitOffer", () => {
  test("the resolver runs only when a token is present", async () => {
    const g = guard(10);
    await g.offer({ requestData: { audioQuality: "low" } });
    await g.offer({ requestData: { loginSyncToken: "   " } });
    await g.offer({ requestData: { loginSyncToken: 123 } });
    await g.offer("");
    expect(g.seenTokens).toEqual([]);
    await g.offer({ request_data: { loginSyncToken: "\tgood\n" } });
    expect(g.seenTokens).toEqual(["good"]);
  });

  test("a refused offer still resolves its bitrate", async () => {
    const g = guard(0);
    const refused = await g.offer({ requestData: { audioQuality: "best" } });
    expect(refused.allowed).toBe(false);
    expect(logs.lines()[0]).toBe(
      "INFO|[offer-middleware] audioQuality='best' → Opus bitrate 192 kbps for this session",
    );
  });

  test("junk is charged a slot before anything validates the body", async () => {
    const g = guard(1);
    const junk = await g.offer("junk");
    expect(junk).toMatchObject({ allowed: true, body: null, requestData: null, token: null });
    expect((await g.offer({ sdp: "x", type: "offer" })).allowed).toBe(false);
  });

  test("a validated token bypasses even a zero quota, whatever else the body lacks", async () => {
    const g = guard(0);
    const admitted = await g.offer({ requestData: { loginSyncToken: "good" } });
    expect(admitted).toEqual({
      allowed: true,
      user: FAN,
      token: "good",
      body: { requestData: { loginSyncToken: "good" } },
      requestData: { loginSyncToken: "good" },
      opusBitrateBps: 96000,
      clientIp: IP,
      quota: null,
    });
  });

  test("a bad token's 429 is byte-identical to no token's", async () => {
    const g = guard(0);
    const withBad = await wire(rejected(await g.offer({ requestData: { loginSyncToken: "bad" } })));
    const without = await wire(rejected(await g.offer({ requestData: {} })));
    expect(withBad).toEqual(without);
    const bytes = new Uint8Array(await rejected(await g.offer("")).arrayBuffer());
    expect(bytes).toEqual(new TextEncoder().encode(withBad.body));
  });

  test("each refusal carries its own unread 429", async () => {
    const g = guard(0);
    const first = rejected(await g.offer("{}"));
    const second = rejected(await g.offer("{}"));
    expect(first).not.toBe(second);
    expect(await first.text()).toBe(await second.text());
  });

  test("buckets are per client IP", async () => {
    const g = guard(1);
    expect((await g.offer("{}", "198.51.100.1")).allowed).toBe(true);
    expect((await g.offer("{}", "198.51.100.1")).allowed).toBe(false);
    expect((await g.offer("{}", "198.51.100.2")).allowed).toBe(true);
  });

  test("the resolver's rejection propagates", async () => {
    const quota = new SlidingWindowQuota(1, 60);
    const failing: OfferGuardDeps = {
      quota,
      audio: AUDIO,
      resolveUser: () => Promise.reject(new Error("boom")),
    };
    const input = { bodyText: '{"requestData":{"loginSyncToken":"t"}}', clientIp: IP };
    await expect(admitOffer(input, failing)).rejects.toThrow("boom");
    expect(quota.peek(IP).remaining).toBe(1);
  });
});

describe("preflightOffer", () => {
  test("peeks and never charges", async () => {
    const g = guard(1);
    for (let i = 0; i < 5; i++) {
      expect((await wire(await g.preflight({ requestData: {} }))).body).toBe(
        '{"ok":true,"anonymous":true,"remaining":1}',
      );
    }
    expect((await g.offer("{}")).allowed).toBe(true);
    expect((await wire(await g.preflight("{}"))).status).toBe(429);
  });

  test("a bad token reads like no token", async () => {
    const g = guard(1);
    const bad = await wire(await g.preflight({ requestData: { loginSyncToken: "bad" } }));
    const none = await wire(await g.preflight({ requestData: {} }));
    expect(bad).toEqual(none);
  });

  test("never applies audioQuality", async () => {
    const g = guard(1);
    await g.preflight({ requestData: { audioQuality: "best" } });
    await g.preflight({ requestData: { audioQuality: "nope" } });
    expect(logs.lines()).toEqual([]);
  });
});

describe("body parsing", () => {
  test("parseOfferBody keeps only JSON objects", () => {
    for (const text of ["", "junk", "null", "[1]", '"x"', "   ", "\ufeff{}"]) {
      expect(parseOfferBody(text)).toBeNull();
    }
    expect(parseOfferBody('{"a": 1}')).toEqual({ a: 1 });
    expect(parseOfferBody(' {"a": 1}\n')).toEqual({ a: 1 });
  });

  test("invalid UTF-8 becomes U+FFFD and the JSON still parses", async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('{"requestData": {"loginSyncToken": "t'),
      0xff,
      ...new TextEncoder().encode('k"}}'),
    ]);
    const bodyText = await new Request("http://localhost/api/offer", {
      method: "POST",
      body: bytes,
    }).text();
    expect(loginSyncTokenFrom(offerRequestData(parseOfferBody(bodyText)))).toBe("t\ufffdk");
  });

  const precedence: [string, unknown, JsonObject | null, string | null][] = [
    ["camelCase", { requestData: { loginSyncToken: "A" } }, { loginSyncToken: "A" }, "A"],
    ["snake_case", { request_data: { loginSyncToken: "B" } }, { loginSyncToken: "B" }, "B"],
    [
      "a non-object requestData defers to request_data",
      { requestData: "x", request_data: { loginSyncToken: "B" } },
      { loginSyncToken: "B" },
      "B",
    ],
    [
      "both objects: requestData wins",
      { requestData: { loginSyncToken: "A" }, request_data: { loginSyncToken: "B" } },
      { loginSyncToken: "A" },
      "A",
    ],
    ["requestData null", { requestData: null }, null, null],
    ["requestData a string", { requestData: "x" }, null, null],
    ["requestData empty", { requestData: {} }, {}, null],
    ["an empty body", {}, null, null],
    ["requestData a list", { requestData: [{ loginSyncToken: "A" }] }, null, null],
  ];

  test.each(precedence)("%s", (_name, body, requestData, token) => {
    const parsed = parseOfferBody(JSON.stringify(body));
    expect(offerRequestData(parsed)).toEqual(requestData);
    expect(loginSyncTokenFrom(offerRequestData(parsed))).toBe(token);
  });

  test("the precedence holds through the guard", async () => {
    const g = guard(5);
    const both = await g.offer({
      requestData: { loginSyncToken: "good" },
      request_data: { loginSyncToken: "bad" },
    });
    expect(both).toMatchObject({ allowed: true, user: FAN, quota: null });
    const deferred = await g.offer({ requestData: "x", request_data: { loginSyncToken: "good" } });
    expect(deferred).toMatchObject({ allowed: true, user: FAN, quota: null });
  });

  const tokens: [unknown, string | null][] = [
    [123, null],
    ["   ", null],
    [" tok ", "tok"],
    ["\x1ctok\x85", "tok"],
    ["\ufefftok", "\ufefftok"],
    [null, null],
    [true, null],
    [["t"], null],
  ];

  test.each(tokens)("loginSyncToken %p → %p", (raw, token) => {
    expect(loginSyncTokenFrom({ loginSyncToken: raw })).toBe(token);
  });

  test("the 429 text is the one Python sent", () => {
    expect(ANON_QUOTA_EXHAUSTED_ERROR).toBe("匿名用户每小时通话次数已达上限，请登录后再试");
  });
});
