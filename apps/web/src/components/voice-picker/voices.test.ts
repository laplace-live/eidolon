import { expect, mock, test } from "bun:test";
import { linguiMacro } from "@/test/lingui-macro";

mock.module("@lingui/core/macro", linguiMacro);
const { httpsOnly, nextPage, voiceCount } = await import("./voices");

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

test("a capped total counts as a number, with a plus", () => {
  expect(voiceCount({ total: 1, totalIsExact: true })).toBe("1 voice");
  expect(voiceCount({ total: 42, totalIsExact: true })).toBe("42 voices");
  expect(voiceCount({ total: 1000, totalIsExact: false })).toBe("1,000+ voices");
});
