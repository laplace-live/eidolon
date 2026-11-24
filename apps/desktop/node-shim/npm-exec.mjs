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
import { globSync, statSync } from "node:fs";
import path from "node:path";

/** Whether `file` is a file, links followed. */
export function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** A manifest's bins, named and pointing inside the package `dir` as npm normalizes them. */
export function binsOf(manifest, dir) {
  let { bin } = manifest;
  if (!bin && typeof manifest.directories?.bin === "string" && manifest.directories.bin) {
    const folder = path.posix.join("/", manifest.directories.bin.replace(/\\/g, "/")).slice(1);
    const root = path.resolve(dir, folder);
    let entries = [];
    // npm's glob enters no link. A recursive readdir follows one to a folder, and two links back
    // into it never end.
    try {
      entries = globSync("**", { cwd: root, withFileTypes: true });
    } catch {}
    bin = {};
    for (const entry of entries) {
      const file = path
        .relative(root, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/");
      if (entry.isFile() && !file.startsWith(".")) bin[entry.name] = `${folder}/${file}`;
    }
  } else if (typeof bin === "string") {
    bin = typeof manifest.name === "string" ? { [manifest.name]: bin } : undefined;
  } else if (Array.isArray(bin)) {
    bin = Object.fromEntries(
      bin.filter((file) => typeof file === "string").map((file) => [path.basename(file), file]),
    );
  }
  const clean = {};
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
export function binOf(manifest, dir) {
  const bins = binsOf(manifest, dir);
  if (new Set(Object.values(bins)).size === 1) return Object.keys(bins)[0];
  const own = String(manifest.name ?? "").replace(/^@[^/]+\//, "");
  return Object.hasOwn(bins, own) ? own : undefined;
}

/** The node_modules/.bin from `start` up that holds `name`, as libnpmexec's localFileExists. */
export function localBin(start, name) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const bin = path.join(dir, "node_modules", ".bin");
    if (isFile(path.resolve(bin, name))) return bin;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** The env's PATH as npm reads it: each key Windows may spell it with, joined in order. */
export function pathOf(env, delimiter = path.delimiter) {
  return Object.keys(env)
    .filter((key) => /^path$/i.test(key) && env[key])
    .map((key) => env[key].split(delimiter))
    .reduce((dirs, more) => dirs.concat(more.filter((dir) => !dirs.includes(dir))), [])
    .join(delimiter);
}

/** npm's PATH: `bins`, each node_modules/.bin from `runPath` up, then node-gyp's and `rest`. */
export function npmPath(bins, runPath, nodeGyp, rest, delimiter = path.delimiter) {
  const dirs = [...bins];
  for (let dir = runPath; ; dir = path.dirname(dir)) {
    dirs.push(path.resolve(dir, "node_modules", ".bin"));
    if (path.dirname(dir) === dir) break;
  }
  return [...dirs, nodeGyp, rest].join(delimiter);
}
