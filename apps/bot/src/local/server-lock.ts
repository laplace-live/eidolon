// One local server per data home: the server holds the offline chain's lock `local-server` while it
// runs, and adds its port to the pid in the lock's .info, so a second start can name it.
import { readFileSync } from "node:fs";
import { isPlainObject } from "@eidolon/config";
import { acquireLock, LockedError, lockInfoPath } from "@eidolon/ingest";
import { writeDataFile } from "./write.ts";

const KEY = "local-server";

/** The server that holds the lock, as its .info tells; null where it doesn't, yet. */
export interface ServerHolder {
  readonly pid: number | null;
  readonly port: number | null;
}

/** acquireLock's .info for the server's lock. */
export function serverLockInfoPath(): string {
  return lockInfoPath(KEY);
}

function readInfo(): Record<string, unknown> {
  try {
    const info: unknown = JSON.parse(readFileSync(serverLockInfoPath(), "utf8"));
    return isPlainObject(info) ? info : {};
  } catch {
    // Not written yet, or gone with its holder.
    return {};
  }
}

const whole = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

/** The lock's release, or the server that holds it already. */
export function takeServerLock():
  | { readonly release: () => void }
  | { readonly holder: ServerHolder } {
  try {
    return { release: acquireLock(KEY, "eidolon") };
  } catch (error) {
    if (!(error instanceof LockedError)) throw error;
    const info = readInfo();
    return { holder: { pid: whole(info.pid), port: whole(info.port) } };
  }
}

/** Adds the port this server listens on to the .info its lock wrote. */
export function recordServerPort(port: number): void {
  writeDataFile(serverLockInfoPath(), JSON.stringify({ ...readInfo(), port }));
}
