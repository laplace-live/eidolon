// The updater's decisions: whether this run updates itself and from what, the flow from a check to
// the restart that installs, its boxes, and the mock. The restart runs through the real quit flow,
// and background mode's real answers stand in for the owner's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageBoxOptions } from "electron";
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
  MOCK_VERSION,
  mockUpdates,
  readOnlyFolder,
  releaseNotesUrl,
  type UpdateDriver,
  UpdateFlow,
  type UpdateFlowOptions,
  type UpdaterRun,
  type UpdateState,
  updateBox,
  updaterMode,
} from "../src/main/update-flow.ts";

const DESKTOP = join(import.meta.dirname, "..");
const en = STRINGS.en;
const LOCAL = "C:\\Users\\t\\AppData\\Local";
const INSTALLED = `${LOCAL}\\Programs\\eidolon\\Eidolon.exe`;
const MAC_EXE = "Eidolon.app/Contents/MacOS/Eidolon";
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
        "c:/users/t/appdata/local/programs/EIDOLON/eidolon.exe",
        `${LOCAL}\\`,
      ),
    ).toBe(true);
  });

  test("and nothing else there: Program Files, win-unpacked, another Programs folder, or no LOCALAPPDATA", () => {
    for (const exe of [
      "C:\\Program Files\\Eidolon\\Eidolon.exe",
      "D:\\builds\\win-unpacked\\Eidolon.exe",
      `${LOCAL}\\Programs\\laplace-eidolon-desktop\\Eidolon.exe`,
      `${LOCAL}\\Programs\\eidolon-old\\Eidolon.exe`,
      `${LOCAL}\\Programs\\Eidolon.exe`,
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

test("Release Notes opens the version's GitHub Release, which the desktop's tag names", () => {
  expect(releaseNotesUrl("0.2.0")).toBe(
    "https://github.com/laplace-live/eidolon/releases/tag/laplace-eidolon-desktop@0.2.0",
  );
});

describe("updateBox", () => {
  test("an update: Download, the default, Later on Esc, and Release Notes", () => {
    expect(
      updateBox({ kind: "available", version: "0.2.0", current: "0.1.0" }, en, "darwin"),
    ).toEqual({
      type: "info",
      title: "Eidolon",
      message: "Eidolon 0.2.0 is available",
      detail:
        "You have 0.1.0. Eidolon downloads the update in the background, then asks before restarting.",
      buttons: ["Download", "Later", "Release Notes"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
  });

  test("downloaded: Restart, the default, and Later, which leaves it to install at the next quit", () => {
    expect(updateBox({ kind: "downloaded", version: "0.2.0" }, en, "win32")).toEqual({
      type: "none",
      title: "Eidolon",
      message: "Restart to finish updating",
      detail:
        "Eidolon 0.2.0 is downloaded. Restart now to install it, or it installs the next time you quit Eidolon.",
      buttons: ["Restart", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
  });

  test("up to date, a failed check and a failed download, the last with Try Again as its default", () => {
    expect(updateBox({ kind: "up-to-date", current: "0.1.0" }, en, "darwin")).toMatchObject({
      type: "info",
      message: "Eidolon is up to date",
      detail: "Eidolon 0.1.0 is the latest version.",
      buttons: ["OK"],
      defaultId: 0,
    });
    expect(updateBox({ kind: "check-failed" }, en, "darwin")).toMatchObject({
      type: "warning",
      message: "Eidolon couldn't check for updates",
      detail: en.text.updateFailed,
      buttons: ["OK"],
    });
    expect(updateBox({ kind: "download-failed" }, en, "darwin")).toMatchObject({
      type: "warning",
      message: "Eidolon couldn't download the update",
      buttons: ["Try Again", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
  });

  test("an update's notes go under the box's text, and an empty one adds nothing", () => {
    const box = { kind: "available", version: "0.2.0", current: "0.1.0" } as const;
    expect(updateBox({ ...box, notes: "• Faster calls" }, en, "darwin").detail).toBe(
      `${en.text.updateAvailable("0.1.0")}\n\n• Faster calls`,
    );
    expect(updateBox({ ...box, notes: "" }, en, "darwin").detail).toBe(
      en.text.updateAvailable("0.1.0"),
    );
  });

  test("in the shell's language", () => {
    expect(
      updateBox(
        { kind: "available", version: "0.2.0", current: "0.1.0" },
        STRINGS["zh-Hans"],
        "win32",
      ),
    ).toMatchObject({
      message: "Eidolon 0.2.0 已发布",
      buttons: ["下载", "稍后", "发行说明"],
    });
  });

  test("read-only: why this copy can't update itself and where to move it, with OK alone, in both languages", () => {
    expect(updateBox({ kind: "read-only" }, en, "darwin")).toEqual({
      type: "info",
      title: "Eidolon",
      message: "Eidolon can't update itself here",
      detail:
        "Eidolon updates itself only from a folder it can write to. Move it to the Applications folder, then open it again.",
      buttons: ["OK"],
      defaultId: 0,
      noLink: true,
    });
    expect(updateBox({ kind: "read-only" }, STRINGS["zh-Hans"], "darwin")).toMatchObject({
      message: "Eidolon 无法在当前位置更新",
      detail: "Eidolon 只能从可写入的文件夹更新自己。请把它移到「应用程序」文件夹，然后重新打开。",
      buttons: ["确定"],
    });
  });
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

/** A flow on `driver`, its boxes answered by `answer` (by default, as background mode answers). */
function harness(
  driver: UpdateDriver | null,
  {
    answer = (box) => box.defaultId ?? 0,
    ...overrides
  }: Partial<UpdateFlowOptions> & { readonly answer?: (box: MessageBoxOptions) => number } = {},
) {
  const shown: MessageBoxOptions[] = [];
  const progress: (number | null)[] = [];
  const opened: string[] = [];
  const lines: string[] = [];
  const states: string[] = [];
  const restarts: string[] = [];
  const flow = new UpdateFlow({
    driver,
    restart: async (install) => {
      restarts.push("restart");
      install();
      return true;
    },
    relaunch: () => lines.push("relaunch"),
    show: async (box) => {
      shown.push(box);
      return { response: answer(box) };
    },
    open: (url) => opened.push(url),
    progress: (fraction) => progress.push(fraction),
    strings: () => en,
    version: "0.1.0",
    platform: "darwin",
    log: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    changed: (state) => states.push(word(state)),
    ...overrides,
  });
  return { flow, shown, progress, opened, lines, states, restarts };
}

const messages = (shown: readonly MessageBoxOptions[]) => shown.map((box) => box.message);
const LATER = 1;
const RELEASE_NOTES = 2;

describe("UpdateFlow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("without a driver it stays unsupported: nothing is scheduled, and Check for Updates… does nothing", async () => {
    const f = harness(null);
    expect(f.flow.state).toEqual({ phase: "unsupported" });
    f.flow.backendReady();
    f.flow.checkByHand();
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS * 2);
    expect(f.flow.state).toEqual({ phase: "unsupported" });
    expect([...f.shown, ...f.states, ...f.lines]).toEqual([]);
  });

  test("read-only: nothing is checked, and Check for Updates… says to move the app to the Applications folder", async () => {
    const f = harness(null, { readOnly: true });
    expect(f.flow.state).toEqual({ phase: "read-only" });
    f.flow.backendReady();
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS * 2);
    expect(await f.flow.check(true)).toEqual({ outcome: "none" });
    expect(f.shown).toEqual([]);
    f.flow.checkByHand();
    await settle();
    expect(f.shown).toEqual([updateBox({ kind: "read-only" }, en, "darwin")]);
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

  test("the quiet check only logs that it's up to date or that it failed; Check for Updates… also says so in a box", async () => {
    const s = scripted();
    const f = harness(s.driver);
    const quiet = f.flow.check(false);
    s.checks[0]?.resolve(null);
    expect(await quiet).toEqual({ outcome: "none" });
    const failing = f.flow.check(false);
    s.checks[1]?.reject(new Error("net::ERR_INTERNET_DISCONNECTED"));
    expect(await failing).toEqual({ outcome: "error", message: "net::ERR_INTERNET_DISCONNECTED" });
    await settle();
    expect(f.shown).toEqual([]);
    expect(f.flow.state).toEqual({ phase: "idle" });

    f.flow.checkByHand();
    s.checks[2]?.resolve(null);
    await settle();
    f.flow.checkByHand();
    s.checks[3]?.reject(new Error("HTTP 503"));
    await settle();
    expect(messages(f.shown)).toEqual([
      "Eidolon is up to date",
      "Eidolon couldn't check for updates",
    ]);
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

  test("no second check while one runs: Check for Updates… joins the quiet check, and reports its answer", async () => {
    const s = scripted();
    const f = harness(s.driver);
    const quiet = f.flow.check(false);
    f.flow.checkByHand();
    expect(f.flow.check(true)).toBe(quiet);
    expect(s.checks).toHaveLength(1);
    expect(f.flow.state).toEqual({ phase: "checking" });
    s.checks[0]?.resolve(null);
    await settle();
    expect(messages(f.shown)).toEqual(["Eidolon is up to date"]);
  });

  test("an update found, even quietly, is offered: Later keeps it for Check for Updates…, Release Notes opens its Release", async () => {
    const s = scripted();
    let response = LATER;
    const f = harness(s.driver, { answer: () => response });
    const found = f.flow.check(false);
    s.checks[0]?.resolve(release("0.2.0"));
    expect(await found).toEqual({ outcome: "available", version: "0.2.0" });
    await settle();
    expect(messages(f.shown)).toEqual(["Eidolon 0.2.0 is available"]);
    expect(f.flow.state).toEqual({ phase: "available", version: "0.2.0" });
    response = RELEASE_NOTES;
    f.flow.checkByHand();
    await settle();
    expect(s.checks).toHaveLength(1);
    expect(messages(f.shown)).toEqual(["Eidolon 0.2.0 is available", "Eidolon 0.2.0 is available"]);
    expect(f.opened).toEqual([releaseNotesUrl("0.2.0")]);
    expect(f.flow.state).toEqual({ phase: "available", version: "0.2.0" });
    expect(s.downloads).toHaveLength(0);
  });

  test("the box that offers an update shows what `notes` makes of its whole manifest, and no notes without it", async () => {
    const s = scripted();
    const read: unknown[] = [];
    const f = harness(s.driver, {
      answer: () => LATER,
      notes: (info, current) => {
        read.push(info);
        return `${(info as UpdateInfo & { eidolonNotes?: string }).eidolonNotes} since ${current}`;
      },
    });
    const manifest = release("0.2.0", { eidolonNotes: "• Faster calls" });
    void f.flow.check(false);
    s.checks[0]?.resolve(manifest);
    await settle();
    expect(read).toEqual([manifest]);
    expect(f.shown[0]?.detail).toBe(
      `${en.text.updateAvailable("0.1.0")}\n\n• Faster calls since 0.1.0`,
    );

    const plain = scripted();
    const g = harness(plain.driver, { answer: () => LATER });
    void g.flow.check(false);
    plain.checks[0]?.resolve(manifest);
    await settle();
    expect(g.shown[0]?.detail).toBe(en.text.updateAvailable("0.1.0"));
  });

  test("Download shows its progress on the Dock or the taskbar, cleared at the end, then asks to restart", async () => {
    const s = scripted();
    const f = harness(s.driver, { answer: (box) => (box.buttons?.[0] === "Restart" ? LATER : 0) });
    void f.flow.check(false);
    s.checks[0]?.resolve(release("0.2.0"));
    await settle();
    expect(f.flow.state).toEqual({ phase: "downloading", version: "0.2.0", percent: 0 });
    s.downloads[0]?.progress(12.4);
    s.downloads[0]?.progress(12.3);
    s.downloads[0]?.progress(99.6);
    s.downloads[0]?.done.resolve();
    await settle();
    expect(f.progress).toEqual([0, 0.12, 1, null]);
    expect(f.flow.state).toEqual({ phase: "downloaded", version: "0.2.0" });
    expect(messages(f.shown)).toEqual(["Eidolon 0.2.0 is available", "Restart to finish updating"]);
    // Later: Check for Updates… asks again, and checks nothing.
    f.flow.checkByHand();
    await settle();
    expect(messages(f.shown).at(-1)).toBe("Restart to finish updating");
    expect(s.checks).toHaveLength(1);
    expect(f.restarts).toEqual([]);
  });

  test("a failed download clears the progress and offers Try Again, which downloads again", async () => {
    const s = scripted();
    const f = harness(s.driver);
    void f.flow.check(true);
    s.checks[0]?.resolve(release("0.2.0"));
    await settle();
    s.downloads[0]?.progress(40);
    s.downloads[0]?.done.reject(new Error("socket hang up"));
    await settle();
    expect(f.progress).toEqual([0, 0.4, null, 0]);
    expect(messages(f.shown)).toEqual([
      "Eidolon 0.2.0 is available",
      "Eidolon couldn't download the update",
    ]);
    expect(f.states).toContain("error 0.2.0");
    expect(s.downloads).toHaveLength(2);
    expect(f.flow.state).toEqual({ phase: "downloading", version: "0.2.0", percent: 0 });
  });

  test("no box on an app that is quitting: the quiet check landing during the owner's quit only logs", async () => {
    const steps: string[] = [];
    const quit = new QuitFlow({
      confirm: async () => true,
      hideWindows: () => steps.push("hide"),
      // Still stopping.
      stopBackend: () => new Promise<void>(() => {}),
      quit: () => steps.push("quit"),
      log: { info: () => {}, error: () => {} },
    });
    const s = scripted();
    const f = harness(s.driver, { quitting: () => quit.quitting });
    f.flow.backendReady();
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS);
    expect(s.checks).toHaveLength(1);
    expect(quit.beforeQuit()).toBe(false);
    await settle();
    expect(steps).toEqual(["hide"]);
    s.checks[0]?.resolve(release("0.2.0"));
    await settle();
    expect(f.shown).toEqual([]);
    expect(s.downloads).toHaveLength(0);
    expect(f.lines.slice(-2)).toEqual([
      "Eidolon: update available: 0.2.0",
      "Eidolon: no update box while quitting (available 0.2.0)",
    ]);
  });

  test("nor the box that asks to restart, for a download that ends during a quit", async () => {
    const s = scripted();
    let quitting = false;
    const f = harness(s.driver, { quitting: () => quitting });
    void f.flow.check(false);
    s.checks[0]?.resolve(release("0.2.0"));
    await settle();
    quitting = true;
    s.downloads[0]?.done.resolve();
    await settle();
    expect(messages(f.shown)).toEqual(["Eidolon 0.2.0 is available"]);
    expect(f.flow.state).toEqual({ phase: "downloaded", version: "0.2.0" });
    expect(f.restarts).toEqual([]);
    expect(f.lines.at(-1)).toBe("Eidolon: no update box while quitting (downloaded 0.2.0)");
  });

  test("one update box at a time: Check for Updates… while one is open shows no second", async () => {
    const s = scripted();
    const open = Promise.withResolvers<{ response: number }>();
    const shown: string[] = [];
    const f = harness(s.driver, {
      show: (box) => {
        shown.push(String(box.message));
        return open.promise;
      },
    });
    void f.flow.check(false);
    s.checks[0]?.resolve(release("0.2.0"));
    await settle();
    f.flow.checkByHand();
    f.flow.checkByHand();
    await settle();
    expect(shown).toEqual(["Eidolon 0.2.0 is available"]);
    open.resolve({ response: LATER });
    await settle();
    f.flow.checkByHand();
    expect(shown).toHaveLength(2);
  });
});

/** A flow that has downloaded 0.2.0, its restart box answered Later unless `answer` says. */
async function downloaded(
  overrides: Partial<UpdateFlowOptions> & {
    readonly answer?: (box: MessageBoxOptions) => number;
  } = {},
) {
  const s = scripted();
  const f = harness(s.driver, {
    answer: (box) => (box.buttons?.[0] === "Restart" ? LATER : 0),
    ...overrides,
  });
  void f.flow.check(false);
  s.checks[0]?.resolve(release("0.2.0"));
  await settle();
  s.downloads[0]?.done.resolve();
  await settle();
  expect(f.flow.state).toEqual({ phase: "downloaded", version: "0.2.0" });
  return { ...f, ...s };
}

describe("Restart", () => {
  test("hops to installing before it restarts, so a second Restart is a no-op: one restart, one quitAndInstall", async () => {
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
    expect(f.flow.state).toEqual({ phase: "installing", version: "0.2.0" });
    f.flow.install();
    f.flow.checkByHand();
    install();
    restart.resolve(true);
    await settle();
    f.flow.install();
    expect(restarts).toEqual(["restart"]);
    expect(f.installs).toEqual(["quitAndInstall"]);
    expect(f.flow.state).toEqual({ phase: "installing", version: "0.2.0" });
    expect(f.lines.slice(-2)).toEqual([
      "Eidolon: restarting to install 0.2.0",
      "Eidolon: installing 0.2.0",
    ]);
  });

  test("the hop is reversible: a Cancel in the quit check hands the state back to downloaded, and Restart works again", async () => {
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
    expect(f.flow.state).toEqual({ phase: "downloaded", version: "0.2.0" });
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
        answer: (box) => (box.buttons?.[0] === "Restart" ? LATER : 0),
      },
    );
    void f.flow.check(false);
    s.checks[0]?.resolve(release("0.2.0"));
    await settle();
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

  test("an error after the download, such as Squirrel.Mac refusing it, takes away Restart: the update is in error", async () => {
    const f = await downloaded();
    f.flow.failed(new Error("Code signature at URL file:///… did not pass validation"));
    expect(f.flow.state).toMatchObject({ phase: "error", version: "0.2.0" });
    // A Restart box still open offers Try Again instead.
    f.flow.install();
    await settle();
    expect(messages(f.shown).at(-1)).toBe("Eidolon couldn't download the update");
    expect(f.installs).toEqual([]);
  });

  test("an error while the restart asks calls it off once it's answered: no latch, no stop, and the failure's box", async () => {
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
      quitting: () => quit.quitting,
      answer: (box) => (box.buttons?.[0] === "Download" ? 0 : LATER),
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
    expect(messages(f.shown).at(-1)).toBe("Eidolon couldn't download the update");
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
    // The check's answer: the latch and the backend's stop come next.
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
      { answer: (box) => (box.buttons?.[0] === "Restart" ? LATER : 0) },
    );
    flow = f.flow;
    void f.flow.check(false);
    s.checks[0]?.resolve(release("0.2.0"));
    await settle();
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

test("main.log's lines name the versions and the failure's first line, with no URL's query", async () => {
  const s = scripted();
  const f = harness(s.driver);
  void f.flow.check(false);
  s.checks[0]?.reject(
    new Error(
      'Cannot find channel "latest-mac.yml" update info: HttpError: 404 at https://downloads.vrp.moe/eidolon/latest-mac.yml?noCache=1j2k3\n"method: GET url: https://downloads.vrp.moe/eidolon/latest-mac.yml?noCache=1j2k3"\nHeaders: {}',
    ),
  );
  await settle();
  expect(f.lines).toEqual([
    "Eidolon: checking for updates",
    'Eidolon: the update check failed: Cannot find channel "latest-mac.yml" update info: HttpError: 404 at https://downloads.vrp.moe/eidolon/latest-mac.yml',
  ]);
});

describe("background mode's answers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Background mode's native calls, which answer each box with its default button. */
  function background(lines: string[]): NativeUi {
    const electron = new Proxy({} as NativeUi, {
      get: () => () => {
        throw new Error("background mode reached Electron");
      },
    });
    return nativeUi(true, electron, { info: (line) => lines.push(line) });
  }

  test("EIDOLON_DESKTOP_MOCK_UPDATE: 9.9.9 found, the first download fails at 60 %, Try Again completes, Restart only logs and goes back to downloaded after 1.5 s", async () => {
    const lines: string[] = [];
    const native = background(lines);
    const mock = mockUpdates({ info: (line) => lines.push(line) });
    const progress: (number | null)[] = [];
    const states: string[] = [];
    const flow = new UpdateFlow({
      driver: mock.driver,
      restart: mock.restart,
      relaunch: () => lines.push("relaunch"),
      show: (box) => native.messageBox(box),
      open: (url) => void native.openExternal(url),
      progress: (fraction) => progress.push(fraction),
      strings: () => en,
      version: "0.1.0",
      platform: "darwin",
      log: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
      changed: (state) => {
        const now = state.phase === "downloading" ? "downloading" : word(state);
        if (states.at(-1) !== now) states.push(now);
      },
    });
    flow.backendReady();
    // The check at 10 s takes 0.6 s; the first download dies at its 12th tick of 150 ms, and the
    // second, which Try Again starts at once, ends at its 20th.
    await vi.advanceTimersByTimeAsync(LAUNCH_CHECK_DELAY_MS + 600 + 150 * 12);
    await settle();
    expect(lines).toContain(
      "Eidolon: the download of 9.9.9 failed: Mock failure: simulated network drop at 60%",
    );
    expect(Math.max(...progress.filter((fraction) => fraction !== null))).toBe(0.55);
    await vi.advanceTimersByTimeAsync(150 * 20);
    await settle();
    expect(flow.state).toEqual({ phase: "installing", version: MOCK_VERSION });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(flow.state.phase).toBe("installing");
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(flow.state).toEqual({ phase: "downloaded", version: MOCK_VERSION });
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
    expect(lines.filter((line) => line.includes("background mode answered"))).toEqual([
      'Eidolon: background mode answered "Download" to a message box: Eidolon 9.9.9 is available You have 0.1.0. Eidolon downloads the update in the background, then asks before restarting.',
      `Eidolon: background mode answered "Try Again" to a message box: Eidolon couldn't download the update ${en.text.updateFailed}`,
      'Eidolon: background mode answered "Restart" to a message box: Restart to finish updating Eidolon 9.9.9 is downloaded. Restart now to install it, or it installs the next time you quit Eidolon.',
    ]);
    expect(lines).toContain(
      "Eidolon: mock update: Restart only logs, and 9.9.9 is back to downloaded in 1.5 s",
    );
    expect(lines).not.toContain("relaunch");
    // So the run repeats: Check for Updates… asks to restart again.
    flow.checkByHand();
    await settle();
    expect(flow.state).toEqual({ phase: "installing", version: MOCK_VERSION });
  });

  test("EIDOLON_DESKTOP_UPDATE_TEST: Download and Restart are the defaults, so the real flow reaches quitAndInstall through the quit check's own box", async () => {
    const lines: string[] = [];
    const native = background(lines);
    const steps: string[] = [];
    const confirmation = new QuitConfirmation({
      check: async (): Promise<Stopping> => ({ calls: 0, tasks: 0, jobs: 1 }),
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
      restart: (install, installable) => quit.restart(install, installable),
      relaunch: () => steps.push("relaunch"),
      show: (box) => native.messageBox(box),
      quitting: () => quit.quitting,
      open: (url) => void native.openExternal(url),
      progress: () => {},
      strings: () => en,
      version: "0.0.1",
      platform: "darwin",
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
    ).toEqual(["Download", "Restart", "Restart"]);
  });
});
