// Updates, decided without Electron, as laplace-persona's updater runs them but in native boxes:
// whether this run updates itself and from what, the flow from a check to the restart that
// installs, its boxes, and EIDOLON_DESKTOP_MOCK_UPDATE's fakes. updater.ts runs it on
// electron-updater.
import type { MessageBoxOptions } from "electron";
import { launchFlag } from "./environment.ts";
import { loggedText } from "./policy.ts";
import type { Strings } from "./strings.ts";

/** Where the flow is. A check's failure is its outcome's, never a state. */
export type UpdateState =
  | { readonly phase: "unsupported" }
  | { readonly phase: "idle" }
  | { readonly phase: "checking" }
  | { readonly phase: "available"; readonly version: string }
  | { readonly phase: "downloading"; readonly version: string; readonly percent: number }
  | { readonly phase: "downloaded"; readonly version: string }
  /**
   * Restart chosen: the hop that makes a second Restart a no-op, since quitAndInstall twice asks
   * Squirrel to relaunch twice, which leaves two copies running. A Cancel in the quit check hands
   * it back to downloaded.
   */
  | { readonly phase: "installing"; readonly version: string }
  /** The download failed, or the update it gave can't install. */
  | { readonly phase: "error"; readonly version: string; readonly message: string };

/** One check's result. */
export type UpdateCheckOutcome =
  | { readonly outcome: "available"; readonly version: string }
  | { readonly outcome: "none" }
  | { readonly outcome: "error"; readonly message: string };

/** How long after the backend is first ready the quiet check runs, clear of startup. */
export const LAUNCH_CHECK_DELAY_MS = 10_000;

/**
 * NSIS's per-user install folder, %LOCALAPPDATA%\Programs\<name>, from electron-builder.yml's
 * `extraMetadata.name`.
 */
export const INSTALL_FOLDER = "eidolon";

const MOCK_UPDATE = "EIDOLON_DESKTOP_MOCK_UPDATE";
const DEV_UPDATE = "EIDOLON_DESKTOP_DEV_UPDATE";
const UPDATE_TEST = "EIDOLON_DESKTOP_UPDATE_TEST";

/**
 * Whether electron-updater can update this install: always outside Windows, and on Windows only
 * NSIS's per-user install. Its installer installs there whatever runs it, so updating a copy
 * anywhere else, Program Files or win-unpacked, would leave a second install beside it. Compared
 * as strings, whatever the case and the separators.
 */
export function isUpdatableInstall(
  platform: string,
  exePath: string,
  localAppData: string | undefined,
): boolean {
  if (platform !== "win32") return true;
  if (!localAppData) return false;
  const norm = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return norm(exePath).startsWith(`${norm(localAppData)}/programs/${INSTALL_FOLDER}/`);
}

/**
 * What updates this run: nothing; the feed a packaged install's app-update.yml names; the feed
 * through dev-app-update.yml, unpackaged (`dev`); or the mock.
 */
export type UpdaterMode = "off" | "feed" | "dev" | "mock";

export interface UpdaterRun {
  readonly packaged: boolean;
  readonly background: boolean;
  readonly platform: NodeJS.Platform;
  /** app.getPath("exe"). */
  readonly exePath: string;
  readonly localAppData?: string;
  /** The launch environment, whose QA flags decide. */
  readonly env: NodeJS.ProcessEnv;
}

/**
 * This run's updater, and main.log's line saying so. Background mode runs no real updater but
 * under EIDOLON_DESKTOP_UPDATE_TEST, a packaged install's, which CI's update test drives; the mock
 * runs anywhere, since it reaches no network.
 */
export function updaterMode({
  packaged,
  background,
  platform,
  exePath,
  localAppData,
  env,
}: UpdaterRun): { readonly mode: UpdaterMode; readonly line: string } {
  const flag = (name: string) => launchFlag(env, name, false, platform);
  if (flag(MOCK_UPDATE)) {
    return {
      mode: "mock",
      line: `Eidolon: updates are faked (${MOCK_UPDATE}): nothing reaches the network`,
    };
  }
  if (background && !flag(UPDATE_TEST)) {
    return { mode: "off", line: "Eidolon: updates are off in background mode" };
  }
  if (!packaged) {
    return !background && flag(DEV_UPDATE)
      ? {
          mode: "dev",
          line: `Eidolon: updates check the release feed from an unpackaged build (${DEV_UPDATE})`,
        }
      : { mode: "off", line: "Eidolon: updates are off in an unpackaged build" };
  }
  if (!isUpdatableInstall(platform, exePath, localAppData)) {
    return {
      mode: "off",
      line: `Eidolon: updates are off: this copy isn't the one installed in %LOCALAPPDATA%\\Programs\\${INSTALL_FOLDER}`,
    };
  }
  return {
    mode: "feed",
    line: background
      ? `Eidolon: updates are on in background mode (${UPDATE_TEST})`
      : "Eidolon: updates are on",
  };
}

