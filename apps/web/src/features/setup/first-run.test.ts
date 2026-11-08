import { expect, test } from "bun:test";
import { firstRunRedirect } from "./first-run";

const key = (account: string, set: boolean) => ({
  account,
  name: account,
  provider: account,
  roles: [],
  set,
});
const ready = { keys: [key("soniox", true), key("fish", true)] };
const missing = { keys: [key("soniox", true), key("fish", false)] };

test("with every key saved, no page redirects", () => {
  for (const path of ["/", "/call", "/setup", "/settings", "/jobs/x", "/personas/a/voice"]) {
    expect(firstRunRedirect(ready, path)).toBeNull();
  }
});

test("a missing key sends every page but the wizard and settings to the wizard", () => {
  for (const path of ["/", "/call", "/jobs", "/personas/a/voice", "/settingsx"]) {
    expect(firstRunRedirect(missing, path)).toBe("/setup");
  }
  for (const path of ["/setup", "/setup/", "/settings", "/settings/"]) {
    expect(firstRunRedirect(missing, path)).toBeNull();
  }
});
