// Copyright (c) 2026 DeepSeek
// SPDX-License-Identifier: MIT
//
// Ported from deepseek-harness apps/desktop/src/command-management.ts@2e39e70496, its PATH edit
// from apps/desktop/scripts/command-path.ps1@2e39e70496
//
// The `eidolon` command for terminals, which the owner installs or removes from Settings alone: on
// macOS a link in /usr/local/bin to the launcher in the app's resources, on Windows that launcher's
// folder on the user's PATH. Electron-free: index.ts hands it the app's facts.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readlink, symlink, unlink } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { CommandAction, CommandChange, CommandState, Unavailable } from "../shared/bridge.ts";
import type { Strings } from "./strings.ts";
import { powershellArgs, powershellExe } from "./update-signature.ts";

/** How a program exited, and what it printed. */
export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a program to its exit; rejects when it can't start or runs out of time. */
export type Runner = (
  file: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly timeout?: number },
) => Promise<RunResult>;

export interface CommandHost {
  readonly platform: NodeJS.Platform;
  /** process.resourcesPath of the packaged app. */
  readonly resourcesPath: string;
  /** optionsUnavailable(...) for this copy. */
  readonly unavailable: Unavailable | null;
  /** The shell's strings now, for macOS's password prompt. */
  readonly strings: () => Strings;
  readonly log: { info(message: string): void; warn(message: string): void };
  /** macOS: the link Install makes; LINK unless a test names another. */
  readonly link?: string;
  /** Windows: the HKCU key whose Path holds the folder; USER_ENVIRONMENT unless a test's. */
  readonly userKey?: string;
  /** Runs osascript and PowerShell, unless a test stands in. */
  readonly run?: Runner;
}

/** macOS: where Install links the launcher. */
export const LINK = "/usr/local/bin/eidolon";
/** Windows: the HKCU key whose Path Windows appends to the system's for new processes. */
export const USER_ENVIRONMENT = "Environment";
/** How long PowerShell may take, its cold start under an antivirus scan included. */
const POWERSHELL_TIMEOUT_MS = 60_000;
/** Another copy's launcher, such as one in an app moved since: Install replaces its link. */
const OTHER_COPY = /\/(?:LAPLACE )?Eidolon\.app\/Contents\/Resources\/bin\/eidolon$/i;

// The elevated steps run only mkdir, ln and rm, on fixed paths: never Eidolon's binary.
const INSTALL_SCRIPT = [
  "on run argv",
  `do shell script "/bin/mkdir -p ${posix.dirname(LINK)} && /bin/ln -sfh " & quoted form of item 1 of argv & " ${LINK}" with prompt (item 2 of argv) with administrator privileges`,
  "end run",
];
const REMOVE_SCRIPT = [
  "on run argv",
  `do shell script "/bin/rm -f ${LINK}" with prompt (item 1 of argv) with administrator privileges`,
  "end run",
];

const runProgram: Runner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", env: options.env, timeout: options.timeout ?? 0, windowsHide: true },
      (error, stdout, stderr) => {
        // A number is the exit code; anything else, a run that didn't start or was killed.
        if (error !== null && typeof error.code !== "number") reject(error);
        else resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr });
      },
    );
  });

/** Where the command stands; only a copy that may offer it reads the system. */
export async function commandState(host: CommandHost): Promise<CommandState> {
  if (host.unavailable !== null) return { state: "unavailable", reason: host.unavailable };
  if (host.platform === "darwin") {
    const link = host.link ?? LINK;
    return linkState(await linkAt(link, launcherOf(host)), link);
  }
  if (host.platform === "win32") {
    const path = folderOf(host);
    try {
      return { state: (await userPath(host, "query")) ? "installed" : "absent", path };
    } catch (error) {
      host.log.warn(`Eidolon: couldn't read your PATH for the eidolon command: ${String(error)}`);
      return { state: "absent", path };
    }
  }
  return { state: "unavailable", reason: "unpackaged" };
}

