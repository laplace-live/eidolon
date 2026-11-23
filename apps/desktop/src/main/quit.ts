// Close and quit on Electron: quit-flow.ts's flow on before-quit, the quit check's native box
// with no owner window, macOS's power-off notice, and Windows' session end, which never reaches
// before-quit.
import { app, type BrowserWindow, type NativeImage, powerMonitor } from "electron";
import type { Backend } from "./backend.ts";
import { mainLog } from "./log.ts";
import { native } from "./native.ts";
import { QuitConfirmation } from "./quit-check.ts";
import { QuitFlow } from "./quit-flow.ts";
import type { Strings } from "./strings.ts";
import { hideWindow } from "./window.ts";

export interface QuitOptions {
  readonly backend: Backend;
  readonly strings: () => Strings;
  /** Windows' box takes the app's icon; macOS draws it on its warning icon. */
  readonly icon?: NativeImage;
  /** Once a quit is approved, before the backend stops: the tray icon goes. */
  readonly approved: () => void;
}

export function installQuit(options: QuitOptions): QuitFlow {
  const confirmation = new QuitConfirmation({
    check: () => options.backend.quitCheck(),
    strings: options.strings,
    // No owner window: a hidden window stays hidden, and the box is a window of its own.
    show: (box) => native.messageBox(options.icon ? { ...box, icon: options.icon } : box),
    // macOS raises the open box with the app; Windows gives no handle to its task dialog.
    focus: () => {
      if (process.platform === "darwin") native.stealFocus();
    },
    log: mainLog,
  });
  const flow = new QuitFlow({
    confirm: (purpose) => confirmation.confirm(purpose),
    hideWindows: () => {
      hideWindow();
      options.approved();
    },
    stopBackend: () => options.backend.stop(),
    quit: () => app.quit(),
    log: mainLog,
  });
  app.on("before-quit", (event) => {
    if (!flow.beforeQuit()) event.preventDefault();
  });
  // Shutting down: the quit that follows doesn't ask, until the window has attention again.
  if (process.platform === "darwin") powerMonitor.on("shutdown", () => flow.poweringOff());
  return flow;
}

/** Per window: the end of the owner's session, which only a window hears. */
export function watchSession(win: BrowserWindow, flow: QuitFlow, backend: Backend): void {
  if (process.platform === "win32") {
    // Electron ends the process right after session-end, and before-quit never runs: the stop
    // starts here, and must not block, or Node never closes the channel that is its trigger.
    win.on("query-session-end", () => backend.sessionEnding());
    win.on("session-end", () => {
      flow.sessionEnded();
      backend.sessionEnded();
    });
  } else {
    win.on("focus", () => flow.attention());
    win.on("show", () => flow.attention());
  }
}
