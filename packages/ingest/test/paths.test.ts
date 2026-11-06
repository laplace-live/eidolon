import "../../config/test/isolated-guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataHome, PROJECT_ROOT, resetSettings, templatesDir } from "@eidolon/config";
import {
  acquireLock,
  binDir,
  canonicalPath,
  embedCachePath,
  indexLockKey,
  indexWritePath,
  LockedError,
  sourceFolder,
  sourcesLockKey,
} from "../src/index.ts";

const touched = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!touched.has(name)) touched.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function swapCase(text: string): string {
  return [...text].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("");
}

afterEach(() => {
  for (const [name, value] of touched) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  touched.clear();
  resetSettings();
  rmSync(dataHome(), { recursive: true, force: true });
});

describe("folders", () => {
  test("the cache, the managed binaries and the sources live in the data home", () => {
    expect(embedCachePath()).toBe(join(dataHome(), "cache", "embed_cache.db"));
    expect(binDir()).toBe(join(dataHome(), "bin"));
    expect(sourceFolder("milky-green", "vods")).toBe(
      join(dataHome(), "sources", "milky-green", "vods"),
    );
  });

  test("the data home, locks/ and cache/ are made private; a folder that exists keeps its mode", () => {
    const mode = (path: string) => statSync(path).mode & 0o777;
    acquireLock("sources:milky-green", "laplace-refine")();
    expect([mode(dataHome()), mode(join(dataHome(), "locks"))]).toEqual([0o700, 0o700]);
    rmSync(dataHome(), { recursive: true, force: true });
    embedCachePath();
    expect([mode(dataHome()), mode(join(dataHome(), "cache"))]).toEqual([0o700, 0o700]);

    rmSync(dataHome(), { recursive: true, force: true });
    const folders = [dataHome(), join(dataHome(), "locks"), join(dataHome(), "cache")];
    for (const path of folders) {
      mkdirSync(path);
      chmodSync(path, 0o755);
    }
    acquireLock("sources:milky-green", "laplace-refine")();
    embedCachePath();
    expect(folders.map(mode)).toEqual([0o755, 0o755, 0o755]);
  });

  test("indexWritePath is where the bot reads, never a template", () => {
    setEnv("LANCEDB_PATH", undefined);
    expect(indexWritePath("milky-green")).toBe(
      join(dataHome(), "personas", "milky-green", "index"),
    );
    setEnv("LANCEDB_PATH", "data/lancedb");
    expect(indexWritePath("milky-green")).toBe(join(PROJECT_ROOT, "data/lancedb"));
    setEnv("LANCEDB_PATH", "/srv/index");
    expect(indexWritePath("milky-green")).toBe("/srv/index");
    setEnv("LANCEDB_PATH", "personas/milky-green/index");
    expect(() => indexWritePath("milky-green")).toThrow(
      `Refusing to write persona milky-green's index into the template folder ${join(PROJECT_ROOT, "personas/milky-green/index")}`,
    );
  });

  test("indexWritePath refuses a template however its path is spelled", () => {
    const dir = mkdtempSync(join(tmpdir(), "ingest-paths-"));
    try {
      symlinkSync(templatesDir(), join(dir, "templates"));
      const spellings = [
        `${PROJECT_ROOT}/apps/../personas/milky-green/index`,
        join(dir, "templates/milky-green/index"),
        join(dir, "templates"),
      ];
      // Only where the file system folds case (APFS, by default): elsewhere it's another folder.
      const swapped = swapCase(templatesDir());
      if (existsSync(swapped)) spellings.push(join(swapped, "milky-green", "index"));
      for (const spelling of spellings) {
        setEnv("LANCEDB_PATH", spelling);
        expect(() => indexWritePath("milky-green"), spelling).toThrow(
          `Refusing to write persona milky-green's index into the template folder ${spelling}`,
        );
      }
      setEnv("LANCEDB_PATH", join(dir, "templates-not/milky-green/index"));
      expect(indexWritePath("milky-green")).toBe(join(dir, "templates-not/milky-green/index"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("indexWritePath refuses a persona whose settings aren't installed", () => {
    expect(() => indexWritePath("other")).toThrow(
      "Persona other is not the active persona (milky-green)",
    );
  });

  test("canonicalPath follows the symlinks of the part that exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "ingest-paths-"));
    try {
      expect(canonicalPath(join(dir, "a/../b/c"))).toBe(join(realpathSync(dir), "b/c"));
      expect(indexLockKey(join(dir, "index"))).toBe(`index:${join(realpathSync(dir), "index")}`);
      expect(sourcesLockKey("milky-green")).toBe("sources:milky-green");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("acquireLock", () => {
  test("one holder per key; release frees it, and its info file goes with it", () => {
    const release = acquireLock("sources:milky-green", "laplace-refine");
    expect(() => acquireLock("sources:milky-green", "laplace-download")).toThrow(
      new LockedError("laplace-refine", "milky-green", process.pid),
    );
    const other = acquireLock("index:/srv/index", "laplace-ingest-facts");
    release();
    release();
    const again = acquireLock("sources:milky-green", "laplace-download");
    again();
    other();
    expect(readdirSync(join(dataHome(), "locks")).filter((n) => n.endsWith(".info"))).toEqual([]);
  });

  test("its files are named by the first 12 hex digits of the key's sha256", () => {
    const release = acquireLock("index:/srv/index", "laplace-ingest-facts");
    try {
      const name = createHash("sha256").update("index:/srv/index", "utf8").digest("hex");
      const files = readdirSync(join(dataHome(), "locks"));
      expect(new Set(files.map((file) => file.slice(0, file.indexOf("."))))).toEqual(
        new Set([name.slice(0, 12)]),
      );
      expect(files).toContain(`${name.slice(0, 12)}.lock`);
      expect(files).toContain(`${name.slice(0, 12)}.info`);
    } finally {
      release();
    }
  });

  test("another process's lock names it, and dies with it", async () => {
    mkdirSync(dataHome(), { recursive: true });
    const paths = join(import.meta.dir, "../src/paths.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `const { acquireLock } = await import(${JSON.stringify(paths)});
         acquireLock("sources:milky-green", "laplace-pipeline");
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
        acquireLock("sources:milky-green", "laplace-refine");
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(LockedError);
      expect((error as Error).message).toBe(
        `Another laplace-pipeline is running for milky-green (pid ${child.pid}).`,
      );
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    const release = acquireLock("sources:milky-green", "laplace-refine");
    release();
    expect(existsSync(join(dataHome(), "locks"))).toBe(true);
  }, 30_000);
});
