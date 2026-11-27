// The updater's decisions: whether this run updates itself and from what, the flow from a check to
// download, skip, and the restart that installs, persisted skipped versions, and the mock. The
// restart runs through the real quit flow, and background mode stands in for headless CI updates.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateInfo } from "electron-updater";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type NativeUi, nativeUi } from "../src/main/background.ts";
import { QuitConfirmation } from "../src/main/quit-check.ts";
import { QuitFlow } from "../src/main/quit-flow.ts";
import { STRINGS, type Stopping } from "../src/main/strings.ts";
import {
  INSTALL_FOLDER,
  isUpdatableInstall,
  LAUNCH_CHECK_DELAY_MS,
  MOCK_NOTES,
  MOCK_VERSION,
  mockUpdates,
  readOnlyFolder,
  readUpdateSettings,
  UPDATES_FILE,
  type UpdateDriver,
  UpdateFlow,
  type UpdateFlowOptions,
  type UpdaterRun,
  updaterMode,
  writeUpdateSettings,
} from "../src/main/update-flow.ts";
import type { UpdateState } from "../src/shared/bridge.ts";
import {
  DESKTOP_PACKAGE,
  manifestNotes,
  type ReleaseNoteEntry,
} from "../src/shared/release-notes.ts";

const DESKTOP = join(import.meta.dirname, "..");
const en = STRINGS.en;
const LOCAL = "C:\\Users\\t\\AppData\\Local";
const INSTALLED = `${LOCAL}\\Programs\\eidolon\\LAPLACE Eidolon.exe`;
const MAC_EXE = "LAPLACE Eidolon.app/Contents/MacOS/LAPLACE Eidolon";
/** Where Gatekeeper runs a quarantined app it hasn't seen moved: a read-only mount of its folder. */
const TRANSLOCATED =
  "/private/var/folders/q1/x7k2m9p40c1b0000gn/T/AppTranslocation/3F2A1C6E-8B9D-4E0F-A1B2-C3D4E5F60718/d";

/** fs.accessSync(folder, W_OK) where it throws `code` for `folders`, each folder it's asked recorded. */
function access(code: "EROFS" | "EACCES", ...folders: string[]) {
  const asked: string[] = [];
  const check = (folder: string) => {
    asked.push(folder);
    if (folders.includes(folder)) {
      throw Object.assign(new Error(`${code}: access '${folder}'`), { code });
    }
  };
  return { check, asked };
}

