// The desktop smokes' kit: a run's folders, its fakes and the app's environment; the app's logs,
// server lock, token and API, read and called as main does; the focus watch; process bookkeeping;
// and on macOS the preferences a packaged run writes. A smoke runs inside runSmoke(), which starts
// all of it and ends it: whatever still runs stopped by pid, the folders removed after a pass and
// kept after a failure, the preferences put back, and a failing check for anything left behind.
import { type ChildProcess, execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { AccountsResponse } from "../../../bot/src/local/api.ts";
import { hintFrom, originOf, readServerInfo, readToken } from "../../src/main/attach.ts";
import { BACKGROUND_LINE, FAKE_MEDIA_DEVICE } from "../../src/main/background.ts";
import { COMPANION_LINES } from "../../src/main/companion.ts";
import { appEnv } from "./env.ts";
import { type Fakes, type FakesOptions, startFakes } from "./fakes.ts";
import { type FocusWatch, watchFocus } from "./focus.ts";
import { Processes, type Started } from "./processes.ts";

export const DESKTOP = resolve(import.meta.dirname, "../..");
export const ROOT = resolve(DESKTOP, "../..");
/** The preferences domain a packaged run writes on macOS, whatever its profile. */
export const PREFERENCES_DOMAIN = "live.laplace.eidolon";
/** Grants the camera and microphone without asking main: never in background mode. */
const FAKE_MEDIA_UI = "--use-fake-ui-for-media-stream";
/** A credential the smoke's own environment carries, which appEnv must keep from the app. */
const CANARY_NAME = "ANTHROPIC_API_KEY";
/** The accounts whose keys the app gets from its environment: the fakes'. */
const FAKE_ACCOUNTS = ["openrouter", "openai"];

/** main.log's lines a smoke waits on; a RegExp captures the line's values. */
export const LINES = {
  background: BACKGROUND_LINE,
  dataHome: /Eidolon: the data home is (.+)$/,
  /** The backend's pid, and the port it was asked for: 0 for a free one. */
  started: /Eidolon: started the backend \(pid (\d+)\) on port (\d+)/,
  attached: /Eidolon: using the server already on this data home, (\S+)/,
  listens: /Eidolon: the backend listens on (\S+)/,
  /** Main loaded the app page: the backend answers. */
  appShown: "Eidolon: the window shows eidolon-app://app/",
  quitting: "Eidolon: quitting",
  /** The pid, and its exit code or signal. */
  exited: /Eidolon: the backend \(pid (\d+)\) exited \((\w+)\)/,
  /** The desktop companion's page said she is drawn: her model, or her picture. */
  companionDrawn: /Eidolon: the companion's page drew her (model|picture)/,
  /** Background mode's record of her showing, where it would show her. */
  companionOffScreen: COMPANION_LINES.offScreen,
} as const;

export interface SmokeArgs {
  /** Background mode and the focus watch off, for a developer who wants to watch. */
  readonly headful: boolean;
  /** The smoke's own arguments, in order. */
  readonly rest: readonly string[];
}

export function parseSmokeArgs(argv: readonly string[]): SmokeArgs {
  const rest = argv.filter((arg) => arg !== "--headful");
  return { headful: rest.length !== argv.length, rest };
}

/** A run's folders, all inside `root`. */
export interface Run {
  readonly root: string;
  /** EIDOLON_HOME. */
  readonly home: string;
  /** EIDOLON_REAL_HOME. */
  readonly realHome: string;
  /** EIDOLON_SHARED_SKILLS. */
  readonly sharedSkills: string;
  /** The app's --user-data-dir: its logs, window bounds and background mode's downloads. */
  readonly profile: string;
  /** Whatever else the smoke writes: launches' output, WAVs, files to upload. */
  readonly scratch: string;
}

/** Where runs go: RUNNER_TEMP on a CI runner, else the OS's temporary folder. */
export function runsFolder(env: NodeJS.ProcessEnv = process.env): string {
  return env.RUNNER_TEMP || tmpdir();
}

export function makeRun(label: string, parent: string = runsFolder()): Run {
  const root = mkdtempSync(join(parent, `eidolon-${label}-`));
  const run: Run = {
    root,
    home: join(root, "home"),
    realHome: join(root, "real-home"),
    sharedSkills: join(root, "shared-skills"),
    profile: join(root, "profile"),
    scratch: join(root, "scratch"),
  };
  for (const folder of [run.home, run.realHome, run.sharedSkills, run.profile, run.scratch]) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  }
  return run;
}