/** The GitHub Release that changesets makes for the desktop's tag. */
export function releaseNotesUrl(version: string): string {
  return `https://github.com/laplace-live/eidolon/releases/tag/laplace-eidolon-desktop@${encodeURIComponent(version)}`;
}

/** A box the flow shows. */
export type UpdateBox =
  | { readonly kind: "available"; readonly version: string; readonly current: string }
  | { readonly kind: "downloaded"; readonly version: string }
  | { readonly kind: "up-to-date"; readonly current: string }
  | { readonly kind: "check-failed" }
  | { readonly kind: "download-failed" };

/** Each box's first button, its default: Download, Restart, Try Again or OK. */
const GO = 0;
const LATER = 1;
const RELEASE_NOTES = 2;

/**
 * One of the flow's native boxes, with no owner window, as the quit box is. Windows' task dialog
 * takes the app's icon, which the caller can add; macOS draws its own.
 */
export function updateBox(
  box: UpdateBox,
  { label, text }: Strings,
  platform: NodeJS.Platform,
): MessageBoxOptions {
  const ask = (
    icon: "info" | "warning",
    message: string,
    detail: string,
    buttons: readonly string[],
  ): MessageBoxOptions => ({
    type: platform === "win32" ? "none" : icon,
    title: "Eidolon",
    message,
    detail,
    buttons: [...buttons],
    defaultId: GO,
    ...(buttons.length > 1 ? { cancelId: LATER } : {}),
    noLink: true,
  });
  switch (box.kind) {
    case "available":
      return ask(
        "info",
        text.updateAvailableTitle(box.version),
        text.updateAvailable(box.current),
        [label.download, label.later, label.releaseNotes],
      );
    case "downloaded":
      return ask("info", text.updateDownloadedTitle, text.updateDownloaded(box.version), [
        label.restart,
        label.later,
      ]);
    case "up-to-date":
      return ask("info", text.upToDateTitle, text.upToDate(box.current), [label.ok]);
    case "check-failed":
      return ask("warning", text.checkFailedTitle, text.updateFailed, [label.ok]);
    case "download-failed":
      return ask("warning", text.downloadFailedTitle, text.updateFailed, [
        label.tryAgain,
        label.later,
      ]);
  }
}

/** What the flow runs on: electron-updater's autoUpdater, or the mock. */
export interface UpdateDriver {
  /** Checks the feed once: the newer version it offers, or null. Rejects when the check fails. */
  check(): Promise<string | null>;
  /** Downloads what the last check found, telling its percent. Rejects when it fails. */
  download(progress: (percent: number) => void): Promise<void>;
  /** quitAndInstall: quits, installs silently and starts the new version. */
  install(): void;
}

export interface UpdateFlowOptions {
  /** Null when this run doesn't update itself: the flow stays unsupported. */
  readonly driver: UpdateDriver | null;
  /**
   * The restart that installs: the quit check and its box, the latch and the backend's stop, then
   * `install`. False when it didn't go ahead, which hands the state back to downloaded.
   */
  readonly restart: (install: () => void) => Promise<boolean>;
  /** Starts the app again as it is, for an update that failed once the restart had stopped it. */
  readonly relaunch: () => void;
  /** native.ts's box, which background mode answers with its default button. */
  readonly show: (box: MessageBoxOptions) => Promise<{ readonly response: number }>;
  /** Opens a release's page in the default browser. */
  readonly open: (url: string) => void;
  /** The download's share on the Dock or the taskbar; null clears it. */
  readonly progress: (fraction: number | null) => void;
  readonly strings: () => Strings;
  /** The version that runs. */
  readonly version: string;
  readonly platform?: NodeJS.Platform;
  /** main.log, a line for each step, for a test to follow. */
  readonly log: { info(message: string): void; warn(message: string): void };
  /** Each new state: the menus follow it. */
  readonly changed?: (state: UpdateState) => void;
}

/** An error's first line for main.log and the state, its URLs without their queries. */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return loggedText(message.split("\n", 1)[0]?.trim() ?? "");
}

/**
 * A quiet check 10 s after the backend is first ready, which says only that an update was found,
 * and Check for Updates…, which also says it's up to date or failed; native boxes from there.
 */
export class UpdateFlow {
  readonly #options: UpdateFlowOptions;
  readonly #driver: UpdateDriver | null;
  #state: UpdateState;
  #checking: Promise<UpdateCheckOutcome> | null = null;
  /** Whether the running check reports "up to date" and failures: Check for Updates… asked too. */
  #manual = false;
  #scheduled = false;
  /** An update box is open; another would stack on it. */
  #asking = false;
  /** quitAndInstall was called: the app is meant to be quitting. */
  #committed = false;
  #relaunched = false;

