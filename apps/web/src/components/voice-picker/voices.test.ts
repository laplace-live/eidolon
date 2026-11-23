import { expect, test, vi } from "vitest";
import type { Voice } from "@/lib/api";
import { linguiMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
const { httpsOnly, nextPage, openingSource, voiceCount } = await import("./voices");

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

test("the picker opens on her own voices once there are any, else on the library", () => {
  const own = (status: "ok" | "no-key" | "refused", ids: readonly string[]) => ({
    status,
    items: ids.map((id) => ({ id }) as Voice),
  });
  expect(openingSource(undefined, false)).toBeNull();
  expect(openingSource(own("ok", ["a"]), false)).toBe("mine");
  expect(openingSource(own("ok", []), false)).toBe("library");
  expect(openingSource(own("no-key", []), false)).toBe("library");
  expect(openingSource(own("refused", []), false)).toBe("library");
  // Listing them failed: the library, unless a list from before still stands.
  expect(openingSource(undefined, true)).toBe("library");
  expect(openingSource(own("ok", ["a"]), true)).toBe("mine");
});
