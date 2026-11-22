// The logs' rotation: five archives, newest first, the oldest dropped, and never a throw, which
// would cost electron-log the line that rotated.
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import log from "electron-log/node";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { archiveName, LOG_ARCHIVES, LOG_MAX_BYTES, rotate } from "../src/main/log-files.ts";

// An ES module's exports can't be spied on in place: rotate gets these instead.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    copyFileSync: vi.fn(actual.copyFileSync),
  };
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "eidolon-log-files-"));
});
afterEach(() => {
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
  vi.mocked(fs.copyFileSync).mockImplementation(actual.copyFileSync);
  rmSync(folder, { recursive: true, force: true });
});

/** Windows' refusal to rename `path` while another program, a tail say, holds it open. */
function holdOpen(path: string): void {
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (from === path) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}'`), {
        code: "EBUSY",
      });
    }
    actual.renameSync(from, to);
  });
}

/** Each file in the folder, with what it holds. */
function files(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(folder)
      .sort()
      .map((name) => [name, readFileSync(join(folder, name), "utf8")]),
  );
}

/** backend.log beside its five archives, each saying which it is. */
function fullFolder(): string {
  const live = join(folder, "backend.log");
  writeFileSync(live, "live\n");
  for (let n = 1; n <= LOG_ARCHIVES; n++) writeFileSync(archiveName(live, n), `archive ${n}\n`);
  return live;
}

test("each log rotates at 2 MB, keeping five archives", () => {
  expect(LOG_MAX_BYTES).toBe(2 * 1024 * 1024);
  expect(LOG_ARCHIVES).toBe(5);
  expect(archiveName("/logs/main.log", 1)).toBe(join("/logs", "main.1.log"));
  expect(archiveName("/logs/backend.log", 5)).toBe(join("/logs", "backend.5.log"));
});

test("moves the log to .1 and each archive one along, dropping the oldest", () => {
  const log = join(folder, "main.log");
  for (let run = 1; run <= 7; run++) {
    writeFileSync(log, `run ${run}\n`);
    rotate(log);
  }
  expect(existsSync(log)).toBe(false);
  expect(readdirSync(folder).sort()).toEqual([
    "main.1.log",
    "main.2.log",
    "main.3.log",
    "main.4.log",
    "main.5.log",
  ]);
  expect(readFileSync(join(folder, "main.1.log"), "utf8")).toBe("run 7\n");
  expect(readFileSync(join(folder, "main.5.log"), "utf8")).toBe("run 3\n");
});

test("leaves another log's archives alone", () => {
  writeFileSync(join(folder, "backend.1.log"), "backend\n");
  writeFileSync(join(folder, "main.log"), "main\n");
  rotate(join(folder, "main.log"));
  expect(readdirSync(folder).sort()).toEqual(["backend.1.log", "main.1.log"]);
});

test("a log another program holds open, which Windows won't rename, goes to .1 as a copy and starts again empty", () => {
  const live = fullFolder();
  holdOpen(live);
  expect(() => rotate(live)).not.toThrow();
  expect(files()).toEqual({
    "backend.1.log": "live\n",
    "backend.2.log": "archive 1\n",
    "backend.3.log": "archive 2\n",
    "backend.4.log": "archive 3\n",
    "backend.5.log": "archive 4\n",
    "backend.log": "",
  });
});

test("a log it can neither move nor copy leaves every archive where it was, and nothing throws", () => {
  const live = fullFolder();
  const before = files();
  holdOpen(live);
  vi.mocked(fs.copyFileSync).mockImplementation(() => {
    throw Object.assign(new Error("EBUSY: resource busy or locked, copyfile"), { code: "EBUSY" });
  });
  for (let line = 1; line <= LOG_ARCHIVES; line++) expect(() => rotate(live)).not.toThrow();
  expect(files()).toEqual(before);
});

test("through electron-log's file transport, a log held open loses no line and no archive", () => {
  const live = join(folder, "backend.log");
  const logger = log.create({ logId: "log-files-test" });
  logger.transports.console.level = false;
  const transport = logger.transports.file;
  transport.resolvePathFn = () => live;
  transport.format = "{text}";
  // It rotates every few lines.
  transport.maxSize = 64;
  transport.archiveLogFn = (old) => rotate(old.path);
  const lines = Array.from({ length: 16 }, (_, n) => `line ${n + 1}`.padEnd(16, "."));
  for (const line of lines.slice(0, 8)) logger.info(line);
  holdOpen(live);
  for (const line of lines.slice(8)) logger.info(line);
  const oldestFirst = [5, 4, 3, 2, 1].map((n) => archiveName(live, n)).filter(existsSync);
  const read = (path: string) => readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  expect([...oldestFirst, live].flatMap(read)).toEqual(lines);
});
