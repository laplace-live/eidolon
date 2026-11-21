// The desktop app's main process, in this order: the profile, the logs and the single-instance
// lock first (instance.ts), then the scheme; once Electron is ready, the session's guards and the
// scheme's handler, the window on the loading page, and then the environment and the backend, which
// the window follows.
import "./instance.ts";
import { join } from "node:path";
import { type AboutPanelOptionsOptions, app, nativeImage, session } from "electron";
import { type Language, pageAt } from "../shared/bridge.ts";
import { dataHome } from "./attach.ts";
import { Backend, licensesFile } from "./backend.ts";
import { BACKGROUND_LINE, hasTray } from "./background.ts";
import { dressWindow, handleAppBridge, sendCommand } from "./chrome.ts";
import type { AppPaths } from "./controller.ts";
import { APP_ORIGIN, DEV_SERVER } from "./forwarder.ts";
import { background, isLaunchRequest, primary, refused, request } from "./instance.ts";
import { backendLog, logStart, logsFolder, mainLog } from "./log.ts";
import { attachContextMenu, setApplicationMenu } from "./menu.ts";
import { aboutPanel, type TrayActions } from "./menus.ts";
import { native, saveDownloads } from "./native.ts";
import { guardNavigation } from "./navigation.ts";
import {
  failurePage,
  PageCommands,
  shellPageStrings,
  type WindowPage,
  WindowPages,
} from "./pages.ts";
import { guardPermissions } from "./permissions.ts";
import {
  FAILED_PAGE,
  handleScheme,
  handleShellBridge,
  LOADING_PAGE,
  registerScheme,
  waitingPage,
} from "./protocol.ts";
import { installQuit, watchSession } from "./quit.ts";
import { HideNotice } from "./quit-flow.ts";
import { STRINGS, shellLanguage } from "./strings.ts";
import { AppTray, trayIconPath } from "./tray.ts";
import { createWindow, mainWindow, showWindow } from "./window.ts";

/** NSIS gives the Start menu shortcut appId as its AppUserModelID. */
const APP_USER_MODEL_ID = "live.laplace.eidolon";
/** dev.ts's switch: Vite serves every path but the backend's. Unpackaged runs only. */
const DEV_SWITCH = "eidolon-dev-server";
/** In userData: the Windows tray notice has shown. */
const TRAY_NOTICE_MARKER = "tray-notice-shown";

function open(path: string): void {
  native.openPath(path).then(
    (error) => {
      if (error !== "") mainLog.warn(`Eidolon: couldn't open ${path}: ${error}`);
    },
    (error: unknown) => mainLog.warn(`Eidolon: couldn't open ${path}: ${String(error)}`),
  );
}

