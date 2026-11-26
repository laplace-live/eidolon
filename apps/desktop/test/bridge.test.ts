import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { scan } from "../../bot/test/local/scan.ts";
import {
  bridgeFor,
  companionBridge,
  desktopBridge,
  type PreloadIpc,
  shellBridge,
} from "../src/preload/bridges.ts";
import {
  accepts,
  BRIDGE,
  COMPANION_CALL_PICKS,
  COMPANION_SWITCH,
  type CompanionMenuState,
  commandChangeOf,
  commandStateOf,
  companionCursorOf,
  companionDragOf,
  companionMenuStateOf,
  companionPickOf,
  companionShapeOf,
  companionStateOf,
  folderOf,
  ID_PATTERN,
  type IpcSender,
  isCommandAction,
  isCompanionCallPick,
  isCompanionChange,
  isCompanionDrawn,
  isCompanionSize,
  isLanguage,
  isThemeSetting,
  loginItemStateOf,
  openChatCommand,
  openTaskCommand,
  type PageChannel,
  pageAt,
  versionsOf,
  windowKindOf,
  windowSizeOf,
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
    sendSync: (channel, ...args) => {
      sent.push([channel, ...args]);
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
    BRIDGE.revealModel,
  ];
  const SHELL_CHANNELS: PageChannel[] = [BRIDGE.retry, BRIDGE.showLogs, BRIDGE.quit];
  /** The app page's channels for the desktop companion. */
  const APP_COMPANION_CHANNELS: PageChannel[] = [
    BRIDGE.companion,
    BRIDGE.setCompanion,
    BRIDGE.popOut,
    BRIDGE.resetCompanionPlace,
    BRIDGE.linkCompanion,
    BRIDGE.feedingCompanion,
    BRIDGE.windowShows,
  ];
  /** Her page's own channels. */
  const HER_CHANNELS: PageChannel[] = [
    BRIDGE.linkApp,
    BRIDGE.companionHit,
    BRIDGE.companionDrag,
    BRIDGE.companionShape,
    BRIDGE.companionDrawn,
    BRIDGE.companionFollow,
    BRIDGE.companionMenu,
  ];
  const EXISTING = [...APP_CHANNELS, ...SHELL_CHANNELS];
  const ALL = [...EXISTING, ...APP_COMPANION_CHANNELS, ...HER_CHANNELS];
  const app: IpcSender = { window: "main", mainFrame: true, origin: "eidolon-app://app" };
  const shell: IpcSender = { window: "main", mainFrame: true, origin: "eidolon-app://shell" };
  /** Her page shares the app page's origin: only her window tells it apart. */
  const her: IpcSender = { window: "companion", mainFrame: true, origin: "eidolon-app://app" };
  const ownSender = (channel: PageChannel): IpcSender =>
    HER_CHANNELS.includes(channel) ? her : SHELL_CHANNELS.includes(channel) ? shell : app;

  test("the app's page alone sets the theme and the language, asks for the versions, takes commands, picks a folder, reads or changes the system options and tells of its unsaved edits", () => {
    for (const channel of APP_CHANNELS) {
      expect(accepts(channel, app)).toBe(true);
      expect(accepts(channel, shell)).toBe(false);
    }
  });

  test("a shell page alone retries, shows the logs and quits", () => {
    for (const channel of SHELL_CHANNELS) {
      expect(accepts(channel, shell)).toBe(true);
      expect(accepts(channel, app)).toBe(false);
    }
  });

  test("never from a subframe, another webContents, a frame that's gone or another address", () => {
    for (const channel of ALL) {
      const own = ownSender(channel);
      expect(accepts(channel, own)).toBe(true);
      expect(accepts(channel, { ...own, mainFrame: false })).toBe(false);
      expect(accepts(channel, { ...own, window: null })).toBe(false);
      expect(accepts(channel, { ...own, origin: null })).toBe(false);
      expect(accepts(channel, { ...own, origin: "eidolon-app://other" })).toBe(false);
      expect(accepts(channel, { ...own, origin: "data:text/html," })).toBe(false);
    }
  });

  test("never from a document at the app's address with an opaque origin, as a sandboxed one has", () => {
    for (const channel of [...APP_CHANNELS, ...APP_COMPANION_CHANNELS, ...HER_CHANNELS]) {
      expect(accepts(channel, { ...ownSender(channel), origin: "null" })).toBe(false);
    }
  });

  test("the desktop companion's page, at the app's own origin, reaches none of the main window's channels", () => {
    for (const channel of [...EXISTING, ...APP_COMPANION_CHANNELS]) {
      expect([channel, accepts(channel, her)]).toEqual([channel, false]);
    }
  });

  test("her channels are her page's alone, never the main window's app page's", () => {
    for (const channel of HER_CHANNELS) {
      expect([channel, accepts(channel, her)]).toEqual([channel, true]);
      expect([channel, accepts(channel, app)]).toEqual([channel, false]);
      expect([channel, accepts(channel, shell)]).toEqual([channel, false]);
    }
  });

  test("the app page's channels for her are the main window's app page's alone", () => {
    for (const channel of APP_COMPANION_CHANNELS) {
      expect([channel, accepts(channel, app)]).toEqual([channel, true]);
      expect([channel, accepts(channel, her)]).toEqual([channel, false]);
      expect([channel, accepts(channel, shell)]).toEqual([channel, false]);
    }
  });

  test("a sender no window holds is refused everywhere", () => {
    for (const channel of ALL) {
      for (const origin of ["eidolon-app://app", "eidolon-app://shell"]) {
        expect(accepts(channel, { window: null, mainFrame: true, origin })).toBe(false);
      }
    }
  });
});

