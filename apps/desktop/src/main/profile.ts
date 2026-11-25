// Copies an upgraded install's state from <appData>/Eidolon into userData once the single-instance
// lock is held and before any reader touches userData, leaving any running Eidolon instance's
// profile and locks untouched. Electron-free.
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  type RmOptions,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { COMPANION_FILE } from "./companion.ts";
import { BOUNDS_FILE } from "./window-options.ts";

/** In userData: the Windows tray notice has shown. */
export const TRAY_NOTICE_MARKER = "tray-notice-shown";
export const MIGRATED_MARKER = ".migrated-from-eidolon";
const LEGACY_PROFILE = "Eidolon";
const PROFILE_FILES = [BOUNDS_FILE, COMPANION_FILE, TRAY_NOTICE_MARKER] as const;

export function migrateLegacyProfile(
  appData: string,
  userData: string,
  remove: (path: string, options: RmOptions) => void = rmSync,
): void {
  const legacy = join(appData, LEGACY_PROFILE);
  const marker = join(userData, MIGRATED_MARKER);
  if (legacy === userData || !existsSync(legacy) || existsSync(marker)) return;
  const staging = join(userData, `Local Storage.migrating-${process.pid}`);
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
      remove(staging, { recursive: true, force: true });
      cpSync(storage, staging, {
        recursive: true,
        errorOnExist: true,
        filter: (source) => basename(source) !== "LOCK",
      });
      renameSync(staging, targetStorage);
    }
    writeFileSync(marker, "");
  } catch {
    try {
      remove(staging, { recursive: true, force: true });
    } catch {
      // An unremovable staging folder never stops startup.
    }
  }
}
