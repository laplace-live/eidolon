// What the update test reads of an install: the version it says it is, from the bundle's Info.plist
// on macOS and from the uninstall entry and LAPLACE Eidolon.exe's version resource on Windows; the
// processes it runs, the app Squirrel.Mac or the NSIS setup starts again after the update included;
// and where an app on the default profile logs.
import { spawnSync } from "node:child_process";
import { posix, win32 } from "node:path";
import { namesUninstaller, type UninstallEntry, uninstallEntries } from "../smoke/nsis.ts";
import { inside, powershellJson, windowsArgs } from "../smoke/packaged.ts";
import type { ProcessRow } from "../smoke/processes.ts";

/** Each source of an install's version and what it says, null where it says nothing. */
export type Versions = Readonly<Record<string, string | null>>;

/** Whether `reported` is `expected`, an X.Y.Z, or Windows' four-part form of it. */
export function sameVersion(reported: string | null | undefined, expected: string): boolean {
  return reported === expected || reported === `${expected}.0`;
}

/** Whether every source says `version`. */
export function atVersion(versions: Versions, version: string): boolean {
  const said = Object.values(versions);
  return said.length > 0 && said.every((value) => sameVersion(value, version));
}

export function versionsText(versions: Versions): string {
  return Object.entries(versions)
    .map(([source, value]) => `${source} ${value ?? "unread"}`)
    .join(", ");
}

/** `plutil -extract CFBundleShortVersionString raw` on an Info.plist: its value, or null. */
export function plutilVersion(status: number | null, stdout: string): string | null {
  const value = stdout.trim();
  return status === 0 && value !== "" ? value : null;
}

/**
 * macOS: the bundle's CFBundleShortVersionString. plutil reads the file itself, where `defaults`
 * goes through cfprefsd, which can answer from before the bundle was replaced.
 */
export function macVersions(bundle: string): Versions {
  const read = spawnSync(
    "plutil",
    ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", `${bundle}/Contents/Info.plist`],
    { encoding: "utf8" },
  );
  return {
    "LAPLACE Eidolon.app's CFBundleShortVersionString": plutilVersion(read.status, read.stdout),
  };
}

/** What the version script emits for LAPLACE Eidolon.exe, through ConvertTo-Json. */
export interface ExeVersion {
  readonly FileVersion?: string | null;
  readonly ProductVersion?: string | null;
}

/** PowerShell's pipeline for `exe`'s version resource; nothing when there's no such file. */
export function exeVersionScript(exe: string): string {
  return `Get-Item -LiteralPath '${exe.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ FileVersion = [string]$_.VersionInfo.FileVersion; ProductVersion = [string]$_.VersionInfo.ProductVersion } }`;
}

/**
 * Windows: the DisplayVersion of the uninstall entry that names `folder`'s uninstaller, and
 * LAPLACE Eidolon.exe's FileVersion, which electron-builder writes as the version itself.
 */
export function windowsVersions(
  entries: readonly UninstallEntry[],
  exe: readonly ExeVersion[],
  folder: string,
): Versions {
  const entry = entries.find((candidate) => namesUninstaller(candidate, folder));
  return {
    "the uninstall entry's DisplayVersion": entry?.DisplayVersion || null,
    "LAPLACE Eidolon.exe's FileVersion": exe[0]?.FileVersion || null,
  };
}

export async function readWindowsVersions(folder: string): Promise<Versions> {
  const [entries, exe] = await Promise.all([
    uninstallEntries(),
    powershellJson<ExeVersion>(exeVersionScript(win32.join(folder, "LAPLACE Eidolon.exe"))),
  ]);
  return windowsVersions(entries, exe, folder);
}

/**
 * The processes that run `install`'s own binaries: on Windows anything in its folder; on macOS its
 * executable, main or backend, but not a helper, which runs under its main, nor Squirrel.Mac's
 * ShipIt, which installs the update from inside the bundle.
 */
export function appProcesses(
  table: readonly ProcessRow[],
  install: string,
  platform: NodeJS.Platform,
): ProcessRow[] {
  if (platform === "win32") {
    return table.filter((row) => inside(windowsArgs(row.command)[0] ?? "", install, "win32"));
  }
  return table.filter((row) => row.command.startsWith(`${install}/Contents/MacOS/`));
}

/** The rows with no parent among them: each launch's main. */
export function mains(rows: readonly ProcessRow[]): ProcessRow[] {
  const pids = new Set(rows.map((row) => row.pid));
  return rows.filter((row) => !pids.has(row.ppid));
}

/**
 * The logs folder of an app on the default profile, as Squirrel.Mac and the NSIS setup start the
 * updated one: no --user-data-dir, whatever the launch that updated it had.
 */
export function defaultLogs(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === "win32") {
    return win32.join(
      env.APPDATA || win32.join(home, "AppData", "Roaming"),
      "LAPLACE Eidolon",
      "logs",
    );
  }
  return posix.join(home, "Library", "Logs", "LAPLACE Eidolon");
}
