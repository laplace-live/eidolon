// fixtures/time.json holds CPython's C fromisoformat on curated stamps plus a sample of a
// 17k-case battery (systematic shapes and random mutations), all of which this port matched.
import { describe, expect, test } from "bun:test";
import {
  normalizeIsoTimestampToUtc,
  parseIsoDate,
  parseIsoDatetime,
  pyIsoformatUtc,
  utcIsoDate,
  wallClockMicros,
} from "../src/time.ts";
import fixtures from "./fixtures/time.json";

function datetimeOutcome(input: unknown): unknown[] {
  try {
    const d = parseIsoDatetime(input);
    return [true, String(d.micros), d.aware];
  } catch (error) {
    return [false, (error as Error).name, (error as Error).message];
  }
}

describe("datetime.fromisoformat", () => {
  test("curated stamps", () => {
    for (const [input, ok, ...rest] of fixtures.curated_datetime as [
      string,
      boolean,
      ...unknown[],
    ][]) {
      const got = datetimeOutcome(input);
      if (ok) expect([input, got]).toEqual([input, [true, rest[0], rest[1]]]);
      else expect([input, got]).toEqual([input, [false, rest[0], rest[1]]]);
    }
  });

  test("battery sample", () => {
    for (const [input, expected] of fixtures.battery_datetime as [string, unknown[]][]) {
      expect([input, datetimeOutcome(input)]).toEqual([input, expected]);
    }
  });

  test("orders a cloud -07:00 stamp after an earlier +00:00 one", () => {
    const cloud = parseIsoDatetime("2025-12-01T03:04:05-07:00");
    const local = parseIsoDatetime("2025-12-01T09:00:00+00:00");
    expect(cloud.micros > local.micros).toBe(true);
  });

  test("a non-string raises TypeError", () => {
    expect(datetimeOutcome(null)).toEqual([
      false,
      "TypeError",
      "fromisoformat: argument must be str",
    ]);
  });
});

describe("date.fromisoformat", () => {
  const outcome = (input: string): unknown[] => {
    try {
      const [y, m, d] = parseIsoDate(input);
      return [
        true,
        `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      ];
    } catch (error) {
      return [false, (error as Error).message];
    }
  };

  test("curated", () => {
    for (const [input, ok, value] of fixtures.date as [string, boolean, string][]) {
      expect([input, outcome(input)]).toEqual([input, [ok, value]]);
    }
  });

  test("battery sample", () => {
    for (const [input, expected] of fixtures.battery_date as [string, unknown[]][]) {
      const want = expected[0] ? expected : [false, expected[2]];
      expect([input, outcome(input)]).toEqual([input, want]);
    }
  });
});

describe("mem0 _normalize_iso_timestamp_to_utc", () => {
  test("curated", () => {
    for (const [input, expected] of fixtures.normalize as [unknown, unknown][]) {
      expect([input, normalizeIsoTimestampToUtc(input)]).toEqual([input, expected]);
    }
  });

  test("battery sample", () => {
    for (const [input, expected] of fixtures.battery_normalize as [unknown, unknown[]][]) {
      let got: unknown[];
      try {
        got = [true, normalizeIsoTimestampToUtc(input)];
      } catch (error) {
        got = [false, (error as Error).name, (error as Error).message];
      }
      expect([input, got]).toEqual([input, expected]);
    }
  });
});

describe("isoformat", () => {
  test("microseconds, with the fraction omitted when zero", () => {
    for (const [micros, iso, date] of fixtures.isoformat as [string, string, string][]) {
      if (!Number.isSafeInteger(Number(micros))) continue;
      expect(pyIsoformatUtc(Number(micros))).toBe(iso);
      expect(utcIsoDate(Number(micros))).toBe(date);
    }
  });

  test("the wall clock tracks Date.now() at microsecond resolution", () => {
    const before = Date.now() * 1000;
    const a = wallClockMicros();
    const b = wallClockMicros();
    const after = Date.now() * 1000 + 1000;
    expect(a).toBeGreaterThanOrEqual(before - 1000);
    expect(b).toBeGreaterThanOrEqual(a);
    expect(b).toBeLessThanOrEqual(after);
    expect(Number.isInteger(a)).toBe(true);
  });
});
