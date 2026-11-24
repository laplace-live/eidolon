// The desktop companion's window on Electron: made, loaded, shown, moved and closed as
// companion-flow.ts asks, and its page's messages to main.
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, screen, type WebContents } from "electron";
import {
  accepts,
  BRIDGE,
  type CompanionCallPick,
  type CompanionDrag,
  type CompanionDrawn,
  type CompanionMenuState,
  type CompanionPick,
  type CompanionShape,
  companionDragOf,
  type DesktopCommand,
  isCompanionDrawn,
  type WindowSize,
} from "../shared/bridge.ts";
import { companionInvokes } from "./app-invokes.ts";
import {
  COMPANION_FILE,
  COMPANION_LINES,
  CURSOR_MS,
  companionWindowSetup,
  writeCompanion,
} from "./companion.ts";
import type { CompanionIo } from "./companion-flow.ts";
import { mainLog } from "./log.ts";
import { native } from "./native.ts";
import { guardCompanionNavigation } from "./navigation.ts";
import { COMPANION_PAGE, loggedUrl } from "./policy.ts";
import { ipcSender } from "./senders.ts";
import { mainWindow } from "./window.ts";
import { type Rectangle, workAreas } from "./window-options.ts";

export interface CompanionWindowEvents {
  /** A main-frame load other than an abort, the preload, or the renderer gone (not a clean exit). */
  failed(detail: string): void;
  /** A new document in her window's main frame (did-navigate). */
  replaced(): void;
  /** Her window closed, by anything but her io's own close. */
  closed(): void;
  /** Her page went with her window, her io's own close included. */
  gone(): void;
}

export interface CompanionWindowDeps {
  readonly events: CompanionWindowEvents;
  readonly background: boolean;
  readonly openMain: () => void;
  readonly hideMain: () => void;
  readonly command: (command: DesktopCommand) => void;
  readonly pick: (pick: CompanionCallPick) => void;
  readonly menus: () => void;
}

/** The io companion-flow.ts drives, and her webContents for the sender rule and the port. */
export function companionWindow(
  deps: CompanionWindowDeps,
): CompanionIo & { contents(): WebContents | null } {
  const setup = companionWindowSetup(process.platform, deps.background);
  let win: BrowserWindow | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  const current = (): BrowserWindow | null => (win !== null && !win.isDestroyed() ? win : null);
  // A failure is did-fail-load's, which decides; a replaced load is no failure.
  const load = (w: BrowserWindow): void => {
    w.loadURL(COMPANION_PAGE).catch(() => {});
  };
  const passClicks = (w: BrowserWindow, pass: boolean): void => {
    w.setIgnoreMouseEvents(pass, pass && setup.forwards ? { forward: true } : undefined);
  };
  const stopCursor = (): void => {
    if (poll !== null) clearInterval(poll);
    poll = null;
  };

  function make(bounds: Rectangle): BrowserWindow {
    const w = new BrowserWindow({
      ...setup.options,
      ...bounds,
      webPreferences: {
        ...setup.options.webPreferences,
        preload: join(app.getAppPath(), "dist", "preload", "index.cjs"),
      },
    });
    win = w;
    if (process.platform === "darwin") w.excludedFromShownWindowsMenu = true;
    passClicks(w, true);
    if (setup.allSpaces) {
      // Without the skip, macOS turns the app into a foreground one and back, and the Dock flickers.
      w.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    }
    const contents = w.webContents;
    // Nothing of a window her io has closed reaches the flow, which may have made another since.
    const own = (): boolean => win === w;
    guardCompanionNavigation(contents, {
      log: mainLog,
      strayed: () => {
        if (own()) load(w);
      },
    });
    w.on("page-title-updated", (event) => event.preventDefault());
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED: a load that another replaced, such as main's own next one.
      if (!own() || !isMainFrame || code === -3) return;
      deps.events.failed(`${description} (${code}) loading ${loggedUrl(url)}`);
    });
    contents.on("preload-error", (_event, _path, error) => {
      if (own()) deps.events.failed(`the preload failed: ${error.message}`);
    });
    contents.on("render-process-gone", (_event, details) => {
      if (!own() || details.reason === "clean-exit") return;
      deps.events.failed(`the page's renderer is gone (${details.reason})`);
    });
    contents.on("did-navigate", () => {
      if (own()) deps.events.replaced();
    });
    contents.on("did-finish-load", () => {
      mainLog.info(`Eidolon: the companion loaded ${loggedUrl(contents.getURL())}`);
    });
    // No close handler: nothing of hers vetoes a close, so a quit and an update's restart close her.
    w.on("closed", () => {
      mainLog.info(COMPANION_LINES.closed);
      if (!own()) return;
      win = null;
      stopCursor();
      deps.events.gone();
      deps.events.closed();
    });
    return w;
  }

  return {
    open(bounds) {
      load(current() ?? make(bounds));
    },
    close() {
      const w = current();
      if (w === null) return;
      win = null;
      stopCursor();
      // Now, not at its closed, which can come after the page of a window made since has asked.
      deps.events.gone();
      w.close();
    },
    show() {
      current()?.showInactive();
    },
    hide() {
      current()?.hide();
    },
    bounds() {
      return current()?.getBounds() ?? null;
    },
    setBounds({ x, y, width, height }) {
      current()?.setBounds({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      });
    },
    setAlwaysOnTop(on) {
      current()?.setAlwaysOnTop(on, "floating");
    },
    passClicks(pass) {
      const w = current();
      if (w !== null) passClicks(w, pass);
    },
    cursor(on) {
      stopCursor();
      if (!on) return;
      let last: { readonly x: number; readonly y: number } | null = null;
      poll = setInterval(() => {
        const w = current();
        if (w === null) {
          stopCursor();
          return;
        }
        const point = screen.getCursorScreenPoint();
        const bounds = w.getBounds();
        const cursor = { x: point.x - bounds.x, y: point.y - bounds.y };
        if (last !== null && last.x === cursor.x && last.y === cursor.y) return;
        last = cursor;
        w.webContents.send(BRIDGE.companionCursor, cursor);
      }, CURSOR_MS);
    },
    throttle(allowed) {
      mainWindow()?.webContents.setBackgroundThrottling(allowed);
    },
    areas() {
      return workAreas(screen.getPrimaryDisplay(), screen.getAllDisplays());
    },
    displays() {
      return screen.getAllDisplays().map((display) => display.bounds);
    },
    save(settings) {
      try {
        writeCompanion(join(app.getPath("userData"), COMPANION_FILE), settings);
      } catch (error) {
        mainLog.warn(`Eidolon: couldn't keep the companion's settings: ${String(error)}`);
      }
    },
    popup(items) {
      const w = current();
      if (w === null) return Promise.resolve();
      // The focused window is popup's default, and hers never is one.
      return new Promise((done) => native.popup(items, { window: w, callback: () => done() }));
    },
    menus: deps.menus,
    openMain: deps.openMain,
    hideMain: deps.hideMain,
    command: deps.command,
    pick: deps.pick,
    after(ms, run) {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    log: mainLog,
    contents() {
      return current()?.webContents ?? null;
    },
  };
}

