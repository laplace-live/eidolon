import { expect, test } from "bun:test";
import { httpsOnly, nextPage, totalLabel } from "./voices";

test("only https URLs load", () => {
  expect(httpsOnly("https://platform.r2.fish.audio/task/x.mp3")).toBe(
    "https://platform.r2.fish.audio/task/x.mp3",
  );
  for (const url of [
    "http://platform.r2.fish.audio/task/x.mp3",
    "javascript:alert(1)",
    "data:audio/mpeg;base64,AAAA",
    "//evil.example/x.mp3",
    "coverimage/abc",
    "",
    null,
    undefined,
  ]) {
    expect(httpsOnly(url)).toBeNull();
  }
});

test("paging stops when Fish says there is no more", () => {
  expect(nextPage({ hasMore: true }, 1)).toBe(2);
  expect(nextPage({ hasMore: false }, 3)).toBeUndefined();
});

test("a capped total shows with a plus", () => {
  expect(totalLabel({ total: 42, totalIsExact: true })).toBe("42");
  expect(totalLabel({ total: 1000, totalIsExact: false })).toBe("1000+");
});
