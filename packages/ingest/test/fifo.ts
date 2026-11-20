// A file a child process blocks on: a FIFO it reads synchronously until the test writes it, so a
// test can send a real signal while the child is in the middle of a synchronous read.
import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { Subprocess } from "@eidolon/config";

/** Makes `path` a FIFO. */
export function makeFifo(path: string): void {
  const made = spawnSync("mkfifo", [path], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`mkfifo ${path}: ${made.stderr}`);
}

/**
 * Waits until the FIFO at `path` has a reader, `child` sitting in its read, then waits out the lag
 * before a just-registered signal listener takes effect; until then a signal still kills. The
 * returned function writes `text` and closes the FIFO, which ends the read. Throws when the child
 * exits first.
 */
export async function whenReading(
  path: string,
  child: Pick<Subprocess, "exitCode" | "signalCode" | "stderr">,
): Promise<(text: string) => void> {
  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      // ENXIO: no reader yet.
      if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
    }
    if (fd !== null) {
      const writer = fd;
      await delay(100);
      return (text) => {
        try {
          writeSync(writer, text);
        } catch (error) {
          // No reader left: a file indexer opened the FIFO first, so the signal came early in the
          // child's run, and the child stopped before it got here.
          if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
        } finally {
          closeSync(writer);
        }
      };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`exited before reading ${path}: ${await new Response(child.stderr).text()}`);
    }
    await delay(10);
  }
}