function run(): void {
  // Unpackaged, Electron's own version would stand in for the app's.
  const version = app.isPackaged ? app.getVersion() : "0.0.0-dev";
  const paths: AppPaths = {
    packaged: app.isPackaged,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  };
  let reported: Language | null = null;
  const language = () => shellLanguage(reported, app.getPreferredSystemLanguages());
  const strings = () => STRINGS[language()];
  let tray: AppTray | null = null;
  let hideNotice: HideNotice | null = null;
  /** The scheme and the session's guards are in place, so a window may load. */
  let started = false;

  const pages = new WindowPages({
    load: (page) => load(page),
    reloadApp: () => {
      const url = mainWindow()?.webContents.getURL() ?? "";
      loadUrl(pageAt(url) === "app" ? url : `${APP_ORIGIN}/`);
    },
    serverVersion: () => backend.serverVersion,
  });
  const commands = new PageCommands((command) => sendCommand(command));
  const backend = new Backend({
    app: paths,
    env: process.env,
    log: mainLog,
    backendLog: (line) => backendLog.info(line),
    devServer: !app.isPackaged && app.commandLine.hasSwitch(DEV_SWITCH) ? DEV_SERVER : undefined,
    waitingPage: () => {
      pages.waited();
      return waitingPage(shellPageStrings(language(), strings()));
    },
  });
  const icon =
    process.platform === "win32" ? nativeImage.createFromPath(trayIconPath()) : undefined;
  const flow = installQuit({
    backend,
    strings,
    icon,
    approved: () => {
      tray?.destroy();
      tray = null;
    },
  });

  const actions: TrayActions = {
    open: () => openWindow(),
    settings: () => {
      openWindow();
      commands.send("settings");
    },
    showLogs: () => open(logsFolder()),
    openDataFolder: () => open(backend.home ?? dataHome(process.env)),
    licenses: () => open(licensesFile(paths)),
    about: () => native.aboutPanel(aboutOptions()),
    quit: () => app.quit(),
  };

  function loadUrl(url: string): void {
    // A failed load is did-fail-load's, which decides; a replaced one is no failure.
    mainWindow()
      ?.loadURL(url)
      .catch(() => {});
  }

  function load(page: WindowPage): void {
    loadUrl(page === "app" ? `${APP_ORIGIN}/` : page === "failed" ? FAILED_PAGE : LOADING_PAGE);
  }

  function aboutOptions(): AboutPanelOptionsOptions {
    const versions = { version, serverVersion: backend.serverVersion };
    return aboutPanel(process.platform, versions, strings(), trayIconPath());
  }

  function setAbout(): void {
    app.setAboutPanelOptions(aboutOptions());
  }

  function languageChanged(next: Language): void {
    const before = language();
    reported = next;
    if (language() === before) return;
    setApplicationMenu(strings(), actions);
    tray?.relabel(strings());
    setAbout();
  }

  function newWindow(): void {
    createWindow({
      created: (win) => {
        guardNavigation(win.webContents, {
          log: mainLog,
          openExternal: (url) => native.openExternal(url),
          strayed: () => pages.strayed(),
        });
        // At the commit of a new document, before its script can say it listens.
        win.webContents.on("did-navigate", () => commands.replaced());
        attachContextMenu(win.webContents, strings);
        dressWindow(win);
        watchSession(win, flow, backend);
      },
      hidesOnClose: () => flow.closeHides(),
      hidOnClose: () => hideNotice?.hidden(),
      failed: (detail) => {
        if (flow.quitting) return;
        mainLog.error(`Eidolon: ${detail}`);
        pages.window(detail);
      },
    });
    commands.replaced();
    pages.opened(backend.state);
  }

  /** Shows the window, from hidden or minimized, or makes it again after the page closed it. */
  function openWindow(): void {
    if (!started || flow.quitting) return;
    if (mainWindow() === null) newWindow();
    showWindow();
  }

  app.on("second-instance", (_event, _argv, _cwd, data) => {
    if (isLaunchRequest(data) && data.command === "quit") app.quit();
    else openWindow();
  });
  app.on("activate", () => openWindow());
  // A page's window.close() destroys the window with no close event; the app stays, for the Dock,
  // the tray or a second launch to make another.
  app.on("window-all-closed", () => {});

  void app
    .whenReady()
    .then(async () => {
      logStart(version);
      if (background) mainLog.info(BACKGROUND_LINE);
      // Before the first load: with no handlers, Electron grants every request.
      guardPermissions(session.defaultSession, {
        isWindow: (contents) => contents !== null && contents === mainWindow()?.webContents,
        strings,
      });
      saveDownloads(session.defaultSession);
      handleScheme(
        {
          strings: () => shellPageStrings(language(), strings()),
          failure: () => failurePage(pages.failure ?? { kind: "window", detail: "" }, strings()),
        },
        (request) => backend.handle(request),
      );
      handleShellBridge({
        retry: () => {
          if (pages.retry(backend.state)) backend.retry();
        },
        showLogs: actions.showLogs,
        quit: actions.quit,
      });
      handleAppBridge({
        versions: () => ({ version, serverVersion: backend.serverVersion }),
        language: languageChanged,
        takesCommands: () => commands.listening(),
      });
      setApplicationMenu(strings(), actions);
      setAbout();
      if (hasTray(process.platform, background)) {
        tray = new AppTray(strings(), actions);
        hideNotice = new HideNotice({
          marker: join(app.getPath("userData"), TRAY_NOTICE_MARKER),
          show: () => {
            const { label, text } = strings();
            return native.messageBox({
              type: "none",
              title: "Eidolon",
              message: text.hideNoticeTitle,
              detail: text.hideNotice,
              buttons: [label.ok],
              noLink: true,
              icon,
            });
          },
          log: mainLog,
        });
      }
      backend.subscribe((state) => {
        pages.backend(state);
        if (state.phase === "ready") setAbout();
      });
      started = true;
      newWindow();
      await backend.start();
    })
    .catch((error: unknown) => {
      mainLog.error(`Eidolon: the app failed to start: ${String(error)}`);
      pages.window(`the app failed to start: ${String(error)}`);
    });
}

if (!refused) {
  // The running instance got this launch's request. A --quit with none running has nothing to quit.
  if (!primary || request.command === "quit") app.exit(0);
  else {
    registerScheme();
    // Before any window: Electron's own default, electron.app.Eidolon, isn't the shortcut's.
    if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);
    run();
  }
}
