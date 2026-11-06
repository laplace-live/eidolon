import { expect, test } from "bun:test";
import { elapsedSeconds, formatBytes, formatDuration, formatUsd } from "./format";

test("durations read as clock time, hours only when there are any", () => {
  expect([0, 65, 3600, 3723, -5].map(formatDuration)).toEqual([
    "0:00",
    "1:05",
    "1:00:00",
    "1:02:03",
    "0:00",
  ]);
});

test("costs are to the cent, and a fraction of a cent isn't rounded away", () => {
  expect(formatUsd(1.5, "en")).toBe("$1.50");
  expect(formatUsd(0, "en")).toBe("$0.00");
  expect(formatUsd(0.004, "en")).toBe("< $0.01");
});

test("sizes use decimal units", () => {
  expect(formatBytes(999, "en")).toBe("999 byte");
  expect(formatBytes(1_234_567_890, "en")).toBe("1.2 GB");
  expect(formatBytes(2_000_000_000_000_000, "en")).toBe("2,000 TB");
});

test("elapsed time runs to the end, or to now while there is none", () => {
  const start = "2026-11-05T10:00:00Z";
  expect(elapsedSeconds(start, "2026-11-05T10:01:30Z", 0)).toBe(90);
  expect(elapsedSeconds(start, null, Date.parse("2026-11-05T10:00:10Z"))).toBe(10);
  expect(elapsedSeconds("not a date", null, 0)).toBe(0);
});
