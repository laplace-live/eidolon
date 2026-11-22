// `node apps/desktop/scripts/update-test.ts <older build's outputs> <newer build's outputs>`, the
// update test desktop.yml runs on a CI runner after signing two versions that read the feed
// http://127.0.0.1:8765/: the older one installed and run in background mode, updated through its
// real updater from the newer one's files served there, checked to be the newer, then removed. A
// PASS or FAIL line per check, and exit 1 when one failed.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { appEnv } from "./smoke/env.ts";
import {
  Checks,
  installedBinary,
  installer,
  makeRun,
  readLog,
  sleep,
  until,
  within,
} from "./smoke/kit.ts";
import { namesUninstaller, silentUninstall, UNINSTALLER, uninstallEntries } from "./smoke/nsis.ts";
import { lineTime } from "./smoke/packaged.ts";
import { Processes, processTable, type Started } from "./smoke/processes.ts";
import {
  type Feed,
  feedFiles,
  manifestName,
  readManifest,
  type Served,
  servedSummary,
  startFeed,
  updateFile,
  wantedNames,
} from "./update-test/feed.ts";
import {
  appProcesses,
  atVersion,
  defaultLogs,
  macVersions,
  mains,
  readWindowsVersions,
  type Versions,
  versionsText,
} from "./update-test/installs.ts";
import { follow, startedVersion, tail, updateSteps } from "./update-test/steps.ts";

const LABEL = "update-test";
const TARGET = `${process.platform}-${process.arch}`;
/** desktop.yml's feed_url for both builds. */
const FEED_PORT = 8765;
// Each wait's limit. The NSIS setup alone took 58 s on windows-latest, and an update also runs the
// old version's uninstaller.
const INSTALL_MS = 180_000;
const EXIT_MS = 120_000;
const UPDATED_MS = 600_000;
const RELAUNCH_MS = 120_000;
const STARTED_MS = 60_000;
const QUIT_MS = 60_000;
const UNINSTALL_MS = 120_000;
const TAIL_LINES = 25;
/** Squirrel.Mac's ShipIt logs here, under the app's bundle identifier. */
const SHIPIT = join(homedir(), "Library", "Caches", "live.laplace.eidolon.ShipIt");

interface Plan {
  readonly platform: "darwin" | "win32";
  readonly oldOutputs: string;
  readonly newOutputs: string;
  readonly oldVersion: string;
  readonly newVersion: string;
  /** The older build's DMG or NSIS setup. */
  readonly installer: string;
  /** The file electron-updater downloads: the zip or the setup. */
  readonly update: string;
  /** What electron-updater asks the feed for beside the manifest. */
  readonly wanted: readonly string[];
}

/** The two builds to test, or why there's no test to run here. */
function plan(args: readonly string[]): Plan | string {
  if (process.env.CI !== "true") {
    return (
      "it installs the app for this user, and the app the update starts again runs on the default " +
      "profile and data home, so it runs only on a CI runner, where CI=true"
    );
  }
  if (TARGET !== "darwin-arm64" && TARGET !== "win32-x64") {
    return `it runs on macOS arm64 and Windows x64, not ${TARGET}`;
  }
  const [older, newer] = args;
  if (args.length !== 2 || !older || !newer) {
    return "usage: node apps/desktop/scripts/update-test.ts <older build's outputs> <newer build's outputs>";
  }
  const platform = process.platform as "darwin" | "win32";
  const [oldOutputs, newOutputs] = [resolve(older), resolve(newer)];
  const name = manifestName(platform);
  const read = (folder: string) => {
    try {
      return readManifest(readFileSync(join(folder, name), "utf8"));
    } catch {
      return null;
    }
  };
  const [oldManifest, newManifest] = [read(oldOutputs), read(newOutputs)];
  if (!oldManifest?.version || !newManifest?.version) {
    return `each build's outputs need electron-builder's ${name}, naming its version: ${oldOutputs}, ${newOutputs}`;
  }
  if (oldManifest.version === newManifest.version) {
    return `both builds are ${newManifest.version}: package the older one at a lower version`;
  }
  const update = updateFile(newManifest, platform);
  if (update === null) {
    return `${join(newOutputs, name)} names no ${platform === "darwin" ? "zip" : "setup"}`;
  }
  let setup: string;
  try {
    setup = installer(platform, oldOutputs);
  } catch (error) {
    return (error as Error).message;
  }
  if (platform === "win32" && existsSync(dirname(installedBinary()))) {
    return `Eidolon is already installed for this user in ${dirname(installedBinary())}. The test installs its own there and uninstalls it after, so it runs only where none is`;
  }
  return {
    platform,
    oldOutputs,
    newOutputs,
    oldVersion: oldManifest.version,
    newVersion: newManifest.version,
    installer: setup,
    update,
    wanted: wantedNames(newManifest, update, oldManifest.version),
  };
}