  constructor(options: UpdateFlowOptions) {
    this.#options = options;
    this.#driver = options.driver;
    this.#state = options.driver === null ? { phase: "unsupported" } : { phase: "idle" };
  }

  get state(): UpdateState {
    return this.#state;
  }

  /** The backend is ready: the first time, the quiet check is set for 10 s later. */
  backendReady(): void {
    if (this.#driver === null || this.#scheduled) return;
    this.#scheduled = true;
    setTimeout(() => void this.check(false), LAUNCH_CHECK_DELAY_MS);
  }

  /** Check for Updates…: a check, or the box of the update already found, downloaded or failed. */
  checkByHand(): void {
    switch (this.#state.phase) {
      case "idle":
      case "checking":
        void this.check(true);
        return;
      case "available":
        void this.#offer();
        return;
      case "downloaded":
        void this.#offerRestart();
        return;
      case "error":
        void this.#offerRetry();
        return;
      default:
        // Unsupported, downloading or installing: the item is hidden or disabled.
        return;
    }
  }

  /** One check of the feed; one asked while another runs joins it, a manual one making it report. */
  check(manual: boolean): Promise<UpdateCheckOutcome> {
    if (this.#checking !== null) {
      if (manual) this.#manual = true;
      return this.#checking;
    }
    const state = this.#state;
    if (state.phase === "available") {
      return Promise.resolve({ outcome: "available", version: state.version });
    }
    if (state.phase !== "idle" || this.#driver === null)
      return Promise.resolve({ outcome: "none" });
    this.#manual = manual;
    const checking = this.#check(this.#driver).finally(() => {
      this.#checking = null;
    });
    this.#checking = checking;
    return checking;
  }

  /** Download, from an update found or one whose download failed. */
  download(): void {
    const state = this.#state;
    const driver = this.#driver;
    if (driver === null || (state.phase !== "available" && state.phase !== "error")) return;
    const { version } = state;
    this.#set({ phase: "downloading", version, percent: 0 });
    this.#options.log.info(`Eidolon: downloading ${version}`);
    this.#options.progress(0);
    driver
      .download((percent) => {
        const now = this.#state;
        const rounded = Math.min(100, Math.max(0, Math.round(percent)));
        if (now.phase !== "downloading" || rounded === now.percent) return;
        this.#set({ phase: "downloading", version, percent: rounded });
        this.#options.progress(rounded / 100);
      })
      .then(
        () => {
          if (this.#state.phase !== "downloading") return;
          this.#options.progress(null);
          this.#set({ phase: "downloaded", version });
          this.#options.log.info(`Eidolon: update downloaded: ${version}`);
          void this.#offerRestart();
        },
        (error: unknown) => {
          if (this.#state.phase !== "downloading") return;
          this.#options.progress(null);
          const message = reason(error);
          this.#set({ phase: "error", version, message });
          this.#options.log.warn(`Eidolon: the download of ${version} failed: ${message}`);
          void this.#offerRetry();
        },
      );
  }

  /** Restart, once: the hop to installing comes first, so a second Restart does nothing. */
  install(): void {
    const state = this.#state;
    if (state.phase === "error") {
      void this.#offerRetry();
      return;
    }
    if (state.phase !== "downloaded") return;
    const { version } = state;
    this.#set({ phase: "installing", version });
    this.#options.log.info(`Eidolon: restarting to install ${version}`);
    const notRestarted = () => {
      if (this.#state.phase !== "installing") return;
      this.#set({ phase: "downloaded", version });
      this.#options.log.info(
        `Eidolon: ${version} stays downloaded, to install at the next restart or quit`,
      );
    };
    this.#options
      .restart(() => this.#installNow(version))
      .then(
        (went) => {
          if (!went) notRestarted();
        },
        (error: unknown) => {
          this.#options.log.warn(`Eidolon: the restart failed: ${reason(error)}`);
          notRestarted();
        },
      );
  }

  /**
   * The driver's error outside a check or a download, whose own promises report theirs: the
   * downloaded update can't install, as when Squirrel.Mac refuses it, or quitAndInstall failed
   * and never quit. Once the restart has stopped the backend, the app comes back without it.
   */
  failed(error: unknown): void {
    const state = this.#state;
    if (state.phase !== "downloaded" && state.phase !== "installing") return;
    const message = reason(error);
    this.#options.log.warn(`Eidolon: ${state.version} can't be installed: ${message}`);
    if (this.#committed) this.#relaunch();
    else this.#set({ phase: "error", version: state.version, message });
  }

  async #check(driver: UpdateDriver): Promise<UpdateCheckOutcome> {
    this.#set({ phase: "checking" });
    this.#options.log.info("Eidolon: checking for updates");
    let outcome: UpdateCheckOutcome;
    try {
      const version = await driver.check();
      outcome = version === null ? { outcome: "none" } : { outcome: "available", version };
    } catch (error) {
      outcome = { outcome: "error", message: reason(error) };
    }
    const manual = this.#manual;
    this.#manual = false;
    const { log, version: current } = this.#options;
    if (outcome.outcome === "available") {
      this.#set({ phase: "available", version: outcome.version });
      log.info(`Eidolon: update available: ${outcome.version}`);
      void this.#offer();
    } else if (outcome.outcome === "none") {
      this.#set({ phase: "idle" });
      log.info(`Eidolon: up to date: ${current} is the latest`);
      if (manual) void this.#ask({ kind: "up-to-date", current });
    } else {
      this.#set({ phase: "idle" });
      log.warn(`Eidolon: the update check failed: ${outcome.message}`);
      if (manual) void this.#ask({ kind: "check-failed" });
    }
    return outcome;
  }

  /** Download, the default; Later; or Release Notes, which leaves it for Check for Updates…. */
  async #offer(): Promise<void> {
    const state = this.#state;
    if (state.phase !== "available") return;
    const { version } = state;
    const response = await this.#ask({
      kind: "available",
      version,
      current: this.#options.version,
    });
    if (response === GO) this.download();
    else if (response === RELEASE_NOTES) this.#options.open(releaseNotesUrl(version));
  }

