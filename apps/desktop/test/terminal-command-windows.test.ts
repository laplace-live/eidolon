// The terminal command on Windows, for real: commandState and changeCommand running the PATH script
// on a scratch key under HKCU, never the real Environment, and the .cmd launcher against a stand-in
// install whose Eidolon.exe is this Node. Windows only.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BACKEND_RUNTIME_ARGS } from "../src/main/controller.ts";
import { STRINGS } from "../src/main/strings.ts";
import { type CommandHost, changeCommand, commandState } from "../src/main/terminal-command.ts";
import { powershellArgs } from "../src/main/update-signature.ts";

const WINDOWS = process.platform === "win32";
const LAUNCHER = join(import.meta.dirname, "..", "launchers", "win", "eidolon.cmd");
const TEST_KEY = "Software\\Eidolon Test";
/** Characters cmd.exe and PowerShell treat specially, and some that aren't ASCII. */
const AWKWARD = "Eidolon Test (x) & 中文 O’Neil";

function literal(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

/** Runs `script` on Windows PowerShell as the app does, without PowerShell 7's module path. */
function powershell(script: string): string {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^psmodulepath$/i.test(name)) delete env[name];
  return execFileSync("powershell.exe", powershellArgs(script), {
    encoding: "utf8",
    env,
    windowsHide: true,
  });
}

type Values = Record<string, { kind: string; value: string }>;

/** The values of HKCU's `key` as the registry holds them, or null when there's no such key. */
function readKey(key: string): Values | null {
  const out = powershell(
    [
      "$ProgressPreference = 'SilentlyContinue'",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
      `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${literal(key)})`,
      "if ($null -eq $k) { [Console]::Out.Write('null'); exit 0 }",
      "$values = @{}",
      "foreach ($n in $k.GetValueNames()) {",
      "  $values[$n] = @{ kind = [string]$k.GetValueKind($n); value = [string]$k.GetValue($n, '', 'DoNotExpandEnvironmentNames') }",
      "}",
      "[Console]::Out.Write((ConvertTo-Json -InputObject $values -Compress -Depth 3))",
    ].join("\n"),
  );
  return JSON.parse(out.trim());
}

/** Sets HKCU's `key` values, each as its kind, or deletes the ones given null. */
function writeKey(key: string, values: Record<string, { kind: string; value: string } | null>) {
  powershell(
    [
      `$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${literal(key)})`,
      ...Object.entries(values).map(([name, entry]) =>
        entry === null
          ? `$k.DeleteValue(${literal(name)}, $false)`
          : `$k.SetValue(${literal(name)}, ${literal(entry.value)}, ${literal(entry.kind)})`,
      ),
    ].join("\n"),
  );
}

/** Deletes `key`, then the test keys' parent when nothing else is in it. */
function deleteKey(key: string) {
  powershell(
    [
      `[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(${literal(key)}, $false)`,
      `$parent = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${literal(TEST_KEY)})`,
      "if ($null -ne $parent) {",
      "  $empty = $parent.SubKeyCount -eq 0 -and $parent.ValueCount -eq 0",
      "  $parent.Dispose()",
      `  if ($empty) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey(${literal(TEST_KEY)}, $false) }`,
      "}",
    ].join("\n"),
  );
}

/** A path as Windows compares it: its long form, without case. */
function same(path: string): string {
  return realpathSync.native(path).toLowerCase();
}

// A skipped suite's body still runs to collect its tests: what touches the disk waits for beforeAll.
describe.runIf(WINDOWS)("the PATH script on a scratch key", () => {
  const key = `${TEST_KEY}\\${randomUUID()}`;
  const warn: string[] = [];
  let root = "";
  let install = "";
  let folder = "";
  let host: CommandHost;
  const path = (value: string, kind: string) => ({ kind, value });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "eidolon-path-"));
    install = join(root, AWKWARD);
    folder = join(install, "resources", "bin");
    mkdirSync(folder, { recursive: true });
    host = {
      platform: "win32",
      resourcesPath: join(install, "resources"),
      unavailable: null,
      strings: () => STRINGS.en,
      log: { info: () => {}, warn: (line) => warn.push(line) },
      userKey: key,
    };
  });

  afterAll(() => {
    delete process.env.EIDOLON_TEST_ROOT;
    deleteKey(key);
    rmSync(root, { recursive: true, force: true });
  }, 60_000);

  test("adds the folder once, keeping the value's kind and every other entry, then removes it", async () => {
    const others = "C:\\Other;%SystemRoot%\\Tools";
    writeKey(key, { Path: path(others, "String"), Kept: path("yes", "String") });
    expect(await commandState(host)).toEqual({ state: "absent", path: folder });
    for (let i = 0; i < 2; i++) {
      expect(await changeCommand(host, "install")).toEqual({
        command: { state: "installed", path: folder },
      });
      expect(readKey(key)).toEqual({
        Path: path(`${others};${folder}`, "String"),
        Kept: path("yes", "String"),
      });
    }
    expect(await commandState(host)).toEqual({ state: "installed", path: folder });
    expect(await changeCommand(host, "remove")).toEqual({
      command: { state: "absent", path: folder },
    });
    expect(readKey(key)).toEqual({ Path: path(others, "String"), Kept: path("yes", "String") });
    expect(warn).toEqual([]);
  }, 180_000);

  test("knows the folder spelled otherwise: a variable, another case, a trailing backslash", async () => {
    process.env.EIDOLON_TEST_ROOT = install;
    const spelled = "%EIDOLON_TEST_ROOT%\\RESOURCES\\BIN\\;C:\\Other";
    writeKey(key, { Path: path(spelled, "ExpandString") });
    expect(await commandState(host)).toEqual({ state: "installed", path: folder });
    expect(await changeCommand(host, "install")).toEqual({
      command: { state: "installed", path: folder },
    });
    expect(readKey(key)?.Path).toEqual(path(spelled, "ExpandString"));
    expect(await changeCommand(host, "remove")).toEqual({
      command: { state: "absent", path: folder },
    });
    expect(readKey(key)?.Path).toEqual(path("C:\\Other", "ExpandString"));
    expect(warn).toEqual([]);
  }, 180_000);

  test("with no Path, adds one as REG_EXPAND_SZ", async () => {
    writeKey(key, { Path: null });
    expect(await commandState(host)).toEqual({ state: "absent", path: folder });
    expect(await changeCommand(host, "install")).toEqual({
      command: { state: "installed", path: folder },
    });
    expect(readKey(key)?.Path).toEqual(path(folder, "ExpandString"));
    expect(await changeCommand(host, "remove")).toEqual({
      command: { state: "absent", path: folder },
    });
    expect(readKey(key)?.Path).toEqual(path("", "ExpandString"));
    expect(warn).toEqual([]);
  }, 180_000);

  test("the scratch key is gone afterwards", () => {
    deleteKey(key);
    expect(readKey(key)).toBeNull();
  }, 60_000);
});