/** Electron's binary, as `require("electron")` names it from apps/desktop, downloading it once. */
export function electronBinary(): string {
  const binary: unknown = createRequire(join(DESKTOP, "package.json"))("electron");
  if (typeof binary !== "string") throw new Error("electron didn't resolve to its binary");
  return binary;
}

/** The packaged app electron-builder leaves in apps/desktop/.out for this machine. */
export function packagedBinary(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? join(DESKTOP, ".out", "win-unpacked", "LAPLACE Eidolon.exe")
    : join(
        DESKTOP,
        ".out",
        "mac-arm64",
        "LAPLACE Eidolon.app",
        "Contents",
        "MacOS",
        "LAPLACE Eidolon",
      );
}

/**
 * An outputs folder's installer, apps/desktop/.out's by default: the NSIS setup on Windows, its only
 * .exe; the DMG on macOS.
 */
export function installer(
  platform: NodeJS.Platform = process.platform,
  out: string = join(DESKTOP, ".out"),
): string {
  const extension = platform === "win32" ? ".exe" : ".dmg";
  const found = existsSync(out) ? readdirSync(out).filter((name) => name.endsWith(extension)) : [];
  if (found.length !== 1) {
    const named = relative(ROOT, out).startsWith("..") ? out : relative(ROOT, out);
    throw new Error(`${named} holds ${found.length} ${extension} files, not one`);
  }
  return join(out, found[0]);
}

/** Where the NSIS setup installs the app for this user: %LOCALAPPDATA%\Programs\eidolon. */
export function installedBinary(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
    "Programs",
    "eidolon",
    "LAPLACE Eidolon.exe",
  );
}

/** How to start the app: a command and its arguments, the run's profile included. */
export interface AppLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/** The unpackaged app: Electron on apps/desktop, its backend from source (pnpm build:desktop). */
export function devApp(run: Run): AppLaunch {
  return { command: electronBinary(), args: [DESKTOP, `--user-data-dir=${run.profile}`] };
}

/** The packaged app's binary, the build's by default, on the run's profile. */
export function packagedApp(run: Run, binary: string = packagedBinary()): AppLaunch {
  return { command: binary, args: [`--user-data-dir=${run.profile}`] };
}

/**
 * Chromium's fake microphone, the only media switch background mode lets answer: a tone, or `wav`
 * (Chromium captures silence from a file unless the audio service runs unsandboxed).
 */
export function fakeMicrophoneArgs(wav?: string): string[] {
  return [
    `--${FAKE_MEDIA_DEVICE}`,
    ...(wav === undefined
      ? []
      : [`--use-file-for-fake-audio-capture=${wav}`, "--disable-features=AudioServiceSandbox"]),
  ];
}

export type LogName = "main" | "backend";

/** `<profile>/logs/main.log` or `backend.log`. */
export function logPath(run: Run, name: LogName): string {
  return join(run.profile, "logs", `${name}.log`);
}

/** The log's text so far; empty before it exists. */
export function readLog(run: Run, name: LogName): string {
  try {
    return readFileSync(logPath(run, name), "utf8");
  } catch {
    return "";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** `promise`'s value, or null once `ms` have passed. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, sleep(ms).then(() => null)]);
}

/** `read()`'s value once `done` holds for it, or its last one at the timeout. */
export async function until<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  everyMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() >= deadline) return value;
    await sleep(everyMs);
  }
}

export interface WaitOptions {
  /** 60 s by default. */
  readonly timeoutMs?: number;
  /** Where in the log to start, in characters: readLog(...).length before what is awaited. */
  readonly from?: number;
}

/** The first line after `from` that holds `pattern`, once one does; throws at the timeout. */
export async function waitForLine(
  run: Run,
  name: LogName,
  pattern: string | RegExp,
  { timeoutMs = 60_000, from = 0 }: WaitOptions = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const line = readLog(run, name)
      .slice(from)
      .split(/\r?\n/)
      .find((candidate) =>
        typeof pattern === "string" ? candidate.includes(pattern) : pattern.test(candidate),
      );
    if (line !== undefined) return line;
    if (Date.now() >= deadline) throw new Error(`${name}.log has no line with ${String(pattern)}`);
    await sleep(100);
  }
}