const outcome = plan(process.argv.slice(2));
if (typeof outcome === "string") {
  console.error(`${LABEL}: ${outcome}`);
  process.exit(2);
}
const planned: Plan = outcome;
const { platform, oldVersion, newVersion } = planned;
const run = makeRun(LABEL);
const checks = new Checks();
const processes = new Processes();
// No account: nothing in an update needs one, and the backend serves without.
const env = { ...appEnv({ homes: run, background: true }), EIDOLON_DESKTOP_UPDATE_TEST: "1" };
/** On macOS a copy Squirrel.Mac updates in place; on Windows NSIS's per-user folder. */
const install =
  platform === "darwin"
    ? join(run.root, "Applications", "Eidolon.app")
    : dirname(installedBinary());
const binary =
  platform === "darwin" ? join(install, "Contents", "MacOS", "Eidolon") : installedBinary();
/** Where the app the update starts again logs: the default profile's. */
const relaunchLogs = defaultLogs(platform, process.env, homedir());

function seconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1);
}

function text(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Fails `name` and prints the last lines of each log that says why. */
function failed(name: string, detail: string, logs: Readonly<Record<string, string>>): false {
  checks.add(name, false, detail);
  for (const [log, content] of Object.entries(logs)) {
    const lines = tail(content, TAIL_LINES);
    console.log(
      lines.length === 0
        ? `  ${log} holds nothing`
        : `  ${log}'s last ${lines.length} lines:\n${lines.map((line) => `    ${line}`).join("\n")}`,
    );
  }
  return false;
}

/** The logs that say why the update stopped: main.log, and on macOS Squirrel.Mac's ShipIt's. */
function updateLogs(): Record<string, string> {
  return {
    "main.log": readLog(run, "main"),
    ...(platform === "darwin" ? { ShipIt_stderr: text(join(SHIPIT, "ShipIt_stderr.log")) } : {}),
  };
}

/** Runs `body`, which adds `name`'s check and returns its verdict; a throw fails it. */
async function check(name: string, body: () => Promise<boolean>): Promise<boolean> {
  let pass = false;
  await checks.step(name, async () => {
    pass = await body();
  });
  return pass;
}

/** A tool's run that must succeed; its output names why when it doesn't. */
function tool(command: string, args: readonly string[]): void {
  const ran = spawnSync(command, args, { encoding: "utf8", timeout: 300_000 });
  if (ran.status !== 0) {
    const said = `${ran.stdout ?? ""}${ran.stderr ?? ""}`.trim().split(/\r?\n/).at(-1);
    throw new Error(
      `${command} ${args[0]} exited ${ran.status ?? ran.signal}: ${said ?? ran.error}`,
    );
  }
}

/** The install as paths a process can name it by: as given, and with links resolved. */
function installPaths(): string[] {
  return [...new Set([install, existsSync(install) ? realpathSync(install) : install])];
}

/** Every process running the install's own binaries. */
async function fromInstall() {
  const table = await processTable();
  return installPaths().flatMap((path) => appProcesses(table, path, platform));
}

const currentVersions = (): Promise<Versions> =>
  platform === "darwin" ? Promise.resolve(macVersions(install)) : readWindowsVersions(install);

/** The feed, each request it answers logged in the run's folder; null when it can't serve. */
async function serve(): Promise<Feed | null> {
  const name = `the feed serves ${newVersion}'s manifest, ${platform === "darwin" ? "zip" : "setup"} and blockmap, and ${oldVersion}'s blockmap, on 127.0.0.1:${FEED_PORT}`;
  let feed: Feed | null = null;
  await check(name, async () => {
    const files = feedFiles(planned.oldOutputs, planned.newOutputs);
    const missing = planned.wanted.filter((wanted) => !files.has(wanted));
    if (missing.length > 0) {
      return checks.add(
        name,
        false,
        `electron-updater would ask for what neither build's outputs hold: ${missing.join(", ")}`,
      );
    }
    const log = join(run.scratch, "feed.log");
    feed = await startFeed(files, {
      port: FEED_PORT,
      onServed: (entry: Served) =>
        appendFileSync(
          log,
          `${entry.method} ${entry.path}${entry.range === null ? "" : ` (${entry.range})`}: ${entry.status}, ${entry.bytes} bytes${entry.complete ? "" : ", cut short"}\n`,
        ),
    });
    return checks.add(name, true, [...files.keys()].join(", "));
  });
  return feed;
}

/** macOS: the DMG's app, copied out as someone dragging it would, into the run's folder. */
function installMac(): Promise<boolean> {
  const name = `${oldVersion} installs: its DMG's app, copied into a temporary folder`;
  return check(name, async () => {
    const mount = join(run.root, "dmg");
    mkdirSync(mount, { recursive: true });
    mkdirSync(dirname(install), { recursive: true });
    tool("hdiutil", [
      "attach",
      "-nobrowse",
      "-noautoopen",
      "-noverify",
      "-readonly",
      "-mountpoint",
      mount,
      planned.installer,
    ]);
    try {
      tool("ditto", [join(mount, "Eidolon.app"), install]);
    } finally {
      if (spawnSync("hdiutil", ["detach", mount]).status !== 0) {
        await sleep(2000);
        spawnSync("hdiutil", ["detach", "-force", mount]);
      }
    }
    const versions = macVersions(install);
    return checks.add(
      name,
      atVersion(versions, oldVersion),
      `${basename(planned.installer)} to ${install}: ${versionsText(versions)}`,
    );
  });
}

/** Windows: the NSIS setup, silently, for this user, as the packaged smoke installs it. */
function installWindows(): Promise<boolean> {
  const name = `${oldVersion} installs: its NSIS setup, silently, for this user`;
  return check(name, async () => {
    const at = Date.now();
    const setup = processes.spawn("setup", planned.installer, ["/S"], { stdio: "ignore" });
    const exit = await within(setup.exited, INSTALL_MS);
    const versions = await readWindowsVersions(install);
    return checks.add(
      name,
      exit?.code === 0 && existsSync(binary) && atVersion(versions, oldVersion),
      `${basename(planned.installer)} /S exited ${exit === null ? `not within ${INSTALL_MS / 1000} s` : (exit.code ?? exit.signal)} after ${seconds(Date.now() - at)} s; ${versionsText(versions)}`,
    );
  });
}

function launch(): Started {
  const output = openSync(join(run.scratch, "main.output.log"), "a");
  try {
    return processes.spawn("main", binary, [`--user-data-dir=${run.profile}`], {
      env,
      stdio: ["ignore", output, output],
    });
  } finally {
    closeSync(output);
  }
}

/** main.log from the updater's start to the install, each step within its time of the last. */
async function followUpdate(main: Started): Promise<boolean> {
  const steps = updateSteps(newVersion);
  let since = Date.now();
  let seen = 0;
  let snapshotAt = 0;
  for (;;) {
    // Before the read: main writes its last line and quits at once, and an exit seen first means
    // the log read after it is whole.
    const exit = main.child.exitCode ?? main.child.signalCode;
    const progress = follow(readLog(run, "main"), steps);
    const now = Date.now();
    for (; seen < progress.lines.length; seen++) {
      const at = lineTime(progress.lines[seen] as string) ?? now;
      checks.add(
        steps[seen]?.name ?? "",
        true,
        `${seconds(at - since)} s after ${seen === 0 ? "the launch" : "the step before"}`,
      );
      since = at;
    }
    const step = steps[seen];
    if (step === undefined) return true;
    const why =
      progress.stopped !== null
        ? `main.log stopped at: ${progress.stopped}`
        : exit !== null
          ? `main exited (${exit}) before it`
          : now - since > step.ms
            ? `no "${step.line}" within ${step.ms / 1000} s`
            : null;
    if (why !== null) {
      return failed(
        step.name,
        `${why}; the last step's line: ${progress.lines.at(-1) ?? "none"}`,
        updateLogs(),
      );
    }
    // What runs under main is tracked as it starts, so nothing it leaves behind goes unseen.
    if (now - snapshotAt >= 5000) {
      await processes.snapshot();
      snapshotAt = Date.now();
    }
    await sleep(250);
  }
}

function checkServed({ served }: Feed): void {
  const manifest = manifestName(platform);
  const answered = (name: string, statuses: readonly number[]) =>
    served.some(
      (entry) => entry.name === name && statuses.includes(entry.status) && entry.complete,
    );
  checks.add(
    `the feed served ${newVersion}: its manifest, then the ${platform === "darwin" ? "zip" : "setup"} whole or in ranges`,
    answered(manifest, [200]) && answered(planned.update, [200, 206]),
    [manifest, ...planned.wanted].map((name) => servedSummary(served, name)).join("; "),
  );
}

function quitsToInstall(main: Started): Promise<boolean> {
  const name = `${oldVersion}'s main quits for the install`;
  return check(name, async () => {
    const at = Date.now();
    const exit = await within(main.exited, EXIT_MS);
    if (exit === null) {
      return failed(
        name,
        `still running ${EXIT_MS / 1000} s after it logged the install`,
        updateLogs(),
      );
    }
    return checks.add(
      name,
      exit.code === 0,
      `exit ${exit.code ?? exit.signal}, ${seconds(Date.now() - at)} s after it logged the install`,
    );
  });
}

function updated(): Promise<boolean> {
  const name = `the installed app is ${newVersion}`;
  return check(name, async () => {
    const at = Date.now();
    const versions = await until(
      currentVersions,
      (now) => atVersion(now, newVersion),
      UPDATED_MS,
      platform === "win32" ? 2000 : 500,
    );
    if (!atVersion(versions, newVersion)) {
      return failed(name, `${versionsText(versions)} after ${UPDATED_MS / 1000} s`, updateLogs());
    }
    return checks.add(
      name,
      true,
      `${versionsText(versions)}, ${seconds(Date.now() - at)} s after ${oldVersion} quit`,
    );
  });
}

/**
 * The app Squirrel.Mac or the NSIS setup starts again, if one does: started outside this test's
 * environment, on the default profile, and on macOS out of background mode. Its main.log must name
 * the new version; then --quit through that profile's lock, and its processes by pid after.
 */
function relaunched(logFrom: number): Promise<boolean> {
  const name = `the app the update starts again, if it does, is ${newVersion} and quits`;
  return check(name, async () => {
    const found = await until(
      async () => mains(await fromInstall()),
      (rows) => rows.length > 0,
      RELAUNCH_MS,
      1000,
    );
    if (found.length === 0) {
      return checks.add(name, true, `none started within ${RELAUNCH_MS / 1000} s`);
    }
    for (const row of found)
      await processes.adopt(`the app started again (pid ${row.pid})`, row.pid);
    const log = join(relaunchLogs, "main.log");
    const version = await until(
      () => startedVersion(text(log).slice(logFrom)),
      (said) => said !== null,
      STARTED_MS,
      500,
    );
    const quit = processes.spawn("quit", binary, ["--quit"], { env, stdio: "ignore" });
    const quitExit = await within(quit.exited, QUIT_MS);
    const left = await until(fromInstall, (rows) => rows.length === 0, QUIT_MS, 500);
    if (left.length > 0) await processes.stopAll();
    const still = await fromInstall();
    return checks.add(
      name,
      version === newVersion && still.length === 0,
      `pid ${found.map((row) => row.pid).join(", ")}; ${log} names ${version ?? "no version"}; --quit exited ${quitExit === null ? "not in time" : (quitExit.code ?? quitExit.signal)}, then ${left.length === 0 ? "it quit" : `${left.length} of its processes were stopped by pid`}${still.length === 0 ? "" : `; still running: ${still.map((row) => row.pid).join(", ")}`}`,
    );
  });
}

/** Windows: the uninstall entry's own command, silently, as the packaged smoke runs it. */
function uninstall(): Promise<boolean> {
  const name = "the uninstaller removes the app silently";
  return check(name, async () => {
    const silent = silentUninstall(await uninstallEntries(), install);
    if (silent === null) {
      return checks.add(
        name,
        false,
        `no uninstall entry names ${join(install, UNINSTALLER)} /currentuser, so nothing ran`,
      );
    }
    const at = Date.now();
    const running = processes.spawn("uninstaller", silent.command, silent.args, {
      stdio: "ignore",
    });
    const exit = await within(running.exited, UNINSTALL_MS);
    // It returns at once, and removes the app from a copy of itself in %TEMP%.
    const gone = await until(
      () => !existsSync(install),
      (yes) => yes,
      UNINSTALL_MS,
      500,
    );
    const entries = (await uninstallEntries()).filter((entry) => namesUninstaller(entry, install));
    return checks.add(
      name,
      exit?.code === 0 && gone && entries.length === 0,
      `${basename(silent.command)} ${silent.args.join(" ")} exited ${exit === null ? "not in time" : (exit.code ?? exit.signal)}; after ${seconds(Date.now() - at)} s ${install} ${gone ? "is gone" : "remains"}, and ${entries.length} uninstall entries name it`,
    );
  });
}

/** The default profile's logs and ShipIt's, into the run's folder, which a failed run uploads. */
function keepLogs(): void {
  const copies: [string, string][] = [[relaunchLogs, join(run.scratch, "default-profile-logs")]];
  if (platform === "darwin") copies.push([SHIPIT, join(run.scratch, "ShipIt")]);
  for (const [from, to] of copies) {
    let names: string[];
    try {
      names = readdirSync(from).filter((name) => name.endsWith(".log"));
    } catch {
      continue;
    }
    mkdirSync(to, { recursive: true });
    for (const name of names) copyFileSync(join(from, name), join(to, name));
  }
}

/** Stops whatever the update left running, then removes the install. */
async function cleanUp(main: Started | null): Promise<void> {
  if (main !== null && main.child.exitCode === null && main.child.signalCode === null) {
    // The update never quit it: --quit through its own profile's lock, then its tree.
    try {
      const quit = processes.spawn("quit", binary, [`--user-data-dir=${run.profile}`, "--quit"], {
        env,
        stdio: "ignore",
      });
      await within(quit.exited, QUIT_MS);
    } catch {
      // The binary is gone mid-update: the tree goes by pid below.
    }
    await within(main.exited, QUIT_MS);
  }
  for (const row of await fromInstall()) {
    await processes.adopt(`${row.command.slice(0, 120)}, from the install`, row.pid);
  }
  await processes.stopAll();
  keepLogs();
  if (platform === "win32") {
    if (existsSync(install)) await uninstall();
    return;
  }
  const copy = dirname(install);
  if (!existsSync(copy)) return;
  rmSync(copy, { recursive: true, force: true });
  checks.add("the updated copy is removed", !existsSync(copy), copy);
}

const interrupted = (signal: NodeJS.Signals): void => {
  process.stderr.write(`\n${LABEL}: ${signal}, stopping what the test started\n`);
  processes.killAllSync();
  process.stderr.write(`${LABEL}: the run's folder is kept: ${run.root}\n`);
  process.exit(signal === "SIGINT" ? 130 : 143);
};
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);

