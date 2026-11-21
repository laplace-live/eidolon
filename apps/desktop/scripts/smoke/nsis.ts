// The Windows leg's NSIS setup, which installs the app for this user in
// %LOCALAPPDATA%\Programs\eidolon with an uninstall entry in HKCU, and the uninstaller it leaves
// beside the app.
import { win32 } from "node:path";
import { powershellJson, windowsArgs } from "./packaged.ts";

/** Where electron-builder's per-user setup writes its uninstall entry. */
export const UNINSTALL_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
/** The uninstaller the setup leaves in the install folder. */
export const UNINSTALLER = "Uninstall Eidolon.exe";

/** The pipeline that lists Eidolon's uninstall entries for this user. */
export const ENTRIES_SCRIPT = `Get-ChildItem -Path '${UNINSTALL_KEY}' -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DisplayName -like 'Eidolon*' } | Select-Object DisplayName,DisplayVersion,UninstallString`;

export interface UninstallEntry {
  readonly DisplayName?: string;
  readonly DisplayVersion?: string;
  /** `"<install folder>\Uninstall Eidolon.exe" /currentuser`. */
  readonly UninstallString?: string;
}

export function uninstallEntries(): Promise<UninstallEntry[]> {
  return powershellJson<UninstallEntry>(ENTRIES_SCRIPT);
}

/** Whether `entry` runs the uninstaller in `folder` for this user, as electron-builder writes it. */
export function namesUninstaller(entry: UninstallEntry, folder: string): boolean {
  const args = windowsArgs(entry.UninstallString ?? "");
  return (
    args[0]?.toLowerCase() === win32.join(folder, UNINSTALLER).toLowerCase() &&
    args.some((arg) => arg.toLowerCase() === "/currentuser")
  );
}

/**
 * The silent uninstall: the entry's UninstallString with /S, or without an entry the install
 * folder's uninstaller, for this user.
 */
export function silentUninstall(
  entry: UninstallEntry | undefined,
  folder: string,
): { readonly command: string; readonly args: readonly string[] } {
  const args = windowsArgs(entry?.UninstallString ?? "");
  return args.length > 0
    ? { command: args[0] as string, args: [...args.slice(1), "/S"] }
    : { command: win32.join(folder, UNINSTALLER), args: ["/currentuser", "/S"] };
}
