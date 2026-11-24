import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { scan } from "../../bot/test/local/scan.ts";
import { bridgeFor, desktopBridge, type PreloadIpc, shellBridge } from "../src/preload/bridges.ts";
import {
  accepts,
  BRIDGE,
  commandChangeOf,
  commandStateOf,
  folderOf,
  ID_PATTERN,
  type IpcSender,
  isCommandAction,
  isLanguage,
  isThemeSetting,
  loginItemStateOf,
  openTaskCommand,
  type PageChannel,
  pageAt,
  versionsOf,
} from "../src/shared/bridge.ts";

const SRC = resolve(import.meta.dirname, "../src");

const CHAT = "0b7f5f2e-3c1d-4e8a-9f60-1a2b3c4d5e6f";
const TASK = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const UNPACKAGED = { state: "unavailable", reason: "unpackaged" };

/**
 * An ipcRenderer that records what is sent and invoked, answers each invoke with the next of
 * `answers`, and lets the test send to the page.
 */
function fakeIpc(answers: unknown[] = []) {
  const sent: unknown[][] = [];
  const invoked: unknown[][] = [];
  const listeners = new Map<string, ((event: unknown, ...args: unknown[]) => void)[]>();
  const ipc: PreloadIpc = {
    send: (channel, ...args) => sent.push([channel, ...args]),
    on: (channel, listener) =>
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]),
    invoke: async (channel, ...args) => {
      invoked.push([channel, ...args]);
      return answers.shift();
    },
  };
  const deliver = (channel: string, ...args: unknown[]) => {
    for (const listener of listeners.get(channel) ?? [])
      listener({ sender: "ipcRenderer" }, ...args);
  };
  return { ipc, sent, invoked, deliver };
}

describe("pageAt", () => {
  test("names the app's page and the shell's by scheme and host, whatever the path", () => {
    expect(pageAt("eidolon-app://app/")).toBe("app");
    expect(pageAt("eidolon-app://app/chats/c1?tab=files#end")).toBe("app");
    expect(pageAt("eidolon-app://shell/loading")).toBe("shell");
    expect(pageAt("eidolon-app://shell/failed")).toBe("shell");
  });

  test("anything else is neither", () => {
    for (const url of [
      "eidolon-app://other/",
      "eidolon-app://app:8080/",
      "eidolon-app://appx/",
      "https://app/",
      "http://127.0.0.1:7860/",
      "file:///app/index.html",
      "data:text/html,<p>app</p>",
      "about:blank",
      "null",
      "",
    ]) {
      expect([url, pageAt(url)]).toEqual([url, null]);
    }
  });
});

describe("accepts", () => {
  const APP_CHANNELS: PageChannel[] = [
    BRIDGE.theme,
    BRIDGE.language,
    BRIDGE.versions,
    BRIDGE.takesCommands,
    BRIDGE.chooseFolder,
    BRIDGE.loginItem,
    BRIDGE.setLoginItem,
    BRIDGE.terminalCommand,
    BRIDGE.setTerminalCommand,
    BRIDGE.unsaved,
  ];
  const app: IpcSender = { window: true, mainFrame: true, origin: "eidolon-app://app" };
  const shell: IpcSender = { window: true, mainFrame: true, origin: "eidolon-app://shell" };

  test("the app's page alone sets the theme and the language, asks for the versions, takes commands, picks a folder, reads or changes the system options and tells of its unsaved edits", () => {
    for (const channel of APP_CHANNELS) {
      expect(accepts(channel, app)).toBe(true);
      expect(accepts(channel, shell)).toBe(false);
    }
  });

  test("a shell page alone retries, shows the logs and quits", () => {
    for (const channel of [BRIDGE.retry, BRIDGE.showLogs, BRIDGE.quit]) {
      expect(accepts(channel, shell)).toBe(true);
      expect(accepts(channel, app)).toBe(false);
    }
  });

  test("never from a subframe, another webContents, a frame that's gone or another address", () => {
    const channels: PageChannel[] = [...APP_CHANNELS, BRIDGE.retry, BRIDGE.showLogs, BRIDGE.quit];
    for (const channel of channels) {
      const own = APP_CHANNELS.includes(channel) ? app : shell;
      expect(accepts(channel, own)).toBe(true);
      expect(accepts(channel, { ...own, mainFrame: false })).toBe(false);
      expect(accepts(channel, { ...own, window: false })).toBe(false);
      expect(accepts(channel, { ...own, origin: null })).toBe(false);
      expect(accepts(channel, { ...own, origin: "eidolon-app://other" })).toBe(false);
      expect(accepts(channel, { ...own, origin: "data:text/html," })).toBe(false);
    }
  });

  test("never from a document at the app's address with an opaque origin, as a sandboxed one has", () => {
    for (const channel of APP_CHANNELS) {
      expect(accepts(channel, { ...app, origin: "null" })).toBe(false);
    }
  });
});

