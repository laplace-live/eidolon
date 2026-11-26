// Copyright (c) 2026 DeepSeek
// SPDX-License-Identifier: MIT
//
// Ported from deepseek-harness scripts/primary-runtime/prepare.spec.ts@2e39e70496
//
// The shim the stage writes from the checkout's launchers, pnpm and @pnpm/exe.<os>-<cpu>, for each
// target, its .cmd launchers where cross-spawn escapes their words for the cmd.exe that reads them
// again. The staged payload's is stage.test.ts's.
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
  SHIM_MODULES,
  shimLaunchers,
  shimPnpm,
  shimPnpmExe,
  stageNodeShim,
} from "../scripts/node-shim.ts";
import { appLayout } from "../scripts/smoke/packaged.ts";

const PNPM_VERSION: string = JSON.parse(
  readFileSync(join(LAUNCHER_SOURCES, "..", "package.json"), "utf8"),
).devDependencies.pnpm;

const temps: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "eidolon-node-shim-stage-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in @pnpm/exe.<os>-<cpu> package when staging a target other than the host's. */
function exeSource(os: string, cpu: string) {
  if (os === process.platform && cpu === process.arch) return undefined;
  const exe = join(temp(), "@pnpm", `exe.${os}-${cpu}`);
  mkdirSync(exe, { recursive: true });
  writeFileSync(
    join(exe, "package.json"),
    JSON.stringify({
      name: `@pnpm/exe.${os}-${cpu}`,
      version: PNPM_VERSION,
      os: [os],
      cpu: [cpu],
    }),
  );
  writeFileSync(join(exe, "LICENSE"), "MIT\n");
  writeFileSync(join(exe, os === "win32" ? "pnpm.exe" : "pnpm"), "");
  return { exe };
}

describe("the shim the stage writes", () => {
  test.each([
    ["darwin", "arm64", "pnpm"],
    ["win32", "x64", "pnpm.exe"],
  ] as const)(
    "for %s/%s: the checkout's launchers in node_modules/.bin, sh's executable, pnpm at their ../node_modules/pnpm, and its @pnpm/exe.* binary beside it",
    (os, cpu, binary) => {
      const payload = temp();
      stageNodeShim(payload, { os, cpu }, exeSource(os, cpu));
      expect(readdirSync(join(payload, NODE_SHIM)).sort()).toEqual(
        ["node_modules", ...SHIM_MODULES].sort(),
      );
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
      for (const file of SHIM_MODULES) {
        expect([file, readFileSync(join(payload, NODE_SHIM, file), "utf8")]).toEqual([
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
      expect(JSON.parse(readFileSync(join(pnpm, "package.json"), "utf8")).version).toBe(
        PNPM_VERSION,
      );
      const modules = join(pnpm, "dist", "node_modules");
      expect(readdirSync(modules)).not.toContain(".bin");
      const exe = shimPnpmExe(payload, { os, cpu });
      expect(exe).toBe(join(bin, "..", "node_modules", "@pnpm", `exe.${os}-${cpu}`));
      expect(JSON.parse(readFileSync(join(exe, "package.json"), "utf8")).version).toBe(
        PNPM_VERSION,
      );
      expect(readdirSync(exe)).toContain(binary);
      if (os !== "win32" && process.platform !== "win32") {
        expect(statSync(join(exe, binary)).mode & 0o777).toBe(0o755);
      }
      const exes = readdirSync(join(payload, NODE_SHIM), { recursive: true })
        .map((file) => String(file).replaceAll("\\", "/"))
        .filter((file) => file.endsWith(".exe"));
      expect(exes).toEqual(
        os === "win32" ? [`node_modules/node_modules/@pnpm/exe.${os}-${cpu}/pnpm.exe`] : [],
      );
    },
  );

  test("holds each module npx.ts imports, so the staged one loads", async () => {
    const payload = temp();
    stageNodeShim(payload, { os: process.platform, cpu: process.arch });
    const npx = await import(pathToFileURL(join(payload, NODE_SHIM, "npx.ts")).href);
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
    stageNodeShim(payload, { os: "win32", cpu: "x64" }, exeSource("win32", "x64"));
    const packaged = appLayout(
      "C:\\Users\\me\\AppData\\Local\\Programs\\eidolon\\LAPLACE Eidolon.exe",
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
