// Copyright (c) 2026 DeepSeek
// SPDX-License-Identifier: MIT
//
// Ported from deepseek-harness scripts/primary-runtime/prepare.ts@2e39e70496
//
// The node shim in the desktop payload, which npm users never get: launchers that run node, npx,
// pnpm and pnpx on the app's own binary as Node, in node-shim/node_modules/.bin, and the pnpm
// apps/desktop pins (plus its @pnpm/exe.* binary) in node-shim/node_modules/node_modules, so the
// launchers' ../node_modules/pnpm is the same path as from their sources in apps/desktop/node-shim.
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { Platform } from "./lockfile.ts";

const DESKTOP = resolve(import.meta.dirname, "..");

/** The shim's folder in the payload. */
export const NODE_SHIM = "node-shim";
/** The launchers' sources. */
export const LAUNCHER_SOURCES = join(DESKTOP, "node-shim");
/** The launchers sh runs. */
export const POSIX_LAUNCHERS: readonly string[] = ["node", "npx", "pnpm", "pnpx"];
/** Every file of the launchers' folder: the POSIX ones and Windows' .cmd ones. */
export const LAUNCHER_FILES: readonly string[] = [
  ...POSIX_LAUNCHERS,
  ...POSIX_LAUNCHERS.map((name) => `${name}.cmd`),
];
/**
 * The TypeScript modules npx runs, staged in `node-shim/` itself rather than `node_modules/.bin`:
 * Node refuses to strip types for paths under `node_modules`.
 */
export const SHIM_MODULES: readonly string[] = [
  "npx.ts",
  "cross-spawn.ts",
  "npm-checks.ts",
  "npm-config.ts",
  "npm-exec.ts",
  "npm-spec.ts",
];

/**
 * The launchers' folder in `payload`: a node_modules/.bin, since cross-spawn, which starts an MCP
 * server, escapes the words of a .cmd there twice, as a cmd-shim's, whose `%*` cmd.exe reads
 * again; a launcher's is read again the same way, and anywhere else it escapes them once.
 */
export function shimLaunchers(payload: string): string {
  return join(payload, NODE_SHIM, "node_modules", ".bin");
}

/** The pnpm the launchers run in `payload`, at their ../node_modules/pnpm. */
export function shimPnpm(payload: string): string {
  return join(payload, NODE_SHIM, "node_modules", "node_modules", "pnpm");
}

/** The platform binary package pnpm's native-binary.mjs resolves at ../@pnpm/exe.<os>-<cpu>. */
export function shimPnpmExe(payload: string, platform: Platform): string {
  return join(dirname(shimPnpm(payload)), "@pnpm", `exe.${platform.os}-${platform.cpu}`);
}

/** The folder of the pnpm package apps/desktop pins, as the workspace's pnpm installed it. */
export function pnpmPackage(): string {
  return dirname(createRequire(join(DESKTOP, "package.json")).resolve("pnpm/package.json"));
}

/** The folder of @pnpm/exe.<os>-<cpu> beside the workspace's installed pnpm. */
export function pnpmExePackage(platform: Platform): string {
  const dir = join(dirname(pnpmPackage()), "@pnpm", `exe.${platform.os}-${platform.cpu}`);
  if (!existsSync(dir)) {
    throw new Error(`No @pnpm/exe.${platform.os}-${platform.cpu} at ${dir}`);
  }
  return dir;
}

export interface NodeShimSources {
  readonly pnpm?: string;
  readonly exe?: string;
}

/** Writes the shim into `payload`, with `platform`'s `@pnpm/exe.*` beside pnpm. */
export function stageNodeShim(
  payload: string,
  platform: Platform,
  sources: NodeShimSources = {},
): void {
  const shim = join(payload, NODE_SHIM);
  const bin = shimLaunchers(payload);
  mkdirSync(bin, { recursive: true });
  for (const file of LAUNCHER_FILES) cpSync(join(LAUNCHER_SOURCES, file), join(bin, file));
  for (const file of SHIM_MODULES) cpSync(join(LAUNCHER_SOURCES, file), join(shim, file));
  // A checkout's modes follow the umask it was made under.
  for (const name of POSIX_LAUNCHERS) chmodSync(join(bin, name), 0o755);
  const pnpm = shimPnpm(payload);
  const source = sources.pnpm ?? pnpmPackage();
  // Its own node_modules holds only the links the workspace's install made to its commands.
  cpSync(source, pnpm, {
    recursive: true,
    dereference: true,
    filter: (path) => path !== join(source, "node_modules"),
  });
  // The bundled packages' commands, which pnpm never runs: node-gyp's is in dist/node-gyp-bin.
  rmSync(join(pnpm, "dist", "node_modules", ".bin"), { recursive: true, force: true });
  const exe = shimPnpmExe(payload, platform);
  cpSync(sources.exe ?? pnpmExePackage(platform), exe, { recursive: true, dereference: true });
  if (platform.os !== "win32") chmodSync(join(exe, "pnpm"), 0o755);
}
