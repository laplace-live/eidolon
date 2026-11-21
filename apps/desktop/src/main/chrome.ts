// The window's chrome (§5.2) and the app's bridge to main (§5.9): the theme the page reports, which
// native menus, dialogs and the caption buttons follow; the fullscreen mark on macOS; the page's
// language; and the versions its bridge carries.
import { type BrowserWindow, ipcMain, nativeTheme } from "electron";
import {
  accepts,
  BRIDGE,
  type DesktopCommand,
  type DesktopVersions,
  isLanguage,
  isThemeSetting,
  type Language,
} from "../shared/bridge.ts";
import { ipcSender, mainWindow } from "./window.ts";
import { titleBarOverlay } from "./window-options.ts";

/** Per window: the caption buttons' colour on Windows, and the fullscreen mark on macOS. */
export function dressWindow(win: BrowserWindow): void {
  if (process.platform === "win32") {
    // The glyphs are the OS's to draw, in the colour they're handed at each theme change.
    const recolour = (): void => {
      if (win.isDestroyed()) return;
      win.setTitleBarOverlay(titleBarOverlay(nativeTheme.shouldUseDarkColors));
    };
    nativeTheme.on("updated", recolour);
    win.once("closed", () => nativeTheme.off("updated", recolour));
  }
  if (process.platform === "darwin") {
    // Fullscreen hides the traffic lights; a new page starts without the mark, so each gets it.
    const mark = (): void => {
      if (!win.isDestroyed()) win.webContents.send(BRIDGE.fullscreen, win.isFullScreen());
    };
    win.on("enter-full-screen", mark);
    win.on("leave-full-screen", mark);
    win.webContents.on("did-navigate", mark);
  }
}

export interface AppBridge {
  /** The desktop's version and the server's, as the backend last reported it. */
  readonly versions: () => DesktopVersions;
  readonly language: (language: Language) => void;
}

/**
 * The app page's messages, each taken only from the window's main frame at eidolon-app://app. The
 * theme setting goes to `themeSource` as it is: a resolved theme would pin prefers-color-scheme and
 * stop the page's System from following the OS.
 */
export function handleAppBridge(bridge: AppBridge): void {
  ipcMain.on(BRIDGE.theme, (event, setting: unknown) => {
    if (accepts(BRIDGE.theme, ipcSender(event)) && isThemeSetting(setting)) {
      nativeTheme.themeSource = setting;
    }
  });
  ipcMain.on(BRIDGE.language, (event, language: unknown) => {
    if (accepts(BRIDGE.language, ipcSender(event)) && isLanguage(language)) {
      bridge.language(language);
    }
  });
  // A synchronous message keeps the page waiting until it has an answer, so every path answers.
  ipcMain.on(BRIDGE.versions, (event) => {
    event.returnValue = accepts(BRIDGE.versions, ipcSender(event)) ? bridge.versions() : null;
  });
}

/** Hands the app's page a menu's command, such as opening Settings; a shell page has no listener. */
export function sendCommand(command: DesktopCommand): void {
  mainWindow()?.webContents.send(BRIDGE.command, command);
}
