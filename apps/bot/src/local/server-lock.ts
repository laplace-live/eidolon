// One local server per data home: the server holds the offline chain's lock `local-server` while it
// runs, and adds its address to the pid in the lock's .info, so a second start can find it.
import { readFileSync } from "node:fs";
import { isPlainObject } from "@eidolon/config";
import { acquireLock, LockedError, lockInfoPath } from "@eidolon/ingest";
import { writeDataFile } from "./write.ts";

const KEY = "local-server";

/** The server that holds the lock, as its .info tells; null where it doesn't, yet. */
export interface ServerHolder {
  readonly pid: number | null;
  readonly port: number | null;
  // As recordServerPort writes them; a server older than it writes neither.
  readonly host: string | null;
  readonly linkHost: string | null;
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

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The lock's release, or the server that holds it already. */
export function takeServerLock():
  | { readonly release: () => void }
  | { readonly holder: ServerHolder } {
  try {
    return { release: acquireLock(KEY, "eidolon") };
  } catch (error) {
    if (!(error instanceof LockedError)) throw error;
    const info = readInfo();
    return {
      holder: {
        pid: whole(info.pid),
        port: whole(info.port),
        host: text(info.host),
        linkHost: text(info.linkHost),
      },
    };
  }
}

/**
 * Adds where this server listens to the .info its lock wrote: `port`; `host`, the first loopback
 * address it bound, as a URL names it (`127.0.0.1`, `[::1]`); and `linkHost`, the host its own
 * links name, `localhost` where it bound every address that name has. A second start and the
 * desktop app reach it at `host` alone: on another loopback address the port may be another local
 * account's.
 */
export function recordServerPort(port: number, host: string, linkHost: string): void {
  writeDataFile(serverLockInfoPath(), JSON.stringify({ ...readInfo(), port, host, linkHost }));
}