/** A log's error lines: main's at electron-log's error level, the backend's at ERROR or CRITICAL. */
export function errorLines(text: string, name: LogName): string[] {
  const error = name === "main" ? /\] \[error\]/ : /\| (ERROR|CRITICAL) +\|/;
  return text.split(/\r?\n/).filter((line) => error.test(line));
}

/** The server holding a data home, from its lock's .info: its pid, port and loopback host. */
export interface ServerAddress {
  readonly pid: number;
  readonly port: number;
  /** As a URL names it: 127.0.0.1, or [::1]. */
  readonly host: string;
  readonly origin: string;
}

/** Null while the .info names no pid, port and host, as main finds a server to attach to. */
export function serverAddress(home: string): ServerAddress | null {
  const hint = hintFrom(readServerInfo(home));
  return hint === null ? null : { ...hint, origin: originOf(hint) };
}

/** local-token's secret, or null while there's none the server could use. */
export function localToken(home: string): string | null {
  return readToken(home)?.secret ?? null;
}

export interface ApiInit extends RequestInit {
  /** 30 s by default; a stream read past it is cut. */
  readonly timeoutMs?: number;
}

/**
 * A request to the server holding `home`, as main's forwarder sends one: to the address the .info
 * records, with the Bearer from local-token, and no Origin, cookie or proof.
 */
