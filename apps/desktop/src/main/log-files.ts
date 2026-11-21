// The logs' rotation (§5.7): main.log and backend.log each move aside at 2 MB, keeping five
// archives, rather than electron-log's single .old file. Electron-free: log.ts hands it to
// electron-log.
import { renameSync, rmSync } from "node:fs";
import { join, parse } from "node:path";

export const LOG_MAX_BYTES = 2 * 1024 * 1024;
export const LOG_ARCHIVES = 5;

/** `main.log`'s archive `n`: `main.1.log`, the newest, to `main.5.log`. */
export function archiveName(file: string, n: number): string {
  const { dir, name, ext } = parse(file);
  return join(dir, `${name}.${n}${ext}`);
}

/** Moves `file` to its first archive, each archive one along, and drops the oldest. */
export function rotate(file: string, keep: number = LOG_ARCHIVES): void {
  rmSync(archiveName(file, keep), { force: true });
  for (let n = keep - 1; n >= 1; n--) {
    try {
      renameSync(archiveName(file, n), archiveName(file, n + 1));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  renameSync(file, archiveName(file, 1));
}
