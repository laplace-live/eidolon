// Updates, decided without Electron, as laplace-persona's updater runs them: whether this run
// updates itself and from what, the flow from a quiet or manual check to download, skip, and the
// restart that installs, persisted skipped versions, and EIDOLON_DESKTOP_MOCK_UPDATE's fakes.
// updater.ts runs it on electron-updater and pushes each state change to the app page.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import type { MessageBoxOptions, NativeImage } from "electron";
import type { UpdateInfo } from "electron-updater";
import type { UpdateCheckOutcome, UpdateState } from "../shared/bridge.ts";
import { DESKTOP_PACKAGE, type ReleaseNoteEntry } from "../shared/release-notes.ts";
import { launchFlag } from "./environment.ts";
import { loggedText } from "./policy.ts";
import type { Strings } from "./strings.ts";

/** How long after the backend is first ready the quiet check runs, clear of startup. */
export const LAUNCH_CHECK_DELAY_MS = 10_000;

/**
 * NSIS's per-user install folder, %LOCALAPPDATA%\Programs\<name>, from electron-builder.yml's
 * `extraMetadata.name`.
 */
export const INSTALL_FOLDER = "eidolon";

/** In userData, beside companion.json and window-bounds.json. */
export const UPDATES_FILE = "updates.json";

const MOCK_UPDATE = "EIDOLON_DESKTOP_MOCK_UPDATE";
const DEV_UPDATE = "EIDOLON_DESKTOP_DEV_UPDATE";
const UPDATE_TEST = "EIDOLON_DESKTOP_UPDATE_TEST";

export interface UpdateSettings {
  readonly skippedVersion: string | null;
}

/** Reads persisted updater settings from `file`, returning defaults when missing or malformed. */
export function readUpdateSettings(file: string): UpdateSettings {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { skippedVersion: null };
  }
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
    return { skippedVersion: null };
  }
  const { skippedVersion } = saved as { readonly skippedVersion?: unknown };
  return {
    skippedVersion:
      typeof skippedVersion === "string" && skippedVersion.length > 0 ? skippedVersion : null,
  };
}

