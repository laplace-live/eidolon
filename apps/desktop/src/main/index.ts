// The desktop app's main process, in this order: the profile, the logs and the single-instance
// lock first (instance.ts), then the scheme; once Electron is ready, the session's guards and the
// scheme's handler, the window on the loading page (hidden at a launch at login), and then the
// environment and the backend, which the window, the desktop companion and the task notifications
// follow.
import "./instance.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AboutPanelOptionsOptions,
  app,
  MessageChannelMain,
  nativeImage,
  screen,
  session,
} from "electron";
import { BRIDGE, type DesktopCommand, type Language, pageAt } from "../shared/bridge.ts";
import { dataHome } from "./attach.ts";
import { NotificationAvatarCache } from "./avatar-cache.ts";
import { Backend, licensesFile } from "./backend.ts";
import {
  BACKGROUND_LINE,
  backendPort,
  type DesktopNotice,
  hasHideNotice,
  hasTray,
  type NoticeEvents,
  type NoticeHandle,
} from "./background.ts";
import { type ChatNotice, ChatWatch, chatNoticeCommand } from "./chat-notices.ts";
import {
  dressWindow,
  handleAppBridge,
  sendCommand,
  sendCompanionPick,
  sendUpdateState,
  sendWindowShows,
} from "./chrome.ts";
import { COMPANION_FILE, readCompanion } from "./companion.ts";
import { Companion, CompanionLink } from "./companion-flow.ts";
import { companionWindow, handleCompanionBridge } from "./companion-window.ts";
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
  PageUnloads,
  shellPageStrings,
  type WindowPage,
  WindowPages,
} from "./pages.ts";
import { guardPermissions } from "./permissions.ts";
import { TRAY_NOTICE_MARKER } from "./profile.ts";
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
import { senderWindow } from "./senders.ts";
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
import { FallbackUpdateBoxes, isUpdatableInstall, type UpdateFlow } from "./update-flow.ts";
import { installUpdater } from "./updater.ts";
import {
  createWindow,
  hideWindow,
  mainWindow,
  onWindowShows,
  showWindow,
  windowShows,
} from "./window.ts";

/** NSIS gives the Start menu shortcut appId as its AppUserModelID. */
const APP_USER_MODEL_ID = "live.laplace.eidolon";
/**
 * Windows' toast activator, pinned: Electron otherwise makes one up whenever the Start menu shortcut
 * has none, as after each update rewrites it, and registers each under HKCU for good.
 */
