// Copyright (c) 2026 DeepSeek
// SPDX-License-Identifier: MIT
//
// Ported from deepseek-harness scripts/primary-runtime/prepare.ts@2e39e70496
//
// The node shim in the desktop payload, which npm users never get: launchers that run node, npx,
// pnpm and pnpx on the app's own binary as Node, in node-shim/node_modules/.bin, and the pnpm
// apps/desktop pins in node-shim/node_modules/node_modules, so the launchers' ../node_modules/pnpm
// is the same path as from their sources in apps/desktop/node-shim.
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { type Platform, supports } from "./lockfile.ts";

const DESKTOP = resolve(import.meta.dirname, "..");

/** The shim's folder in the payload. */
export const NODE_SHIM = "node-shim";
/** The launchers' sources. */
export const LAUNCHER_SOURCES = join(DESKTOP, "node-shim");
/** The launchers sh runs. */
export const POSIX_LAUNCHERS: readonly string[] = ["node", "npx", "pnpm", "pnpx"];
/** Every file of the launchers' folder: the POSIX ones, Windows' .cmd ones and the JS npx runs. */
export const LAUNCHER_FILES: readonly string[] = [
  ...POSIX_LAUNCHERS,
  ...POSIX_LAUNCHERS.map((name) => `${name}.cmd`),
  "npx.mjs",
  "cross-spawn.mjs",
  "npm-checks.mjs",
  "npm-config.mjs",
  "npm-exec.mjs",
  "npm-spec.mjs",
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

/** The folder of the pnpm package apps/desktop pins, as the workspace's pnpm installed it. */
export function pnpmPackage(): string {
  // Its exports map "." to its package.json, and nothing else.
  return dirname(createRequire(join(DESKTOP, "package.json")).resolve("pnpm"));
}

/**
 * Remove packages bundled directly under pnpm's dist/node_modules whose npm `os`/`cpu` fields
 * exclude the target. The pnpm tarball carries every platform's optional native packages, such as
 * `@reflink/reflink-darwin-x64`. Nested node_modules and the `libc` field are not inspected; the
 * pinned pnpm bundles neither nested native packages nor Linux variants.
 */
export function prunePnpmForeignNativePackages(pnpm: string, platform: string, arch: string): void {
  const modules = join(pnpm, "dist", "node_modules");
  const directories = (parent: string): string[] =>
    readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== ".bin")
      .map((entry) => join(parent, entry.name));
  const packages = directories(modules).flatMap((entry) =>
    basename(entry).startsWith("@") ? directories(entry) : [entry],
  );
  for (const directory of packages) {
    const { os, cpu } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (!supports(os, platform) || !supports(cpu, arch)) rmSync(directory, { recursive: true });
  }
}

/** Writes the shim into `payload`, its pnpm pruned to `platform`'s natives. */
export function stageNodeShim(payload: string, platform: Platform): void {
  const bin = shimLaunchers(payload);
  mkdirSync(bin, { recursive: true });
  for (const file of LAUNCHER_FILES) cpSync(join(LAUNCHER_SOURCES, file), join(bin, file));
  // A checkout's modes follow the umask it was made under.
  for (const name of POSIX_LAUNCHERS) chmodSync(join(bin, name), 0o755);
  const pnpm = shimPnpm(payload);
  const source = pnpmPackage();
  // Its own node_modules holds only the links the workspace's install made to its commands.
  cpSync(source, pnpm, {
    recursive: true,
    dereference: true,
    filter: (path) => path !== join(source, "node_modules"),
  });
  prunePnpmForeignNativePackages(pnpm, platform.os, platform.cpu);
  // The bundled packages' commands, which pnpm never runs: node-gyp's is in dist/node-gyp-bin.
  rmSync(join(pnpm, "dist", "node_modules", ".bin"), { recursive: true, force: true });
  // ps-list's fastlist executables, which pnpm's build copies in and nothing runs: electron-builder
  // signs every .exe it packs, so the Windows release would sign them as Eidolon's.
  rmSync(join(pnpm, "dist", "vendor"), { recursive: true, force: true });
}