describe.runIf(WINDOWS)("the .cmd launcher against a stand-in install", () => {
  let root = "";
  let install = "";
  let launcher = "";
  /** Where the stand-in CLI writes what it got. */
  const CLI = [
    "process.stdout.write(JSON.stringify({",
    "  execPath: process.execPath,",
    "  execArgv: process.execArgv,",
    "  argv: process.argv.slice(1),",
    "  env: Object.fromEntries(",
    '    ["ELECTRON_RUN_AS_NODE", "EIDOLON_APP_ROOT", "EIDOLON_NO_DOTENV", "EIDOLON_HOME"].map(',
    "      (name) => [name, process.env[name] ?? null],",
    "    ),",
    "  ),",
    "}));",
    'if (process.argv.at(-1) === "exit-7") process.exitCode = 7;',
    "",
  ].join("\n");

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "eidolon-cmd-"));
    install = join(root, AWKWARD);
    mkdirSync(join(install, "resources", "bin"), { recursive: true });
    mkdirSync(join(install, "resources", "eidolon", "dist"), { recursive: true });
    copyFileSync(process.execPath, join(install, "Eidolon.exe"));
    launcher = join(install, "resources", "bin", "eidolon.cmd");
    copyFileSync(LAUNCHER, launcher);
    writeFileSync(join(install, "resources", "eidolon", "dist", "cli.js"), CLI);
  }, 60_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** cmd.exe running the launcher with `args` as typed, the way a terminal does. */
  function cmd(args: string, env: NodeJS.ProcessEnv) {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", `""${launcher}"${args}"`], {
      encoding: "utf8",
      env,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }

  test("with arguments, runs the CLI on the install's binary as Node, exiting as it does", () => {
    const env = {
      ...process.env,
      NODE_OPTIONS: undefined,
      ELECTRON_RUN_AS_NODE: undefined,
      EIDOLON_HOME: "C:\\an eidolon home",
    };
    const run = cmd(' search --help "two words" "a & b"', env);
    expect([run.status, run.stderr]).toEqual([0, ""]);
    const got = JSON.parse(run.stdout);
    expect(same(got.execPath)).toBe(same(join(install, "Eidolon.exe")));
    expect(got.execArgv).toEqual([...BACKEND_RUNTIME_ARGS]);
    expect(same(got.argv[0])).toBe(same(join(install, "resources", "eidolon", "dist", "cli.js")));
    expect(got.argv.slice(1)).toEqual(["search", "--help", "two words", "a & b"]);
    expect(got.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      EIDOLON_NO_DOTENV: "1",
      EIDOLON_HOME: "C:\\an eidolon home",
    });
    expect(same(got.env.EIDOLON_APP_ROOT)).toBe(same(join(install, "resources", "eidolon")));
    expect(cmd(" search exit-7", env).status).toBe(7);
  }, 60_000);

  test("with none, starts the install's binary with nothing to run and ELECTRON_RUN_AS_NODE cleared", async () => {
    // The stand-in is Node, so a preload stands in for the app: it records how it started, then
    // exits before Node's REPL would. Forward slashes: NODE_OPTIONS takes a backslash as an escape.
    const opened = join(root, "opened.json");
    const preload = join(root, "opened.cjs");
    writeFileSync(
      preload,
      `require("node:fs").writeFileSync(${JSON.stringify(opened)}, JSON.stringify({ argv: process.argv, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null })); process.exit(0);\n`,
    );
    const run = cmd("", {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: `--require "${preload.replaceAll("\\", "/")}"`,
    });
    expect([run.status, run.stdout, run.stderr]).toEqual([0, "", ""]);
    const deadline = Date.now() + 30_000;
    while (!existsSync(opened) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const started = JSON.parse(readFileSync(opened, "utf8"));
    expect(started.runAsNode).toBeNull();
    expect(started.argv).toHaveLength(1);
    expect(same(started.argv[0])).toBe(same(join(install, "Eidolon.exe")));
  }, 60_000);
});
