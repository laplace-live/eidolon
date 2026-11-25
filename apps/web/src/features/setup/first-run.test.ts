import { expect, test } from "vitest";
import { firstRunRedirect, requiredKeyMissing } from "./first-run";

const key = (account: string, roles: string[], set: boolean) => ({
  account,
  name: account,
  provider: account,
  roles,
  set,
});
const keys = (openrouter: boolean, soniox: boolean, fish: boolean) => ({
  keys: [
    key("soniox", ["hearing"], soniox),
    key("openrouter", ["mind"], openrouter),
    key("fish", ["voice"], fish),
  ],
  activeCalls: 0,
});
const ready = keys(true, true, true);
const missing = keys(false, true, true);

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

test("the keys of hearing and voice alone, which only calls need, send no page anywhere", () => {
  for (const path of ["/", "/call", "/chats/c1"]) {
    expect(firstRunRedirect(keys(true, false, false), path)).toBeNull();
  }
});

test("an account the mind or a realtime model uses is waited for, whatever else it serves", () => {
  const waited = (roles: string[]) => requiredKeyMissing({ keys: [key("a", roles, false)] });
  expect(waited(["hearing"])).toBe(false);
  expect(waited(["hearing", "voice"])).toBe(false);
  expect(waited(["hearing", "mind", "voice"])).toBe(true);
  expect(waited(["realtime"])).toBe(true);
});

test("a key gone during a call leaves every page in place, since opening the wizard ends the call", () => {
  const calling = { ...missing, activeCalls: 1 };
  for (const path of ["/", "/call", "/chats/c1", "/personas/a/appearance", "/tasks"]) {
    expect(firstRunRedirect(calling, path)).toBeNull();
  }
});
