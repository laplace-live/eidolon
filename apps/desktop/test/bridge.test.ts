import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { scan } from "../../bot/test/local/scan.ts";
import { bridgeFor, desktopBridge, type PreloadIpc, shellBridge } from "../src/preload/bridges.ts";
import {
  accepts,
  BRIDGE,
  type IpcSender,
  isLanguage,
  isThemeSetting,
  type PageChannel,
  pageAt,
  versionArguments,
  versionsFrom,
} from "../src/shared/bridge.ts";

const SRC = resolve(import.meta.dirname, "../src");

/** An ipcRenderer that records what is sent and lets the test send to the page. */
function fakeIpc() {
  const sent: unknown[][] = [];
  const listeners = new Map<string, ((event: unknown, ...args: unknown[]) => void)[]>();
  const ipc: PreloadIpc = {
    send: (channel, ...args) => sent.push([channel, ...args]),
    on: (channel, listener) =>
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]),
  };
  const deliver = (channel: string, ...args: unknown[]) => {
    for (const listener of listeners.get(channel) ?? [])
      listener({ sender: "ipcRenderer" }, ...args);
  };
  return { ipc, sent, deliver };
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
  const app: IpcSender = { window: true, mainFrame: true, url: "eidolon-app://app/settings" };
  const shell: IpcSender = { window: true, mainFrame: true, url: "eidolon-app://shell/failed" };

  test("the app's page alone sets the theme and the language", () => {
    for (const channel of [BRIDGE.theme, BRIDGE.language]) {
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
    const channels: PageChannel[] = [
      BRIDGE.theme,
      BRIDGE.language,
      BRIDGE.retry,
      BRIDGE.showLogs,
      BRIDGE.quit,
    ];
    for (const channel of channels) {
      const own = channel === BRIDGE.theme || channel === BRIDGE.language ? app : shell;
      expect(accepts(channel, { ...own, mainFrame: false })).toBe(false);
      expect(accepts(channel, { ...own, window: false })).toBe(false);
      expect(accepts(channel, { ...own, url: null })).toBe(false);
      expect(accepts(channel, { ...own, url: "eidolon-app://other/" })).toBe(false);
      expect(accepts(channel, { ...own, url: "data:text/html," })).toBe(false);
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

test("the versions reach the preload's argv and back, and are empty when main passed none", () => {
  const versions = { version: "0.1.0", serverVersion: "0.13.0" };
  const argv = [
    "/path/to/Eidolon Helper (Renderer)",
    "--type=renderer",
    ...versionArguments(versions),
  ];
  expect(versionsFrom(argv)).toEqual(versions);
  expect(versionsFrom(["/path/to/Eidolon Helper (Renderer)"])).toEqual({
    version: "",
    serverVersion: "",
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

  test("a command reaches the page's callback as its name alone, never with the IPC event", () => {
    const { ipc, deliver } = fakeIpc();
    const received: unknown[][] = [];
    desktopBridge(ipc, "win32", { version: "", serverVersion: "" }).onCommand((...args) =>
      received.push(args),
    );
    deliver(BRIDGE.command, "settings");
    deliver(BRIDGE.command, { name: "settings" });
    deliver(BRIDGE.command);
    expect(received).toEqual([["settings"]]);
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