const TOAST_ACTIVATOR_CLSID = "{75F1E873-F478-41C1-9698-DBCAB1E2A111}";
/** dev.ts's switch: Vite serves every path but the backend's. Unpackaged runs only. */
const DEV_SWITCH = "eidolon-dev-server";
/** A model's rig in its folder, as the server names it (RIG_FILE in apps/bot/src/local/appearance.ts). */
const MODEL_FILE = "model.p2lrt";

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
  let fallbackUpdates: FallbackUpdateBoxes | null = null;
  /** The scheme and the session's guards are in place, so a window may load. */
  let started = false;
  /** A login launch holds the updater's launch check until the window shows. */
  let updatesHeld = false;

  const pages = new WindowPages({
    load: (page) => {
      load(page);
      if (page === "app") companion?.appPage();
      else companion?.shellPage();
    },
    reloadApp: () => {
      const url = mainWindow()?.webContents.getURL() ?? "";
      loadUrl(pageAt(url) === "app" ? url : `${APP_ORIGIN}/`);
      companion?.appPage();
    },
    serverVersion: () => backend.serverVersion,
  });
  const commands = new PageCommands(
    (command) => sendCommand(command),
    () => void fallbackUpdates?.checkByHand(),
  );
  const useFallbackUpdater = (): boolean =>
    !background &&
    !flow.quitting &&
    !commands.hasUpdater &&
    (commands.isListening || pages.failure !== null);
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
  const hostMismatches = new Map<string, number>();
  const backendFetch = async (
    path: string,
    { signal, expectedHost }: { readonly signal: AbortSignal; readonly expectedHost?: string },
  ) => {
    const response = await backend.get(
      path,
      signal,
      expectedHost !== undefined ? { expectedHost } : undefined,
    );
    if (response.status === 409 && expectedHost !== undefined) {
      hostMismatches.set(expectedHost, (hostMismatches.get(expectedHost) ?? 0) + 1);
    }
    return response;
  };
  const avatarCache =
    notifies && !background
      ? new NotificationAvatarCache({
          folder: join(app.getPath("userData"), "notification-avatars"),
          fetch: backendFetch,
          log: mainLog,
        })
      : null;
  let noticeFailed = false;
  const noticeEvents = (click: () => void): NoticeEvents => ({
    click,
    failed: (error) => {
      if (noticeFailed) return;
      noticeFailed = true;
      mainLog.warn(`Eidolon: a notification failed: ${error}`);
    },
  });
  const showAsyncNotice = (
    build: (signal: AbortSignal) => Promise<DesktopNotice | null>,
    events: NoticeEvents,
  ): NoticeHandle => {
    const controller = new AbortController();
    let inner: NoticeHandle | null = null;
    let closed = false;
    void build(controller.signal)
      .then((built) => {
        if (closed || built === null || mainWindow()?.isFocused() === true) return;
        inner = native.notify(built, events);
        if (closed) {
          inner?.close();
          inner = null;
        }
      })
      .catch((error) => {
        if (!closed && !controller.signal.aborted) {
          mainLog.warn(`Eidolon: couldn't prepare a notification: ${String(error)}`);
        }
      });
    return {
      close() {
        if (closed) return;
        closed = true;
        controller.abort();
        inner?.close();
        inner = null;
      },
    };
  };
  const buildDesktopNotice = (params: {
    readonly title: string;
    readonly body: string;
    readonly chat: string | null;
    readonly senderId: string | null;
    readonly senderName: string;
    readonly groupTitle: string | null;
    readonly avatarPath: string | null;
  }): DesktopNotice => {
    const { title, body, chat, senderId, senderName, groupTitle, avatarPath } = params;
    const withAvatar = avatarPath !== null ? { avatarPath } : {};
    if (groupTitle !== null && chat !== null) {
      return {
        title: groupTitle,
        subtitle: title,
        body,
        threadId: chat,
        ...(senderId !== null ? { sender: { id: senderId, name: senderName } } : {}),
        group: { id: chat, title: groupTitle, ...withAvatar },
      };
    }
    return {
      title,
      body,
      ...(chat !== null ? { threadId: chat } : {}),
      ...(senderId !== null ? { sender: { id: senderId, name: senderName, ...withAvatar } } : {}),
    };
  };
  const chatWatch: ChatWatch | null = notifies
    ? new ChatWatch({
        fetch: backendFetch,
        focused: () => mainWindow()?.isFocused() === true,
        strings,
        show: (notice) => {
          const events = noticeEvents(() => openChatNotice(notice));
          const toDesktopNotice = (avatarPath: string | null) =>
            buildDesktopNotice({
              title: notice.speakerName,
              body: notice.body,
              chat: notice.chat,
              senderId: notice.speakerId,
              senderName: notice.speakerName,
              groupTitle: notice.groupTitle,
              avatarPath,
            });
          if (avatarCache === null) return native.notify(toDesktopNotice(null), events);
          const noticeHost = chatWatch?.host;
          const mismatchBefore = noticeHost != null ? (hostMismatches.get(noticeHost) ?? 0) : 0;
          return showAsyncNotice(async (signal) => {
            const avatarPath = await avatarCache.resolve(
              notice.speakerId,
              notice.groupPeers,
              signal,
              noticeHost,
            );
            if (
              noticeHost != null &&
              (chatWatch?.host !== noticeHost ||
                (hostMismatches.get(noticeHost) ?? 0) !== mismatchBefore)
            ) {
              return null;
            }
            return toDesktopNotice(avatarPath);
          }, events);
        },
        log: mainLog,
      })
    : null;
  const watch: TaskWatch | null = notifies
    ? new TaskWatch({
        fetch: backendFetch,
        focused: () => mainWindow()?.isFocused() === true,
        show: (notice) => {
          const { title, body } = noticeText(notice, strings());
          const events = noticeEvents(() => openNotice(notice));
          const toDesktopNotice = (groupTitle: string | null, avatarPath: string | null) =>
            buildDesktopNotice({
              title,
              body,
              chat: notice.chat,
              senderId: notice.personaId,
              senderName: title,
              groupTitle,
              avatarPath,
            });
          if (avatarCache === null || notice.personaId === null) {
            return native.notify(
              avatarCache === null ? { title, body } : toDesktopNotice(null, null),
              events,
            );
          }
          const personaId = notice.personaId;
          const noticeHost = watch?.host;
          const mismatchBefore = noticeHost != null ? (hostMismatches.get(noticeHost) ?? 0) : 0;
          const hostSwitched = () =>
            noticeHost != null &&
            (watch?.host !== noticeHost ||
              (hostMismatches.get(noticeHost) ?? 0) !== mismatchBefore);
          return showAsyncNotice(async (signal) => {
            const groupInfo =
              notice.chat !== null
                ? ((await chatWatch?.groupFor(notice.chat, personaId, noticeHost)) ?? null)
                : null;
            if (hostSwitched()) return null;
            const avatarPath = await avatarCache.resolve(
              personaId,
              groupInfo?.groupPeers ?? [],
              signal,
              noticeHost,
            );
            if (hostSwitched()) return null;
            return toDesktopNotice(groupInfo?.groupTitle ?? null, avatarPath);
          }, events);
        },
        log: mainLog,
      })
    : null;
  const chooseFolder = joinPending(() =>
    native.chooseFolder(mainWindow(), folderDialogOptions(strings(), app.getPath("home"))),
  );
  const readLoginItem = () => app.getLoginItemSettings(loginItemQuery(process.platform));
  const icon =
    process.platform === "win32" ? nativeImage.createFromPath(trayIconPath()) : undefined;
  const flow = installQuit({
    backend,
    unsaved: () => unloads.unsaved,
    strings,
    icon,
    approved: () => {
      chatWatch?.stop();
      watch?.stop();
      companion?.quit();
      tray?.destroy();
      tray = null;
    },
  });
  const unloads = new PageUnloads(() => flow.quitting);

  const actions: TrayActions = {
    open: () => openWindow(),
    settings: () => {
      openWindow();
      commands.send("settings");
    },
    checkForUpdates: () => {
      openWindow();
      if (useFallbackUpdater()) void fallbackUpdates?.checkByHand();
      else commands.send("check-updates");
    },
    showLogs: () => open(logsFolder()),
    openDataFolder: () => open(backend.home ?? dataHome(process.env)),
    licenses: () => open(licensesFile(paths)),
    about: () => native.aboutPanel(aboutOptions()),
    companion: (on) => companion?.setOn(on),
    quit: () => app.quit(),
  };
  /** The desktop companion's flow, from the moment Electron is ready. */
  let companion: Companion | null = null;
  const link = new CompanionLink(pairPorts);
  const herWindow = companionWindow({
    events: {
      failed: (detail) => companion?.failed(detail),
      replaced: () => {
        link.companionGone();
        companion?.pageReplaced();
      },
      gone: () => link.companionGone(),
      closed: () => companion?.closed(),
    },
    background,
    openMain: () => openWindow(),
    hideMain: () => hideWindow(),
    command: (command) => commands.send(command),
    pick: (pick) => sendCompanionPick(pick),
    menus: () => setMenus(),
  });
  senderWindow("main", () => mainWindow()?.webContents ?? null);
  senderWindow("companion", () => herWindow.contents());

  /** Hands the app page and hers each an end of a new channel; main never reads it. */
  function pairPorts(): void {
    const main = mainWindow()?.webContents;
    const her = herWindow.contents();
    if (main === undefined || her === null) return;
    const { port1, port2 } = new MessageChannelMain();
    main.postMessage(BRIDGE.companionPort, null, [port1]);
    her.postMessage(BRIDGE.companionPort, null, [port2]);
  }

  function loadUrl(url: string): void {
    const win = mainWindow();
    // A failed load is did-fail-load's, which decides; a replaced one is no failure.
    if (win !== null) unloads.mainLoad(() => win.loadURL(url)).catch(() => {});
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

  const menuUpdates = (): UpdatesItem =>
    updates === null ? "hidden" : updatesItem(updates.state.phase);

  /**
   * The application menu and the tray's, in the shell's language, as the updater stands and with
   * the desktop companion's checkbox as she is.
   */
  function setMenus(): void {
    const updatesMenu = menuUpdates();
    const on = companion?.on ?? false;
    setApplicationMenu(strings(), actions, updatesMenu, on);
    tray?.relabel(strings(), updatesMenu, on);
  }

  function languageChanged(next: Language): void {
    const before = language();
    reported = next;
    if (language() === before) return;
    setMenus();
    setAbout();
  }

  function newWindow(hidden = false): void {
    createWindow(
      {
        created: (win) => {
          guardNavigation(win.webContents, {
            log: mainLog,
            openExternal: (url) => native.openExternal(url),
            strayed: () => pages.strayed(),
          });
          // At the commit of a new document, before its script can say it listens.
          win.webContents.on("did-navigate", () => {
            commands.replaced();
            companion?.feeding(false);
            link.appGone();
          });
          win.webContents.on("render-process-gone", () => commands.replaced());
          win.on("closed", () => link.appGone());
          unloads.follow(win.webContents);
          // Here preventDefault() lets the unload go ahead, over the page's beforeunload.
          win.webContents.on("will-prevent-unload", (event) => {
            if (!unloads.goes()) return;
            event.preventDefault();
            mainLog.info("Eidolon: the page asked to stay (beforeunload); letting it go");
          });
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
      },
      hidden,
    );
    companion?.mainWindowMade();
    commands.replaced();
    pages.opened(backend.state);
  }

  /** Shows the window, from hidden or minimized, or makes it again after the page closed it. */
  function openWindow(): void {
    if (!started || flow.quitting) return;
    if (mainWindow() === null) newWindow();
    showWindow();
    if (updatesHeld) {
      updatesHeld = false;
      if (backend.state.phase === "ready") updates?.backendReady();
    }
  }

  function openNoticeCommand(kind: "task" | "chat", command: () => DesktopCommand): void {
    openWindow();
    try {
      commands.send(command());
    } catch (error) {
      mainLog.warn(`Eidolon: couldn't open the ${kind} a notification named: ${String(error)}`);
    }
  }

  /** A notification's click: the window, then its task. */
  function openNotice(notice: Notice): void {
    openNoticeCommand("task", () => noticeCommand(notice));
  }

  /** A chat notification's click: the window, then its conversation. */
  function openChatNotice(notice: ChatNotice): void {
    openNoticeCommand("chat", () => chatNoticeCommand(notice));
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
        version,
        changed: (state) => {
          sendUpdateState(state);
          if (useFallbackUpdater()) void fallbackUpdates?.stateChanged(state);
        },
      });
      fallbackUpdates = new FallbackUpdateBoxes({
        flow: updates,
        version,
        strings,
        icon,
        quitting: () => flow.quitting,
        showBox: (opts) => native.messageBox(opts).then((result) => result.response),
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
      /** Why this copy can't offer Open at Login and the terminal command, or null when it can. */
      const unavailable = optionsUnavailable({
        background,
        packaged: app.isPackaged,
        platform: process.platform,
        inApplications: process.platform === "darwin" && app.isInApplicationsFolder(),
        installedCopy,
      });
      // Background mode reads no login item.
      const atLogin =
        !background &&
        openedAtLogin(
          process.platform,
          process.argv,
          app.getLoginItemSettings().wasOpenedAtLogin === true,
        );
      updatesHeld = atLogin;
      // Before the first window, whose loading page is the first page it hears of.
      const companionFlow = new Companion(herWindow, {
        settings: readCompanion(join(app.getPath("userData"), COMPANION_FILE)),
        background,
        atLogin,
        strings,
      });
      companion = companionFlow;
      const commandHost: CommandHost = {
        platform: process.platform,
        resourcesPath: process.resourcesPath,
        unavailable,
        strings,
        log: mainLog,
      };
      handleAppBridge({
        versions: () => ({ version, serverVersion: backend.serverVersion }),
        language: languageChanged,
        takesCommands: () => {
          commands.listening();
          if (useFallbackUpdater() && updates !== null) {
            void fallbackUpdates?.stateChanged(updates.state);
          }
        },
        unsaved: (held) => unloads.held(held),
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
        companion: () => companionFlow.state(),
        setCompanion: (change) => companionFlow.change(change),
        popOut: () => companionFlow.popOut(),
        resetCompanionPlace: () => companionFlow.resetPlace(),
        revealModel: ({ persona, model }) => {
          const home = backend.home ?? dataHome(process.env);
          const file = join(home, "personas", persona, "models", model, MODEL_FILE);
          if (!existsSync(file)) return false;
          native.showItemInFolder(file);
          return true;
        },
        linkCompanion: () => link.appAsks(),
        feedingCompanion: (on) => companionFlow.feeding(on),
        windowShows,
        updateState: () => {
          commands.updaterListening();
          return updates?.state ?? { phase: "unsupported" };
        },
        updateCheck: () => updates?.check(true) ?? Promise.resolve({ outcome: "none" }),
        updateDownload: () => updates?.download(),
        updateInstall: () => updates?.install(),
        updateSkip: () => updates?.skip(),
      });
      handleCompanionBridge({
        linkApp: () => link.companionAsks(),
        hit: (over) => companionFlow.hit(over),
        drag: (drag) => companionFlow.drag(drag),
        drawn: (drawn) => companionFlow.drawn(drawn),
        follow: (on) => companionFlow.follow(on),
        shape: (shape) => companionFlow.shape(shape),
        menu: (state) => companionFlow.menu(state),
      });
      onWindowShows((shows) => {
        companionFlow.mainShown(shows);
        sendWindowShows(shows);
      });
      screen.on("display-added", () => companionFlow.displaysChanged());
      screen.on("display-removed", () => companionFlow.displaysChanged());
      screen.on("display-metrics-changed", () => companionFlow.displaysChanged());
      setMenus();
      setAbout();
      if (hasTray(process.platform, background)) {
        tray = new AppTray(strings(), actions, menuUpdates(), companionFlow.on, process.platform);
      }
      if (hasHideNotice(process.platform, background)) {
        hideNotice = new HideNotice({
          marker: join(app.getPath("userData"), TRAY_NOTICE_MARKER),
          show: () => {
            const { label, text } = strings();
            return native.messageBox({
              type: "none",
              title: "LAPLACE Eidolon",
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
      const chatWatchFollows = chatWatch === null ? null : followBackend(chatWatch);
      backend.subscribe((state) => {
        pages.backend(state);
        watchFollows?.(state);
        chatWatchFollows?.(state);
        if (state.phase !== "ready") return;
        setAbout();
        if (!updatesHeld) updates?.backendReady();
      });
      started = true;
      // The Dock, the tray, a second launch, a menu item or a notification's click shows it.
      if (atLogin)
        mainLog.info("Eidolon: opened at login, so the window stays hidden until it's asked for");
      newWindow(atLogin);
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
