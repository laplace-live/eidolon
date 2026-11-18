// The Usage page's line of what was used, with the macros stubbed.
import { expect, mock, test } from "bun:test";
import { linguiMacro } from "@/test/lingui-macro";

mock.module("@lingui/core/macro", linguiMacro);
mock.module("@lingui/react/macro", () => ({ useLingui: () => ({ t: linguiMacro().t }) }));
const { unitsText } = await import("./tables");
const { totalsOf } = await import("./summary");

test("a line's web searches read as a count beside its tokens, one or many", () => {
  const none = totalsOf([]);
  expect(unitsText("en", { ...none, inputTokens: 1600, outputTokens: 150, searches: 1 })).toBe(
    "1.6K tokens in · 150 out · 1 search",
  );
  expect(unitsText("en", { ...none, searches: 3 })).toBe("3 searches");
});