test("the theme setting and the language take exactly apps/web's values", () => {
  for (const setting of ["light", "dark", "system"]) expect(isThemeSetting(setting)).toBe(true);
  for (const setting of ["Dark", "auto", "", null, undefined, 1, { toString: () => "dark" }]) {
    expect(isThemeSetting(setting)).toBe(false);
  }
  for (const language of ["en", "zh-Hans"]) expect(isLanguage(language)).toBe(true);
  for (const language of ["zh", "zh-CN", "en-US", "", null, ["en"]]) {
    expect(isLanguage(language)).toBe(false);
  }
});

test("the channels are distinct and Eidolon's own", () => {
  const channels = Object.values(BRIDGE);
  expect(new Set(channels).size).toBe(channels.length);
  for (const channel of channels) expect(channel).toMatch(/^eidolon:[a-z-]+$/);
});

test("the versions are main's answer, and empty strings where it answered something else", () => {
  const versions = { version: "0.1.0", serverVersion: "0.13.0" };
  expect(versionsOf(versions)).toEqual(versions);
  expect(versionsOf({ version: "0.1.0", extra: true })).toEqual({
    version: "0.1.0",
    serverVersion: "",
  });
  for (const answer of [null, undefined, "0.1.0", 1, { version: 1, serverVersion: ["0.13.0"] }]) {
    expect(versionsOf(answer)).toEqual({ version: "", serverVersion: "" });
  }
});

describe("openTaskCommand", () => {
  test("names a chat's task by both ids", () => {
    expect(openTaskCommand(CHAT, TASK)).toBe(`open-task:${CHAT}:${TASK}`);
  });

  test("takes only the server's ids: lowercase UUIDs, whole", () => {
    expect(ID_PATTERN.test(CHAT)).toBe(true);
    for (const id of [
      CHAT.toUpperCase(),
      `${CHAT}:x`,
      `${CHAT}\n`,
      CHAT.replaceAll("-", ""),
      `/${CHAT}`,
      "",
      "settings",
    ]) {
      expect([id, ID_PATTERN.test(id)]).toEqual([id, false]);
      expect(() => openTaskCommand(id, TASK)).toThrow();
      expect(() => openTaskCommand(CHAT, id)).toThrow();
    }
  });
});

