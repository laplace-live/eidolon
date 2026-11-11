import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { activePersona } from "@eidolon/config";
import {
  ANONYMOUS,
  admitChatTurn,
  CHAT_ANON_QUOTA_ERROR,
  CHAT_USER_QUOTA_ERROR,
  type ChatAdmission,
  type ChatQuotas,
  chatPersonas,
  SlidingWindowQuota,
  type UserContext,
} from "../src/index.ts";
import { EnvPatch, FakeClock, LogCapture } from "./helpers.ts";

const FAN: UserContext = { mid: 12345678, uname: "奶绿粉丝", face: null, isLoggedIn: true };
const OTHER_FAN: UserContext = { mid: 87654321, uname: "另一个粉丝", face: null, isLoggedIn: true };
const IP = "203.0.113.7";

const env = new EnvPatch();
let logs: LogCapture;
beforeEach(() => {
  logs = new LogCapture();
});
afterEach(() => {
  logs.restore();
  env.restore();
});

function guard(anon = 2, user = 3) {
  const clock = new FakeClock(1000);
  const quotas: ChatQuotas = {
    anonymous: new SlidingWindowQuota(anon, 3600, clock.now),
    loggedIn: new SlidingWindowQuota(user, 3600, clock.now),
  };
  const asked: string[] = [];
  const resolveUser = async (token: string): Promise<UserContext> => {
    asked.push(token);
    if (token === "good") return FAN;
    return token === "other" ? OTHER_FAN : ANONYMOUS;
  };
  const turn = (token: string | null, clientIp = IP) =>
    admitChatTurn({ token, clientIp }, { quotas, resolveUser });
  return { clock, quotas, asked, turn };
}

async function refusal(admission: ChatAdmission) {
  if (admission.allowed) throw new Error("expected a refused turn");
  const { response } = admission;
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    retryAfter: response.headers.get("retry-after"),
    body: await response.text(),
  };
}

describe("admitChatTurn", () => {
  test("anonymous turns are counted per IP, and the next one is refused with a 429", async () => {
    const g = guard(2);
    expect(await g.turn(null)).toEqual({
      allowed: true,
      user: ANONYMOUS,
      quota: { allowed: true, remaining: 1, retryAfterSeconds: 0 },
    });
    expect((await g.turn(null)).allowed).toBe(true);
    expect((await g.turn(null, "198.51.100.1")).allowed).toBe(true);
    g.clock.t = 1001;
    const refused = await g.turn(null);
    expect(refused).toMatchObject({ allowed: false, user: ANONYMOUS });
    expect(await refusal(refused)).toEqual({
      status: 429,
      contentType: "application/json; charset=utf-8",
      retryAfter: "3599",
      body: `{"error": "${CHAT_ANON_QUOTA_ERROR}", "retry_after": 3599}`,
    });
    expect(g.asked).toEqual([]);
    expect(logs.lines()).toEqual([
      "INFO|[chat-quota] Quota exhausted for ip=203.0.113.7; rejecting the turn " +
        "(retry_after=3599s, max=2)",
    ]);
  });

  test("a validated token is counted per mid, on any IP, and never against the IP's quota", async () => {
    const g = guard(1, 2);
    expect(await g.turn("good", "198.51.100.1")).toEqual({
      allowed: true,
      user: FAN,
      quota: { allowed: true, remaining: 1, retryAfterSeconds: 0 },
    });
    expect((await g.turn("good", "198.51.100.2")).allowed).toBe(true);
    const refused = await g.turn("good", "198.51.100.3");
    expect(refused).toMatchObject({ allowed: false, user: FAN });
    expect(JSON.parse((await refusal(refused)).body)).toEqual({
      error: CHAT_USER_QUOTA_ERROR,
      retry_after: 3600,
    });
    // Another viewer's mid, and the IPs those turns came from, still have their own slots.
    expect((await g.turn("other", "198.51.100.1")).allowed).toBe(true);
    expect((await g.turn(null, "198.51.100.1")).allowed).toBe(true);
    expect(g.quotas.loggedIn.peek(String(FAN.mid)).remaining).toBe(0);
    expect(g.asked).toEqual(["good", "good", "good", "other"]);
  });

  test("a token that doesn't validate is anonymous: the IP's quota, never the mid's", async () => {
    const g = guard(1, 5);
    const admitted = await g.turn("forged");
    expect(admitted).toMatchObject({ allowed: true, user: ANONYMOUS });
    expect(g.quotas.anonymous.peek(IP).remaining).toBe(0);
    expect(await refusal(await g.turn("forged-again"))).toMatchObject({ status: 429 });
    expect(g.asked).toEqual(["forged", "forged-again"]);
    expect(logs.lines()[0]).toBe(
      "INFO|[chat-quota] Token present but did not validate (len=6); charging the anonymous quota",
    );
  });

  test("a quota of 0 refuses every turn of its kind", async () => {
    const g = guard(0, 0);
    expect((await g.turn(null)).allowed).toBe(false);
    expect((await g.turn("good")).allowed).toBe(false);
  });
});

describe("chatPersonas", () => {
  test("defaults to the installed persona alone", () => {
    env.set("EIDOLON_CHAT_PERSONAS", undefined);
    expect(chatPersonas()).toEqual([activePersona().id]);
    env.set("EIDOLON_CHAT_PERSONAS", "");
    expect(chatPersonas()).toEqual([activePersona().id]);
  });

  test("reads a comma-separated list, trimmed, blanks and repeats dropped, on every call", () => {
    env.set("EIDOLON_CHAT_PERSONAS", " milky-green, ,other,milky-green ");
    expect(chatPersonas()).toEqual(["milky-green", "other"]);
    env.set("EIDOLON_CHAT_PERSONAS", "other");
    expect(chatPersonas()).toEqual(["other"]);
  });
});
