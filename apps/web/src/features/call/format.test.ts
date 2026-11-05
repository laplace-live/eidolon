import { describe, expect, test } from "bun:test";
import { formatDuration, monogram } from "./format";

describe("formatDuration", () => {
  test("minutes and seconds, then hours", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(59_999)).toBe("00:59");
    expect(formatDuration(61_000)).toBe("01:01");
    expect(formatDuration(3_599_000)).toBe("59:59");
    expect(formatDuration(3_600_000)).toBe("1:00:00");
    expect(formatDuration(-5000)).toBe("00:00");
  });
});

describe("monogram", () => {
  test("a short name of two characters or fewer shows whole", () => {
    expect(monogram("奶绿", "明前奶绿")).toBe("奶绿");
    expect(monogram("Al", "Alice")).toBe("Al");
  });

  test("a longer one shows its first character, or the initials of its first two words", () => {
    expect(monogram("mika", "Mika")).toBe("M");
    expect(monogram("小明同学", "")).toBe("小");
    expect(monogram("lumi chan", "")).toBe("LC");
    expect(monogram("👩‍🎤 star", "")).toBe("👩‍🎤S");
  });

  test("falls back to the name", () => {
    expect(monogram("  ", "明前奶绿")).toBe("明");
  });
});