/** Lets promise callbacks run, with real or fake timers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("isUpdatableInstall", () => {
  test("outside Windows, every install updates", () => {
    expect(
      isUpdatableInstall("darwin", "/Applications/Eidolon.app/Contents/MacOS/Eidolon", ""),
    ).toBe(true);
    expect(
      isUpdatableInstall(
        "darwin",
        "/Users/t/Downloads/Eidolon.app/Contents/MacOS/Eidolon",
        undefined,
      ),
    ).toBe(true);
    expect(isUpdatableInstall("linux", "/opt/Eidolon/eidolon", undefined)).toBe(true);
  });

  test("on Windows, NSIS's per-user install in %LOCALAPPDATA%\\Programs\\eidolon, whatever the case and separators", () => {
    expect(isUpdatableInstall("win32", INSTALLED, LOCAL)).toBe(true);
    expect(
      isUpdatableInstall(
        "win32",
        "c:/users/t/appdata/local/programs/EIDOLON/laplace eidolon.exe",
        `${LOCAL}\\`,
      ),
    ).toBe(true);
  });

  test("and nothing else there: Program Files, win-unpacked, another Programs folder, or no LOCALAPPDATA", () => {
    for (const exe of [
      "C:\\Program Files\\LAPLACE Eidolon\\LAPLACE Eidolon.exe",
      "D:\\builds\\win-unpacked\\LAPLACE Eidolon.exe",
      `${LOCAL}\\Programs\\laplace-eidolon-desktop\\LAPLACE Eidolon.exe`,
      `${LOCAL}\\Programs\\eidolon-old\\LAPLACE Eidolon.exe`,
      `${LOCAL}\\Programs\\LAPLACE Eidolon.exe`,
    ]) {
      expect([exe, isUpdatableInstall("win32", exe, LOCAL)]).toEqual([exe, false]);
    }
    expect(isUpdatableInstall("win32", INSTALLED, undefined)).toBe(false);
    expect(isUpdatableInstall("win32", INSTALLED, "")).toBe(false);
  });

  test("its folder is the one electron-builder.yml's extraMetadata.name gives NSIS", () => {
    const builder = readFileSync(join(DESKTOP, "electron-builder.yml"), "utf8");
    expect(/^extraMetadata:\s*\n\s+name:\s*(\S+)\s*$/m.exec(builder)?.[1]).toBe(INSTALL_FOLDER);
  });
});

describe("readOnlyFolder", () => {
  test("a copy run from its mounted DMG: the bundle's folder is the image's read-only volume", () => {
    const { check, asked } = access("EROFS", "/Volumes/Eidolon");
    expect(readOnlyFolder(`/Volumes/Eidolon/${MAC_EXE}`, check)).toBe("/Volumes/Eidolon");
    expect(asked).toEqual(["/Volumes/Eidolon"]);
  });

  test("a copy Gatekeeper translocated: its randomized folder is a read-only mount", () => {
    const { check, asked } = access("EROFS", TRANSLOCATED);
    expect(readOnlyFolder(`${TRANSLOCATED}/${MAC_EXE}`, check)).toBe(TRANSLOCATED);
    expect(asked).toEqual([TRANSLOCATED]);
  });

  test("none for /Applications, writable or not: Squirrel.Mac asks a standard account for an administrator's password", () => {
    const writable = access("EROFS");
    expect(readOnlyFolder(`/Applications/${MAC_EXE}`, writable.check)).toBeNull();
    expect(writable.asked).toEqual(["/Applications"]);
    const standard = access("EACCES", "/Applications");
    expect(readOnlyFolder(`/Applications/${MAC_EXE}`, standard.check)).toBeNull();
    expect(standard.asked).toEqual(["/Applications"]);
  });
});

describe("updaterMode", () => {
  const packaged: UpdaterRun = {
    packaged: true,
    background: false,
    platform: "darwin",
    exePath: `/Applications/${MAC_EXE}`,
    env: {},
    checkWritable: () => {},
  };
  const mode = (run: Partial<UpdaterRun>) => updaterMode({ ...packaged, ...run });

  test("a packaged install checks the release feed its app-update.yml names", () => {
    expect(mode({})).toEqual({ mode: "feed", line: "Eidolon: updates are on" });
    expect(mode({ platform: "win32", exePath: INSTALLED, localAppData: LOCAL }).mode).toBe("feed");
  });

  test("on macOS, a copy on a read-only volume is read-only, and main.log says where it runs", () => {
    const dmg = access("EROFS", "/Volumes/Eidolon");
    expect(mode({ exePath: `/Volumes/Eidolon/${MAC_EXE}`, checkWritable: dmg.check })).toEqual({
      mode: "read-only",
      line: "Eidolon: updates are off: this copy runs from a read-only volume, /Volumes/Eidolon, such as a disk image or the copy Gatekeeper translocates",
    });
    const translocated = access("EROFS", TRANSLOCATED);
    expect(
      mode({ exePath: `${TRANSLOCATED}/${MAC_EXE}`, checkWritable: translocated.check }).mode,
    ).toBe("read-only");
    expect(mode({ checkWritable: access("EACCES", "/Applications").check }).mode).toBe("feed");
  });

  test("background mode, an unpackaged build and Windows never ask whether the bundle's folder is writable", () => {
    const { check, asked } = access("EROFS", "/Volumes/Eidolon");
    const dmg = `/Volumes/Eidolon/${MAC_EXE}`;
    expect(mode({ exePath: dmg, checkWritable: check, background: true }).mode).toBe("off");
    expect(mode({ exePath: dmg, checkWritable: check, packaged: false }).mode).toBe("off");
    expect(
      mode({ platform: "win32", exePath: INSTALLED, localAppData: LOCAL, checkWritable: check })
        .mode,
    ).toBe("feed");
    expect(asked).toEqual([]);
  });

  test("a copy on Windows that isn't the per-user install stays off, and says why", () => {
    expect(
      mode({
        platform: "win32",
        exePath: "D:\\builds\\win-unpacked\\Eidolon.exe",
        localAppData: LOCAL,
      }),
    ).toEqual({
      mode: "off",
      line: "Eidolon: updates are off: this copy isn't the one installed in %LOCALAPPDATA%\\Programs\\eidolon",
    });
  });

  test("unpackaged, off, unless EIDOLON_DESKTOP_DEV_UPDATE checks the feed through dev-app-update.yml", () => {
    expect(mode({ packaged: false })).toEqual({
      mode: "off",
      line: "Eidolon: updates are off in an unpackaged build",
    });
    expect(mode({ packaged: false, env: { EIDOLON_DESKTOP_DEV_UPDATE: "1" } })).toEqual({
      mode: "dev",
      line: "Eidolon: updates check the release feed from an unpackaged build (EIDOLON_DESKTOP_DEV_UPDATE)",
    });
  });

  test("background mode is off, even packaged and installed, and under EIDOLON_DESKTOP_DEV_UPDATE", () => {
    const line = "Eidolon: updates are off in background mode";
    expect(mode({ background: true })).toEqual({ mode: "off", line });
    expect(
      mode({ background: true, packaged: false, env: { EIDOLON_DESKTOP_DEV_UPDATE: "1" } }),
    ).toEqual({ mode: "off", line });
  });

  test("EIDOLON_DESKTOP_UPDATE_TEST runs the real updater in background mode, packaged and installed only", () => {
    const test = { EIDOLON_DESKTOP_UPDATE_TEST: "1" };
    expect(mode({ background: true, env: test })).toEqual({
      mode: "feed",
      line: "Eidolon: updates are on in background mode (EIDOLON_DESKTOP_UPDATE_TEST)",
    });
    expect(mode({ background: true, packaged: false, env: test }).mode).toBe("off");
    expect(
      mode({
        background: true,
        platform: "win32",
        exePath: "C:\\Program Files\\Eidolon\\Eidolon.exe",
        localAppData: LOCAL,
        env: test,
      }).mode,
    ).toBe("off");
  });

  test("EIDOLON_DESKTOP_MOCK_UPDATE fakes the flow anywhere, background mode included", () => {
    const mock = { EIDOLON_DESKTOP_MOCK_UPDATE: "true" };
    const line =
      "Eidolon: updates are faked (EIDOLON_DESKTOP_MOCK_UPDATE): nothing reaches the network";
    expect(mode({ env: mock })).toEqual({ mode: "mock", line });
    expect(mode({ background: true, env: mock }).mode).toBe("mock");
    expect(mode({ packaged: false, env: mock }).mode).toBe("mock");
  });

  test("reads each flag as the app reads its others: on for 1, true, yes or on, without case on Windows alone", () => {
    for (const value of ["1", " TRUE ", "yes", "On"]) {
      expect(mode({ env: { EIDOLON_DESKTOP_MOCK_UPDATE: value } }).mode).toBe("mock");
    }
    for (const value of ["0", "", "false", "maybe"]) {
      expect(mode({ env: { EIDOLON_DESKTOP_MOCK_UPDATE: value } }).mode).toBe("feed");
    }
    const lower = { eidolon_desktop_update_test: "1" };
    expect(mode({ background: true, env: lower }).mode).toBe("off");
    expect(
      mode({
        background: true,
        platform: "win32",
        exePath: INSTALLED,
        localAppData: LOCAL,
        env: lower,
      }).mode,
    ).toBe("feed");
  });

  test("in background mode the real updater runs only under EIDOLON_DESKTOP_UPDATE_TEST, and never unpackaged", () => {
    const runs: UpdaterRun[] = [];
    const flags = [
      "EIDOLON_DESKTOP_MOCK_UPDATE",
      "EIDOLON_DESKTOP_DEV_UPDATE",
      "EIDOLON_DESKTOP_UPDATE_TEST",
    ];
    for (let bits = 0; bits < 8; bits++) {
      const env = Object.fromEntries(
        flags.filter((_, i) => bits & (1 << i)).map((name) => [name, "1"]),
      );
      for (const packaged of [true, false]) {
        for (const [platform, exePath] of [
          ["darwin", "/Applications/Eidolon.app/Contents/MacOS/Eidolon"],
          ["win32", INSTALLED],
          ["win32", "C:\\Program Files\\Eidolon\\Eidolon.exe"],
        ] as const) {
          runs.push({
            packaged,
            background: true,
            platform,
            exePath,
            localAppData: LOCAL,
            env,
            checkWritable: () => {},
          });
        }
      }
    }
    const real = runs.filter((run) => ["feed", "dev"].includes(updaterMode(run).mode));
    expect(real.length).toBeGreaterThan(0);
    for (const run of real) {
      expect(run.env.EIDOLON_DESKTOP_UPDATE_TEST).toBe("1");
      expect(run.env.EIDOLON_DESKTOP_MOCK_UPDATE).toBeUndefined();
      expect(run.packaged).toBe(true);
      expect(updaterMode(run).mode).toBe("feed");
    }
  });
});

test("dev-app-update.yml names electron-builder.yml's feed, with a cache of its own", () => {
  const field = (text: string, name: string) =>
    new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, "m").exec(text)?.[1];
  const builder = readFileSync(join(DESKTOP, "electron-builder.yml"), "utf8");
  const publish = /^publish:\n((?: .*\n)+)/m.exec(builder)?.[1] ?? "";
  const dev = readFileSync(join(DESKTOP, "dev-app-update.yml"), "utf8");
  for (const name of ["provider", "url", "useMultipleRangeRequest"]) {
    expect([name, field(dev, name)]).toEqual([name, field(publish, name)]);
  }
  expect(field(publish, "url")).toBe("https://downloads.vrp.moe/eidolon");
  expect(field(dev, "updaterCacheDirName")).toBe("eidolon-dev-updater");
});

test("readUpdateSettings and writeUpdateSettings persist skippedVersion safely", () => {
  const dir = mkdtempSync(join(tmpdir(), "eidolon-updates-settings-"));
  try {
    const file = join(dir, UPDATES_FILE);
    expect(readUpdateSettings(file)).toEqual({ skippedVersion: null });
    writeUpdateSettings(file, { skippedVersion: "0.2.0" });
    expect(readUpdateSettings(file)).toEqual({ skippedVersion: "0.2.0" });
    writeUpdateSettings(file, { skippedVersion: "" });
    expect(readUpdateSettings(file)).toEqual({ skippedVersion: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A newer version's manifest, as electron-updater parses latest*.yml, with any key it adds. */
