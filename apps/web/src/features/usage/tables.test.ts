// The Usage page's line of what was used, with the macros stubbed.
import { expect, test, vi } from "vitest";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
const { unitsText } = await import("./tables");
const { totalsOf } = await import("./summary");

test("a line's web searches read as a count beside its tokens, one or many", () => {
  const none = totalsOf([]);
  expect(unitsText("en", { ...none, inputTokens: 1600, outputTokens: 150, searches: 1 })).toBe(
    "1.6K tokens in · 150 out · 1 search",
  );
  expect(unitsText("en", { ...none, searches: 3 })).toBe("3 searches");
});
