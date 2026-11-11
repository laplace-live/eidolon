import { expect, test } from "bun:test";
import { chatName, relativeTime, shortDate } from "./format";

const NOW = new Date(2026, 10, 9, 12, 0).getTime();
const MINUTE = 60_000;

test("a time is relative within the week, and a date after", () => {
  expect(relativeTime(NOW - 10_000, NOW, "en")).toBe("now");
  expect(relativeTime(NOW + 5000, NOW, "en")).toBe("now");
  expect(relativeTime(NOW - 5 * MINUTE, NOW, "en")).toBe("5 min. ago");
  expect(relativeTime(NOW - 3 * 60 * MINUTE, NOW, "en")).toBe("3 hr. ago");
  expect(relativeTime(NOW - 24 * 60 * MINUTE, NOW, "en")).toBe("yesterday");
  expect(relativeTime(NOW - 8 * 24 * 60 * MINUTE, NOW, "en")).toBe("Nov 1");
  expect(relativeTime(NOW - 5 * MINUTE, NOW, "zh-Hans")).toBe("5分钟前");
});

test("a date names its year only when it isn't this one", () => {
  expect(shortDate(new Date(2026, 0, 2).getTime(), "en", NOW)).toBe("Jan 2");
  expect(shortDate(new Date(2025, 0, 2).getTime(), "en", NOW)).toBe("Jan 2, 2025");
});

test("an untitled chat is named for her and the day it started", () => {
  expect(chatName("照片", "Mio", NOW, "en", NOW)).toBe("照片");
  expect(chatName(null, "Mio", NOW, "en", NOW)).toBe("Mio · Nov 9");
});