  /** Restart, the default; or Later, which leaves it to install at the next quit. */
  async #offerRestart(): Promise<void> {
    const state = this.#state;
    if (state.phase !== "downloaded") return;
    if ((await this.#ask({ kind: "downloaded", version: state.version })) === GO) this.install();
  }

  /** Try Again, the default, downloads again. */
  async #offerRetry(): Promise<void> {
    if (this.#state.phase !== "error") return;
    if ((await this.#ask({ kind: "download-failed" })) === GO) this.download();
  }

  /** The box's answer, or null when one is already open or it didn't show. */
  async #ask(box: UpdateBox): Promise<number | null> {
    if (this.#asking) return null;
    this.#asking = true;
    const { show, strings, platform = process.platform } = this.#options;
    try {
      return (await show(updateBox(box, strings(), platform))).response;
    } catch (error) {
      this.#options.log.warn(`Eidolon: an update box didn't show: ${reason(error)}`);
      return null;
    } finally {
      this.#asking = false;
    }
  }

  /** The restart has stopped everything: quitAndInstall, or the app back without the update. */
  #installNow(version: string): void {
    const driver = this.#driver;
    if (this.#state.phase !== "installing" || driver === null) {
      this.#relaunch();
      return;
    }
    // First: an error quitAndInstall dispatches as it runs must find it committed.
    this.#committed = true;
    this.#options.log.info(`Eidolon: installing ${version}`);
    driver.install();
  }

  #relaunch(): void {
    if (this.#relaunched) return;
    this.#relaunched = true;
    this.#options.log.warn("Eidolon: restarting without the update");
    this.#options.relaunch();
  }

  #set(next: UpdateState): void {
    if (JSON.stringify(next) === JSON.stringify(this.#state)) return;
    this.#state = next;
    this.#options.changed?.(next);
  }
}

/** The mock's update, beyond any real one. */
export const MOCK_VERSION = "9.9.9";
const MOCK_CHECK_MS = 600;
const MOCK_TICK_MS = 150;
const MOCK_RESTART_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * EIDOLON_DESKTOP_MOCK_UPDATE's fakes, as persona's PERSONA_MOCK_UPDATE: the check finds 9.9.9, the
 * first download fails at 60 % and a retry completes, 5 % a tick. Restart only logs, then hands the
 * update back to downloaded after 1.5 s, so the run repeats: nothing is checked, stopped or quit.
 */
export function mockUpdates(log: { info(message: string): void }): {
  readonly driver: UpdateDriver;
  readonly restart: (install: () => void) => Promise<boolean>;
} {
  let downloads = 0;
  return {
    driver: {
      check: async () => {
        await sleep(MOCK_CHECK_MS);
        return MOCK_VERSION;
      },
      download: (progress) => {
        const fails = ++downloads === 1;
        return new Promise((resolve, reject) => {
          let percent = 0;
          const timer = setInterval(() => {
            percent = Math.min(percent + 5, 100);
            if (fails && percent >= 60) {
              clearInterval(timer);
              reject(new Error("Mock failure: simulated network drop at 60%"));
              return;
            }
            progress(percent);
            if (percent < 100) return;
            clearInterval(timer);
            resolve();
          }, MOCK_TICK_MS);
        });
      },
      install: () => {},
    },
    restart: async () => {
      log.info(
        `Eidolon: mock update: Restart only logs, and ${MOCK_VERSION} is back to downloaded in 1.5 s`,
      );
      await sleep(MOCK_RESTART_MS);
      return false;
    },
  };
}
