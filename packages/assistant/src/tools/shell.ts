// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/utils/shell.ts@ac78a60
//
// The shell a task's commands run in, the environment they get, and the kill that takes a command
// with everything it started. Commands run on macOS and Linux only.
import { accessSync, constants } from "node:fs";
import { basename, delimiter, isAbsolute, sep } from "node:path";
import { fold } from "../policy.ts";
import type { PathGuard } from "../types.ts";

export interface ShellConfig {
  readonly shell: string;
  readonly args: readonly string[];
}

/**
 * Whether a task may run commands on `platform`: a kill takes a command's process group, which
 * Windows lacks.
 */
export function bashOffered(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "linux";
}

function shellPathExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** pi's order: /bin/bash, then bash on `path`, the PATH a command gets, then sh. */
export function getShellConfig(path: string): ShellConfig {
  if (shellPathExists("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
  const bash = Bun.which("bash", { PATH: path });
  if (bash !== null) return { shell: bash, args: ["-c"] };
  return { shell: Bun.which("sh", { PATH: path }) ?? "/bin/sh", args: ["-c"] };
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

/** A command's PATH when none of the server's is left: the system's own, which only root writes. */
const SYSTEM_PATH = ["/usr/bin", "/bin"].join(delimiter);

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
  const kept = entries.filter((_, at) => !writable[at]);
  // bash takes an empty PATH, and an unset one, to mean the folder the command starts in.
  return kept.length > 0 ? kept.join(delimiter) : SYSTEM_PATH;
}

/**
 * The environment a command runs with, made again at each spawn: PASSED's variables and every
 * LC_* from `from`, its PATH less what commandPath drops, and TERM=dumb, as a command has no
 * terminal. Without `guard`, PATH keeps the folders a task may write.
 */
export async function shellEnv(
  guard?: PathGuard,
  from: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(from)) {
    if (value !== undefined && (PASSED.has(name) || name.startsWith("LC_"))) env[name] = value;
  }
  env.PATH = await commandPath(from.PATH ?? "", guard);
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
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
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
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Fallback to killing just the child if process group kill fails
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already dead
    }
  }
}
