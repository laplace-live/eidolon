// What the preload hands each page, apart from Electron so the tests can drive it with a fake IPC.
import {
  BRIDGE,
  type DesktopVersions,
  type EidolonDesktop,
  type EidolonShell,
  isLanguage,
  isThemeSetting,
  type Page,
  pageAt,
} from "../shared/bridge.ts";

/** The part of `ipcRenderer` the bridges use. */
export interface PreloadIpc {
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/** The bridge a page gets, if any: only a main frame, at the app's address or the shell's. */
export function bridgeFor(url: string, mainFrame: boolean): Page | null {
  return mainFrame ? pageAt(url) : null;
}

/** `window.eidolonDesktop`. It sends only values main takes, and hands the page no IPC event. */
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
    },
  };
}

/** `window.eidolonShell`: each call a message with nothing in it, which main acts on. */
export function shellBridge(ipc: PreloadIpc): EidolonShell {
  return {
    retry: () => ipc.send(BRIDGE.retry),
    showLogs: () => ipc.send(BRIDGE.showLogs),
    quit: () => ipc.send(BRIDGE.quit),
  };
}
