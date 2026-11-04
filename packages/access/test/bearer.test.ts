import { describe, expect, test } from "bun:test";
import {
  ANONYMOUS,
  extractBearerToken,
  type LoggedInUser,
  resolveBearerCaller,
  type UserContext,
} from "../src/index.ts";

describe("extractBearerToken", () => {
  // Each row was answered by Python's memory_admin._extract_bearer_token.
  const rows: [string | null | undefined, string | null][] = [
    [null, null],
    [undefined, null],
    ["", null],
    ["Bearer abc", "abc"],
    ["bearer abc", "abc"],
    ["BEARER abc", "abc"],
    ["  Bearer   abc  ", "abc"],
    ["Bearer\tabc", "abc"],
    ["Bearer a b", "a b"],
    ["Bearer", null],
    ["Bearer   ", null],
    ["Basic abc", null],
    ["Bearerabc", null],
    ["Bearer　abc　", "abc"],
    ["Bearer\x1cabc", "abc"],
    ["\x85Bearer abc", "abc"],
    // What Headers.get makes of two Authorization headers.
    ["Bearer a, Bearer b", "a, Bearer b"],
  ];

  test.each(rows)("%p → %p", (header, token) => {
    expect(extractBearerToken(header)).toBe(token);
  });
});

describe("resolveBearerCaller", () => {
  const loggedIn: LoggedInUser = { mid: 12345678, uname: "奶绿粉丝", face: null, isLoggedIn: true };

  test("returns the logged-in user for a valid bearer token", async () => {
    const seen: string[] = [];
    const caller = await resolveBearerCaller("Bearer  good-token ", async (token) => {
      seen.push(token);
      return loggedIn;
    });
    expect(caller).toBe(loggedIn);
    expect(seen).toEqual(["good-token"]);
  });

  test("never resolves without a bearer token", async () => {
    let calls = 0;
    const resolve = async () => {
      calls++;
      return loggedIn;
    };
    for (const header of [null, undefined, "", "Basic abc", "Bearer"]) {
      expect(await resolveBearerCaller(header, resolve)).toBeNull();
    }
    expect(calls).toBe(0);
  });

  test("an anonymous resolution is null", async () => {
    expect(await resolveBearerCaller("Bearer bad", async () => ANONYMOUS)).toBeNull();
  });

  test("logged in without a mid is null", async () => {
    const noMid: UserContext = { mid: null, uname: "x", face: null, isLoggedIn: true };
    expect(await resolveBearerCaller("Bearer tok", async () => noMid)).toBeNull();
  });

  test("a mid without isLoggedIn is null", async () => {
    const notLoggedIn: UserContext = { mid: 1, uname: "x", face: null, isLoggedIn: false };
    expect(await resolveBearerCaller("Bearer tok", async () => notLoggedIn)).toBeNull();
  });
});
