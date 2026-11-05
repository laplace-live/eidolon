// Expected values are Python datetime.date's.
import { describe, expect, test } from "bun:test";
import {
  addDays,
  DateRangeError,
  diffDays,
  firstOfMonth,
  firstOfNextMonth,
  fromIsoformat,
  isoDate,
  isValidIsoDate,
  parseIsoDate,
  todayIn,
  weekday,
} from "../src/index.ts";

describe("civil dates", () => {
  test("construction validates like date()", () => {
    expect(isoDate(26, 3, 24)).toBe("0026-03-24");
    expect(isoDate(2024, 2, 29)).toBe("2024-02-29");
    expect(() => isoDate(2026, 2, 29)).toThrow("day is out of range for month");
    expect(() => isoDate(2026, 13, 1)).toThrow("month must be in 1..12");
    expect(() => isoDate(0, 1, 1)).toThrow("year 0 is out of range");
    expect(() => isoDate(10000, 1, 1)).toThrow(DateRangeError);
  });

  test("arithmetic across months, leap days and the calendar's ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2100-02-28", 1)).toBe("2100-03-01");
    expect(addDays("2000-02-28", 1)).toBe("2000-02-29");
    expect(addDays("2026-09-09", -739867)).toBe("0001-01-01");
    expect(() => addDays("0001-01-01", -1)).toThrow("date value out of range");
    expect(() => addDays("9999-12-31", 1)).toThrow(DateRangeError);
    expect(diffDays("2026-09-01", "2026-09-09")).toBe(8);
    expect(diffDays("2026-09-09", "2026-09-01")).toBe(-8);
    expect(diffDays("0001-01-01", "9999-12-31")).toBe(3652058);
  });

  test("weekday is Monday-based", () => {
    expect(weekday("2026-09-07")).toBe(0);
    expect(weekday("2026-09-09")).toBe(2);
    expect(weekday("2026-09-13")).toBe(6);
    expect(weekday("0001-01-01")).toBe(0);
  });

  test("month boundaries", () => {
    expect(firstOfMonth("2024-02-29")).toBe("2024-02-01");
    expect(firstOfNextMonth("2024-02-29")).toBe("2024-03-01");
    expect(firstOfNextMonth("2026-12-15")).toBe("2027-01-01");
    expect(() => firstOfNextMonth("9999-12-01")).toThrow("date value out of range");
  });

  test("strict YYYY-MM-DD parsing", () => {
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("2026-02-29")).toBe(false);
    expect(isValidIsoDate("2026-9-8")).toBe(false);
    expect(isValidIsoDate("0000-01-01")).toBe(false);
    expect(isValidIsoDate("２０２６-０９-０８")).toBe(false);
    expect(parseIsoDate("2026-09-08")).toBe("2026-09-08");
    expect(() => parseIsoDate("20260908")).toThrow(DateRangeError);
  });

  test("date.fromisoformat reads the C parser's grammar", () => {
    expect(fromIsoformat("2026-09-09")).toBe("2026-09-09");
    expect(fromIsoformat("20260909")).toBe("2026-09-09");
    expect(fromIsoformat("2026-W37-3")).toBe("2026-09-09");
    expect(fromIsoformat("2026W37")).toBe("2026-09-07");
    expect(fromIsoformat("20260909xx")).toBe("2026-09-09");
    expect(fromIsoformat("2020-W53-7")).toBe("2021-01-03");
    expect(fromIsoformat("0001-W01-1")).toBe("0001-01-01");
    expect(() => fromIsoformat("2026-9-9")).toThrow("Invalid isoformat string: '2026-9-9'");
    for (const bad of ["2026-13-01", "2026-W53-1x", "2021-W53-1", "9999-W52-6", "0000-01-01"]) {
      expect(() => fromIsoformat(bad)).toThrow(DateRangeError);
    }
  });

  test("todayIn reads the zone's wall clock", () => {
    const now = new Date("2026-09-08T16:30:00Z");
    expect(todayIn("Asia/Shanghai", now)).toBe("2026-09-09");
    expect(todayIn("UTC", now)).toBe("2026-09-08");
  });
});
