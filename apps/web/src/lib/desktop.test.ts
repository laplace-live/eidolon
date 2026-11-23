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

const CHAT = "0b7f5f2e-3c1d-4e8a-9f60-1a2b3c4d5e6f";
const TASK = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

test("a notification's click opens the Tasks page, or a task in its chat", () => {
  const navigate = vi.fn();
  runCommand("tasks", navigate);
  runCommand(`open-task:${CHAT}:${TASK}`, navigate);
  expect(navigate.mock.calls).toEqual([["/tasks"], [`/chats/${CHAT}?task=${TASK}`]]);
});

test("a task's command opens nothing unless both are the server's ids, whole", () => {
  const navigate = vi.fn();
  for (const command of [
    `open-task:${CHAT}`,
    `open-task:${CHAT}:${TASK}:x`,
    `open-task:${CHAT.toUpperCase()}:${TASK}`,
    `open-task:${CHAT}:../../settings`,
    `open-task:${CHAT}:${TASK}\n`,
    `open-task:${CHAT}:${TASK}?x=1`,
    `open-task::${TASK}`,
    ` open-task:${CHAT}:${TASK}`,
    `Open-Task:${CHAT}:${TASK}`,
    "open-task",
  ]) {
    runCommand(command, navigate);
  }
  expect(navigate).not.toHaveBeenCalled();
});

test("an app whose bridge predates the folder dialog and the system options is still a bridge", () => {
  const bridge: EidolonDesktop = fakeBridge();
  globalThis.eidolonDesktop = bridge;
  expect(desktop()?.chooseFolder).toBeUndefined();
  expect(desktop()?.loginItem).toBeUndefined();
  expect(desktop()?.setLoginItem).toBeUndefined();
  expect(desktop()?.terminalCommand).toBeUndefined();
  expect(desktop()?.setTerminalCommand).toBeUndefined();
});

test("a bridge with them hands their answers on", async () => {
  const installed = { state: "installed", path: "/usr/local/bin/eidolon" } as const;
  globalThis.eidolonDesktop = {
    ...fakeBridge(),
    chooseFolder: async () => "/Users/me/Projects",
    loginItem: async () => ({ state: "needs-approval" }),
    setLoginItem: async (on) => ({ state: on ? "on" : "off" }),
    terminalCommand: async () => installed,
    setTerminalCommand: async () => ({ command: installed, error: "cancelled" }),
  };
  const app = desktop();
  expect(await app?.chooseFolder?.()).toBe("/Users/me/Projects");
  expect(await app?.loginItem?.()).toEqual({ state: "needs-approval" });
  expect(await app?.setLoginItem?.(true)).toEqual({ state: "on" });
  expect(await app?.terminalCommand?.()).toEqual(installed);
  expect(await app?.setTerminalCommand?.("remove")).toEqual({
    command: installed,
    error: "cancelled",
  });
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