/** Installs or removes the command, then reads where it stands. */
export async function changeCommand(
  host: CommandHost,
  action: CommandAction,
): Promise<CommandChange> {
  if (host.unavailable !== null) {
    host.log.warn(`Eidolon: this copy can't ${action} the eidolon command (${host.unavailable})`);
    return { command: { state: "unavailable", reason: host.unavailable }, error: "failed" };
  }
  if (host.platform === "darwin") return changeLink(host, action);
  if (host.platform === "win32") return changePath(host, action);
  return { command: await commandState(host), error: "failed" };
}

function launcherOf(host: CommandHost): string {
  return posix.join(host.resourcesPath, "bin", "eidolon");
}

function folderOf(host: CommandHost): string {
  return win32.join(host.resourcesPath, "bin");
}

/** What is at the link's path: nothing, our link, another copy's, or something else. */
type Found = "none" | "ours" | "other-copy" | "foreign";

async function linkAt(link: string, launcher: string): Promise<Found> {
  try {
    if (!(await lstat(link)).isSymbolicLink()) return "foreign";
    const target = posix.resolve(posix.dirname(link), await readlink(link));
    if (target === launcher) return "ours";
    return OTHER_COPY.test(target) ? "other-copy" : "foreign";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // What can't be read may be something else: Install refuses rather than replace it.
    return code === "ENOENT" || code === "ENOTDIR" ? "none" : "foreign";
  }
}

function linkState(found: Found, link: string): CommandState {
  if (found === "ours") return { state: "installed", path: link };
  if (found === "foreign") return { state: "taken", path: link };
  return { state: "absent", path: link };
}

async function writable(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function changeLink(host: CommandHost, action: CommandAction): Promise<CommandChange> {
  const link = host.link ?? LINK;
  const launcher = launcherOf(host);
  const install = action === "install";
  const done: Found = install ? "ours" : "none";
  const found = await linkAt(link, launcher);
  if (found === done) return { command: linkState(found, link) };
  if (found === "foreign") {
    host.log.warn(`Eidolon: didn't ${action} the eidolon command: ${link} isn't Eidolon's`);
    return { command: linkState(found, link), error: "failed" };
  }
  let error: CommandChange["error"];
  if (await writable(posix.dirname(link))) {
    try {
      if (found !== "none") await unlink(link);
      if (install) await symlink(launcher, link);
    } catch (cause) {
      host.log.warn(`Eidolon: couldn't ${action} the eidolon command at ${link}: ${String(cause)}`);
      error = "failed";
    }
  } else {
    const { text } = host.strings();
    error = install
      ? await elevated(host, action, INSTALL_SCRIPT, [launcher, text.installCommandPrompt])
      : await elevated(host, action, REMOVE_SCRIPT, [text.removeCommandPrompt]);
  }
  const now = await linkAt(link, launcher);
  if (error === undefined && now !== done) {
    host.log.warn(`Eidolon: the eidolon command didn't ${action}: ${link} reads as ${now}`);
    error = "failed";
  }
  if (error === undefined) {
    host.log.info(
      install
        ? `Eidolon: installed the eidolon command at ${link}`
        : `Eidolon: removed the eidolon command from ${link}`,
    );
  }
  return { command: linkState(now, link), ...(error && { error }) };
}

/** Runs an AppleScript that asks for an administrator; undefined once it has run. */
async function elevated(
  host: CommandHost,
  action: CommandAction,
  script: readonly string[],
  argv: readonly string[],
): Promise<CommandChange["error"]> {
  const args = [...script.flatMap((line) => ["-e", line]), ...argv];
  let result: RunResult;
  try {
    result = await (host.run ?? runProgram)("/usr/bin/osascript", args, {});
  } catch (error) {
    host.log.warn(`Eidolon: couldn't ask to ${action} the eidolon command: ${String(error)}`);
    return "failed";
  }
  if (result.code === 0) return undefined;
  // osascript's error when the password prompt is cancelled ends with AppleScript's -128.
  if (/\(-128\)\s*$/.test(result.stderr)) {
    host.log.info(`Eidolon: the password prompt to ${action} the eidolon command was cancelled`);
    return "cancelled";
  }
  host.log.warn(
    `Eidolon: couldn't ${action} the eidolon command as an administrator: ${result.stderr.trim()}`,
  );
  return "failed";
}

async function changePath(host: CommandHost, action: CommandAction): Promise<CommandChange> {
  const path = folderOf(host);
  try {
    const present = await userPath(host, action === "install" ? "add" : "remove");
    host.log.info(
      present
        ? `Eidolon: installed the eidolon command: ${path} is on your PATH`
        : `Eidolon: removed the eidolon command: ${path} is off your PATH`,
    );
    return { command: { state: present ? "installed" : "absent", path } };
  } catch (error) {
    host.log.warn(`Eidolon: couldn't ${action} the eidolon command: ${String(error)}`);
    return { command: await commandState(host), error: "failed" };
  }
}

/** Runs userPathScript: whether the folder is on the Path now. */
async function userPath(host: CommandHost, action: "query" | "add" | "remove"): Promise<boolean> {
  // As updater.ts does (electron-builder#7127): PowerShell 7's module path breaks 5.1's.
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^psmodulepath$/i.test(name)) delete env[name];
  const script = userPathScript(action, folderOf(host), host.userKey ?? USER_ENVIRONMENT);
  const result = await (host.run ?? runProgram)(powershellExe(), powershellArgs(script), {
    env,
    timeout: POWERSHELL_TIMEOUT_MS,
  });
  const answer = result.stdout.trim();
  if (result.code === 0 && (answer === "present" || answer === "absent")) {
    return answer === "present";
  }
  const detail = (result.stderr.trim() || answer).slice(0, 500);
  throw new Error(`PowerShell exited with ${result.code}: ${detail}`);
}