export interface CompanionBridge {
  readonly linkApp: () => void;
  readonly hit: (over: boolean) => void;
  readonly drag: (drag: CompanionDrag) => void;
  readonly drawn: (drawn: CompanionDrawn | null) => void;
  readonly follow: (on: boolean) => void;
  readonly shape: (shape: CompanionShape) => WindowSize;
  readonly menu: (state: CompanionMenuState) => Promise<CompanionPick | null>;
}

/** Her page's messages and invokes, each taken only from her window's main frame at eidolon-app://app. */
export function handleCompanionBridge(bridge: CompanionBridge): void {
  ipcMain.on(BRIDGE.linkApp, (event) => {
    if (accepts(BRIDGE.linkApp, ipcSender(event))) bridge.linkApp();
  });
  ipcMain.on(BRIDGE.companionHit, (event, over: unknown) => {
    if (accepts(BRIDGE.companionHit, ipcSender(event)) && typeof over === "boolean") {
      bridge.hit(over);
    }
  });
  ipcMain.on(BRIDGE.companionDrag, (event, value: unknown) => {
    if (!accepts(BRIDGE.companionDrag, ipcSender(event))) return;
    const drag = companionDragOf(value);
    if (drag !== null) bridge.drag(drag);
  });
  ipcMain.on(BRIDGE.companionDrawn, (event, drawn: unknown) => {
    if (accepts(BRIDGE.companionDrawn, ipcSender(event)) && isCompanionDrawn(drawn)) {
      bridge.drawn(drawn);
    }
  });
  ipcMain.on(BRIDGE.companionFollow, (event, on: unknown) => {
    if (accepts(BRIDGE.companionFollow, ipcSender(event)) && typeof on === "boolean") {
      bridge.follow(on);
    }
  });
  for (const [channel, answer] of companionInvokes(bridge)) {
    // The sender is read before anything awaits: senderFrame turns null once the page navigates.
    ipcMain.handle(channel, (event, argument: unknown) => answer(ipcSender(event), argument));
  }
}
