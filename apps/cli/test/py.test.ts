import { describe, expect, test } from "bun:test";
import { ljust, mean, rjust, textwrapIndent } from "../src/index.ts";

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

test("statistics.mean", () => {
  expect(mean([1, 2, 4])).toBe(7 / 3);
  expect(() => mean([])).toThrow("mean requires at least one data point");
});
