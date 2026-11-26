// Copyright (c) npm, Inc.
// Copyright GitHub Inc.
// Copyright (c) GitHub Inc.
// SPDX-License-Identifier: ISC
//
// Ported from npm-normalize-package-bin lib/index.js@5.0.0, @npmcli/package-json
// lib/normalize.js@7.0.5, libnpmexec lib/file-exists.js and lib/get-bin-from-manifest.js@10.3.2,
// and @npmcli/run-script lib/set-path.js@10.0.4
//
// What npx runs, as npm finds it: a package's bins, the one it picks given no command, a bin in a
// node_modules/.bin from a folder up, and npm's PATH for the command.
import { type Dirent, globSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Env = Readonly<Record<string, string | undefined>>;

export interface PackageManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly bin?: unknown;
  readonly directories?: unknown;
  readonly workspaces?: unknown;
  readonly devEngines?: unknown;
  readonly [key: string]: unknown;
}

/** Whether `file` is a file, links followed. */
export function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The shim's launchers: beside these modules in a checkout, in node_modules/.bin in a payload. */
export const SHIM_BIN: URL = isFile(fileURLToPath(new URL("node.cmd", import.meta.url)))
  ? new URL("./", import.meta.url)
  : new URL("./node_modules/.bin/", import.meta.url);

/** A manifest's bins, named and pointing inside the package `dir` as npm normalizes them. */
export function binsOf(manifest: PackageManifest, dir: string): Record<string, string> {
  let { bin } = manifest;
  const directories = manifest.directories as { readonly bin?: unknown } | null | undefined;
  const binDir =
    typeof directories === "object" && directories !== null ? directories.bin : undefined;
  if (!bin && typeof binDir === "string" && binDir) {
    const folder = path.posix.join("/", binDir.replace(/\\/g, "/")).slice(1);
    const root = path.resolve(dir, folder);
    let entries: Dirent[] = [];
    // npm's glob enters no link. A recursive readdir follows one to a folder, and two links back
    // into it never end.
    try {
      entries = globSync("**", { cwd: root, withFileTypes: true });
    } catch {}
    const scanned: Record<string, string> = {};
    for (const entry of entries) {
      const file = path
        .relative(root, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/");
      if (entry.isFile() && !file.startsWith(".")) scanned[entry.name] = `${folder}/${file}`;
    }
    bin = scanned;
  } else if (typeof bin === "string") {
    bin = typeof manifest.name === "string" ? { [manifest.name]: bin } : undefined;
  } else if (Array.isArray(bin)) {
    bin = Object.fromEntries(
      bin
        .filter((file): file is string => typeof file === "string")
        .map((file) => [path.basename(file), file]),
    );
  }
  const clean: Record<string, string> = {};
  if (bin === null || typeof bin !== "object") return clean;
  for (const [key, value] of Object.entries(bin)) {
    const name = path.posix.join("/", path.posix.basename(key.replace(/\\|:/g, "/"))).slice(1);
    if (typeof value !== "string" || !name) continue;
    const file = path.posix.join("/", value.replace(/\\/g, "/")).slice(1);
    if (file) clean[name] = file;
  }
  return clean;
}

/** The bin npm runs from a package given no command, or undefined where npm can't tell which. */
export function binOf(manifest: PackageManifest, dir: string): string | undefined {
  const bins = binsOf(manifest, dir);
  if (new Set(Object.values(bins)).size === 1) return Object.keys(bins)[0];
  const own = String(manifest.name ?? "").replace(/^@[^/]+\//, "");
  return Object.hasOwn(bins, own) ? own : undefined;
}

/** The node_modules/.bin from `start` up that holds `name`, as libnpmexec's localFileExists. */
export function localBin(start: string, name: string): string | undefined {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const bin = path.join(dir, "node_modules", ".bin");
    if (isFile(path.resolve(bin, name))) return bin;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** The env's PATH as npm reads it: each key Windows may spell it with, joined in order. */
export function pathOf(env: Env, delimiter = path.delimiter): string {
  return Object.keys(env)
    .filter((key) => /^path$/i.test(key) && Boolean(env[key]))
    .map((key) => (env[key] as string).split(delimiter))
    .reduce<string[]>((dirs, more) => dirs.concat(more.filter((dir) => !dirs.includes(dir))), [])
    .join(delimiter);
}

/** npm's PATH: `bins`, each node_modules/.bin from `runPath` up, then node-gyp's and `rest`. */
export function npmPath(
  bins: readonly string[],
  runPath: string,
  nodeGyp: string,
  rest: string,
  delimiter = path.delimiter,
): string {
  const dirs = [...bins];
  for (let dir = runPath; ; dir = path.dirname(dir)) {
    dirs.push(path.resolve(dir, "node_modules", ".bin"));
    if (path.dirname(dir) === dir) break;
  }
  return [...dirs, nodeGyp, rest].join(delimiter);
}
