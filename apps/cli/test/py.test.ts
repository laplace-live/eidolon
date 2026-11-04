import { describe, expect, test } from "bun:test";
import { PyFloat, pyJsonDumps } from "@eidolon/config";
import { ljust, loadsPy, mean, pyRound, rjust, splitlines, textwrapIndent } from "../src/index.ts";

describe("str.splitlines", () => {
  test("splits on every Python line boundary and drops a trailing empty line", () => {
    expect(splitlines("")).toEqual([]);
    expect(splitlines("\n")).toEqual([""]);
    expect(splitlines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitlines("a\n\n")).toEqual(["a", ""]);
    expect(splitlines("a\r\nb\rc\vd\fe\x1cf\x1dg\x1eh\x85i\u2028j\u2029k")).toEqual([
      ..."abcdefghijk",
    ]);
  });
});

describe("textwrap.indent", () => {
  test("prefixes lines with content and leaves whitespace-only lines alone", () => {
    expect(textwrapIndent("a\n\n  \nb\r\nc", "  ")).toBe("  a\n\n  \n  b\r\n  c");
    expect(textwrapIndent("", "  ")).toBe("");
  });
});

describe("format-spec padding counts code points", () => {
  test("ljust and rjust", () => {
    expect(ljust("😀", 3)).toBe("😀  ");
    expect(rjust("ab", 4)).toBe("  ab");
    expect(ljust("abcdef", 3)).toBe("abcdef");
  });
});

describe("round()", () => {
  test("ties go to the even neighbour", () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, 2.4999, 2.5001].map(pyRound)).toEqual([
      0, 2, 2, 0, -2, 2, 3,
    ]);
  });
});

test("statistics.mean", () => {
  expect(mean([1, 2, 4])).toBe(7 / 3);
  expect(() => mean([])).toThrow("mean requires at least one data point");
});

test("loadsPy keeps 1.0 apart from 1", () => {
  const value = loadsPy('{"a": 1.0, "b": 1, "c": [2e-05, 0.5, -0]}') as Record<string, unknown>;
  expect(value.a).toEqual(new PyFloat(1));
  expect(value.b).toBe(1);
  expect(pyJsonDumps(value)).toBe('{"a": 1.0, "b": 1, "c": [2e-05, 0.5, 0]}');
});
