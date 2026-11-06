import { expect, test } from "bun:test";
import { firstRunRedirect } from "./first-run";

const ready = { keys: { SONIOX_API_KEY: true, OPENROUTER_API_KEY: true, FISH_API_KEY: true } };
const missing = { keys: { ...ready.keys, FISH_API_KEY: false } };

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
