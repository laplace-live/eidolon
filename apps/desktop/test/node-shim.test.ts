// Copyright (c) 2026 DeepSeek
// SPDX-License-Identifier: MIT
//
// Ported from deepseek-harness scripts/primary-runtime/prepare.spec.ts@2e39e70496
//
// pnpm's prune, on deepseek's made-up bundled packages, then the shim the stage writes from the
// checkout's launchers and pnpm, for each target, its .cmd launchers where cross-spawn escapes their
// words for the cmd.exe that reads them again. The staged payload's is stage.test.ts's.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  LAUNCHER_FILES,
  LAUNCHER_SOURCES,
  NODE_SHIM,
  POSIX_LAUNCHERS,
  prunePnpmForeignNativePackages,
  shimLaunchers,
  shimPnpm,
  stageNodeShim,
} from "../scripts/node-shim.ts";
import { appLayout } from "../scripts/smoke/packaged.ts";

const temps: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "eidolon-node-shim-stage-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pnpm's prune", () => {
  test.each([
    ["darwin", "arm64", ["reflink", "reflink-darwin-arm64"], ["@reflink", "not-windows", "semver"]],
    ["darwin", "x64", ["reflink", "reflink-darwin-x64"], ["@reflink", "not-windows", "semver"]],
    ["win32", "x64", ["reflink", "reflink-win32-x64-msvc"], ["@reflink", "not-darwin", "semver"]],
  ] as const)("keeps only the bundled packages %s/%s admits", (platform, arch, reflink, top) => {
    const root = temp();
    const modules = join(root, "dist", "node_modules");
    const packages: Record<string, { os?: string[]; cpu?: string[] }> = {
      semver: {},
      "@reflink/reflink": {},
      "@reflink/reflink-darwin-arm64": { os: ["darwin"], cpu: ["arm64"] },
      "@reflink/reflink-darwin-x64": { os: ["darwin"], cpu: ["x64"] },
      "@reflink/reflink-win32-x64-msvc": { os: ["win32"], cpu: ["x64"] },
      "not-windows": { os: ["!win32"] },
      "not-darwin": { os: ["!darwin"] },
      contradictory: { os: ["darwin", "win32", "!darwin", "!win32"] },
    };
    for (const [name, fields] of Object.entries(packages)) {
      mkdirSync(join(modules, name), { recursive: true });
      writeFileSync(join(modules, name, "package.json"), JSON.stringify({ name, ...fields }));
    }
    mkdirSync(join(modules, ".bin"));
    prunePnpmForeignNativePackages(root, platform, arch);
    expect(readdirSync(modules).sort()).toEqual([".bin", ...top]);
    expect(readdirSync(join(modules, "@reflink")).sort()).toEqual(reflink);
  });
});

describe("the shim the stage writes", () => {
  test.each([
    ["darwin", "arm64", "@reflink/reflink-darwin-arm64"],
    ["win32", "x64", "@reflink/reflink-win32-x64-msvc"],
  ] as const)(
    "for %s/%s: the checkout's launchers in a node_modules/.bin, sh's executable, and pnpm at their ../node_modules/pnpm, pruned, without the install's links to its commands, its bundled packages' .bin or any .exe",
    (os, cpu, native) => {
      const payload = temp();
      stageNodeShim(payload, { os, cpu });
      expect(readdirSync(join(payload, NODE_SHIM))).toEqual(["node_modules"]);
      expect(readdirSync(join(payload, NODE_SHIM, "node_modules")).sort()).toEqual([
        ".bin",
        "node_modules",
      ]);
      const bin = shimLaunchers(payload);
      expect(readdirSync(bin).sort()).toEqual([...LAUNCHER_FILES].sort());
      for (const file of LAUNCHER_FILES) {
        expect([file, readFileSync(join(bin, file), "utf8")]).toEqual([
          file,
          readFileSync(join(LAUNCHER_SOURCES, file), "utf8"),
        ]);
      }
      if (process.platform !== "win32") {
        for (const name of POSIX_LAUNCHERS) {
          expect([name, statSync(join(bin, name)).mode & 0o777]).toEqual([name, 0o755]);
        }
      }
      const pnpm = shimPnpm(payload);
      expect(pnpm).toBe(join(bin, "..", "node_modules", "pnpm"));
      expect(readdirSync(pnpm)).not.toContain("node_modules");
      const { devDependencies } = JSON.parse(
        readFileSync(join(LAUNCHER_SOURCES, "..", "package.json"), "utf8"),
      );
      expect(JSON.parse(readFileSync(join(pnpm, "package.json"), "utf8")).version).toBe(
        devDependencies.pnpm,
      );
      const modules = join(pnpm, "dist", "node_modules");
      expect(readdirSync(modules)).not.toContain(".bin");
      expect(readdirSync(join(modules, "@reflink")).sort()).toEqual([
        "reflink",
        native.slice("@reflink/".length),
      ]);
      const exes = readdirSync(join(payload, NODE_SHIM), { recursive: true }).filter((file) =>
        String(file).endsWith(".exe"),
      );
      expect(exes).toEqual([]);
    },
  );

  test("holds each module npx.mjs imports, so the staged one loads", async () => {
    const payload = temp();
    stageNodeShim(payload, { os: process.platform, cpu: process.arch });
    const npx = await import(pathToFileURL(join(shimLaunchers(payload), "npx.mjs")).href);
    expect(npx.plan).toBeTypeOf("function");
  });
});

describe("cross-spawn, which starts an MCP server", () => {
  /** The installed cross-spawn's own test for a cmd-shim, whose words it escapes twice. */
  function isCmdShim(): RegExp {
    const backend = createRequire(
      join(import.meta.dirname, "../../../packages/assistant/package.json"),
    );
    const parse = readFileSync(backend.resolve("cross-spawn/lib/parse.js"), "utf8");
    const literal = /^const isCmdShimRegExp = \/(.+)\/([a-z]*);\r?$/m.exec(parse);
    if (literal === null) throw new Error("cross-spawn's parse.js names no isCmdShimRegExp");
    return new RegExp(literal[1] as string, literal[2]);
  }

  test("takes each .cmd launcher, as staged and in a packaged app on Windows, for a cmd-shim", () => {
    const shim = isCmdShim();
    const payload = temp();
    stageNodeShim(payload, { os: "win32", cpu: "x64" });
    const packaged = appLayout(
      "C:\\Users\\me\\AppData\\Local\\Programs\\eidolon\\Eidolon.exe",
      "win32",
    );
    for (const name of POSIX_LAUNCHERS) {
      for (const file of [
        join(shimLaunchers(payload), `${name}.cmd`),
        `${packaged.nodeShim}\\${name}.cmd`,
      ]) {
        expect([file, shim.test(file)]).toEqual([file, true]);
      }
    }
  });
});
