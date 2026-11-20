// The locks that keep two processes from writing the same files. A subpath of its own
// (@eidolon/config/lock), so what imports config's index never loads node:sqlite.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataHome } from "./home.ts";
import { isPlainObject } from "./py.ts";

/** Another process holds the lock; the CLI exits 1, or emits code "locked" under --json. */
export class LockedError extends Error {
  override name = "LockedError";
  readonly code = "locked";
  constructor(holder: string, target: string, pid: number | null) {
    super(`Another ${holder} is running for ${target}${pid === null ? "" : ` (pid ${pid})`}.`);
  }
}

/** SQLite's result code for a lock another connection holds. */
const SQLITE_BUSY = 5;

// A lock's database must stay reachable: collecting it would close the connection and release it.
const held = new Set<DatabaseSync>();

function holderInfo(path: string): { pid: number | null; command: string | null } {
  try {
    const info: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isPlainObject(info)) {
      return {
        pid: typeof info.pid === "number" ? info.pid : null,
        command: typeof info.command === "string" ? info.command : null,
      };
    }
  } catch {
    // Not written yet, or gone: the holder is unknown.
  }
  return { pid: null, command: null };
}

/** Where lock `key`'s files sit in `<home>/locks/`, named by its SHA-256's first 12 hex digits. */
function lockStem(key: string): string {
  const name = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12);
  return join(dataHome(), "locks", name);
}

/** The .info lock `key`'s holder writes: its pid, command, key and start. */
export function lockInfoPath(key: string): string {
  return `${lockStem(key)}.info`;
}

/**
 * Takes the lock named `key` for this process, or throws LockedError naming its holder. The lock
 * is SQLite's exclusive lock on a file in `<home>/locks/`, which the OS drops when the process
 * dies, so a crash never leaves a stale lock. Call the returned function to release it.
 */
export function acquireLock(key: string, command: string): () => void {
  // Made with the data home when either is missing, readable by this user only.
  mkdirSync(join(dataHome(), "locks"), { recursive: true, mode: 0o700 });
  const infoPath = lockInfoPath(key);
  const db = new DatabaseSync(`${lockStem(key)}.lock`);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    if ((error as { errcode?: unknown }).errcode !== SQLITE_BUSY) throw error;
    const holder = holderInfo(infoPath);
    const colon = key.indexOf(":");
    throw new LockedError(holder.command ?? command, key.slice(colon + 1), holder.pid);
  }
  held.add(db);
  writeFileSync(
    infoPath,
    JSON.stringify({ pid: process.pid, command, key, start: new Date().toISOString() }),
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // While the lock is still held, so it can't remove the next holder's file.
    try {
      unlinkSync(infoPath);
    } catch {
      // Already gone.
    }
    db.exec("ROLLBACK");
    db.close();
    held.delete(db);
  };
}
