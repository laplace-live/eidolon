// The server lock's .info: what recordServerPort adds to it, and what reads it, with hosts or
// without them, which a server from before hosts were recorded leaves out.
import "../../../../packages/config/test/isolated-guard.ts";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dataHome } from "@eidolon/config";
import { acquireLock, LockedError } from "@eidolon/ingest";
import { afterEach, expect, test } from "vitest";
import {
  recordServerPort,
  serverLockInfoPath,
  takeServerLock,
} from "../../src/local/server-lock.ts";

afterEach(() => {
  rmSync(dataHome(), { recursive: true, force: true });
});

function info(): Record<string, unknown> {
  return JSON.parse(readFileSync(serverLockInfoPath(), "utf8"));
}

/** Runs `body` holding the server lock, as a server does. */
function holding(body: () => void): void {
  const lock = takeServerLock();
  if (!("release" in lock)) throw new Error("the lock is held already");
  try {
    body();
  } finally {
    lock.release();
  }
}

test("recordServerPort adds the port and hosts to the lock's fields, as a new file", () => {
  holding(() => {
    const written = info();
    const inode = statSync(serverLockInfoPath()).ino;
    recordServerPort(54321, "[::1]", "localhost");
    expect(info()).toEqual({ ...written, port: 54321, host: "[::1]", linkHost: "localhost" });
    expect(Object.keys(info())).toEqual([
      "pid",
      "command",
      "key",
      "start",
      "port",
      "host",
      "linkHost",
    ]);
    // Renamed over the old one, so no reader sees it half written.
    expect(statSync(serverLockInfoPath()).ino).not.toBe(inode);
  });
});

test("a second start reads the holder's pid, port and hosts, or no hosts from an older one", () => {
  holding(() => {
    const { pid, command, key, start } = info();
    writeFileSync(serverLockInfoPath(), JSON.stringify({ pid, command, key, start, port: 7861 }));
    expect(takeServerLock()).toEqual({ holder: { pid, port: 7861, host: null, linkHost: null } });
    recordServerPort(7862, "[::1]", "localhost");
    expect(takeServerLock()).toEqual({
      holder: { pid, port: 7862, host: "[::1]", linkHost: "localhost" },
    });
  });
});

test("the offline chain's lock error names the holder from an .info with a host", () => {
  holding(() => {
    recordServerPort(7862, "127.0.0.1", "127.0.0.1");
    let error: unknown;
    try {
      acquireLock("local-server", "laplace-pipeline");
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(LockedError);
    expect((error as Error).message).toBe(
      `Another eidolon is running for local-server (pid ${process.pid}).`,
    );
  });
});