/** Persists updater settings atomically through a temporary file. */
export function writeUpdateSettings(file: string, settings: UpdateSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ skippedVersion: settings.skippedVersion })}\n`);
  renameSync(temporary, file);
}

/**
 * Whether electron-updater can update this install where it is on Windows: only NSIS's per-user
 * install. Its installer installs there whatever runs it, so updating a copy anywhere else,
 * Program Files or win-unpacked, would leave a second install beside it. Compared as strings,
 * whatever the case and the separators. Always elsewhere; macOS has readOnlyFolder.
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
 * The folder holding a macOS app's bundle, from its executable, when it is on a read-only volume,
 * as a mounted DMG and the copy Gatekeeper translocates are; else null. Squirrel.Mac refuses an
 * update there, "Cannot update while running on a read-only volume", but only once the whole zip
 * has downloaded (https://github.com/Squirrel/Squirrel.Mac/issues/182). A folder this user can't
 * write isn't one: Squirrel.Mac installs there with an administrator's password.
 */
export function readOnlyFolder(
  exePath: string,
  checkWritable: (folder: string) => void,
): string | null {
  const folder = posix.resolve(exePath, "../../../..");
  try {
    checkWritable(folder);
    return null;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === "EROFS" ? folder : null;
  }
}

/**
 * What updates this run: nothing; nothing, from a read-only volume on macOS, whose Check for
 * Updates… says to move the app; the feed a packaged install's app-update.yml names; the feed
 * through dev-app-update.yml, unpackaged (`dev`); or the mock.
 */
export type UpdaterMode = "off" | "read-only" | "feed" | "dev" | "mock";

export interface UpdaterRun {
  readonly packaged: boolean;
  readonly background: boolean;
  readonly platform: NodeJS.Platform;
  /** app.getPath("exe"). */
  readonly exePath: string;
  readonly localAppData?: string;
  /** The launch environment, whose QA flags decide. */
  readonly env: NodeJS.ProcessEnv;
  /** fs.accessSync(folder, W_OK), which throws its error when this user can't write there. */
  readonly checkWritable: (folder: string) => void;
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
  checkWritable,
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
  const readOnly = platform === "darwin" ? readOnlyFolder(exePath, checkWritable) : null;
  if (readOnly !== null) {
    return {
      mode: "read-only",
      line: `Eidolon: updates are off: this copy runs from a read-only volume, ${readOnly}, such as a disk image or the copy Gatekeeper translocates`,
    };
  }
  return {
    mode: "feed",
    line: background
      ? `Eidolon: updates are on in background mode (${UPDATE_TEST})`
      : "Eidolon: updates are on",
  };
}

/** What the flow runs on: electron-updater's autoUpdater, or the mock. */
export interface UpdateDriver {
  /**
   * Checks the feed once: a newer version's manifest as electron-updater parsed it, every key of
   * latest*.yml kept, or null. Rejects when the check fails.
   */
  check(): Promise<UpdateInfo | null>;
  /** Downloads what the last check found, telling its percent. Rejects when it fails. */
  download(progress: (percent: number) => void): Promise<void>;
  /** quitAndInstall: quits, installs silently and starts the new version. */
  install(): void;
}

export interface UpdateFlowOptions {
  /** Null when this run doesn't update itself: the flow stays unsupported, or read-only. */
  readonly driver: UpdateDriver | null;
  /** With no driver: updaterMode's read-only, whose Check for Updates… opens the move dialog. */
  readonly readOnly?: boolean;
  /**
   * Automatically download and install as soon as an update is available/downloaded (headless CI
   * update test under EIDOLON_DESKTOP_UPDATE_TEST).
   */
  readonly autoProceed?: boolean;
  /** Previously skipped version, kept silent on quiet launch checks. */
  readonly skippedVersion?: () => string | null;
  /** Persists a newly skipped version. */
  readonly saveSkippedVersion?: (version: string) => void;
  /**
   * The restart that installs: the quit check and its box, `installable` once it's answered, the
   * latch and the backend's stop, then `install`. False when it didn't go ahead, which hands the
   * state back to downloaded.
   */
  readonly restart: (install: () => void, installable: () => boolean) => Promise<boolean>;
  /** Starts the app again as it is, for an update that failed once the restart had stopped it. */
  readonly relaunch: () => void;
  /** The download's share on the Dock or the taskbar; null clears it. */
  readonly progress: (fraction: number | null) => void;
  /** The version that runs. */
  readonly version: string;
  /** main.log, a line for each step, for a test to follow. */
  readonly log: { info(message: string): void; warn(message: string): void };
  /** Each new state: the app page and the menus follow it. */
  readonly changed?: (state: UpdateState) => void;
  /** The release's notes for the dialog, from its manifest; none unless given. */
  readonly notes?: (info: UpdateInfo, current: string) => readonly ReleaseNoteEntry[];
}

/** An error's first line for main.log and the state, its URLs without their queries. */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return loggedText(message.split("\n", 1)[0]?.trim() ?? "");
}

/**
 * A quiet check 10 s after the backend is first ready, and manual checks from the app menu or
 * tray; state changes push to the renderer's title-bar badge and in-app update dialog.
 */
export class UpdateFlow {
  readonly #options: UpdateFlowOptions;
  readonly #driver: UpdateDriver | null;
  #state: UpdateState;
  #notes: readonly ReleaseNoteEntry[] = [];
  #checking: Promise<UpdateCheckOutcome> | null = null;
  /** Whether the running check reports skipped versions too: Check for Updates… asked too. */
  #manual = false;
  #scheduled = false;
  /** quitAndInstall was called: the app is meant to be quitting. */
  #committed = false;
  #relaunched = false;

  constructor(options: UpdateFlowOptions) {
    this.#options = options;
    this.#driver = options.driver;
    this.#state =
      options.driver !== null
        ? { phase: "idle" }
        : options.readOnly
          ? { phase: "read-only" }
          : { phase: "unsupported" };
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

  /** One check of the feed; one asked while another runs joins it, a manual one surfacing skipped versions. */
  check(manual: boolean): Promise<UpdateCheckOutcome> {
    if (this.#checking !== null) {
      if (manual) this.#manual = true;
      return this.#checking;
    }
    const state = this.#state;
    if (state.phase === "available") {
      return Promise.resolve({ outcome: "available", version: state.version });
    }
    if (state.phase !== "idle" || this.#driver === null) {
      return Promise.resolve({ outcome: "none" });
    }
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
          this.#set({ phase: "downloaded", version, notes: this.#notes });
          this.#options.log.info(`Eidolon: update downloaded: ${version}`);
          if (this.#options.autoProceed) this.install();
        },
        (error: unknown) => {
          if (this.#state.phase !== "downloading") return;
          this.#options.progress(null);
          const message = reason(error);
          this.#set({ phase: "error", version, message });
          this.#options.log.warn(`Eidolon: the download of ${version} failed: ${message}`);
        },
      );
  }

  /** Restart, once: the hop to installing comes first, so a second Restart does nothing. */
  install(): void {
    const state = this.#state;
    if (state.phase !== "downloaded") return;
    const { version, notes } = state;
    this.#set({ phase: "installing", version, notes });
    this.#options.log.info(`Eidolon: restarting to install ${version}`);
    let calledOff = false;
    const installable = () => {
      if (this.#state.phase === "installing") return true;
      calledOff = true;
      this.#options.log.warn(`Eidolon: not restarting, since ${version} can't be installed`);
      return false;
    };
    const notRestarted = () => {
      if (calledOff || this.#state.phase !== "installing") return;
      this.#set({ phase: "downloaded", version, notes: this.#notes });
      this.#options.log.info(
        `Eidolon: ${version} stays downloaded, to install at the next restart or quit`,
      );
    };
    this.#options
      .restart(() => this.#installNow(version), installable)
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

  /** Persist the offered version as skipped and clear the badge. */
  skip(): void {
    const state = this.#state;
    if (state.phase !== "available") return;
    const { version } = state;
    this.#options.saveSkippedVersion?.(version);
    this.#options.log.info(`Eidolon: skipped update ${version}`);
    this.#set({ phase: "idle" });
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
    let found: UpdateInfo | null = null;
    let failedMessage: string | null = null;
    try {
      found = await driver.check();
    } catch (error) {
      failedMessage = reason(error);
    }
    const manual = this.#manual;
    this.#manual = false;
    const { log, version: current } = this.#options;
    if (failedMessage !== null) {
      this.#set({ phase: "idle" });
      log.warn(`Eidolon: the update check failed: ${failedMessage}`);
      return { outcome: "error", message: failedMessage };
    }
    if (found === null) {
      this.#set({ phase: "idle" });
      log.info(`Eidolon: up to date: ${current} is the latest`);
      return { outcome: "none" };
    }
    const skipped = this.#options.skippedVersion?.() ?? null;
    if (!this.#options.autoProceed && !manual && found.version === skipped) {
      this.#set({ phase: "idle" });
      log.info(`Eidolon: update available: ${found.version} (skipped)`);
      return { outcome: "none" };
    }
    this.#notes = this.#options.notes?.(found, current) ?? [];
    this.#set({ phase: "available", version: found.version, notes: this.#notes });
    log.info(`Eidolon: update available: ${found.version}`);
    if (this.#options.autoProceed) this.download();
    return { outcome: "available", version: found.version };
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
    if (sameUpdateState(this.#state, next)) return;
    this.#state = next;
    this.#options.changed?.(next);
  }
}

function sameUpdateState(a: UpdateState, b: UpdateState): boolean {
  if (a === b) return true;
  if (a.phase !== b.phase) return false;
  if (
    a.phase === "unsupported" ||
    a.phase === "read-only" ||
    a.phase === "idle" ||
    a.phase === "checking"
  ) {
    return true;
  }
  if (a.phase === "downloading" && b.phase === "downloading") {
    return a.version === b.version && a.percent === b.percent;
  }
  if (a.phase === "error" && b.phase === "error") {
    return a.version === b.version && a.message === b.message;
  }
  if (
    (a.phase === "available" || a.phase === "downloaded" || a.phase === "installing") &&
    (b.phase === "available" || b.phase === "downloaded" || b.phase === "installing")
  ) {
    return a.version === b.version && a.notes === b.notes;
  }
  return false;
}

/** The mock's update, beyond any real one. */
export const MOCK_VERSION = "9.9.9";
const MOCK_CHECK_MS = 600;
const MOCK_TICK_MS = 150;
const MOCK_RESTART_MS = 1_500;

export const MOCK_NOTES: readonly ReleaseNoteEntry[] = [
  {
    date: "2026-11-26T10:22:31Z",
    versions: { [DESKTOP_PACKAGE]: MOCK_VERSION },
    items: [
      {
        kind: "feature",
        packages: [DESKTOP_PACKAGE],
        text: "Mock: check and install desktop updates inside the window",
      },
      {
        kind: "performance",
        packages: [DESKTOP_PACKAGE],
        text: "Mock: faster startup when attaching to a running server",
      },
      {
        kind: "improvement",
        packages: [DESKTOP_PACKAGE],
        text: "Mock: polished title-bar badge and scrollable release notes",
      },
      {
        kind: "fix",
        packages: [DESKTOP_PACKAGE],
        text: "Mock: keep downloaded updates ready across quit cancellation",
      },
      {
        kind: "other",
        packages: [DESKTOP_PACKAGE],
        text: "Mock: an uncategorized item on the Other fallback",
      },
      {
        kind: "feature",
        packages: [DESKTOP_PACKAGE],
        text: "Mock: persist skipped update versions in the profile",
      },
      {
        kind: "performance",
        packages: [DESKTOP_PACKAGE],
        text: "Mock: reduce renderer work while the window is hidden",
      },
      {
        kind: "improvement",
        packages: [DESKTOP_PACKAGE],
        text: "Mock: show download percentage in the update dialog and Dock",
      },
      {
        kind: "fix",
        packages: [DESKTOP_PACKAGE],
        text: "Mock: handle offline update checks cleanly in a toast",
      },
      {
        kind: "other",
        packages: [DESKTOP_PACKAGE],
        text: "Mock: additional release note entry to exercise scrolling",
      },
    ],
  },
  {
    date: "2026-11-20T09:00:00Z",
    versions: { [DESKTOP_PACKAGE]: "9.9.8" },
    items: [
      {
        kind: "fix",
        packages: [DESKTOP_PACKAGE],
        text: "Mock: an older release, to exercise grouping",
      },
    ],
  },
];

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * EIDOLON_DESKTOP_MOCK_UPDATE's fakes, as persona's PERSONA_MOCK_UPDATE: the check finds 9.9.9
 * with mock release notes covering every kind, the first download fails at 60 % and a retry
 * completes, 5 % a tick. Relaunch only logs, then hands the update back to downloaded after 1.5 s,
 * so the run repeats: nothing is checked, stopped or quit.
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
        return {
          version: MOCK_VERSION,
          files: [],
          path: "",
          sha512: "",
          releaseDate: "2026-11-26T10:22:31Z",
          eidolonNotes: MOCK_NOTES,
        } as UpdateInfo;
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

export interface FallbackUpdateBoxesOptions {
  readonly flow: UpdateFlow;
  readonly version: string;
  readonly strings: () => Strings;
  readonly showBox: (options: MessageBoxOptions) => Promise<number>;
  readonly quitting: () => boolean;
  readonly icon?: NativeImage;
}

/**
 * Native dialog fallback used when the loaded document lacks the in-app updater UI (for example,
 * when desktop attaches to an older terminal server or shows the shell failure page).
 */
export class FallbackUpdateBoxes {
  readonly #options: FallbackUpdateBoxesOptions;
  #open = false;
  #prompted: string | null = null;

  constructor(options: FallbackUpdateBoxesOptions) {
    this.#options = options;
  }

  /** Prompts on passive or post-check state transitions when the active page cannot render them. */
  async stateChanged(state: UpdateState): Promise<void> {
    if (state.phase === "available") {
      const key = `${state.phase}:${state.version}`;
      if (this.#prompted === key) return;
      this.#prompted = key;
      const { label, text } = this.#options.strings();
      const clicked = await this.#ask({
        type: "info",
        message: text.updateAvailableTitle(state.version),
        detail: text.updateAvailable(this.#options.version),
        buttons: [label.download, label.later],
        defaultId: 0,
        cancelId: 1,
      });
      if (clicked === 0 && !this.#options.quitting()) this.#options.flow.download();
      return;
    }
    if (state.phase === "downloaded") {
      const key = `${state.phase}:${state.version}`;
      if (this.#prompted === key) return;
      this.#prompted = key;
      const { label, text } = this.#options.strings();
      const clicked = await this.#ask({
        type: "info",
        message: text.updateDownloadedTitle,
        detail: text.updateDownloaded(state.version),
        buttons: [label.restart, label.later],
        defaultId: 0,
        cancelId: 1,
      });
      if (clicked === 0 && !this.#options.quitting()) this.#options.flow.install();
      return;
    }
    if (state.phase === "error") {
      const key = `${state.phase}:${state.version}`;
      if (this.#prompted === key) return;
      this.#prompted = key;
      const { label, text } = this.#options.strings();
      const clicked = await this.#ask({
        type: "warning",
        message: text.updateFailedTitle,
        detail: state.message,
        buttons: [label.tryAgain, label.later],
        defaultId: 0,
        cancelId: 1,
      });
      if (clicked === 0 && !this.#options.quitting()) this.#options.flow.download();
      return;
    }
    this.#prompted = null;
  }

  /** Handles Check for Updates… when the active page cannot handle `check-updates`. */
  async checkByHand(): Promise<void> {
    if (this.#options.quitting() || this.#open) return;
    const state = this.#options.flow.state;
    const { label, text } = this.#options.strings();
    if (state.phase === "read-only") {
      await this.#ask({
        type: "info",
        message: text.readOnlyTitle,
        detail: text.readOnly,
        buttons: [label.ok],
      });
      return;
    }
    if (state.phase === "available" || state.phase === "downloaded" || state.phase === "error") {
      this.#prompted = null;
      await this.stateChanged(state);
      return;
    }
    if (state.phase !== "idle" && state.phase !== "checking") return;
    this.#prompted = null;
    const res = await this.#options.flow.check(true);
    if (this.#options.quitting()) return;
    if (res.outcome === "none") {
      await this.#ask({
        type: "info",
        message: text.upToDateTitle,
        detail: text.upToDate(this.#options.version),
        buttons: [label.ok],
      });
      return;
    }
    if (res.outcome === "error") {
      await this.#ask({
        type: "warning",
        message: text.checkFailedTitle,
        detail: res.message,
        buttons: [label.ok],
      });
      return;
    }
    if (this.#prompted !== `available:${res.version}`) {
      await this.stateChanged(this.#options.flow.state);
    }
  }

  async #ask(
    box: Pick<
      MessageBoxOptions,
      "type" | "message" | "detail" | "buttons" | "defaultId" | "cancelId"
    >,
  ): Promise<number | null> {
    if (this.#open || this.#options.quitting()) return null;
    this.#open = true;
    try {
      return await this.#options.showBox({
        ...box,
        title: "LAPLACE Eidolon",
        noLink: true,
        ...(this.#options.icon === undefined ? {} : { icon: this.#options.icon }),
      });
    } finally {
      this.#open = false;
    }
  }
}