function release(version: string, extra: Record<string, unknown> = {}): UpdateInfo {
  return {
    version,
    files: [],
    path: "",
    sha512: "",
    releaseDate: "2026-11-22T00:00:00.000Z",
    ...extra,
  };
}

/** A driver whose every check and download waits on the test. */
function scripted() {
  const checks: PromiseWithResolvers<UpdateInfo | null>[] = [];
  const downloads: { progress: (percent: number) => void; done: PromiseWithResolvers<void> }[] = [];
  const installs: string[] = [];
  const driver: UpdateDriver = {
    check: () => {
      const check = Promise.withResolvers<UpdateInfo | null>();
      checks.push(check);
      return check.promise;
    },
    download: (progress) => {
      const done = Promise.withResolvers<void>();
      downloads.push({ progress, done });
      return done.promise;
    },
    install: () => {
      installs.push("quitAndInstall");
    },
  };
  return { driver, checks, downloads, installs };
}

/** A state as one word and its version, for the record of what the flow went through. */
function word(state: UpdateState): string {
  if (state.phase === "downloading") return `downloading ${state.version} ${state.percent}`;
  return "version" in state ? `${state.phase} ${state.version}` : state.phase;
}

/** A flow on `driver`, keeping skipped versions in memory unless overridden. */
function harness(driver: UpdateDriver | null, overrides: Partial<UpdateFlowOptions> = {}) {
  const progress: (number | null)[] = [];
  const lines: string[] = [];
  const states: string[] = [];
  const restarts: string[] = [];
  let skipped: string | null = null;
  const flow = new UpdateFlow({
    driver,
    skippedVersion: () => skipped,
    saveSkippedVersion: (version) => {
      skipped = version;
    },
    restart: async (install) => {
      restarts.push("restart");
      install();
      return true;
    },
    relaunch: () => lines.push("relaunch"),
    progress: (fraction) => progress.push(fraction),
    version: "0.1.0",
    log: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    changed: (state) => states.push(word(state)),
    notes: manifestNotes,
    ...overrides,
  });
  return { flow, progress, lines, states, restarts, skipped: () => skipped };
}

