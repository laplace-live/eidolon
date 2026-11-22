// Updates on Electron: update-flow.ts's flow on electron-updater's autoUpdater, or on the mock, with
// native.ts's boxes, Release Notes through the link policy, and the download's progress on the Dock
// or the taskbar.
import { accessSync, constants } from "node:fs";
import { app, type NativeImage } from "electron";
import { autoUpdater, type ProgressInfo } from "electron-updater";
import { manifestNotes } from "../shared/release-notes.ts";
import { background } from "./instance.ts";
import { mainLog } from "./log.ts";
import { native } from "./native.ts";
import { loggedText, openAction } from "./policy.ts";
import type { QuitFlow } from "./quit-flow.ts";
import type { Strings } from "./strings.ts";
import {
  mockUpdates,
  type UpdateDriver,
  UpdateFlow,
  type UpdateState,
  updaterMode,
} from "./update-flow.ts";
import { mainWindow } from "./window.ts";

export interface UpdaterOptions {
  /** The quit flow, whose restart installs. */
  readonly quit: QuitFlow;
  readonly strings: () => Strings;
  /** The version that runs. */
  readonly version: string;
  /** Windows' boxes take the app's icon. */
  readonly icon?: NativeImage;
  readonly changed: (state: UpdateState) => void;
}

function logged(message: unknown): unknown {
  if (typeof message === "string") return loggedText(message);
  return message instanceof Error ? loggedText(message.stack ?? message.message) : message;
}

/** electron-updater's own lines go to main.log, their URLs without the feed's queries. */
const updaterLog = {
  info: (message?: unknown) => mainLog.info(logged(message)),
  warn: (message?: unknown) => mainLog.warn(logged(message)),
  error: (message?: unknown) => mainLog.error(logged(message)),
};

/** electron-updater's autoUpdater: the download waits for Download, the install for Restart or a quit. */
function releaseFeed(dev: boolean): UpdateDriver {
  const updater = autoUpdater;
  updater.logger = updaterLog;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  // Unpackaged, electron-updater reads apps/desktop/dev-app-update.yml only when forced.
  updater.forceDevUpdateConfig = dev;
  return {
    check: async () => {
      const result = await updater.checkForUpdates();
      if (result === null) throw new Error("electron-updater is inactive in this build");
      return result.isUpdateAvailable ? result.updateInfo : null;
    },
    download: async (progress) => {
      const listener = (info: ProgressInfo) => progress(info.percent);
      updater.on("download-progress", listener);
      try {
        // Not update-downloaded, which on macOS fires before Squirrel.Mac has fetched the zip from
        // electron-updater's proxy: this settles after, or rejects on Squirrel's error.
        await updater.downloadUpdate();
      } finally {
        updater.off("download-progress", listener);
      }
    },
    // Silent on Windows, and the new version started after it; Squirrel.Mac relaunches it anyway.
    install: () => updater.quitAndInstall(true, true),
  };
}

/** This run's updater: inert, the release feed or the mock, as updaterMode decides. */
export function installUpdater(options: UpdaterOptions): UpdateFlow {
  const { mode, line } = updaterMode({
    packaged: app.isPackaged,
    background,
    platform: process.platform,
    exePath: app.getPath("exe"),
    localAppData: process.env.LOCALAPPDATA,
    env: process.env,
    checkWritable: (folder) => accessSync(folder, constants.W_OK),
  });
  mainLog.info(line);
  const mock = mode === "mock" ? mockUpdates(mainLog) : null;
  const feed = mode === "feed" || mode === "dev" ? releaseFeed(mode === "dev") : null;
  const flow = new UpdateFlow({
    driver: mock?.driver ?? feed,
    readOnly: mode === "read-only",
    restart:
      mock?.restart ?? ((install, installable) => options.quit.restart(install, installable)),
    relaunch: () => {
      app.relaunch();
      app.quit();
    },
    show: (box) => native.messageBox(options.icon ? { ...box, icon: options.icon } : box),
    quitting: () => options.quit.quitting,
    open: (url) => {
      if (openAction(url) !== "browser") return;
      native.openExternal(url).catch((error: unknown) => {
        mainLog.warn(
          `Eidolon: the default browser didn't open the release notes: ${String(error)}`,
        );
      });
    },
    progress: (fraction) => mainWindow()?.setProgressBar(fraction ?? -1),
    strings: options.strings,
    version: options.version,
    log: mainLog,
    changed: options.changed,
    notes: (info, current) => manifestNotes(info, current, options.strings().text.notes),
  });
  // A check's and a download's errors reach their promises too; the flow takes only the others.
  if (feed !== null) autoUpdater.on("error", (error) => flow.failed(error));
  return flow;
}