console.log(
  `${LABEL}: ${oldVersion} to ${newVersion} on ${TARGET}, in background mode; the run's folder is ${run.root}`,
);
let feed: Feed | null = null;
let main: Started | null = null;
try {
  feed = await serve();
  if (feed !== null && (platform === "darwin" ? await installMac() : await installWindows())) {
    const logFrom = text(join(relaunchLogs, "main.log")).length;
    main = launch();
    if (await followUpdate(main)) {
      checkServed(feed);
      await quitsToInstall(main);
      if (await updated()) await relaunched(logFrom);
    }
  }
} catch (error) {
  const said = error instanceof Error ? (error.stack ?? error.message) : String(error);
  checks.add(`${LABEL} ran to its end`, false, said.split("\n").slice(0, 4).join(" | "));
} finally {
  await cleanUp(main);
}
const left = await processes.settle(10_000);
checks.add(
  "nothing the test started is left running",
  left.length === 0,
  left.join("; ") || "every process stopped",
);
if (left.length > 0) await processes.stopAll();
await feed?.close();
process.off("SIGINT", interrupted);
process.off("SIGTERM", interrupted);
const passed = checks.list.filter((entry) => entry.pass).length;
if (checks.pass) rmSync(run.root, { recursive: true, force: true, maxRetries: 5 });
console.log(
  `${LABEL}: ${passed}/${checks.list.length} passed${checks.pass ? "" : `; the run's folder is kept: ${run.root}`}`,
);
process.exit(checks.pass ? 0 : 1);
