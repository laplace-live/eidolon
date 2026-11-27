// Updates on Electron: update-flow.ts's flow on electron-updater's autoUpdater, or on the mock,
// with skipped versions persisted in userData and the download's progress on the Dock or taskbar.
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { autoUpdater, type NsisUpdater, type ProgressInfo } from "electron-updater";
import type { UpdateState } from "../shared/bridge.ts";
import { manifestNotes } from "../shared/release-notes.ts";
import { background } from "./instance.ts";
import { mainLog } from "./log.ts";
import { loggedText } from "./policy.ts";
import type { QuitFlow } from "./quit-flow.ts";
import {
  mockUpdates,
  readUpdateSettings,
  UPDATES_FILE,
  type UpdateDriver,
  UpdateFlow,
  type UpdateFlowOptions,
  updaterMode,
  writeUpdateSettings,
} from "./update-flow.ts";
import {
  powershellArgs,
  powershellExe,
  SIGNATURE_TIMEOUT_MS,
  signatureScript,
  signatureVerdict,
} from "./update-signature.ts";
import { mainWindow } from "./window.ts";

const execFileAsync = promisify(execFile);

export interface UpdaterOptions {
  /** The quit flow, whose restart installs. */
  readonly quit: QuitFlow;
  /** The version that runs. */
  readonly version: string;
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

/**
 * Windows: the downloaded setup's Authenticode check, in place of electron-updater's
 * (update-signature.ts): null to install it, else why not. A check that can't run refuses it.
 */
async function verifySetupSignature(
  publisherNames: string[],
  file: string,
): Promise<string | null> {
  // As electron-updater does (electron-builder#7127): PowerShell 7's module path breaks 5.1's.
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^psmodulepath$/i.test(name)) delete env[name];
  let verdict: string | null;
  try {
    const { stdout } = await execFileAsync(powershellExe(), powershellArgs(signatureScript(file)), {
      encoding: "utf8",
      env,
      timeout: SIGNATURE_TIMEOUT_MS,
      windowsHide: true,
    });
    verdict = signatureVerdict(stdout, file, publisherNames);
  } catch (error) {
    verdict = `couldn't check the update's signature: ${String(error)}`;
  }
  if (verdict === null) mainLog.info("Eidolon: the update's signature is valid");
  else mainLog.warn(`Eidolon: the update's signature doesn't check out: ${verdict}`);
  return verdict;
}

/** electron-updater's autoUpdater: the download waits for Download, the install for Restart or a quit. */
function releaseFeed(dev: boolean): UpdateDriver {
  const updater = autoUpdater;
  if (process.platform === "win32") {
    (updater as NsisUpdater).verifyUpdateCodeSignature = verifySetupSignature;
  }
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

function skippedStore(
  driver: UpdateDriver | null,
): Pick<UpdateFlowOptions, "skippedVersion" | "saveSkippedVersion"> {
  if (driver === null) return {};
  const settingsPath = join(app.getPath("userData"), UPDATES_FILE);
  let settings = readUpdateSettings(settingsPath);
  return {
    skippedVersion: () => settings.skippedVersion,
    saveSkippedVersion: (skippedVersion) => {
      settings = { skippedVersion };
      try {
        writeUpdateSettings(settingsPath, settings);
      } catch (error) {
        mainLog.warn(`Eidolon: couldn't save skipped update: ${String(error)}`);
      }
    },
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
  const driver = mock?.driver ?? feed;
  const flow = new UpdateFlow({
    driver,
    readOnly: mode === "read-only",
    autoProceed: background && mode === "feed",
    ...skippedStore(driver),
    restart:
      mock?.restart ?? ((install, installable) => options.quit.restart(install, installable)),
    relaunch: () => {
      app.relaunch();
      app.quit();
    },
    progress: (fraction) => mainWindow()?.setProgressBar(fraction ?? -1),
    version: options.version,
    log: mainLog,
    changed: options.changed,
    notes: manifestNotes,
  });
  // A check's and a download's errors reach their promises too; the flow takes only the others.
  if (feed !== null) autoUpdater.on("error", (error) => flow.failed(error));
  return flow;
}
