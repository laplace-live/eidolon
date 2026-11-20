// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/utils/shell.ts@ac78a60, its Windows parts @cb1205e
//
// The shell a task's commands run in, the environment they get, and the kill that takes a command
// with everything it started. On Windows commands run in Git Bash, as pi's do, and an MCP server
// gets the same environment.
import { accessSync, constants } from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { killTree, which } from "@eidolon/config";
import { fold } from "../policy.ts";
import type { PathGuard } from "../types.ts";

export interface ShellConfig {
  readonly shell: string;
  readonly args: readonly string[];
}

function shellPathExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The bash.exe Windows commands run in, as pi finds it: Git Bash where its installer puts it, for
 * everyone or for this user alone, then one on `path` (Cygwin, MSYS2), but never WSL's launcher in
 * System32, which runs a command in Linux, far from the task's folder and its PATH. Null when there
 * is none.
 */
export function windowsBash(path: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const programs = env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs");
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], programs]) {
    if (!root) continue;
    const gitBash = join(root, "Git", "bin", "bash.exe");
    if (shellPathExists(gitBash)) return gitBash;
  }
  const system = env.SystemRoot ?? "C:\\Windows";
  const launchers = ["System32", "Sysnative"].map((folder) => fold(join(system, folder)));
  const folders = path
    .split(delimiter)
    .filter((folder) => folder !== "" && !launchers.includes(fold(resolve(folder))));
  return which("bash", folders.join(delimiter), "win32");
}

// Looked up once, as pi does: a Git installed later shows after the app's next start.
let foundWindowsBash: string | null | undefined;

/** Whether a task may run commands on `platform`: on Windows, only in a bash it finds. */
export function bashOffered(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return platform === "darwin" || platform === "linux";
  if (foundWindowsBash === undefined) foundWindowsBash = windowsBash(process.env.PATH ?? "");
  return foundWindowsBash !== null;
}

/**
 * pi's order: on Windows windowsBash, else /bin/bash, then bash on `path`, the PATH a command gets,
 * then sh.
 */
export function getShellConfig(path: string): ShellConfig {
  if (process.platform === "win32") {
    const bash = windowsBash(path);
    if (bash !== null) return { shell: bash, args: ["-c"] };
    throw new Error(
      "No bash shell found. Install Git for Windows (https://git-scm.com/download/win), or put " +
        "Cygwin's or MSYS2's bash on PATH, then start Eidolon again.",
    );
  }
  if (shellPathExists("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
  const bash = which("bash", path);
  if (bash !== null) return { shell: bash, args: ["-c"] };
  return { shell: which("sh", path) ?? "/bin/sh", args: ["-c"] };
}

/**
 * What a command keeps of the server's environment, by name, besides every LC_* and a PATH of its
 * own. Nothing else passes, so no key the .env put in process.env reaches a command. The proxies are
 * there for npm and git behind one, and SSH_AUTH_SOCK as the owner's own shell has it.
 */
const PASSED: ReadonlySet<string> = new Set([
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
]);

/**
 * What a Windows program needs of the environment that libuv doesn't add back, in any case, as
 * Windows matches names: npx's cache is under LOCALAPPDATA, Go's os.UserConfigDir reads APPDATA,
 * and cmd.exe finds a .cmd through PATHEXT.
 */
const PASSED_ON_WINDOWS: ReadonlySet<string> = new Set([
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "USERDOMAIN",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "COMPUTERNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
]);

/** A command's PATH when none of the server's is left: the system's own, which only root writes. */
const SYSTEM_PATH = ["/usr/bin", "/bin"].join(delimiter);

/** SYSTEM_PATH on Windows, under SystemRoot. */
function windowsSystemPath(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  return [`${root}\\System32`, root].join(";");
}

/** A folder npm and bun put first on a script's PATH, for the package's own tools. */
function isPackageBin(entry: string): boolean {
  const parts = entry.split(sep).filter((part) => part !== "");
  const [folder, bin] = parts.slice(-2).map(fold);
  return parts.length >= 2 && folder === "node_modules" && bin === ".bin";
}

/** The folder `bun run` puts first on a script's PATH where Node is missing: its `node` is Bun. */
function isBunNodeShim(entry: string): boolean {
  return fold(basename(entry)).startsWith("bun-node-");
}

/**
 * `path` without the folders a task could put a program in, ahead of the owner's own: empty and
 * relative entries (the folder a command starts in), every node_modules/.bin (npx and bun run add
 * the server's folder's and each one's above it), Bun's node shim, and every folder `guard` lets
 * the task write. Only this task's: another task's folders stay, and so does a link from a folder
 * kept into one this task writes.
 */
async function commandPath(path: string, guard: PathGuard | undefined): Promise<string> {
  const entries = [...new Set(path.split(delimiter))].filter(
    (entry) => entry !== "" && isAbsolute(entry) && !isPackageBin(entry) && !isBunNodeShim(entry),
  );
  const writable = await Promise.all(
    entries.map((entry) =>
      guard === undefined
        ? false
        : guard.resolve(entry, "write").then(
            () => true,
            () => false,
          ),
    ),
  );
  return entries.filter((_, at) => !writable[at]).join(delimiter);
}

/**
 * The environment a command runs with, made again at each spawn: PASSED's variables, on Windows
 * PASSED_ON_WINDOWS' too, and every LC_* from `from`, its PATH less what commandPath drops, and
 * TERM=dumb, as a command has no terminal. Without `guard`, PATH keeps the folders a task may write.
 */
export async function shellEnv(
  guard?: PathGuard,
  from: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<Record<string, string>> {
  const windows = platform === "win32";
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(from)) {
    if (value === undefined) continue;
    const passed =
      PASSED.has(name) ||
      name.startsWith("LC_") ||
      (windows && PASSED_ON_WINDOWS.has(name.toUpperCase()));
    if (passed) env[name] = value;
  }
  // bash takes an empty PATH, and an unset one, to mean the folder the command starts in.
  env.PATH =
    (await commandPath(from.PATH ?? "", guard)) ||
    (windows ? windowsSystemPath(from) : SYSTEM_PATH);
  env.TERM = "dumb";
  return env;
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Unicode interlinear annotation characters U+FFF9..U+FFFB (crash string-width due to a bug)
 */
export function sanitizeBinaryOutput(str: string): string {
  // All removed characters are single UTF-16 code units, so surrogate pairs are never split.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFF9-\uFFFB]/g, "");
}

/** Kills process `pid` and its process group: a command spawned detached leads its own. */
export function killProcessTree(pid: number): void {
  if (process.platform === "darwin") {
    // macOS signals group members individually after releasing the group lock. A killed
    // child can wake its waiting shell before that shell is signalled, letting `a; b`
    // start b during cancellation (#11252). Stop the group first to reduce this race;
    // this is best-effort, not an atomic freeze. SIGKILL also kills stopped processes.
    // Linux holds tasklist_lock across group signalling; child exit notification needs
    // its write lock, so the shell is signalled before observing the killed child's exit.
    try {
      process.kill(-pid, "SIGSTOP");
    } catch {
      // A failed stop must not prevent the kill attempt or its single-process fallback.
    }
  }
  killTree(pid);
}
