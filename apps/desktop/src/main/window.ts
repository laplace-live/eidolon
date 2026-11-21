// The app's one window, with no system title bar: the page draws its own, beside the system's window
// controls.
import { join } from "node:path";
import { app, BrowserWindow, type BrowserWindowConstructorOptions, nativeTheme } from "electron";

/** apps/web's sidebar header row, whose middle the traffic lights sit on. */
const SIDEBAR_ROW_PX = 52;
/** apps/web's page header row, which Windows' caption buttons fill. */
const HEADER_ROW_PX = 56;
/** The traffic lights' height, as `trafficLightPosition` places them. */
const TRAFFIC_LIGHTS_PX = 16;

/** The caption buttons' glyphs, which Windows draws in the colour it's given. */
function symbolColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#ffffff" : "#1f1f1f";
}

function chrome(): BrowserWindowConstructorOptions {
  if (process.platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: (SIDEBAR_ROW_PX - TRAFFIC_LIGHTS_PX) / 2 },
      // Without it macOS publishes no env(titlebar-area-*) for the page's insets.
      titleBarOverlay: true,
    };
  }
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#00000000", symbolColor: symbolColor(), height: HEADER_ROW_PX },
  };
}

/** Shown once its first page is ready to paint. */
export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 520,
    minHeight: 600,
    show: false,
    title: "Eidolon",
    ...chrome(),
    webPreferences: {
      preload: join(app.getAppPath(), "dist", "preload", "index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  return win;
}