describe("main's answers, as the preload hands them on", () => {
  test("a folder is a string, and anything else none", () => {
    expect(folderOf("/Users/me/Projects")).toBe("/Users/me/Projects");
    for (const answer of [null, undefined, 1, ["/Users/me"], { path: "/Users/me" }]) {
      expect(folderOf(answer)).toBeNull();
    }
  });

  test("Open at Login's state keeps its own fields, and anything else reads as an unpackaged copy's", () => {
    for (const state of ["on", "off", "needs-approval"]) {
      expect(loginItemStateOf({ state, extra: "x" })).toEqual({ state });
    }
    for (const reason of ["background", "unpackaged", "outside-applications", "not-installed"]) {
      expect(loginItemStateOf({ state: "unavailable", reason })).toEqual({
        state: "unavailable",
        reason,
      });
    }
    for (const answer of [
      null,
      undefined,
      "on",
      { state: "ON" },
      { state: "unavailable" },
      { state: "unavailable", reason: "elsewhere" },
      { state: "installed", path: "/usr/local/bin/eidolon" },
    ]) {
      expect(loginItemStateOf(answer)).toEqual(UNPACKAGED);
    }
  });

  test("the terminal command's state keeps its own fields, and anything else reads as an unpackaged copy's", () => {
    for (const state of ["absent", "installed", "taken"]) {
      expect(commandStateOf({ state, path: "/usr/local/bin/eidolon", reason: "x" })).toEqual({
        state,
        path: "/usr/local/bin/eidolon",
      });
    }
    expect(commandStateOf({ state: "unavailable", reason: "not-installed", path: "C:\\" })).toEqual(
      { state: "unavailable", reason: "not-installed" },
    );
    for (const answer of [
      null,
      "installed",
      { state: "installed" },
      { state: "installed", path: 1 },
      { state: "on" },
      { state: "unavailable", reason: "background " },
    ]) {
      expect(commandStateOf(answer)).toEqual(UNPACKAGED);
    }
  });

  test("a change keeps its state and its error, and one of another shape failed", () => {
    const installed = { state: "installed", path: "/usr/local/bin/eidolon" };
    expect(commandChangeOf({ command: installed })).toEqual({ command: installed });
    expect(commandChangeOf({ command: installed, error: undefined })).toEqual({
      command: installed,
    });
    for (const error of ["cancelled", "failed"]) {
      expect(commandChangeOf({ command: installed, error })).toEqual({ command: installed, error });
    }
    for (const answer of [
      null,
      installed,
      { command: installed, error: "denied" },
      { command: installed, error: null },
      { command: { state: "installed" } },
      { error: "cancelled" },
    ]) {
      expect(commandChangeOf(answer)).toEqual({ command: UNPACKAGED, error: "failed" });
    }
  });

  test("a terminal command action is install or remove alone", () => {
    expect(isCommandAction("install")).toBe(true);
    expect(isCommandAction("remove")).toBe(true);
    for (const value of ["Install", "uninstall", "", null, undefined, ["install"]]) {
      expect(isCommandAction(value)).toBe(false);
    }
  });
});

