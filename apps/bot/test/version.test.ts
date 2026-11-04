import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { botVersion, syncVersion, VERSION_SITES } from "../scripts/sync-version.ts";

const ROOT = join(import.meta.dir, "../../..");

function copyOfSites(): string {
  const dir = mkdtempSync(join(tmpdir(), "eidolon-version-"));
  for (const file of ["apps/bot/package.json", ...VERSION_SITES.map(([f]) => f)]) {
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    cpSync(join(ROOT, file), join(dir, file));
  }
  return dir;
}

describe("version", () => {
  test("every place the bot states its version agrees with apps/bot/package.json", () => {
    for (const [file, pattern] of VERSION_SITES) {
      expect(pattern.exec(readFileSync(join(ROOT, file), "utf8"))?.[1], file).toBe(
        botVersion(ROOT),
      );
    }
  });

  test("sync rewrites only the version in each site", () => {
    const dir = copyOfSites();
    const before = VERSION_SITES.map(([file]) => readFileSync(join(dir, file), "utf8"));
    expect(syncVersion(dir, "9.8.7")).toEqual(VERSION_SITES.map(([file]) => file));
    VERSION_SITES.forEach(([file, pattern], i) => {
      const after = readFileSync(join(dir, file), "utf8");
      expect(pattern.exec(after)?.[1]).toBe("9.8.7");
      expect(after.replace("9.8.7", botVersion(ROOT))).toBe(before[i] as string);
    });
    expect(syncVersion(dir, "9.8.7")).toEqual([]);
  });
});
