// The app's one window (§5.1): no system title bar, its bounds kept across launches, closed only by
// a quit. Main keeps whether it shows itself: Electron reports an occluded window as hidden.
import { join } from "node:path";
import { app, BrowserWindow, type IpcMainEvent, nativeTheme, screen } from "electron";
import type { IpcSender } from "../shared/bridge.ts";
import { mainLog } from "./log.ts";
import {
  BOUNDS_FILE,
  backgroundColor,
  chromeOptions,
  MIN_SIZE,
  placement,
  readBounds,
  writeBounds,
} from "./window-options.ts";

const SAVE_AFTER_MS = 500;

let window: BrowserWindow | null = null;
/** Whether the window shows, as main left it: hidden by a close, shown by a launch or a click. */
let shown = false;

/** The window, while it exists: a page's window.close() destroys it, and showWindow() makes another. */
export function mainWindow(): BrowserWindow | null {
  return window !== null && !window.isDestroyed() ? window : null;
}

/** Who sent `event`, for the bridges' sender rule (bridge.ts's accepts). */
export function ipcSender(event: IpcMainEvent): IpcSender {
  const win = mainWindow();
  return {
    window: win !== null && event.sender === win.webContents,
    mainFrame: win !== null && event.senderFrame === win.webContents.mainFrame,
    origin: event.senderFrame?.origin ?? null,
  };
}

function boundsFile(): string {
  return join(app.getPath("userData"), BOUNDS_FILE);
}

function saveBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  try {
    writeBounds(boundsFile(), { ...win.getNormalBounds(), maximized: win.isMaximized() });
  } catch (error) {
    mainLog.warn(`Eidolon: couldn't keep the window's bounds: ${String(error)}`);
  }
}

/** What a new window does besides showing: the rest of main hooks it up here. */
export interface WindowHooks {
  /** Before its first load, so nothing on the page runs unguarded. */
  readonly created: (win: BrowserWindow) => void;
  /** Whether a close hides the window instead: always, but once a quit is under way. */
  readonly hidesOnClose: () => boolean;
  /** After a close hid it. */
  readonly hidOnClose: () => void;
  /** A page gone wrong: a load other than an abort, the preload, or the renderer. */
  readonly failed: (detail: string) => void;
}

/** Hidden until its first page is ready to paint, at the bounds it had last. */
export function createWindow(hooks: WindowHooks): BrowserWindow {
  const saved = placement(
    readBounds(boundsFile()),
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    ...(saved.x === undefined ? {} : { x: saved.x, y: saved.y }),
    width: saved.width,
    height: saved.height,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: "Eidolon",
    backgroundColor: backgroundColor(dark),
    ...chromeOptions(process.platform, dark),
    webPreferences: {
      preload: join(app.getAppPath(), "dist", "preload", "index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  window = win;
  shown = false;
  if (saved.maximized) win.maximize();
  win.once("ready-to-show", () => showWindow());
  win.on("show", () => {
    shown = true;
  });
  // Main owns the title: the page's <title> would name the window after each page.
  win.on("page-title-updated", (event) => event.preventDefault());

  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saveBounds(win);
    }, SAVE_AFTER_MS);
  };
  win.on("resize", later);
  win.on("move", later);
  win.on("close", (event) => {
    if (timer !== null) clearTimeout(timer);
    saveBounds(win);
    if (!hooks.hidesOnClose()) return;
    event.preventDefault();
    hideWindow();
    hooks.hidOnClose();
  });
  win.on("closed", () => {
    if (timer !== null) clearTimeout(timer);
    if (window === win) window = null;
  });

  const contents = win.webContents;
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 is ERR_ABORTED: a load that another replaced, such as main's own next page.
    if (!isMainFrame || code === -3) return;
    hooks.failed(`${description} (${code}) loading ${url}`);
  });
  contents.on("preload-error", (_event, _path, error) => {
    hooks.failed(`the preload failed: ${error.message}`);
  });
  contents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    hooks.failed(`the page's renderer is gone (${details.reason})`);
  });
  contents.on("did-finish-load", () => {
    const url = URL.parse(contents.getURL());
    if (url !== null) {
      mainLog.info(`Eidolon: the window shows ${url.protocol}//${url.host}${url.pathname}`);
    }
  });
  hooks.created(win);
  return win;
}

/** Brings the window forward, from hidden or minimized. */
export function showWindow(): void {
  const win = mainWindow();
  if (win === null) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  shown = true;
}

/**
 * Hides the window, leaving fullscreen first on macOS: a hidden fullscreen window leaves a black
 * Space behind.
 */
export function hideWindow(): void {
  const win = mainWindow();
  if (win === null) return;
  shown = false;
  if (process.platform === "darwin" && win.isFullScreen()) {
    win.once("leave-full-screen", () => {
      if (!win.isDestroyed() && !shown) win.hide();
    });
    win.setFullScreen(false);
    return;
  }
  win.hide();
}
