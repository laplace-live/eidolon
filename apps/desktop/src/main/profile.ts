// Moves an upgraded install's <appData>/Eidolon profile to userData before the single-instance
// lock or any reader touches it. Electron-free.
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";
import { COMPANION_FILE } from "./companion.ts";
import { BOUNDS_FILE } from "./window-options.ts";

/** In userData: the Windows tray notice has shown. */
export const TRAY_NOTICE_MARKER = "tray-notice-shown";
const LEGACY_PROFILE = "Eidolon";
const PROFILE_FILES = [BOUNDS_FILE, COMPANION_FILE, TRAY_NOTICE_MARKER] as const;
const INITIALIZED_ENTRIES = [
  ...PROFILE_FILES,
  "Local Storage",
  "Preferences",
  "Local State",
] as const;

export function migrateLegacyProfile(appData: string, userData: string): void {
  const legacy = join(appData, LEGACY_PROFILE);
  if (legacy === userData || !existsSync(legacy)) return;
  try {
    const present = existsSync(userData);
    if (!present || readdirSync(userData).length === 0) {
      if (present) rmdirSync(userData);
      renameSync(legacy, userData);
      return;
    }
  } catch {
    // A held handle or non-empty skeleton folder falls through to copying the profile's state.
  }
  if (INITIALIZED_ENTRIES.some((name) => existsSync(join(userData, name)))) return;
  try {
    mkdirSync(userData, { recursive: true });
    for (const name of PROFILE_FILES) {
      const from = join(legacy, name);
      const to = join(userData, name);
      if (existsSync(from) && !existsSync(to)) {
        copyFileSync(from, to, constants.COPYFILE_EXCL);
      }
    }
    const storage = join(legacy, "Local Storage");
    const targetStorage = join(userData, "Local Storage");
    if (existsSync(storage) && !existsSync(targetStorage)) {
      cpSync(storage, targetStorage, { recursive: true, errorOnExist: true });
    }
  } catch {
    // An unreadable profile never stops startup.
  }
}
