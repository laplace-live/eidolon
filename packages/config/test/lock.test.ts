import "./isolated-guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
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
import { dirname, join } from "node:path";
import { dataHome } from "../src/index.ts";
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
    const lock = join(import.meta.dir, "../src/lock.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `const { acquireLock } = await import(${JSON.stringify(lock)});
         acquireLock("task:0199e0a4", "laplace-task");
         console.log("locked");
         await Bun.sleep(30_000);`,
      ],
      { cwd: dataHome(), env: { ...process.env }, stdout: "pipe", stderr: "inherit" },
    );
    try {
      const reader = child.stdout.getReader();
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

test("the lock is @eidolon/config/lock, so nothing config's index loads imports bun:sqlite", async () => {
  const manifest = await Bun.file(join(import.meta.dir, "../package.json")).json();
  expect(manifest.exports["./lock"]).toBe("./src/lock.ts");
  expect(Bun.resolveSync("@eidolon/config/lock", import.meta.dir)).toBe(
    join(import.meta.dir, "../src/lock.ts"),
  );
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const reached = new Set<string>();
  const specifiers = new Set<string>();
  const queue = [join(import.meta.dir, "../src/index.ts")];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (reached.has(file)) continue;
    reached.add(file);
    for (const { path } of transpiler.scanImports(await Bun.file(file).text())) {
      specifiers.add(path);
      if (path.startsWith(".")) queue.push(join(dirname(file), path));
    }
  }
  expect(reached.size).toBeGreaterThan(10);
  expect(reached).not.toContain(join(import.meta.dir, "../src/lock.ts"));
  expect(specifiers).not.toContain("bun:sqlite");
});