describe("UpdateFlow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("without a driver it stays unsupported: nothing is scheduled, and check does nothing", async () => {
    const f = harness(null);
    expect(f.flow.state).toEqual({ phase: "unsupported" });
    f.flow.backendReady();
    expect(await f.flow.check(true)).toEqual({ outcome: "none" });
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS * 2);
    expect(f.flow.state).toEqual({ phase: "unsupported" });
    expect([...f.states, ...f.lines]).toEqual([]);
  });

  test("read-only: nothing is checked and phase stays read-only", async () => {
    const f = harness(null, { readOnly: true });
    expect(f.flow.state).toEqual({ phase: "read-only" });
    f.flow.backendReady();
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS * 2);
    expect(await f.flow.check(true)).toEqual({ outcome: "none" });
    expect(f.flow.state).toEqual({ phase: "read-only" });
    expect([...f.states, ...f.lines]).toEqual([]);
  });

  test("the backend's first ready starts one quiet check 10 s later; later readies start none", async () => {
    const s = scripted();
    const f = harness(s.driver);
    expect(f.flow.state).toEqual({ phase: "idle" });
    f.flow.backendReady();
    f.flow.backendReady();
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS - 1);
    expect(s.checks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.checks).toHaveLength(1);
    s.checks[0]?.resolve(null);
    await settle();
    f.flow.backendReady();
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS * 3);
    expect(s.checks).toHaveLength(1);
  });

  test("quiet and manual checks both return outcomes and log; errors stay out of UpdateState", async () => {
    const s = scripted();
    const f = harness(s.driver);
    const quiet = f.flow.check(false);
    s.checks[0]?.resolve(null);
    expect(await quiet).toEqual({ outcome: "none" });
    const failing = f.flow.check(false);
    s.checks[1]?.reject(new Error("net::ERR_INTERNET_DISCONNECTED"));
    expect(await failing).toEqual({ outcome: "error", message: "net::ERR_INTERNET_DISCONNECTED" });
    await settle();
    expect(f.flow.state).toEqual({ phase: "idle" });

    const manualOk = f.flow.check(true);
    s.checks[2]?.resolve(null);
    expect(await manualOk).toEqual({ outcome: "none" });
    const manualFail = f.flow.check(true);
    s.checks[3]?.reject(new Error("HTTP 503"));
    expect(await manualFail).toEqual({ outcome: "error", message: "HTTP 503" });
    expect(f.flow.state).toEqual({ phase: "idle" });
    expect(f.lines).toEqual([
      "Eidolon: checking for updates",
      "Eidolon: up to date: 0.1.0 is the latest",
      "Eidolon: checking for updates",
      "Eidolon: the update check failed: net::ERR_INTERNET_DISCONNECTED",
      "Eidolon: checking for updates",
      "Eidolon: up to date: 0.1.0 is the latest",
      "Eidolon: checking for updates",
      "Eidolon: the update check failed: HTTP 503",
    ]);
  });

  test("no second check while one runs: a manual check joins the quiet check and surfaces skipped versions", async () => {
    const s = scripted();
    const f = harness(s.driver, { skippedVersion: () => "0.2.0" });
    const quiet = f.flow.check(false);
    expect(f.flow.check(true)).toBe(quiet);
    expect(s.checks).toHaveLength(1);
    expect(f.flow.state).toEqual({ phase: "checking" });
    s.checks[0]?.resolve(release("0.2.0"));
    expect(await quiet).toEqual({ outcome: "available", version: "0.2.0" });
    expect(f.flow.state).toEqual({ phase: "available", version: "0.2.0", notes: [] });
  });

  test("skip persists skippedVersion, hides quiet checks for that version, and yields to manual checks", async () => {
    const s = scripted();
    const f = harness(s.driver);
    const notes: ReleaseNoteEntry[] = [
      {
        date: "2026-11-26T00:00:00Z",
        versions: { [DESKTOP_PACKAGE]: "0.2.0" },
        items: [{ kind: "feature", packages: [DESKTOP_PACKAGE], text: "In-app updater" }],
      },
    ];
    const first = f.flow.check(false);
    s.checks[0]?.resolve(release("0.2.0", { eidolonNotes: notes }));
    expect(await first).toEqual({ outcome: "available", version: "0.2.0" });
    expect(f.flow.state).toEqual({ phase: "available", version: "0.2.0", notes });

    f.flow.skip();
    expect(f.skipped()).toBe("0.2.0");
    expect(f.flow.state).toEqual({ phase: "idle" });
    expect(f.lines.at(-1)).toBe("Eidolon: skipped update 0.2.0");

    // Subsequent quiet check for the skipped version stays idle.
    const quietAgain = f.flow.check(false);
    s.checks[1]?.resolve(release("0.2.0", { eidolonNotes: notes }));
    expect(await quietAgain).toEqual({ outcome: "none" });
    expect(f.flow.state).toEqual({ phase: "idle" });
    expect(f.lines.at(-1)).toBe("Eidolon: update available: 0.2.0 (skipped)");

    // Manual check still surfaces the skipped version with its notes.
    const manual = f.flow.check(true);
    s.checks[2]?.resolve(release("0.2.0", { eidolonNotes: notes }));
    expect(await manual).toEqual({ outcome: "available", version: "0.2.0" });
    expect(f.flow.state).toEqual({ phase: "available", version: "0.2.0", notes });
  });

  test("download shows progress on the Dock or taskbar, clears it at the end, and keeps notes on downloaded", async () => {
    const s = scripted();
    const f = harness(s.driver);
    const notes: ReleaseNoteEntry[] = [
      {
        date: "2026-11-26T00:00:00Z",
        versions: { [DESKTOP_PACKAGE]: "0.2.0" },
        items: [{ kind: "performance", packages: [DESKTOP_PACKAGE], text: "Faster startup" }],
      },
    ];
    const checked = f.flow.check(false);
    s.checks[0]?.resolve(release("0.2.0", { eidolonNotes: notes }));
    await checked;
    f.flow.download();
    expect(f.flow.state).toEqual({ phase: "downloading", version: "0.2.0", percent: 0 });
    s.downloads[0]?.progress(12.4);
    s.downloads[0]?.progress(12.3);
    s.downloads[0]?.progress(99.6);
    s.downloads[0]?.done.resolve();
    await settle();
    expect(f.progress).toEqual([0, 0.12, 1, null]);
    expect(f.flow.state).toEqual({ phase: "downloaded", version: "0.2.0", notes });
    // Calling check(true) while downloaded does not re-hit the feed.
    expect(await f.flow.check(true)).toEqual({ outcome: "none" });
    expect(s.checks).toHaveLength(1);
    expect(f.restarts).toEqual([]);
  });

  test("a failed download clears the progress, enters error state, and retries cleanly on download()", async () => {
    const s = scripted();
    const f = harness(s.driver);
    const checked = f.flow.check(true);
    s.checks[0]?.resolve(release("0.2.0"));
    await checked;
    f.flow.download();
    s.downloads[0]?.progress(40);
    s.downloads[0]?.done.reject(new Error("socket hang up"));
    await settle();
    expect(f.progress).toEqual([0, 0.4, null]);
    expect(f.flow.state).toEqual({
      phase: "error",
      version: "0.2.0",
      message: "socket hang up",
    });
    expect(s.downloads).toHaveLength(1);

    f.flow.download();
    expect(s.downloads).toHaveLength(2);
    expect(f.flow.state).toEqual({ phase: "downloading", version: "0.2.0", percent: 0 });
    expect(f.progress).toEqual([0, 0.4, null, 0]);
  });

  test("main.log's lines name the versions and the failure's first line, with no URL's query", async () => {
    const s = scripted();
    const f = harness(s.driver);
    const check = f.flow.check(false);
    s.checks[0]?.reject(
      new Error(
        'Cannot find channel "latest-mac.yml" update info: HttpError: 404 at https://downloads.vrp.moe/eidolon/latest-mac.yml?noCache=1j2k3\n"method: GET url: https://downloads.vrp.moe/eidolon/latest-mac.yml?noCache=1j2k3"\nHeaders: {}',
      ),
    );
    await check;
    expect(f.lines).toEqual([
      "Eidolon: checking for updates",
      'Eidolon: the update check failed: Cannot find channel "latest-mac.yml" update info: HttpError: 404 at https://downloads.vrp.moe/eidolon/latest-mac.yml',
    ]);
  });
});

