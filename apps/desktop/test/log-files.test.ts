// The logs' rotation: five archives, newest first, the oldest dropped.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { archiveName, LOG_ARCHIVES, LOG_MAX_BYTES, rotate } from "../src/main/log-files.ts";

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "eidolon-log-files-"));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

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
