import { describe, expect, test } from "bun:test";
import { formatDuration } from "./format";

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