describe("the preload's bridges", () => {
  test("go to a main frame alone, the app's bridge on the app's page and the shell's on a shell page", () => {
    expect(bridgeFor("eidolon-app://app/", true)).toBe("app");
    expect(bridgeFor("eidolon-app://shell/loading", true)).toBe("shell");
    expect(bridgeFor("eidolon-app://app/", false)).toBeNull();
    expect(bridgeFor("eidolon-app://shell/failed", false)).toBeNull();
    expect(bridgeFor("https://example.com/", true)).toBeNull();
  });

  test("the app's bridge carries the platform and versions and sends only values main takes", () => {
    const { ipc, sent } = fakeIpc();
    const bridge = desktopBridge(ipc, "darwin", { version: "0.1.0", serverVersion: "0.13.0" });
    expect(bridge).toMatchObject({ platform: "darwin", version: "0.1.0", serverVersion: "0.13.0" });
    bridge.setTheme("dark");
    bridge.setTheme("system");
    bridge.setLanguage("zh-Hans");
    // What a page could pass despite the types.
    bridge.setTheme("sepia" as never);
    bridge.setLanguage({ toString: () => "en" } as never);
    expect(sent).toEqual([
      [BRIDGE.theme, "dark"],
      [BRIDGE.theme, "system"],
      [BRIDGE.language, "zh-Hans"],
    ]);
  });

  test("the app's bridge tells main of the page's unsaved edits in booleans alone", () => {
    const { ipc, sent } = fakeIpc();
    const bridge = desktopBridge(ipc, "darwin", { version: "", serverVersion: "" });
    bridge.unsaved(true);
    bridge.unsaved(false);
    // What a page could pass despite the types.
    for (const held of ["true", 1, null, undefined, { valueOf: () => true }]) {
      bridge.unsaved(held as never);
    }
    expect(sent).toEqual([
      [BRIDGE.unsaved, true],
      [BRIDGE.unsaved, false],
    ]);
  });

  test("a command reaches the page's callback as its name alone, never with the IPC event", () => {
    const { ipc, sent, deliver } = fakeIpc();
    const received: unknown[][] = [];
    desktopBridge(ipc, "win32", { version: "", serverVersion: "" }).onCommand((...args) =>
      received.push(args),
    );
    // Once it listens, main may send the command it held while the page loaded.
    expect(sent).toEqual([[BRIDGE.takesCommands]]);
    deliver(BRIDGE.command, "settings");
    deliver(BRIDGE.command, { name: "settings" });
    deliver(BRIDGE.command);
    deliver(BRIDGE.command, `open-task:${CHAT}:${TASK}`);
    expect(received).toEqual([["settings"], [`open-task:${CHAT}:${TASK}`]]);
  });

  test("the folder dialog and the system options invoke main with only values it takes", async () => {
    const { ipc, invoked } = fakeIpc();
    const bridge = desktopBridge(ipc, "darwin", { version: "", serverVersion: "" });
    await bridge.chooseFolder();
    await bridge.loginItem();
    await bridge.setLoginItem(true);
    await bridge.setLoginItem(false);
    // What a page could pass despite the types.
    await bridge.setLoginItem("yes" as never);
    await bridge.terminalCommand();
    await bridge.setTerminalCommand("install");
    await bridge.setTerminalCommand("remove");
    await expect(bridge.setTerminalCommand("rm -rf /" as never)).rejects.toThrow();
    await expect(
      bridge.setTerminalCommand({ toString: () => "install" } as never),
    ).rejects.toThrow();
    expect(invoked).toEqual([
      [BRIDGE.chooseFolder],
      [BRIDGE.loginItem],
      [BRIDGE.setLoginItem, true],
      [BRIDGE.setLoginItem, false],
      [BRIDGE.setLoginItem, false],
      [BRIDGE.terminalCommand],
      [BRIDGE.setTerminalCommand, "install"],
      [BRIDGE.setTerminalCommand, "remove"],
    ]);
  });

  test("main's answers reach the page in their declared shapes alone", async () => {
    const installed = { state: "installed", path: "/usr/local/bin/eidolon" };
    const { ipc } = fakeIpc([
      "/Users/me/Projects",
      { state: "needs-approval", extra: true },
      { state: "maybe" },
      { ...installed, extra: true },
      { command: installed, error: "cancelled" },
      { command: installed, error: "denied" },
      42,
    ]);
    const bridge = desktopBridge(ipc, "darwin", { version: "", serverVersion: "" });
    expect(await bridge.chooseFolder()).toBe("/Users/me/Projects");
    expect(await bridge.loginItem()).toEqual({ state: "needs-approval" });
    expect(await bridge.setLoginItem(true)).toEqual(UNPACKAGED);
    expect(await bridge.terminalCommand()).toEqual(installed);
    expect(await bridge.setTerminalCommand("install")).toEqual({
      command: installed,
      error: "cancelled",
    });
    expect(await bridge.setTerminalCommand("remove")).toEqual({
      command: UNPACKAGED,
      error: "failed",
    });
    expect(await bridge.chooseFolder()).toBeNull();
  });

  test("main's refusal reaches the page as a rejection", async () => {
    const ipc: PreloadIpc = {
      send: () => {},
      on: () => {},
      invoke: async () => {
        throw new Error("Error invoking remote method 'eidolon:login-item': Error: refused");
      },
    };
    const bridge = desktopBridge(ipc, "win32", { version: "", serverVersion: "" });
    await expect(bridge.loginItem()).rejects.toThrow("refused");
  });

  test("the shell's bridge sends each button's channel with nothing in it", () => {
    const { ipc, sent } = fakeIpc();
    const bridge = shellBridge(ipc);
    bridge.retry();
    bridge.showLogs();
    bridge.quit();
    expect(sent).toEqual([[BRIDGE.retry], [BRIDGE.showLogs], [BRIDGE.quit]]);
  });
});

test("the preload loads only electron and its own modules: a sandbox gives it no Node", () => {
  const sources = (dir: string) =>
    readdirSync(join(SRC, dir))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(SRC, dir, name));
  const files = [...sources("preload"), ...sources("shared")];
  expect(files).toContain(join(SRC, "preload", "index.ts"));
  for (const file of files) {
    const own = (specifier: string) =>
      /^(?:preload|shared)[/\\]/.test(relative(SRC, resolve(dirname(file), specifier)));
    const outside = scan(file).filter((specifier) =>
      specifier.startsWith(".") ? !own(specifier) : specifier !== "electron",
    );
    expect([relative(SRC, file), outside]).toEqual([relative(SRC, file), []]);
  }
  // Main bundles the shared module too, where electron's contextBridge and ipcRenderer don't exist.
  for (const file of sources("shared")) expect(scan(file)).toEqual([]);
});
