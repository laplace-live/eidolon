// No backend code runs in Electron's main process or its pages: apps/desktop/src loads only
// Electron's own packages, undici, Node's builtins and its own modules, and takes the backend's
// packages and apps/bot as types alone. The backend runs as Node, from the staged payload.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { scan } from "../../bot/test/local/scan.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const SRC = join(ROOT, "apps", "desktop", "src");
const PACKAGES = /^(?:electron|electron-updater|electron-log|undici)(?:\/|$)/;

/** Whether `specifier`, loaded by `file`, is something apps/desktop/src may not load. */
function forbidden(file: string, specifier: string): boolean {
  if (specifier.startsWith(".")) {
    const path = relative(SRC, resolve(dirname(file), specifier));
    return path.startsWith("..") || isAbsolute(path);
  }
  return !specifier.startsWith("node:") && !PACKAGES.test(specifier);
}

function sources(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((name) => /\.[cm]?tsx?$/.test(name))
    .map((name) => join(dir, name));
}

describe("apps/desktop/src", () => {
  test("loads only Electron's packages, undici, Node's builtins and its own modules", () => {
    const files = sources(SRC);
    expect(files).toContain(join(SRC, "main", "index.ts"));
    const loaded = files.flatMap((file) =>
      scan(file).map((specifier) => [relative(ROOT, file), specifier] as const),
    );
    expect(loaded.map(([, specifier]) => specifier)).toContain("electron");
    expect(loaded.filter(([file, specifier]) => forbidden(join(ROOT, file), specifier))).toEqual(
      [],
    );
  });

  test("the rule refuses the backend's code, a builtin without node: and a file outside src", () => {
    const file = join(SRC, "main", "index.ts");
    for (const specifier of [
      "@eidolon/config",
      "laplace-eidolon",
      "../../../bot/src/local/api.ts",
      "../../scripts/electron-env.ts",
      "fs",
      "vite",
    ]) {
      expect([specifier, forbidden(file, specifier)]).toEqual([specifier, true]);
    }
    for (const specifier of [
      "electron",
      "electron-log/main",
      "electron-updater",
      "undici",
      "node:fs",
      "./window.ts",
      "../preload/index.ts",
    ]) {
      expect([specifier, forbidden(file, specifier)]).toEqual([specifier, false]);
    }
  });

  test("a type taken with import type loads nothing, and one named inline loads its module", () => {
    const dir = mkdtempSync(join(tmpdir(), "eidolon-desktop-boundary-"));
    try {
      const file = join(dir, "types.ts");
      writeFileSync(
        file,
        [
          'import type { LocalApi } from "../../../bot/src/local/api.ts";',
          'import { type JobInfo } from "@eidolon/cli/job";',
          'import { app } from "electron";',
          "export type Both = [LocalApi, JobInfo, typeof app];",
        ].join("\n"),
      );
      expect(scan(file)).toEqual(["@eidolon/cli/job", "electron"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