/**
 * PowerShell's single-quoted literal of `value`. PowerShell takes the typographic single quotes as
 * quotes too, and a profile folder may have one, such as C:\Users\Zoë O’Neil.
 */
function literal(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

/**
 * The PowerShell script that reads, adds or removes `folder` in the Path of HKCU's `key`, as the
 * registry holds it, and prints whether it's there now: `present` or `absent`. Entries compare as
 * Windows reads them: without case, variables expanded, a trailing backslash or none. Install
 * appends, so an eidolon the owner already has stays first. The value keeps its kind.
 */
export function userPathScript(
  action: "query" | "add" | "remove",
  folder: string,
  key: string = USER_ENVIRONMENT,
): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    `$action = ${literal(action)}`,
    `$name = ${literal(key)}`,
    `$folder = ${literal(folder)}`,
    "try {",
    "  if ($action -eq 'add') {",
    "    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($name)",
    "  } else {",
    "    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($name, $action -eq 'remove')",
    "  }",
    "  $raw = ''",
    "  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString",
    "  if ($null -ne $key -and $key.GetValueNames() -contains 'Path') {",
    "    $kind = $key.GetValueKind('Path')",
    "    if ($kind -ne 'String' -and $kind -ne 'ExpandString') { throw \"Path is $kind, not text\" }",
    "    $raw = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
    "  }",
    "  $ours = $folder.TrimEnd('\\')",
    "  $kept = [Collections.Generic.List[string]]::new()",
    "  $present = $false",
    "  if ($raw -ne '') {",
    "    foreach ($entry in $raw.Split(';')) {",
    "      if ([Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\\') -eq $ours) {",
    "        $present = $true",
    "      } else {",
    "        $kept.Add($entry)",
    "      }",
    "    }",
    "  }",
    "  $next = $null",
    "  if ($action -eq 'add' -and -not $present) {",
    "    if ($raw -eq '' -or $raw.EndsWith(';')) { $next = $raw + $folder } else { $next = $raw + ';' + $folder }",
    "    $present = $true",
    "  }",
    "  if ($action -eq 'remove' -and $present) {",
    "    $next = $kept -join ';'",
    "    $present = $false",
    "  }",
    "  if ($null -ne $next) {",
    "    $key.SetValue('Path', $next, $kind)",
    // Deleting a variable no one has deletes nothing and broadcasts WM_SETTINGCHANGE, so Explorer,
    // and the terminals it starts after, read the new Path.
    ...(key === USER_ENVIRONMENT
      ? ["    [Environment]::SetEnvironmentVariable('EIDOLON_PATH_CHANGED', $null, 'User')"]
      : []),
    "  }",
    "  [Console]::Out.Write($(if ($present) { 'present' } else { 'absent' }))",
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\n");
}
