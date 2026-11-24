// What the preload hands each page, apart from Electron so the tests can drive it with a fake IPC.
import {
  BRIDGE,
  commandChangeOf,
  commandStateOf,
  companionCursorOf,
  companionDragOf,
  companionMenuStateOf,
  companionPickOf,
  companionShapeOf,
  companionStateOf,
  type DesktopVersions,
  type EidolonCompanion,
  type EidolonDesktop,
  type EidolonShell,
  folderOf,
  isCommandAction,
  isCompanionCallPick,
  isCompanionChange,
  isCompanionDrawn,
  isLanguage,
  isThemeSetting,
  loginItemStateOf,
  pageAt,
  type WindowKind,
  windowSizeOf,
} from "../shared/bridge.ts";

/** The part of `ipcRenderer` the bridges use. */
export interface PreloadIpc {
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * The bridge a page gets, if any: only a main frame's; at the app's address the companion's in her
 * window and the app's in the main one, and at the shell's address the shell's, in the main window.
 */
export function bridgeFor(
  url: string,
  mainFrame: boolean,
  kind: WindowKind,
): "app" | "companion" | "shell" | null {
  if (!mainFrame) return null;
  const page = pageAt(url);
  if (page === "app") return kind === "companion" ? "companion" : "app";
  return page === "shell" && kind === "main" ? "shell" : null;
}

/**
 * `window.eidolonDesktop`. It sends only values main takes, hands the page no IPC event, and gives
 * it main's answers only in the shapes it declares.
 */
export function desktopBridge(
  ipc: PreloadIpc,
  platform: string,
  versions: DesktopVersions,
): EidolonDesktop {
  return {
    platform,
    version: versions.version,
    serverVersion: versions.serverVersion,
    setTheme: (setting) => {
      if (isThemeSetting(setting)) ipc.send(BRIDGE.theme, setting);
    },
    setLanguage: (language) => {
      if (isLanguage(language)) ipc.send(BRIDGE.language, language);
    },
    onCommand: (callback) => {
      ipc.on(BRIDGE.command, (_event, command) => {
        if (typeof command === "string") callback(command);
      });
      ipc.send(BRIDGE.takesCommands);
    },
    chooseFolder: () => ipc.invoke(BRIDGE.chooseFolder).then(folderOf),
    loginItem: () => ipc.invoke(BRIDGE.loginItem).then(loginItemStateOf),
    setLoginItem: (on) => ipc.invoke(BRIDGE.setLoginItem, on === true).then(loginItemStateOf),
    terminalCommand: () => ipc.invoke(BRIDGE.terminalCommand).then(commandStateOf),
    setTerminalCommand: (action) =>
      isCommandAction(action)
        ? ipc.invoke(BRIDGE.setTerminalCommand, action).then(commandChangeOf)
        : Promise.reject(new Error("the terminal command takes install or remove")),
    companion: () => ipc.invoke(BRIDGE.companion).then(companionStateOf),
    setCompanion: (change) =>
      isCompanionChange(change)
        ? ipc.invoke(BRIDGE.setCompanion, change).then(companionStateOf)
        : Promise.reject(new Error("the desktop companion takes on or showAtLogin")),
    popOut: () => ipc.invoke(BRIDGE.popOut).then(companionStateOf),
    linkCompanion: () => ipc.send(BRIDGE.linkCompanion),
    feedingCompanion: (feeding) => ipc.send(BRIDGE.feedingCompanion, feeding === true),
    onCompanionPick: (callback) => {
      ipc.on(BRIDGE.companionPick, (_event, pick) => {
        if (isCompanionCallPick(pick)) callback(pick);
      });
    },
  };
}

/** `window.eidolonShell`: each call a message with nothing in it, which main acts on. */
export function shellBridge(ipc: Pick<PreloadIpc, "send">): EidolonShell {
  return {
    retry: () => ipc.send(BRIDGE.retry),
    showLogs: () => ipc.send(BRIDGE.showLogs),
    quit: () => ipc.send(BRIDGE.quit),
  };
}

/** `window.eidolonCompanion`: sends only values main takes, and hands the page main's answers in their shapes. */
export function companionBridge(ipc: PreloadIpc, platform: string): EidolonCompanion {
  return {
    platform,
    link: () => ipc.send(BRIDGE.linkApp),
    hit: (over) => ipc.send(BRIDGE.companionHit, over === true),
    drag: (value) => {
      const drag = companionDragOf(value);
      if (drag !== null) ipc.send(BRIDGE.companionDrag, drag);
    },
    shape: async (value) => {
      const shape = companionShapeOf(value);
      if (shape === null) throw new Error("her shape is her picture, or her model's aspect");
      const size = windowSizeOf(await ipc.invoke(BRIDGE.companionShape, shape));
      if (size === null) throw new Error("main answered no size for her window");
      return size;
    },
    drawn: (drawn) => {
      if (isCompanionDrawn(drawn)) ipc.send(BRIDGE.companionDrawn, drawn);
    },
    follow: (on) => ipc.send(BRIDGE.companionFollow, on === true),
    onCursor: (callback) => {
      ipc.on(BRIDGE.companionCursor, (_event, value) => {
        const cursor = companionCursorOf(value);
        if (cursor !== null) callback(cursor);
      });
    },
    menu: async (value) => {
      const state = companionMenuStateOf(value);
      if (state === null) throw new Error("her menu takes the call's state and her models");
      return companionPickOf(await ipc.invoke(BRIDGE.companionMenu, state));
    },
  };
}
