// The window's chrome and the app's bridge to main: the theme the page reports, which
// native menus, dialogs and the caption buttons follow; the fullscreen mark on macOS; the page's
// language and its unsaved edits; the versions its bridge carries; the folder dialog, the system
// options and the desktop companion it asks main for; and her menu's picks for its call.
import { type BrowserWindow, ipcMain, nativeTheme } from "electron";
import {
  accepts,
  BRIDGE,
  type CompanionCallPick,
  type DesktopCommand,
  type DesktopVersions,
  isLanguage,
  isThemeSetting,
  type Language,
} from "../shared/bridge.ts";
import { type AppInvokes, appInvokes } from "./app-invokes.ts";
import { ipcSender } from "./senders.ts";
import { mainWindow } from "./window.ts";
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

export interface AppBridge extends AppInvokes {
  /** The desktop's version and the server's, as the backend last reported it. */
  readonly versions: () => DesktopVersions;
  readonly language: (language: Language) => void;
  /** The page listens for commands now. */
  readonly takesCommands: () => void;
  /** Whether the page holds unsaved edits now. */
  readonly unsaved: (held: boolean) => void;
  /** The page listens for a port to the companion's page. */
  readonly linkCompanion: () => void;
  /** Whether a call she is on is up in the page. */
  readonly feedingCompanion: (on: boolean) => void;
  /** window.ts's windowShows. */
  readonly windowShows: () => boolean;
}

/**
 * The app page's messages and invokes, each taken only from the window's main frame at
 * eidolon-app://app. The theme setting goes to `themeSource` as it is: a resolved theme would pin
 * prefers-color-scheme and stop the page's System from following the OS.
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
  ipcMain.on(BRIDGE.takesCommands, (event) => {
    if (accepts(BRIDGE.takesCommands, ipcSender(event))) bridge.takesCommands();
  });
  ipcMain.on(BRIDGE.unsaved, (event, held: unknown) => {
    if (accepts(BRIDGE.unsaved, ipcSender(event)) && typeof held === "boolean") {
      bridge.unsaved(held);
    }
  });
  ipcMain.on(BRIDGE.linkCompanion, (event) => {
    if (accepts(BRIDGE.linkCompanion, ipcSender(event))) bridge.linkCompanion();
  });
  ipcMain.on(BRIDGE.feedingCompanion, (event, on: unknown) => {
    if (accepts(BRIDGE.feedingCompanion, ipcSender(event)) && typeof on === "boolean") {
      bridge.feedingCompanion(on);
    }
  });
  // A synchronous message keeps the page waiting until it has an answer, so every path answers.
  ipcMain.on(BRIDGE.versions, (event) => {
    event.returnValue = accepts(BRIDGE.versions, ipcSender(event)) ? bridge.versions() : null;
  });
  ipcMain.on(BRIDGE.windowShows, (event) => {
    event.returnValue = accepts(BRIDGE.windowShows, ipcSender(event)) ? bridge.windowShows() : null;
  });
  for (const [channel, answer] of appInvokes(bridge)) {
    // The sender is read before anything awaits: senderFrame turns null once the page navigates.
    ipcMain.handle(channel, (event, argument: unknown) => answer(ipcSender(event), argument));
  }
}

/**
 * Hands the app's page a menu's or a notification's command, such as opening Settings; a shell page
 * has no listener.
 */
export function sendCommand(command: DesktopCommand): void {
  mainWindow()?.webContents.send(BRIDGE.command, command);
}

/**
 * Hands the app page a pick from her menu for its call; a shell page, or none, drops it. Never held
 * as PageCommands holds a command: a call would start on a page that loads later.
 */
export function sendCompanionPick(pick: CompanionCallPick): void {
  mainWindow()?.webContents.send(BRIDGE.companionPick, pick);
}

/** Tells the app page whether its window shows: hidden or minimized, its call draws for no one. */
export function sendWindowShows(shows: boolean): void {
  mainWindow()?.webContents.send(BRIDGE.windowShows, shows);
}
