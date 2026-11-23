// The desktop app's main process, in this order: the profile, the logs and the single-instance
// lock first (instance.ts), then the scheme; once Electron is ready, the session's guards and the
// scheme's handler, the window on the loading page (none at a launch at login), and then the
// environment and the backend, which the window and the task notifications follow.
import "./instance.ts";
import { join } from "node:path";
import { type AboutPanelOptionsOptions, app, nativeImage, session } from "electron";
import { type Language, pageAt } from "../shared/bridge.ts";
import { dataHome } from "./attach.ts";
import { Backend, licensesFile } from "./backend.ts";
import { BACKGROUND_LINE, backendPort, hasTray } from "./background.ts";
import { dressWindow, handleAppBridge, sendCommand } from "./chrome.ts";
import type { AppPaths } from "./controller.ts";
import { folderDialogOptions, joinPending } from "./folder-dialog.ts";
import { APP_ORIGIN, DEV_SERVER } from "./forwarder.ts";
import { background, isLaunchRequest, primary, refused, request } from "./instance.ts";
import { backendLog, logStart, logsFolder, mainLog } from "./log.ts";
import { attachContextMenu, setApplicationMenu } from "./menu.ts";
import { aboutPanel, type TrayActions, type UpdatesItem, updatesItem } from "./menus.ts";
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
import type { BackendFetch } from "./quit-check.ts";
import { HideNotice } from "./quit-flow.ts";
import { STRINGS, shellLanguage } from "./strings.ts";
import {
  loginItemQuery,
  loginItemState,
  loginItemWrite,
  openedAtLogin,
  optionsUnavailable,
} from "./system-options.ts";
import {
  followBackend,
  type Notice,
  noticeCommand,
  noticeText,
  TaskWatch,
} from "./task-notices.ts";
import { type CommandHost, changeCommand, commandState } from "./terminal-command.ts";
import { AppTray, trayIconPath } from "./tray.ts";
import { isUpdatableInstall, type UpdateFlow } from "./update-flow.ts";
import { installUpdater } from "./updater.ts";
import { createWindow, mainWindow, showWindow } from "./window.ts";

/** NSIS gives the Start menu shortcut appId as its AppUserModelID. */
const APP_USER_MODEL_ID = "live.laplace.eidolon";
/**
 * Windows' toast activator, pinned: Electron otherwise makes one up whenever the Start menu shortcut
 * has none, as after each update rewrites it, and registers each under HKCU for good.
 */
const TOAST_ACTIVATOR_CLSID = "{75F1E873-F478-41C1-9698-DBCAB1E2A111}";
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
  const installedCopy = isUpdatableInstall(
    process.platform,
    process.execPath,
    process.env.LOCALAPPDATA,
  );
  /** Why this copy can't offer Open at Login and the terminal command, or null when it can. */
  const unavailable = optionsUnavailable({
    background,
    packaged: app.isPackaged,
    platform: process.platform,
    inApplications: process.platform === "darwin" && app.isInApplicationsFolder(),
    installedCopy,
  });
  // Background mode only logs each notice. On Windows any copy but the installed one would point the
  // installed app's Start menu shortcut and its COM key at itself.
  const notifies =
    background || (app.isPackaged && (process.platform !== "win32" || installedCopy));
  if (notifies && !background && process.platform === "win32") {
    app.setToastActivatorCLSID(TOAST_ACTIVATOR_CLSID);
  }
  let tray: AppTray | null = null;
  let hideNotice: HideNotice | null = null;
  let updates: UpdateFlow | null = null;
  /** Check for Updates… as the menus have it. */
  let menuUpdates: UpdatesItem = "hidden";
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
    port: backendPort(background),
    waitingPage: () => {
      pages.waited();
      return waitingPage(shellPageStrings(language(), strings()));
    },
  });
  const backendFetch: BackendFetch = (path, { signal }) => backend.get(path, signal);
  let noticeFailed = false;
  const watch = notifies
    ? new TaskWatch({
        fetch: backendFetch,
        focused: () => mainWindow()?.isFocused() === true,
        show: (notice) => {
          const { title, body } = noticeText(notice, strings());
          return native.notify(
            { title, body },
            {
              click: () => openNotice(notice),
              failed: (error) => {
                if (noticeFailed) return;
                noticeFailed = true;
                mainLog.warn(`Eidolon: a notification failed: ${error}`);
              },
            },
          );
        },
        log: mainLog,
      })
    : null;
  const commandHost: CommandHost = {
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    unavailable,
    strings,
    log: mainLog,
  };
  const chooseFolder = joinPending(() =>
    native.chooseFolder(mainWindow(), folderDialogOptions(strings(), app.getPath("home"))),
  );
  const readLoginItem = () => app.getLoginItemSettings(loginItemQuery(process.platform));
  const icon =
    process.platform === "win32" ? nativeImage.createFromPath(trayIconPath()) : undefined;
  const flow = installQuit({
    backend,
    strings,
    icon,
    approved: () => {
      watch?.stop();
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
    checkForUpdates: () => updates?.checkByHand(),
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

  /** The application menu and the tray's, in the shell's language, as the updater stands. */
  function setMenus(): void {
    menuUpdates = updates === null ? "hidden" : updatesItem(updates.state.phase);
    setApplicationMenu(strings(), actions, menuUpdates);
    tray?.relabel(strings(), menuUpdates);
  }

  function languageChanged(next: Language): void {
    const before = language();
    reported = next;
    if (language() === before) return;
    setMenus();
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

  /** A notification's click: the window, then its task, as noticeCommand decides. */
  function openNotice(notice: Notice): void {
    openWindow();
    noticeCommand(notice, backendFetch).then(
      (command) => {
        if (command !== null) commands.send(command);
      },
      (error: unknown) => {
        mainLog.warn(`Eidolon: couldn't open the task a notification named: ${String(error)}`);
      },
    );
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
      if (watch === null) mainLog.info("Eidolon: notifications are off in this copy of the app");
      updates = installUpdater({
        quit: flow,
        strings,
        version,
        icon,
        // A download's progress leaves the item as it is.
        changed: (state) => {
          if (updatesItem(state.phase) !== menuUpdates) setMenus();
        },
      });
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
        chooseFolder,
        loginItem: () => loginItemState(process.platform, unavailable, readLoginItem),
        // The write returns nothing and only logs a failure, so the state is read again after it.
        setLoginItem: (on) =>
          loginItemState(process.platform, unavailable, () => {
            app.setLoginItemSettings(loginItemWrite(process.platform, on));
            mainLog.info(`Eidolon: Open at Login was turned ${on ? "on" : "off"}`);
            return readLoginItem();
          }),
        terminalCommand: () => commandState(commandHost),
        setTerminalCommand: (action) => changeCommand(commandHost, action),
      });
      setMenus();
      setAbout();
      if (hasTray(process.platform, background)) {
        tray = new AppTray(strings(), actions, menuUpdates);
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
      const watchFollows = watch === null ? null : followBackend(watch);
      backend.subscribe((state) => {
        pages.backend(state);
        watchFollows?.(state);
        if (state.phase !== "ready") return;
        setAbout();
        updates?.backendReady();
      });
      started = true;
      // Background mode reads no login item.
      const atLogin =
        !background &&
        openedAtLogin(
          process.platform,
          process.argv,
          app.getLoginItemSettings().wasOpenedAtLogin === true,
        );
      // The Dock, the tray, a second launch, a menu item or a notification's click makes one.
      if (atLogin) mainLog.info("Eidolon: opened at login, so no window until one is asked for");
      else newWindow();
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
