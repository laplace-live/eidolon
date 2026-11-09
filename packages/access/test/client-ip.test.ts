import { afterEach, describe, expect, test } from "bun:test";
import { resolveClientIp, UNKNOWN_CLIENT_IP } from "../src/index.ts";
import { EnvPatch } from "./helpers.ts";

const env = new EnvPatch();
afterEach(() => env.restore());

function headers(...entries: [string, string][]): Headers {
  const h = new Headers();
  for (const [name, value] of entries) h.append(name, value);
  return h;
}

describe("resolveClientIp", () => {
  // Each row: name, EIDOLON_REAL_IP_HEADER, raw headers, peer address, and the IP expected.
  const rows: [string, string | undefined, [string, string][], string | null, string][] = [
    [
      "unset ignores X-Forwarded-For",
      undefined,
      [["x-forwarded-for", "1.1.1.1"]],
      "10.0.0.1",
      "10.0.0.1",
    ],
    [
      "first comma entry, trimmed",
      "X-Forwarded-For",
      [["x-forwarded-for", " 1.1.1.1 , 2.2.2.2"]],
      "10.0.0.1",
      "1.1.1.1",
    ],
    [
      "the env name is stripped and lowercased",
      "  CF-Connecting-IP  ",
      [["cf-connecting-ip", "3.3.3.3"]],
      "10.0.0.1",
      "3.3.3.3",
    ],
    [
      "an empty value falls back to the peer",
      "x-real-ip",
      [["x-real-ip", ""]],
      "10.0.0.1",
      "10.0.0.1",
    ],
    [
      "an empty first entry ignores later headers",
      "x-real-ip",
      [
        ["x-real-ip", " , 4.4.4.4"],
        ["x-real-ip", "5.5.5.5"],
      ],
      "10.0.0.1",
      "10.0.0.1",
    ],
    [
      "the first header wins",
      "x-real-ip",
      [
        ["x-real-ip", "6.6.6.6"],
        ["x-real-ip", "7.7.7.7"],
      ],
      "10.0.0.1",
      "6.6.6.6",
    ],
    [
      "the value is not validated as an IP",
      "x-real-ip",
      [["x-real-ip", "not-an-ip"]],
      "10.0.0.1",
      "not-an-ip",
    ],
    ["an absent header falls back to the peer", "x-real-ip", [], "10.0.0.1", "10.0.0.1"],
    ["no peer is the shared bucket", undefined, [], null, "unknown"],
    ["an empty peer is the shared bucket", undefined, [], "", "unknown"],
    [
      "a name with a space matches nothing",
      "x real ip",
      [["x-real-ip", "8.8.8.8"]],
      "10.0.0.1",
      "10.0.0.1",
    ],
    [
      "a non-ASCII name matches nothing",
      "ü-ip",
      [["x-real-ip", "8.8.8.8"]],
      "10.0.0.1",
      "10.0.0.1",
    ],
    ["a blank env is unset", "   ", [["x-real-ip", "8.8.8.8"]], "10.0.0.1", "10.0.0.1"],
    // Headers.get keeps U+00A0 and U+0085; Python's strip() removes both.
    [
      "Python whitespace around the entry",
      "x-real-ip",
      [["x-real-ip", "\xa09.9.9.9\x85"]],
      "10.0.0.1",
      "9.9.9.9",
    ],
  ];

  test.each(rows)("%s", (_name, realIpHeader, entries, peer, expected) => {
    env.set("EIDOLON_REAL_IP_HEADER", realIpHeader);
    expect(resolveClientIp(headers(...entries), peer)).toBe(expected);
  });

  test("a name Headers.get rejects falls back to the peer instead of throwing", () => {
    env.set("EIDOLON_REAL_IP_HEADER", "中");
    expect(() => new Headers().get("中")).toThrow();
    expect(resolveClientIp(headers(["x-real-ip", "8.8.8.8"]), "10.0.0.1")).toBe("10.0.0.1");
    expect(resolveClientIp(new Headers(), undefined)).toBe(UNKNOWN_CLIENT_IP);
  });

  test("the env var is read on every call", () => {
    const h = headers(["cf-connecting-ip", "3.3.3.3"], ["x-real-ip", "4.4.4.4"]);
    env.set("EIDOLON_REAL_IP_HEADER", "cf-connecting-ip");
    expect(resolveClientIp(h, "10.0.0.1")).toBe("3.3.3.3");
    env.set("EIDOLON_REAL_IP_HEADER", "x-real-ip");
    expect(resolveClientIp(h, "10.0.0.1")).toBe("4.4.4.4");
    env.set("EIDOLON_REAL_IP_HEADER", "");
    expect(resolveClientIp(h, "10.0.0.1")).toBe("10.0.0.1");
  });

  test("a dual-stack peer address is used as given", () => {
    env.set("EIDOLON_REAL_IP_HEADER", undefined);
    expect(resolveClientIp(new Headers(), "::ffff:127.0.0.1")).toBe("::ffff:127.0.0.1");
  });
});