test("a preload's window is the companion's only with her switch among its arguments", () => {
  expect(windowKindOf(["/Eidolon", "--type=renderer", COMPANION_SWITCH])).toBe("companion");
  expect(windowKindOf(["/Eidolon", "--type=renderer"])).toBe("main");
  expect(windowKindOf([])).toBe("main");
  expect(windowKindOf(["--eidolon-window=companion-x", "eidolon-window=companion"])).toBe("main");
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

describe("openChatCommand and openTaskCommand", () => {
  test("names a chat or a chat's task by its ids", () => {
    expect(openChatCommand(CHAT)).toBe(`open-chat:${CHAT}`);
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
      expect(() => openChatCommand(id)).toThrow();
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

/** Her menu's state, as her page would send it with two models and one outfit. */
const MENU_STATE: CompanionMenuState = {
  call: "idle",
  live: false,
  micOn: true,
  models: [
    { id: "milky", name: "奶绿" },
    { id: "tml-2", name: "TML & Co" },
  ],
  model: "milky",
  outfits: [{ id: "summer_1", name: "Summer" }],
  outfit: null,
};

describe("the desktop companion's values", () => {
  test("her state is on only when main says so, shows at login unless it says not, and is off screen only in background mode", () => {
    expect(companionStateOf({ on: true, showAtLogin: false, background: true, x: 1 })).toEqual({
      on: true,
      showAtLogin: false,
      background: true,
    });
    for (const answer of [
      null,
      undefined,
      "on",
      1,
      [],
      { on: "true", showAtLogin: 0 },
      { background: "true" },
      { background: 1 },
    ]) {
      expect(companionStateOf(answer)).toEqual({ on: false, showAtLogin: true, background: false });
    }
  });

  test("a change names on, showAtLogin or both, each a boolean, and nothing else", () => {
    for (const change of [{ on: true }, { showAtLogin: false }, { on: false, showAtLogin: true }]) {
      expect(isCompanionChange(change)).toBe(true);
    }
    for (const change of [
      {},
      { on: "yes" },
      { on: true, x: 1 },
      { on: true, x: true },
      { x: true },
      { on: undefined },
      { showAtLogin: null },
      null,
      true,
      [true],
      "on",
    ]) {
      expect([change, isCompanionChange(change)]).toEqual([change, false]);
    }
  });

  test("her shape is her picture, or her model framed between 0.1 and 4 wide for its height", () => {
    expect(companionShapeOf({ kind: "picture", aspect: 9 })).toEqual({ kind: "picture" });
    expect(companionShapeOf({ kind: "model", aspect: 0.42, extra: 1 })).toEqual({
      kind: "model",
      aspect: 0.42,
    });
    expect(companionShapeOf({ kind: "model", aspect: 0.1 })).toEqual({
      kind: "model",
      aspect: 0.1,
    });
    expect(companionShapeOf({ kind: "model", aspect: 4 })).toEqual({ kind: "model", aspect: 4 });
    for (const shape of [
      { kind: "model", aspect: 0.09 },
      { kind: "model", aspect: 4.01 },
      { kind: "model", aspect: Number.NaN },
      { kind: "model", aspect: Number.POSITIVE_INFINITY },
      { kind: "model", aspect: "0.5" },
      { kind: "model" },
      { kind: "video", aspect: 1 },
      "picture",
      null,
    ]) {
      expect([shape, companionShapeOf(shape)]).toEqual([shape, null]);
    }
  });

  test("drawn is her model, her picture, or null for not drawn", () => {
    for (const drawn of ["model", "picture", null]) expect(isCompanionDrawn(drawn)).toBe(true);
    for (const drawn of [undefined, "Model", "loading", true, { kind: "model" }]) {
      expect(isCompanionDrawn(drawn)).toBe(false);
    }
  });

  test("a drag has its phase and a pointer no farther than a million DIP off, each axis finite", () => {
    expect(companionDragOf({ phase: "move", x: -120.5, y: 1e6, extra: 1 })).toEqual({
      phase: "move",
      x: -120.5,
      y: 1e6,
    });
    for (const phase of ["start", "move", "end"]) {
      expect(companionDragOf({ phase, x: 0, y: 0 })).toEqual({ phase, x: 0, y: 0 });
    }
    for (const drag of [
      { phase: "drop", x: 0, y: 0 },
      { phase: "move", x: 1e6 + 1, y: 0 },
      { phase: "move", x: 0, y: Number.NaN },
      { phase: "move", x: "1", y: 0 },
      { phase: "move", x: 0 },
      null,
    ]) {
      expect([drag, companionDragOf(drag)]).toEqual([drag, null]);
    }
  });

  test("the cursor is a point no farther than a million DIP off, each axis finite", () => {
    expect(companionCursorOf({ x: -40, y: 2560.5, z: 1 })).toEqual({ x: -40, y: 2560.5 });
    for (const cursor of [
      { x: "1", y: 0 },
      { x: 0, y: -1e6 - 1 },
      { x: Number.NEGATIVE_INFINITY, y: 0 },
      { x: 1 },
      [1, 2],
      null,
    ]) {
      expect([cursor, companionCursorOf(cursor)]).toEqual([cursor, null]);
    }
  });

  test("her menu's state keeps the call's, her models and her outfits, each as its own kind", () => {
    expect(companionMenuStateOf({ ...MENU_STATE, extra: true })).toEqual(MENU_STATE);
    for (const call of ["idle", "open", "up"] as const) {
      expect(companionMenuStateOf({ ...MENU_STATE, call })?.call).toBe(call);
    }
    // The active model can fall past the list's cap, and the worn outfit off its list.
    expect(companionMenuStateOf({ ...MENU_STATE, model: "unlisted", outfit: "winter" })).toEqual({
      ...MENU_STATE,
      model: "unlisted",
      outfit: "winter",
    });
    expect(companionMenuStateOf({ ...MENU_STATE, models: [], model: null, outfits: [] })).toEqual({
      ...MENU_STATE,
      models: [],
      model: null,
      outfits: [],
    });
    const named = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `m${index}`, name: `Model ${index}` }));
    expect(companionMenuStateOf({ ...MENU_STATE, models: named(50) })?.models).toHaveLength(50);
    expect(companionMenuStateOf({ ...MENU_STATE, outfits: named(32) })?.outfits).toHaveLength(32);
    const long = "a".repeat(64);
    expect(companionMenuStateOf({ ...MENU_STATE, model: long })?.model).toBe(long);
    for (const state of [
      { ...MENU_STATE, call: "ringing" },
      { ...MENU_STATE, live: "no" },
      { ...MENU_STATE, micOn: undefined },
      { ...MENU_STATE, models: named(51) },
      { ...MENU_STATE, outfits: named(33) },
      { ...MENU_STATE, models: [{ id: "Milky", name: "奶绿" }] },
      { ...MENU_STATE, models: [{ id: "milky", name: "x".repeat(201) }] },
      { ...MENU_STATE, models: [{ id: "milky" }] },
      { ...MENU_STATE, models: "milky" },
      { ...MENU_STATE, outfits: [{ id: "a".repeat(33), name: "Long" }] },
      { ...MENU_STATE, model: `${long}a` },
      { ...MENU_STATE, model: "../x" },
      { ...MENU_STATE, model: undefined },
      { ...MENU_STATE, outfit: "-summer" },
      { ...MENU_STATE, outfit: 1 },
      null,
      "idle",
    ]) {
      expect(companionMenuStateOf(state), JSON.stringify(state)).toBeNull();
    }
    expect(
      companionMenuStateOf({ ...MENU_STATE, models: [{ id: "milky", name: "x".repeat(200) }] }),
    ).not.toBeNull();
  });

  test("main's size for her window is two whole sides from 1 to 10,000 DIP", () => {
    expect(windowSizeOf({ width: 202, height: 480, x: 1 })).toEqual({ width: 202, height: 480 });
    expect(windowSizeOf({ width: 1, height: 10_000 })).toEqual({ width: 1, height: 10_000 });
    for (const size of [
      { width: 0, height: 480 },
      { width: 202.5, height: 480 },
      { width: 202, height: 10_001 },
      { width: -1, height: 480 },
      { width: "202", height: 480 },
      { width: 202 },
      null,
    ]) {
      expect([size, windowSizeOf(size)]).toEqual([size, null]);
    }
  });

  test("a pick is one of her menu's own, a size, a model's id, or an outfit's id or none", () => {
    for (const pick of [
      "call",
      "hang-up",
      "mute",
      "unmute",
      "open",
      "always-on-top",
      "hide",
      "size:small",
      "size:medium",
      "size:large",
      "model:milky",
      "outfit:",
      "outfit:summer_1",
    ]) {
      expect(companionPickOf(pick)).toBe(pick);
    }
    for (const pick of [
      "size:huge",
      "size:",
      "model:",
      "model:Milky",
      "model:../x",
      `outfit:${"a".repeat(33)}`,
      "outfit:-x",
      "quit",
      "Call",
      "",
      1,
      null,
      ["call"],
    ]) {
      expect([pick, companionPickOf(pick)]).toEqual([pick, null]);
    }
  });

  test("a pick for the call is one of the four main hands the app page alone", () => {
    expect([...COMPANION_CALL_PICKS]).toEqual(["call", "hang-up", "mute", "unmute"]);
    for (const pick of COMPANION_CALL_PICKS) expect(isCompanionCallPick(pick)).toBe(true);
    for (const pick of ["open", "hide", "size:large", "model:a", "always-on-top", 1, null]) {
      expect([pick, isCompanionCallPick(pick)]).toEqual([pick, false]);
    }
  });

  test("a size is small, medium or large", () => {
    for (const size of ["small", "medium", "large"]) expect(isCompanionSize(size)).toBe(true);
    for (const size of ["huge", "Medium", "", null, 1]) expect(isCompanionSize(size)).toBe(false);
  });
});

describe("the preload's bridges", () => {
  test("go to a main frame alone, the app's bridge on the app's page and the shell's on a shell page", () => {
    expect(bridgeFor("eidolon-app://app/", true, "main")).toBe("app");
    expect(bridgeFor("eidolon-app://shell/loading", true, "main")).toBe("shell");
    expect(bridgeFor("eidolon-app://app/", false, "main")).toBeNull();
    expect(bridgeFor("eidolon-app://shell/failed", false, "main")).toBeNull();
    expect(bridgeFor("https://example.com/", true, "main")).toBeNull();
  });

  test("in the desktop companion's window, her page gets hers, and nothing else gets one", () => {
    expect(bridgeFor("eidolon-app://app/companion", true, "companion")).toBe("companion");
    expect(bridgeFor("eidolon-app://app/companion", true, "main")).toBe("app");
    expect(bridgeFor("eidolon-app://app/companion", false, "companion")).toBeNull();
    expect(bridgeFor("eidolon-app://shell/loading", true, "companion")).toBeNull();
    expect(bridgeFor("https://example.com/", true, "companion")).toBeNull();
    expect(bridgeFor("about:blank", true, "companion")).toBeNull();
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
      sendSync: () => null,
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

  test("the app's bridge reads and changes the desktop companion with only values main takes, answering her state's shape", async () => {
    const { ipc, invoked } = fakeIpc([
      { on: true, showAtLogin: false, background: true, extra: 1 },
      { on: "yes" },
      null,
    ]);
    const bridge = desktopBridge(ipc, "darwin", { version: "", serverVersion: "" });
    expect(await bridge.companion()).toEqual({ on: true, showAtLogin: false, background: true });
    expect(await bridge.setCompanion({ on: true })).toEqual({
      on: false,
      showAtLogin: true,
      background: false,
    });
    expect(await bridge.popOut()).toEqual({ on: false, showAtLogin: true, background: false });
    // What a page could pass despite the types.
    for (const change of [
      {},
      { on: "yes" },
      { on: true, x: 1 },
      { on: true, x: true },
      { x: true },
      null,
    ]) {
      await expect(bridge.setCompanion(change as never)).rejects.toThrow();
    }
    expect(invoked).toEqual([
      [BRIDGE.companion],
      [BRIDGE.setCompanion, { on: true }],
      [BRIDGE.popOut],
    ]);
  });

  test("the app's bridge resets her place, answering her state's shape", async () => {
    const { ipc, invoked } = fakeIpc([{ on: true, showAtLogin: true, background: false }]);
    const bridge = desktopBridge(ipc, "darwin", { version: "", serverVersion: "" });
    expect(await bridge.resetCompanionPlace()).toEqual({
      on: true,
      showAtLogin: true,
      background: false,
    });
    expect(invoked).toEqual([[BRIDGE.resetCompanionPlace]]);
  });

  test("the app's bridge shows a model by its persona's id and its own alone, true only on main's true", async () => {
    const { ipc, invoked } = fakeIpc([true, "yes", false]);
    const bridge = desktopBridge(ipc, "darwin", { version: "", serverVersion: "" });
    expect(await bridge.revealModel({ persona: "milky-green", model: "tml" })).toBe(true);
    expect(await bridge.revealModel({ persona: "milky-green", model: "tml" })).toBe(false);
    for (const model of [
      { persona: "milky-green", model: "../x" },
      { persona: "/etc", model: "tml" },
      { persona: "milky-green" },
      null,
    ]) {
      await expect(bridge.revealModel(model as never)).rejects.toThrow();
    }
    const extra = { persona: "milky-green", model: "tml", path: "/etc" };
    expect(await bridge.revealModel(extra)).toBe(false);
    expect(invoked).toEqual([
      [BRIDGE.revealModel, { persona: "milky-green", model: "tml" }],
      [BRIDGE.revealModel, { persona: "milky-green", model: "tml" }],
      [BRIDGE.revealModel, { persona: "milky-green", model: "tml" }],
    ]);
  });

  test("the app's bridge asks for a port, says whether it feeds her, and sends nothing else", () => {
    const { ipc, sent } = fakeIpc();
    const bridge = desktopBridge(ipc, "darwin", { version: "", serverVersion: "" });
    bridge.linkCompanion();
    bridge.feedingCompanion(true);
    bridge.feedingCompanion(false);
    bridge.feedingCompanion("yes" as never);
    expect(sent).toEqual([
      [BRIDGE.linkCompanion],
      [BRIDGE.feedingCompanion, true],
      [BRIDGE.feedingCompanion, false],
      [BRIDGE.feedingCompanion, false],
    ]);
  });

  test("the app's bridge says whether its window shows, as main answers at once and at each change", () => {
    const { ipc, sent, deliver } = fakeIpc([false]);
    const shows: unknown[][] = [];
    desktopBridge(ipc, "darwin", { version: "", serverVersion: "" }).onWindowShows((...args) =>
      shows.push(args),
    );
    expect(sent).toEqual([[BRIDGE.windowShows]]);
    for (const value of [true, "false", 0, null, false]) deliver(BRIDGE.windowShows, value);
    expect(shows).toEqual([[false], [true], [false]]);
    // Whatever main answers but false reads as shown: a page hidden by mistake would draw nothing.
    const other = fakeIpc([null]);
    const read: unknown[] = [];
    desktopBridge(other.ipc, "darwin", { version: "", serverVersion: "" }).onWindowShows((value) =>
      read.push(value),
    );
    expect(read).toEqual([true]);
  });

  test("a pick from her menu reaches the app's page as a call pick alone, never with the IPC event", () => {
    const { ipc, sent, deliver } = fakeIpc();
    const received: unknown[][] = [];
    desktopBridge(ipc, "win32", { version: "", serverVersion: "" }).onCompanionPick((...args) =>
      received.push(args),
    );
    expect(sent).toEqual([]);
    for (const pick of ["mute", "open", "model:a", "hide", 1, { pick: "call" }, "hang-up"]) {
      deliver(BRIDGE.companionPick, pick);
    }
    expect(received).toEqual([["mute"], ["hang-up"]]);
  });

  test("her bridge sends only values main takes", () => {
    const { ipc, sent } = fakeIpc();
    const bridge = companionBridge(ipc, "darwin");
    expect(bridge.platform).toBe("darwin");
    bridge.link();
    bridge.hit(true);
    bridge.hit("yes" as never);
    bridge.follow(true);
    bridge.follow(1 as never);
    bridge.drag({ phase: "start", x: 10, y: 20 });
    bridge.drag({ phase: "move", x: "11", y: 20 } as never);
    bridge.drag({ phase: "fling", x: 11, y: 20 } as never);
    bridge.drawn("model");
    bridge.drawn(null);
    bridge.drawn("loading" as never);
    expect(sent).toEqual([
      [BRIDGE.linkApp],
      [BRIDGE.companionHit, true],
      [BRIDGE.companionHit, false],
      [BRIDGE.companionFollow, true],
      [BRIDGE.companionFollow, false],
      [BRIDGE.companionDrag, { phase: "start", x: 10, y: 20 }],
      [BRIDGE.companionDrawn, "model"],
      [BRIDGE.companionDrawn, null],
    ]);
  });

  test("her bridge invokes her shape and her menu only with values main takes, answering their shapes", async () => {
    const { ipc, invoked } = fakeIpc([
      { width: 202, height: 480, extra: 1 },
      { width: 0, height: 480 },
      "size:large",
      "quit",
      null,
    ]);
    const bridge = companionBridge(ipc, "win32");
    expect(await bridge.shape({ kind: "model", aspect: 0.42 })).toEqual({
      width: 202,
      height: 480,
    });
    await expect(bridge.shape({ kind: "picture" })).rejects.toThrow();
    expect(await bridge.menu(MENU_STATE)).toBe("size:large");
    expect(await bridge.menu({ ...MENU_STATE, call: "up", live: true })).toBeNull();
    expect(await bridge.menu(MENU_STATE)).toBeNull();
    // What a page could pass despite the types.
    await expect(bridge.shape({ kind: "model", aspect: 9 } as never)).rejects.toThrow();
    await expect(bridge.menu({ ...MENU_STATE, call: "ringing" } as never)).rejects.toThrow();
    expect(invoked).toEqual([
      [BRIDGE.companionShape, { kind: "model", aspect: 0.42 }],
      [BRIDGE.companionShape, { kind: "picture" }],
      [BRIDGE.companionMenu, MENU_STATE],
      [BRIDGE.companionMenu, { ...MENU_STATE, call: "up", live: true }],
      [BRIDGE.companionMenu, MENU_STATE],
    ]);
  });

  test("main's cursor reaches her page in its shape alone, never with the IPC event", () => {
    const { ipc, deliver } = fakeIpc();
    const received: unknown[][] = [];
    companionBridge(ipc, "darwin").onCursor((...args) => received.push(args));
    deliver(BRIDGE.companionCursor, { x: 12, y: -40, extra: 1 });
    deliver(BRIDGE.companionCursor, { x: "1", y: 2 });
    deliver(BRIDGE.companionCursor);
    expect(received).toEqual([[{ x: 12, y: -40 }]]);
  });

  test("her bridge has no member that hears a pick for the call, nor any of the app page's", () => {
    const bridge = companionBridge(fakeIpc().ipc, "darwin");
    expect(Object.keys(bridge).sort()).toEqual(
      ["drag", "drawn", "follow", "hit", "link", "menu", "onCursor", "platform", "shape"].sort(),
    );
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
