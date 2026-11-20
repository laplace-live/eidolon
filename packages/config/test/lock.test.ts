import "./isolated-guard.ts";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { dataHome, spawnProcess } from "../src/index.ts";
import { acquireLock, LockedError, lockInfoPath } from "../src/lock.ts";

afterEach(() => {
  rmSync(dataHome(), { recursive: true, force: true });
});

describe("acquireLock", () => {
  test("one holder per key; release frees it, and its info file goes with it", () => {
    const release = acquireLock("task:0199e0a4", "laplace-task");
    expect(() => acquireLock("task:0199e0a4", "eidolon")).toThrow(
      new LockedError("laplace-task", "0199e0a4", process.pid),
    );
    expect(JSON.parse(readFileSync(lockInfoPath("task:0199e0a4"), "utf8"))).toMatchObject({
      pid: process.pid,
      command: "laplace-task",
      key: "task:0199e0a4",
    });
    const other = acquireLock("index:/srv/index", "laplace-ingest-facts");
    release();
    release();
    expect(existsSync(lockInfoPath("task:0199e0a4"))).toBe(false);
    acquireLock("task:0199e0a4", "eidolon")();
    other();
    expect(readdirSync(join(dataHome(), "locks")).filter((n) => n.endsWith(".info"))).toEqual([]);
  });

  test("its files are in the data home's locks/, named by the first 12 hex digits of the key's sha256", () => {
    const release = acquireLock("index:/srv/index", "laplace-ingest-facts");
    try {
      const name = createHash("sha256").update("index:/srv/index", "utf8").digest("hex");
      const stem = name.slice(0, 12);
      // SQLite's journal sits beside the lock while it is held.
      const files = readdirSync(join(dataHome(), "locks"));
      expect(new Set(files.map((file) => file.slice(0, file.indexOf("."))))).toEqual(
        new Set([stem]),
      );
      expect(files).toContain(`${stem}.lock`);
      expect(lockInfoPath("index:/srv/index")).toBe(join(dataHome(), "locks", `${stem}.info`));
      expect(files).toContain(`${stem}.info`);
    } finally {
      release();
    }
  });

  test("makes the data home and locks/ private; a folder that exists keeps its mode", () => {
    const mode = (path: string) => statSync(path).mode & 0o777;
    const folders = [dataHome(), join(dataHome(), "locks")];
    acquireLock("task:0199e0a4", "laplace-task")();
    expect(folders.map(mode)).toEqual([0o700, 0o700]);

    rmSync(dataHome(), { recursive: true, force: true });
    for (const path of folders) {
      mkdirSync(path);
      chmodSync(path, 0o755);
    }
    acquireLock("task:0199e0a4", "laplace-task")();
    expect(folders.map(mode)).toEqual([0o755, 0o755]);
  });

  test("another process's lock names it, and dies with it", async () => {
    mkdirSync(dataHome(), { recursive: true });
    const lock = join(import.meta.dirname, "../src/lock.ts");
    const child = spawnProcess(
      [
        process.execPath,
        "-e",
        `const { acquireLock } = await import(${JSON.stringify(lock)});
         acquireLock("task:0199e0a4", "laplace-task");
         console.log("locked");
         await new Promise((resolve) => setTimeout(resolve, 30_000));`,
      ],
      { cwd: dataHome(), stdout: "pipe", stderr: "inherit" },
    );
    try {
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe("locked\n");
      let error: unknown;
      try {
        acquireLock("task:0199e0a4", "eidolon");
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(LockedError);
      expect((error as Error).message).toBe(
        `Another laplace-task is running for 0199e0a4 (pid ${child.pid}).`,
      );
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    acquireLock("task:0199e0a4", "eidolon")();
  }, 30_000);
});

test("the lock is @eidolon/config/lock, so importing config's index never loads node:sqlite", async () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8"));
  expect(manifest.exports["./lock"]).toBe("./src/lock.ts");
  expect(createRequire(import.meta.filename).resolve("@eidolon/config/lock")).toBe(
    join(import.meta.dirname, "../src/lock.ts"),
  );
  // What the import loads, as a resolve hook in a process of its own records it.
  const index = join(import.meta.dirname, "../src/index.ts");
  const child = spawnProcess([
    process.execPath,
    "-e",
    `const loaded = [];
     (await import("node:module")).registerHooks({
       resolve(specifier, context, next) {
         const resolved = next(specifier, context);
         loaded.push(resolved.url);
         return resolved;
       },
     });
     await import(${JSON.stringify(index)});
     console.log(JSON.stringify(loaded));`,
  ]);
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(code).toBe(0);
  const loaded: string[] = JSON.parse(text);
  expect(loaded.filter((url) => url.endsWith("/packages/config/src/index.ts"))).toHaveLength(1);
  expect(loaded.length).toBeGreaterThan(10);
  expect(loaded.filter((url) => url.endsWith("/src/lock.ts"))).toEqual([]);
  expect(loaded).not.toContain("node:sqlite");
});
