// The logs' rotation: main.log and backend.log each move aside at 2 MB, keeping five
// archives, rather than electron-log's single .old file. Electron-free: log.ts hands it to
// electron-log.
import { copyFileSync, renameSync, rmSync, truncateSync } from "node:fs";
import { join, parse } from "node:path";

export const LOG_MAX_BYTES = 2 * 1024 * 1024;
export const LOG_ARCHIVES = 5;

/** `main.log`'s archive `n`: `main.1.log`, the newest, to `main.5.log`. */
export function archiveName(file: string, n: number): string {
  const { dir, name, ext } = parse(file);
  return join(dir, `${name}.${n}${ext}`);
}

/**
 * Moves `file` to its first archive, each archive one along, and drops the oldest. It never throws:
 * electron-log swallows its transport's error, losing the line, and with its size count still over
 * the limit rotates again at the next one.
 */
export function rotate(file: string, keep: number = LOG_ARCHIVES): void {
  // No archive moves before the log has, to a name none of them has.
  const aside = archiveName(file, 0);
  try {
    if (!moveAside(file, aside)) return;
    rmSync(archiveName(file, keep), { force: true });
    for (let n = keep - 1; n >= 1; n--) {
      try {
        renameSync(archiveName(file, n), archiveName(file, n + 1));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    renameSync(aside, archiveName(file, 1));
  } catch {
    // An archive held open on Windows stops the shift: the log stays aside, and the next rotation
    // replaces it.
  }
}

/** Renames `file` to `aside`, else copies it there and empties it; false when neither works. */
function moveAside(file: string, aside: string): boolean {
  try {
    renameSync(file, aside);
    return true;
  } catch {
    // Windows refuses to rename a file another program holds open without delete sharing, as a
    // tail or an antivirus scan does.
  }
  try {
    copyFileSync(file, aside);
  } catch {
    return false;
  }
  try {
    truncateSync(file);
    return true;
  } catch {
    // Left whole, it would go aside again at every line.
    rmSync(aside, { force: true });
    return false;
  }
}
