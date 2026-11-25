// Copies an upgraded install's state from <appData>/Eidolon into userData before the
// single-instance lock or any reader touches it, leaving any running Eidolon instance's profile
// and locks untouched. Electron-free.
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
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

export function migrateLegacyProfile(appData: string, userData: string): void {
  const legacy = join(appData, LEGACY_PROFILE);
  const marker = join(userData, MIGRATED_MARKER);
  if (legacy === userData || !existsSync(legacy) || existsSync(marker)) return;
  const staging = join(userData, "Local Storage.migrating");
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
      rmSync(staging, { recursive: true, force: true });
      cpSync(storage, staging, {
        recursive: true,
        errorOnExist: true,
        filter: (source) => basename(source) !== "LOCK",
      });
      renameSync(staging, targetStorage);
    }
    writeFileSync(marker, "");
  } catch {
    rmSync(staging, { recursive: true, force: true });
  }
}
