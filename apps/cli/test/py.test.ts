import { describe, expect, test } from "bun:test";
import { mean, textwrapIndent } from "../src/index.ts";

describe("textwrap.indent", () => {
  test("prefixes lines with content and leaves whitespace-only lines alone", () => {
    expect(textwrapIndent("a\n\n  \nb\r\nc", "  ")).toBe("  a\n\n  \n  b\r\n  c");
    expect(textwrapIndent("", "  ")).toBe("");
  });
});

test("statistics.mean", () => {
  expect(mean([1, 2, 4])).toBe(7 / 3);
  expect(() => mean([])).toThrow("mean requires at least one data point");
});