/** A flow that has downloaded 0.2.0 and is waiting on Relaunch Now. */
async function downloaded(overrides: Partial<UpdateFlowOptions> = {}) {
  const s = scripted();
  const f = harness(s.driver, overrides);
  const check = f.flow.check(false);
  s.checks[0]?.resolve(release("0.2.0"));
  await check;
  f.flow.download();
  s.downloads[0]?.done.resolve();
  await settle();
  expect(f.flow.state).toEqual({ phase: "downloaded", version: "0.2.0", notes: [] });
  return { ...f, ...s };
}

describe("Restart", () => {
  test("hops to installing before it restarts, so a second install is a no-op: one restart, one quitAndInstall", async () => {
    const restart = Promise.withResolvers<boolean>();
    let install: () => void = () => {};
    const restarts: string[] = [];
    const f = await downloaded({
      restart: (next) => {
        restarts.push("restart");
        install = next;
        return restart.promise;
      },
    });
    f.flow.install();
    expect(f.flow.state).toEqual({ phase: "installing", version: "0.2.0", notes: [] });
    f.flow.install();
    install();
    restart.resolve(true);
    await settle();
    f.flow.install();
    expect(restarts).toEqual(["restart"]);
    expect(f.installs).toEqual(["quitAndInstall"]);
    expect(f.flow.state).toEqual({ phase: "installing", version: "0.2.0", notes: [] });
    expect(f.lines.slice(-2)).toEqual([
      "Eidolon: restarting to install 0.2.0",
      "Eidolon: installing 0.2.0",
    ]);
  });

  test("the hop is reversible: a Cancel in the quit check hands the state back to downloaded, and install works again", async () => {
    let went = false;
    const restarts: string[] = [];
    const f = await downloaded({
      restart: async (install) => {
        restarts.push("restart");
        if (went) install();
        return went;
      },
    });
    f.flow.install();
    await settle();
    expect(f.flow.state).toEqual({ phase: "downloaded", version: "0.2.0", notes: [] });
    expect(f.installs).toEqual([]);
    went = true;
    f.flow.install();
    await settle();
    expect(restarts).toEqual(["restart", "restart"]);
    expect(f.installs).toEqual(["quitAndInstall"]);
  });

  test("on the real quit flow: the check in a restart's words, the latch, the backend's stop, then quitAndInstall once", async () => {
    const steps: string[] = [];
    const stopped = Promise.withResolvers<void>();
    const quit = new QuitFlow({
      confirm: async (purpose) => {
        steps.push(`confirm ${purpose}`);
        return true;
      },
      hideWindows: () => steps.push("hide"),
      stopBackend: () => {
        steps.push("stop");
        return stopped.promise;
      },
      quit: () => steps.push("quit"),
      log: { info: () => {}, error: () => {} },
    });
    const s = scripted();
    const f = harness(
      {
        ...s.driver,
        install: () => {
          // quitAndInstall closes every window, then runs before-quit: both must go through.
          steps.push(
            `quitAndInstall (a close hides: ${quit.closeHides()}, before-quit lets by: ${quit.beforeQuit()})`,
          );
        },
      },
      {
        restart: (install, installable) => quit.restart(install, installable),
      },
    );
    const check = f.flow.check(false);
    s.checks[0]?.resolve(release("0.2.0"));
    await check;
    f.flow.download();
    s.downloads[0]?.done.resolve();
    await settle();
    f.flow.install();
    await settle();
    expect(steps).toEqual(["confirm restart", "hide", "stop"]);
    f.flow.install();
    stopped.resolve();
    await settle();
    expect(steps).toEqual([
      "confirm restart",
      "hide",
      "stop",
      "quitAndInstall (a close hides: false, before-quit lets by: true)",
    ]);
  });

  test("an error after the download, such as Squirrel.Mac refusing it, moves to error and install does nothing", async () => {
    const f = await downloaded();
    f.flow.failed(new Error("Code signature at URL file:///… did not pass validation"));
    expect(f.flow.state).toMatchObject({ phase: "error", version: "0.2.0" });
    f.flow.install();
    await settle();
    expect(f.installs).toEqual([]);
  });

  test("an error while the restart asks calls it off once answered: no latch, no stop, and error state stays", async () => {
    const steps: string[] = [];
    const answered = Promise.withResolvers<boolean>();
    const quit = new QuitFlow({
      confirm: (purpose) => {
        steps.push(`confirm ${purpose}`);
        return answered.promise;
      },
      hideWindows: () => steps.push("hide"),
      stopBackend: async () => {
        steps.push("stop");
      },
      quit: () => steps.push("quit"),
      log: { info: () => {}, error: () => {} },
    });
    const f = await downloaded({
      restart: (install, installable) => quit.restart(install, installable),
    });
    f.flow.install();
    await settle();
    expect(steps).toEqual(["confirm restart"]);
    f.flow.failed(new Error("Cannot update while running on a read-only volume"));
    answered.resolve(true);
    await settle();
    expect(steps).toEqual(["confirm restart"]);
    expect([quit.quitting, quit.closeHides()]).toEqual([false, true]);
    expect(f.installs).toEqual([]);
    expect(f.flow.state).toMatchObject({ phase: "error", version: "0.2.0" });
    expect(f.lines.slice(-2)).toEqual([
      "Eidolon: 0.2.0 can't be installed: Cannot update while running on a read-only volume",
      "Eidolon: not restarting, since 0.2.0 can't be installed",
    ]);
  });

  test("an error once the quit check has let the restart through brings the app back without the update, never a quitAndInstall", async () => {
    const restart = Promise.withResolvers<boolean>();
    let install: () => void = () => {};
    let installable: () => boolean = () => false;
    const f = await downloaded({
      restart: (next, check) => {
        install = next;
        installable = check;
        return restart.promise;
      },
    });
    f.flow.install();
    expect(installable()).toBe(true);
    f.flow.failed(new Error("Squirrel.Mac: update failed"));
    install();
    restart.resolve(true);
    await settle();
    expect(f.installs).toEqual([]);
    expect(f.lines.slice(-3)).toEqual([
      "Eidolon: 0.2.0 can't be installed: Squirrel.Mac: update failed",
      "Eidolon: restarting without the update",
      "relaunch",
    ]);
  });

  test("an error after quitAndInstall, which then never quits, relaunches the app once", async () => {
    const f = await downloaded({
      restart: async (install) => {
        install();
        return true;
      },
    });
    f.flow.install();
    await settle();
    expect(f.installs).toEqual(["quitAndInstall"]);
    f.flow.failed(new Error("No update filepath provided, can't quit and install"));
    f.flow.failed(new Error("No update filepath provided, can't quit and install"));
    expect(f.lines.filter((line) => line === "relaunch")).toEqual(["relaunch"]);
  });

  test("so does the error electron-updater dispatches from inside quitAndInstall, before it returns", async () => {
    const s = scripted();
    let flow: UpdateFlow | null = null;
    const f = harness(
      {
        ...s.driver,
        install: () =>
          flow?.failed(new Error("No update filepath provided, can't quit and install")),
      },
      {},
    );
    flow = f.flow;
    const check = f.flow.check(false);
    s.checks[0]?.resolve(release("0.2.0"));
    await check;
    f.flow.download();
    s.downloads[0]?.done.resolve();
    await settle();
    f.flow.install();
    await settle();
    expect(f.lines.slice(-2)).toEqual(["Eidolon: restarting without the update", "relaunch"]);
  });

  test("errors in other phases are the check's or the download's own, and change nothing", async () => {
    const s = scripted();
    const f = harness(s.driver);
    f.flow.failed(new Error("Cannot check for updates"));
    expect(f.flow.state).toEqual({ phase: "idle" });
    void f.flow.check(false);
    f.flow.failed(new Error("Cannot check for updates"));
    expect(f.flow.state).toEqual({ phase: "checking" });
    expect(f.lines).toEqual(["Eidolon: checking for updates"]);
  });
});