export async function api(home: string, path: string, init: ApiInit = {}): Promise<Response> {
  const server = serverAddress(home);
  const token = localToken(home);
  if (server === null || token === null) {
    throw new Error(`no server with a token holds ${home}`);
  }
  const { timeoutMs = 30_000, headers, ...rest } = init;
  const sent = new Headers(headers);
  sent.set("authorization", `Bearer ${token}`);
  return fetch(new URL(path, server.origin), {
    ...rest,
    headers: sent,
    signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

/** On macOS, `pid`'s environment as ps shows it, with its command line first; null elsewhere. */
export function environmentOf(pid: number): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return execFileSync("ps", ["-wwE", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  } catch {
    return null;
  }
}

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

/** A smoke's checks, each printed as it's added. */
export class Checks {
  readonly list: Check[] = [];

  add(name: string, pass: boolean, detail = ""): boolean {
    this.list.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : ` — ${detail}`}`);
    return pass;
  }

  /** Runs `body`, which adds its own checks; a throw fails `name` with the error's first line. */
  async step(name: string, body: () => Promise<void>): Promise<boolean> {
    try {
      await body();
      return true;
    } catch (error) {
      this.add(name, false, error instanceof Error ? error.message.split("\n")[0] : String(error));
      return false;
    }
  }

  get pass(): boolean {
    return this.list.every((check) => check.pass);
  }
}

/** macOS's preferences for `domain`, kept as they were; restore() puts them back. */
class Preferences {
  readonly #domain: string;
  readonly #saved: string | null;
  readonly #before: string | null;

  constructor(domain: string, folder: string) {
    this.#domain = domain;
    this.#before = this.#read();
    // `defaults export` writes an empty plist for a domain that doesn't exist.
    this.#saved = this.#before === null ? null : join(folder, `${domain}.plist`);
    if (this.#saved !== null) execFileSync("defaults", ["export", domain, this.#saved]);
  }

  /** Whether they read as they did before the run. */
  restore(): { readonly restored: boolean; readonly detail: string } {
    const file = join(homedir(), "Library", "Preferences", `${this.#domain}.plist`);
    if (this.#saved === null) {
      spawnSync("defaults", ["delete", this.#domain], { stdio: "ignore" });
      // cfprefsd leaves the file behind, empty.
      rmSync(file, { force: true });
      const absent = this.#read() === null && !existsSync(file);
      return {
        restored: absent,
        detail: absent ? `${file} is gone, as before` : `${file} remains`,
      };
    }
    execFileSync("defaults", ["import", this.#domain, this.#saved]);
    const same = this.#read() === this.#before;
    return {
      restored: same,
      detail: same ? `${this.#domain} as it was` : `${this.#domain} differs`,
    };
  }

  #read(): string | null {
    const read = spawnSync("defaults", ["read", this.#domain], { encoding: "utf8" });
    return read.status === 0 ? read.stdout : null;
  }
}

export interface SmokeOptions {
  /** Names the run's folder and the smoke in its output. */
  readonly label: string;
  /** --headful, and the smoke's own arguments. */
  readonly argv?: readonly string[];
  /** On macOS, put live.laplace.eidolon's preferences back as they were: a packaged run writes them. */
  readonly restoresPreferences?: boolean;
  readonly fakes?: FakesOptions;
}

export interface Smoke {
  readonly label: string;
  readonly args: SmokeArgs;
  readonly run: Run;
  readonly fakes: Fakes;
  /** The app's environment: every launch gets it, a server started for the app to attach to too. */
  readonly env: Readonly<Record<string, string>>;
  readonly processes: Processes;
  readonly focus: FocusWatch;
  readonly checks: Checks;
  /** Starts `app` with `extra` arguments, tracked, its output in the scratch folder. */
  launch(what: string, app: AppLaunch, extra?: readonly string[]): Started;
  /** Starts the app's main process, as launch("main") does, and has the focus watch check it. */
  start(app: AppLaunch, extra?: readonly string[]): Started;
  /** `app` under Playwright's Electron driver, tracked, its main watched: unpackaged only. */
  drive(app: AppLaunch, extra?: readonly string[]): Promise<DrivenApp>;
  /** A second launch of `app` with --quit, as a terminal would quit it; null code at the timeout. */
  quit(app: AppLaunch, timeoutMs?: number): Promise<SecondLaunch>;
  log(name: LogName): string;
  waitForLine(name: LogName, pattern: string | RegExp, options?: WaitOptions): Promise<string>;
  /** The server on the run's home. */
  server(): ServerAddress | null;
  api(path: string, init?: ApiInit): Promise<Response>;
  /**
   * Adds the check that the canary key in the smoke's own environment never reached the backend,
   * which must be running: no account but the fakes' takes a key from its environment, and on
   * macOS the canary isn't in it.
   */
  checkCanary(): Promise<boolean>;
}

/** Playwright's ElectronApplication and the process it started. */
export interface DrivenApp {
  readonly app: import("playwright-core").ElectronApplication;
  readonly main: Started;
}

export interface SecondLaunch {
  readonly code: number | null;
  readonly signal: string | null;
  readonly ms: number;
}

function refuseFakeUi(extra: readonly string[]): void {
  if (extra.includes(FAKE_MEDIA_UI)) {
    throw new Error(`${FAKE_MEDIA_UI} grants the camera and microphone without asking main`);
  }
}

/** Starts a smoke: its run, fakes, environment, focus watch, and the interrupt that ends it. */
export async function startSmoke({
  label,
  argv = process.argv.slice(2),
  restoresPreferences = false,
  fakes: fakesOptions,
}: SmokeOptions): Promise<Smoke & { finish(): Promise<number> }> {
  const args = parseSmokeArgs(argv);
  const run = makeRun(label);
  const canary = `eidolon-smoke-canary-${randomBytes(9).toString("hex")}`;
  process.env[CANARY_NAME] = canary;
  const fakes = await startFakes(fakesOptions);
  const env = appEnv({ homes: run, fakes, background: !args.headful });
  const processes = new Processes();
  const checks = new Checks();
  const preferences =
    restoresPreferences && process.platform === "darwin"
      ? new Preferences(PREFERENCES_DOMAIN, run.scratch)
      : null;
  const skip =
    process.platform !== "darwin" ? "it runs on macOS only" : args.headful ? "--headful" : null;
  const focus = watchFocus({ ours: (pid) => processes.ours(pid), skip });

  // Synchronous: Playwright's own handler exits the process once it has closed Electron.
  const interrupted = (signal: NodeJS.Signals): void => {
    process.stderr.write(`\n${label}: ${signal}, stopping what the smoke started\n`);
    processes.killAllSync();
    preferences?.restore();
    process.stderr.write(`${label}: the run's folder is kept: ${run.root}\n`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);

  const smoke: Smoke = {
    label,
    args,
    run,
    fakes,
    env,
    processes,
    focus,
    checks,
    launch(what, app, extra = []) {
      refuseFakeUi(extra);
      const output = openSync(join(run.scratch, `${what.replace(/\W+/g, "-")}.output.log`), "a");
      try {
        return processes.spawn(what, app.command, [...app.args, ...extra], {
          env,
          stdio: ["ignore", output, output],
        });
      } finally {
        closeSync(output);
      }
    },
    start(app, extra = []) {
      const main = smoke.launch("main", app, extra);
      if (main.child.pid !== undefined) focus.main(main.child.pid);
      return main;
    },
    async drive(app, extra = []) {
      refuseFakeUi(extra);
      const { _electron } = await import("playwright-core");
      const driven = await _electron.launch({
        executablePath: app.command,
        args: [...app.args, ...extra],
        env: { ...env },
        timeout: 60_000,
      });
      const child: ChildProcess = driven.process();
      const main = processes.track("main", child);
      if (child.pid !== undefined) focus.main(child.pid);
      return { app: driven, main };
    },
    async quit(app, timeoutMs = 30_000) {
      const startedAt = Date.now();
      const second = smoke.launch("quit", app, ["--quit"]);
      const timer = setTimeout(() => second.child.kill("SIGKILL"), timeoutMs);
      const { code, signal } = await second.exited;
      clearTimeout(timer);
      return { code: signal === "SIGKILL" ? null : code, signal, ms: Date.now() - startedAt };
    },
    log: (name) => readLog(run, name),
    waitForLine: (name, pattern, options) => waitForLine(run, name, pattern, options),
    server: () => serverAddress(run.home),
    api: (path, init) => api(run.home, path, init),
    async checkCanary() {
      const name = `the canary ${CANARY_NAME} in the smoke's environment never reached the backend`;
      const server = serverAddress(run.home);
      const response = await api(run.home, "/api/local/accounts");
      if (!response.ok)
        return checks.add(name, false, `GET /api/local/accounts: ${response.status}`);
      const { accounts } = (await response.json()) as AccountsResponse;
      const fromEnv = accounts.filter((account) => account.key.source === "env").map((a) => a.id);
      const leaked = fromEnv.filter((id) => !FAKE_ACCOUNTS.includes(id));
      const environment = server === null ? null : environmentOf(server.pid);
      const inEnvironment = environment?.includes(canary) ?? false;
      return checks.add(
        name,
        leaked.length === 0 && !inEnvironment,
        `accounts keyed from the environment: ${fromEnv.join(", ") || "none"}; ${
          environment === null
            ? "its environment unread here"
            : `its environment ${inEnvironment ? "holds" : "lacks"} the canary`
        }`,
      );
    },
  };

  async function finish(): Promise<number> {
    const left = await processes.settle(10_000);
    checks.add(
      "nothing the smoke started is left running",
      left.length === 0,
      left.join("; ") || "every process stopped",
    );
    if (left.length > 0) {
      await processes.stopAll();
      const still = await processes.settle(5000);
      if (still.length > 0) checks.add("what was left is stopped", false, still.join("; "));
    }
    const report = await focus.stop();
    if (report.skipped === null) {
      const front = Object.entries(report.front).map(([name, n]) => `${name} ×${n}`);
      const types = Object.entries(report.types).map(([type, n]) => `${type} ×${n}`);
      checks.add(
        "the focus watch: the app never in front, no prompt, main an accessory",
        report.failures.length === 0,
        `${report.samples} samples over ${report.seconds.toFixed(1)} s (longest gap ${report.maxGapMs} ms); in front: ${front.join(", ") || "nothing"}; main: ${types.join(", ") || "never seen"}${report.failures.length > 0 ? `; ${report.failures.join("; ")}` : ""}`,
      );
    } else console.log(`(the focus watch is off: ${report.skipped})`);
    checks.add(
      "the fakes answered every request: each carried their key, to a route they serve",
      fakes.refused.length === 0 && fakes.unknown.length === 0,
      `answered ${JSON.stringify(fakes.counts())}; refused ${fakes.refused.join(", ") || "none"}; unknown ${fakes.unknown.join(", ") || "none"}`,
    );
    await fakes.stop();
    if (preferences !== null) {
      const { restored, detail } = preferences.restore();
      checks.add("macOS's preferences for the app are as they were", restored, detail);
    }
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    const passed = checks.list.filter((check) => check.pass).length;
    if (checks.pass) rmSync(run.root, { recursive: true, force: true });
    console.log(
      `${label}: ${passed}/${checks.list.length} passed${checks.pass ? "" : `; the run's folder is kept: ${run.root}`}`,
    );
    return checks.pass ? 0 : 1;
  }

  return { ...smoke, finish };
}

/** Runs `body` as a smoke and exits with its verdict; a throw fails it with the error. */
export async function runSmoke(
  options: SmokeOptions,
  body: (smoke: Smoke) => Promise<void>,
): Promise<never> {
  const smoke = await startSmoke(options);
  try {
    await body(smoke);
  } catch (error) {
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    smoke.checks.add(
      `${options.label} ran to its end`,
      false,
      text.split("\n").slice(0, 4).join(" | "),
    );
  }
  process.exit(await smoke.finish());
}
