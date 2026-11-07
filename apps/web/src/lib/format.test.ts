import { afterEach, expect, test } from "bun:test";
import { elapsedSeconds, formatBytes, formatClock, formatDuration, formatUsd } from "./format";

const IntlDateTimeFormat = Intl.DateTimeFormat;

afterEach(() => {
  Intl.DateTimeFormat = IntlDateTimeFormat;
});

/**
 * Intl.DateTimeFormat under ECMA-402's earlier hour12 rule, which V8 follows: hour12: false is h24
 * where the locale's own cycle is 12-hour. JavaScriptCore, which runs these tests, picks h23.
 */
class V8DateTimeFormat extends IntlDateTimeFormat {
  constructor(lang?: string | string[], options: Intl.DateTimeFormatOptions = {}) {
    const own = new IntlDateTimeFormat(lang, { hour: "numeric" }).resolvedOptions().hourCycle;
    const { hour12, ...rest } = options;
    super(
      lang,
      hour12 === false && (own === "h12" || own === "h24")
        ? { ...rest, hourCycle: "h24" }
        : options,
    );
  }
}

test("the clock runs from 00 to 23, five past midnight included, as V8 writes it too", () => {
  Intl.DateTimeFormat = V8DateTimeFormat as typeof Intl.DateTimeFormat;
  const fivePast = new Date(2026, 10, 5, 0, 5, 0).getTime();
  expect(formatClock(fivePast, "en")).toBe("00:05:00");
  expect(formatClock(fivePast, "zh-CN")).toBe("00:05:00");
  expect(formatClock(new Date(2026, 10, 5, 23, 59, 59).getTime(), "en")).toBe("23:59:59");
});

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
  expect(formatBytes(999, "en")).toBe("999 bytes");
  expect(formatBytes(1, "en")).toBe("1 byte");
  expect(formatBytes(94, "zh-CN")).toBe("94字节");
  expect(formatBytes(1_234_567_890, "en")).toBe("1.2 GB");
  expect(formatBytes(2_000_000_000_000_000, "en")).toBe("2,000 TB");
});

test("elapsed time runs to the end, or to now while there is none", () => {
  const start = "2026-11-05T10:00:00Z";
  expect(elapsedSeconds(start, "2026-11-05T10:01:30Z", 0)).toBe(90);
  expect(elapsedSeconds(start, null, Date.parse("2026-11-05T10:00:10Z"))).toBe(10);
  expect(elapsedSeconds("not a date", null, 0)).toBe(0);
});
