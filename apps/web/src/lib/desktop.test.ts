import { i18n } from "@lingui/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type CompanionCallPick,
  companion,
  connectDesktop,
  desktop,
  type EidolonCompanion,
  type EidolonDesktop,
  holdUnsaved,
  offersPopOut,
  onCompanionPort,
  runCommand,
  subscribeCompanionPick,
  subscribeWindowShows,
  windowShows,
} from "./desktop";
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
  globalThis.eidolonCompanion = undefined;
  vi.unstubAllGlobals();
});

test("a browser has no bridge, and connecting there touches nothing", () => {
  expect(desktop()).toBeNull();
  expect(companion()).toBeNull();
  expect(offersPopOut(desktop())).toBe(false);
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

test("the desktop companion's Call, while nothing here can place it, opens /call", () => {
  const navigate = vi.fn();
  runCommand("call", navigate);
  expect(navigate.mock.calls).toEqual([["/call"]]);
});

const CHAT = "0b7f5f2e-3c1d-4e8a-9f60-1a2b3c4d5e6f";
const TASK = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

test("a notification's click opens a chat, the Tasks page, or a task in its chat", () => {
  const navigate = vi.fn();
  runCommand("tasks", navigate);
  runCommand(`open-chat:${CHAT}`, navigate);
  runCommand(`open-task:${CHAT}:${TASK}`, navigate);
  expect(navigate.mock.calls).toEqual([
    ["/tasks"],
    [`/chats/${CHAT}`],
    [`/chats/${CHAT}?task=${TASK}`],
  ]);
});

test("a chat or task command opens nothing unless the ids are the server's ids, whole", () => {
  const navigate = vi.fn();
  for (const command of [
    `open-chat:${CHAT.toUpperCase()}`,
    `open-chat:${CHAT}:x`,
    `open-chat:../../settings`,
    `open-chat:${CHAT}\n`,
    "open-chat:",
    "open-chat",
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
  expect(desktop()).toBe(bridge);
  expect(desktop()?.chooseFolder).toBeUndefined();
  expect(desktop()?.loginItem).toBeUndefined();
  expect(desktop()?.setLoginItem).toBeUndefined();
  expect(desktop()?.terminalCommand).toBeUndefined();
  expect(desktop()?.setTerminalCommand).toBeUndefined();
  expect(desktop()?.unsaved).toBeUndefined();
});

/** A bridge that records what the page says of its unsaved edits. */
function editsBridge(): EidolonDesktop & { readonly said: boolean[] } {
  const said: boolean[] = [];
  return { ...fakeBridge(), said, unsaved: (held) => said.push(held) };
}

describe("holdUnsaved", () => {
  test("tells the app true as the first hold starts and false as the last ends, in any order", () => {
    const bridge = editsBridge();
    globalThis.eidolonDesktop = bridge;
    const prompt = holdUnsaved();
    const glossary = holdUnsaved();
    expect(bridge.said).toEqual([true]);
    prompt();
    const facts = holdUnsaved();
    glossary();
    expect(bridge.said).toEqual([true]);
    facts();
    expect(bridge.said).toEqual([true, false]);
    holdUnsaved()();
    expect(bridge.said).toEqual([true, false, true, false]);
  });

  test("StrictMode's run, cleanup and second run of an effect leave one hold", () => {
    const bridge = editsBridge();
    globalThis.eidolonDesktop = bridge;
    holdUnsaved()();
    const second = holdUnsaved();
    expect(bridge.said).toEqual([true, false, true]);
    second();
    expect(bridge.said).toEqual([true, false, true, false]);
  });

  test("a browser and an app whose bridge predates it hear nothing, and the count holds there too", () => {
    const inBrowser = holdUnsaved();
    globalThis.eidolonDesktop = fakeBridge();
    const inOlderApp = holdUnsaved();
    inBrowser();
    inOlderApp();
    const bridge = editsBridge();
    globalThis.eidolonDesktop = bridge;
    holdUnsaved()();
    expect(bridge.said).toEqual([true, false]);
  });
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

test("an app whose bridge predates the desktop companion offers none of her members, nor Pop Out", () => {
  globalThis.eidolonDesktop = fakeBridge();
  const app = desktop();
  expect(app?.companion).toBeUndefined();
  expect(app?.setCompanion).toBeUndefined();
  expect(app?.popOut).toBeUndefined();
  expect(app?.linkCompanion).toBeUndefined();
  expect(app?.feedingCompanion).toBeUndefined();
  expect(app?.onCompanionPick).toBeUndefined();
  expect(app?.onWindowShows).toBeUndefined();
  expect(offersPopOut(app)).toBe(false);
  // Connecting such an app hands no pick on, and throws for none it lacks.
  const heard = vi.fn();
  const stop = subscribeCompanionPick(heard);
  connectDesktop(vi.fn());
  stop();
  expect(heard).not.toHaveBeenCalled();
  expect(windowShows()).toBe(true);
});

test("the window shows until the app's bridge says otherwise, and each change reaches its listeners", () => {
  let tell: ((shows: boolean) => void) | undefined;
  globalThis.eidolonDesktop = {
    ...fakeBridge(),
    onWindowShows: (callback) => {
      tell = callback;
      callback(false);
    },
  };
  const heard = vi.fn();
  const stop = subscribeWindowShows(heard);
  expect(windowShows()).toBe(true);
  connectDesktop(vi.fn());
  expect(windowShows()).toBe(false);
  tell?.(false);
  tell?.(true);
  expect(windowShows()).toBe(true);
  stop();
  tell?.(false);
  tell?.(true);
  // Told false, then true again: two changes heard while subscribed, none repeated.
  expect(heard).toHaveBeenCalledTimes(2);
});

test("a bridge with the companion's members offers Pop Out and hands their answers on", async () => {
  const state = { on: true, showAtLogin: true, background: false } as const;
  globalThis.eidolonDesktop = {
    ...fakeBridge(),
    companion: async () => state,
    setCompanion: async (change) => ({ ...state, ...change }),
    popOut: async () => state,
    linkCompanion: () => {},
    feedingCompanion: () => {},
    onCompanionPick: () => {},
  };
  const app = desktop();
  expect(offersPopOut(app)).toBe(true);
  expect(await app?.companion?.()).toEqual(state);
  expect(await app?.setCompanion?.({ showAtLogin: false })).toEqual({
    ...state,
    showAtLogin: false,
  });
});

test("the desktop companion's page has her own bridge and never the app's", () => {
  const bridge = { platform: "darwin" } as EidolonCompanion;
  globalThis.eidolonCompanion = bridge;
  expect(companion()).toBe(bridge);
  expect(desktop()).toBeNull();
});

test("her menu's call picks reach each listener subscribed then, and one with none is dropped", () => {
  let send: ((pick: CompanionCallPick) => void) | undefined;
  globalThis.eidolonDesktop = {
    ...fakeBridge(),
    onCompanionPick: (callback) => {
      send = callback;
    },
  };
  connectDesktop(vi.fn());
  expect(send).toBeDefined();

  // Nobody listens yet: the pick goes nowhere, and no later listener ever hears it.
  send?.("call");
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = subscribeCompanionPick(first);
  const stopSecond = subscribeCompanionPick(second);
  send?.("mute");
  stopFirst();
  send?.("hang-up");
  stopSecond();
  send?.("unmute");
  expect(first.mock.calls).toEqual([["mute"]]);
  expect(second.mock.calls).toEqual([["mute"], ["hang-up"]]);
});

test("a port is taken only from this window's own tagged message with exactly one port", () => {
  const listeners = new Set<(event: unknown) => void>();
  vi.stubGlobal("addEventListener", (type: string, listener: (event: unknown) => void) => {
    if (type === "message") listeners.add(listener);
  });
  vi.stubGlobal("removeEventListener", (type: string, listener: (event: unknown) => void) => {
    if (type === "message") listeners.delete(listener);
  });
  const post = (event: unknown) => {
    for (const listener of listeners) listener(event);
  };
  const port = { name: "port" } as unknown as MessagePort;
  const other = { name: "other" } as unknown as MessagePort;
  const tag = { eidolon: "companion-port" };
  const got = vi.fn();
  const stop = onCompanionPort(got);
  expect(listeners.size).toBe(1);

  post({ source: {}, data: tag, ports: [port] });
  post({ source: null, data: tag, ports: [port] });
  post({ source: globalThis, data: {}, ports: [port] });
  post({ source: globalThis, data: "companion-port", ports: [port] });
  post({ source: globalThis, data: null, ports: [port] });
  post({ source: globalThis, data: { eidolon: "companion-ports" }, ports: [port] });
  post({ source: globalThis, data: tag, ports: [] });
  post({ source: globalThis, data: tag, ports: [port, other] });
  expect(got).not.toHaveBeenCalled();

  post({ source: globalThis, data: tag, ports: [port] });
  expect(got.mock.calls).toEqual([[port]]);

  stop();
  expect(listeners.size).toBe(0);
  post({ source: globalThis, data: tag, ports: [other] });
  expect(got).toHaveBeenCalledTimes(1);
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
