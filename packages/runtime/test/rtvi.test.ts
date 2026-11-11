import { describe, expect, test } from "bun:test";
import { BOT_ABOUT } from "../src/index.ts";

describe("BOT_ABOUT", () => {
  // The version itself is checked against apps/bot/package.json by apps/bot/test/version.test.ts.
  test("is the bot's identity, frozen", () => {
    expect(Object.keys(BOT_ABOUT)).toEqual(["library", "library_version"]);
    expect(BOT_ABOUT.library).toBe("laplace-eidolon");
    expect(BOT_ABOUT.library_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.isFrozen(BOT_ABOUT)).toBe(true);
  });
});
