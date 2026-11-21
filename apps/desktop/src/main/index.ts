// The desktop app's main process: the profile and the single-instance lock first, then the scheme,
// and once Electron is ready, the window on the loading page.
import "./instance.ts";
import { app, type BrowserWindow } from "electron";
import { isLaunchRequest, primary, request } from "./instance.ts";
import { handleScheme, LOADING_PAGE, registerScheme } from "./protocol.ts";
import { createWindow } from "./window.ts";

/** NSIS gives the Start menu shortcut appId as its AppUserModelID. */
const APP_USER_MODEL_ID = "live.laplace.eidolon";

let mainWindow: BrowserWindow | null = null;

/** Brings the window forward from hidden or minimized, or opens it again once it's gone. */
function showWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    mainWindow.loadURL(LOADING_PAGE).catch((error: unknown) => {
      console.error("Eidolon: the loading page didn't load", error);
    });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

if (!primary || request.command === "quit") {
  // The running instance got this launch's request. A --quit with none running has nothing to quit.
  app.exit(0);
} else {
  registerScheme();
  // Before any window: Electron's own default, electron.app.Eidolon, isn't the shortcut's.
  if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);
  app.on("second-instance", (_event, _argv, _cwd, data) => {
    if (isLaunchRequest(data) && data.command === "quit") app.quit();
    else showWindow();
  });
  void app.whenReady().then(() => {
    handleScheme();
    showWindow();
  });
}