describe("mock and headless update test", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("EIDOLON_DESKTOP_MOCK_UPDATE: 9.9.9 with release notes, first download fails at 60 %, retry completes, install reverts in 1.5 s", async () => {
    const lines: string[] = [];
    const mock = mockUpdates({ info: (line) => lines.push(line) });
    const progress: (number | null)[] = [];
    const states: string[] = [];
    const flow = new UpdateFlow({
      driver: mock.driver,
      restart: mock.restart,
      relaunch: () => lines.push("relaunch"),
      progress: (fraction) => progress.push(fraction),
      version: "0.1.0",
      log: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
      changed: (state) => {
        const now = state.phase === "downloading" ? "downloading" : word(state);
        if (states.at(-1) !== now) states.push(now);
      },
      notes: manifestNotes,
    });
    flow.backendReady();
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS + 600);
    await settle();
    expect(flow.state).toEqual({ phase: "available", version: MOCK_VERSION, notes: MOCK_NOTES });

    // First download fails at 60 %.
    flow.download();
    await vi.advanceTimersByTimeAsync(150 * 12);
    await settle();
    expect(lines).toContain(
      "Eidolon: the download of 9.9.9 failed: Mock failure: simulated network drop at 60%",
    );
    expect(Math.max(...progress.filter((fraction) => fraction !== null))).toBe(0.55);
    expect(flow.state).toEqual({
      phase: "error",
      version: MOCK_VERSION,
      message: "Mock failure: simulated network drop at 60%",
    });

    // Retry completes with full notes intact.
    flow.download();
    await vi.advanceTimersByTimeAsync(150 * 20);
    await settle();
    expect(flow.state).toEqual({ phase: "downloaded", version: MOCK_VERSION, notes: MOCK_NOTES });

    // Install logs and hands back to downloaded after 1.5 s so the mock repeats.
    flow.install();
    expect(flow.state).toEqual({ phase: "installing", version: MOCK_VERSION, notes: MOCK_NOTES });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(flow.state.phase).toBe("installing");
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(flow.state).toEqual({ phase: "downloaded", version: MOCK_VERSION, notes: MOCK_NOTES });
    expect(states).toEqual([
      "checking",
      "available 9.9.9",
      "downloading",
      "error 9.9.9",
      "downloading",
      "downloaded 9.9.9",
      "installing 9.9.9",
      "downloaded 9.9.9",
    ]);
    expect(lines).toContain(
      "Eidolon: mock update: Restart only logs, and 9.9.9 is back to downloaded in 1.5 s",
    );
    expect(lines).not.toContain("relaunch");
  });

  test("EIDOLON_DESKTOP_UPDATE_TEST: autoProceed drives check -> download -> quit check -> quitAndInstall headlessly", async () => {
    const lines: string[] = [];
    const electron = new Proxy({} as NativeUi, {
      get: () => () => {
        throw new Error("background mode reached Electron");
      },
    });
    const native = nativeUi(true, electron, { info: (line) => lines.push(line) });
    const steps: string[] = [];
    const confirmation = new QuitConfirmation({
      check: async (): Promise<Stopping> => ({ calls: 0, tasks: 0, jobs: 1 }),
      unsaved: () => false,
      strings: () => en,
      show: (box) => native.messageBox(box),
      focus: () => {},
      platform: "darwin",
    });
    const quit = new QuitFlow({
      confirm: (purpose) => confirmation.confirm(purpose),
      hideWindows: () => steps.push("hide"),
      stopBackend: async () => {
        steps.push("stop");
      },
      quit: () => steps.push("quit"),
      log: { info: (line) => lines.push(line), error: (line) => lines.push(line) },
    });
    const driver: UpdateDriver = {
      check: async () => release("0.0.2"),
      download: async (progress) => progress(100),
      install: () => steps.push(`quitAndInstall (latched: ${!quit.closeHides()})`),
    };
    const flow = new UpdateFlow({
      driver,
      autoProceed: true,
      restart: (install, installable) => quit.restart(install, installable),
      relaunch: () => steps.push("relaunch"),
      progress: () => {},
      version: "0.0.1",
      log: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    });
    flow.backendReady();
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS);
    await settle();
    expect(steps).toEqual(["hide", "stop", "quitAndInstall (latched: true)"]);
    expect(lines.filter((line) => !line.includes("background mode answered"))).toEqual([
      "Eidolon: checking for updates",
      "Eidolon: update available: 0.0.2",
      "Eidolon: downloading 0.0.2",
      "Eidolon: update downloaded: 0.0.2",
      "Eidolon: restarting to install 0.0.2",
      "Eidolon: quitting to install the update",
      "Eidolon: installing 0.0.2",
    ]);
    expect(
      lines
        .filter((line) => line.includes("background mode answered"))
        .map((line) => /"(.*?)"/.exec(line)?.[1]),
    ).toEqual(["Restart"]);
  });
});
