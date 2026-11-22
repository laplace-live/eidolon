import { i18n } from "@lingui/core";
import { afterEach, expect, test, vi } from "vitest";
import { connectDesktop, desktop, type EidolonDesktop, runCommand } from "./desktop";
import { setTheme } from "./theme";

interface FakeBridge extends EidolonDesktop {
  readonly themes: string[];
  readonly languages: string[];
  readonly menu: { send?: (command: string) => void };
}

function fakeBridge(): FakeBridge {
  const themes: string[] = [];
  const languages: string[] = [];
  const menu: FakeBridge["menu"] = {};
  return {
    platform: "darwin",
    version: "0.1.0",
    serverVersion: "0.13.0",
    themes,
    languages,
    menu,
    setTheme: (setting) => themes.push(setting),
    setLanguage: (language) => languages.push(language),
    onCommand: (callback) => {
      menu.send = callback;
    },
  };
}

afterEach(() => {
  globalThis.eidolonDesktop = undefined;
  vi.unstubAllGlobals();
});

test("a browser has no bridge, and connecting there touches nothing", () => {
  expect(desktop()).toBeNull();
  const navigate = vi.fn();
  connectDesktop(navigate);
  expect(navigate).not.toHaveBeenCalled();
});

test("the menu's Settings command opens Settings, and nothing else runs", () => {
  const navigate = vi.fn();
  runCommand("settings", navigate);
  runCommand("toString", navigate);
  runCommand("quit", navigate);
  expect(navigate.mock.calls).toEqual([["/settings"]]);
});

test("the theme setting and the language reach the app at once and on each change", async () => {
  // What theme.ts's apply() touches, outside a browser.
  vi.stubGlobal("document", { documentElement: { classList: { toggle() {} }, style: {} } });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const bridge = fakeBridge();
  globalThis.eidolonDesktop = bridge;
  const navigate = vi.fn();
  connectDesktop(navigate);
  expect(bridge.themes).toEqual(["system"]);
  expect(bridge.languages).toEqual([]);

  setTheme("dark");
  setTheme("system");
  // As the OS's own change of theme applies it: the setting is still System, so nothing new.
  setTheme("system");
  expect(bridge.themes).toEqual(["system", "dark", "system"]);

  i18n.load("zh-Hans", {});
  i18n.activate("zh-Hans");
  i18n.load("en", {});
  expect(bridge.languages).toEqual(["zh-Hans"]);
  i18n.activate("en");
  expect(bridge.languages).toEqual(["zh-Hans", "en"]);

  bridge.menu.send?.("settings");
  expect(navigate.mock.calls).toEqual([["/settings"]]);
});
