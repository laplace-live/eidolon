// npx for an MCP server where the computer has none, deciding as npm's npx does: a bin of the
// project's own or in a node_modules/.bin from npm's local prefix up, or a package the project has
// installed, runs as it is; anything else the pnpm Eidolon bundles installs into its dlx cache, set
// to install as npm does. The command then runs here, on npm's PATH and in npm's folder, and npx
// ends as it did. pnpm reports on stderr, so the server's stdout, which the MCP protocol owns,
// holds only what the server prints.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  globSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cmdLine } from "./cross-spawn.mjs";

const DROPPED = new Set(["-y", "--yes", "-q", "--quiet"]);

/** The settings an .npmrc gives before any [section], as npm's ini parser reads their values. */
function readNpmrc(file) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  const settings = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*([^;#\s=][^=]*?)\s*(?:=(.*))?$/.exec(line);
    if (match === null) continue;
    const value = (match[2] ?? "true").trim();
    settings[match[1]] = /^(["']).*\1$/.test(value)
      ? value.slice(1, -1)
      : value.replace(/\s*[;#].*$/, "");
  }
  return settings;
}

/**
 * npm's config sources npx reads, highest first, each as `{ key: value }`: the npm_config_*
 * variables in `env`, the .npmrc at npm's local `prefix`, then the user's.
 */
export function npmConfig(env, prefix, home) {
  const variables = {};
  for (const [name, value] of Object.entries(env)) {
    const key = /^npm_config_(.+)$/i.exec(name)?.[1];
    if (key === undefined || !value) continue;
    variables[key.startsWith("//") ? key : key.replace(/(?!^)_/g, "-").toLowerCase()] = value;
  }
  const user = path.resolve(variables.userconfig ?? path.join(home, ".npmrc"));
  const project = path.join(prefix, ".npmrc");
  return [variables, project === user ? {} : readNpmrc(project), readNpmrc(user)];
}

/** A boolean setting as npm reads one: a number unless 0, any other word unless false or null. */
function flag(value) {
  if (value === undefined) return false;
  const number = Number(value);
  return Number.isNaN(number) ? value !== "false" && value !== "null" : number !== 0;
}

/**
 * The minutes npm's `before` or `min-release-age` holds a version back, from the highest source
 * that gives either, `before` first within one.
 */
function releaseAge(sources, now) {
  for (const source of sources) {
    const before = Date.parse(source.before ?? "");
    if (!Number.isNaN(before)) return Math.max(0, Math.ceil((now - before) / 60_000));
    const days = Number(source["min-release-age"] ?? Number.NaN);
    if (!Number.isNaN(days)) return Math.max(0, Math.ceil(days * 1440));
  }
  return 0;
}

/**
 * pnpm's settings that make its dlx install what npm's npx would, as npx would, under npm's config
 * `sources` as npmConfig reads them, its variables first; or why it can't.
 * @returns {string[] | { error: string }}
 */
export function npxSettings(sources, now = Date.now()) {
  const setting = (key) => sources.find((source) => Object.hasOwn(source, key))?.[key];
  const ignoreScripts = flag(setting("ignore-scripts"));
  // npm then fails an install with any script allow-scripts doesn't name, which pnpm can't tell
  // before it installs.
  if (
    !ignoreScripts &&
    flag(setting("strict-allow-scripts")) &&
    !flag(setting("dangerously-allow-all-scripts"))
  ) {
    return { error: "strict-allow-scripts is set, and Eidolon's npx can't hold an install to it" };
  }
  const exotic = [setting("allow-git"), setting("allow-remote")];
  return [
    // npm runs every dependency's install scripts, or none under ignore-scripts; pnpm only those of
    // the packages asked for.
    ignoreScripts ? "--config.ignore-scripts=true" : "--config.dangerously-allow-all-builds=true",
    // npm takes the newest version that before or min-release-age allows; pnpm one at least a day
    // old.
    `--config.minimum-release-age=${releaseAge(sources, now)}`,
    // npm installs a dependency's own git and tarball-URL dependencies unless allow-git or
    // allow-remote is root or none; pnpm refuses them.
    `--config.block-exotic-subdeps=${exotic.some((allow) => allow === "root" || allow === "none")}`,
    // npm installs a flat node_modules, where a package finds what it uses without declaring it up
    // the folders, and the packages beside it at ../name. pnpm's isolated layout puts each package
    // among its own dependencies alone, and in its global virtual store an ES module finds the rest
    // only through a loader in NODE_OPTIONS, which the packaged app's Electron ignores.
    "--config.node-linker=hoisted",
    // npm reads no pnpmfile; pnpm runs the one of the workspace around the folder, or the home's,
    // whose hooks can rewrite what installs.
    "--config.ignore-pnpmfile=true",
    // npm takes registries from its variables, which pnpm never reads: a private package's name
    // would resolve on the registry pnpm falls back on. The .npmrc files' pnpm reads itself.
    ...Object.entries(sources[0] ?? {})
      .filter(([key]) => key === "registry" || /^@[^:/]+:registry$/.test(key))
      .map(([key, value]) => `--config.${key}=${value}`),
  ];
}

/**
 * npx's arguments: the packages its -p and --package options name, then the command and the words
 * after it, which are the command's. An option this npx doesn't take is an error, named without
 * its value.
 * @param {readonly string[]} args
 * @returns {{ packages: string[], command: string[] } | { error: string }}
 */
export function readNpx(args) {
  const packages = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (DROPPED.has(arg)) continue;
    const option = arg.split("=", 1)[0];
    if (option === "-p" || option === "--package") {
      const name = option === arg ? args[++at] : arg.slice(option.length + 1);
      if (!name) return { error: `${option} needs a package` };
      packages.push(name);
      continue;
    }
    if (arg !== "--" && arg.startsWith("-"))
      return { error: `Eidolon's npx doesn't take ${option}` };
    const command = args.slice(arg === "--" ? at + 1 : at);
    if (command.length === 0) break;
    return { packages, command };
  }
  return { error: "nothing to run" };
}

const URL_SPEC = /^(?:git\+)?[a-z]+:/i;
const SCP_GIT_SPEC = /^[^@]+@[^:.]+\.[^:]+:.+$/i;
const TARBALL = /[.](?:tgz|tar\.gz|tar)$/i;
const GITHUB_SHORTCUT = /^[^:@%/\s.-][^:@%/\s]*\/[^:@\s/%]+(?:#.*)?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;

/**
 * The folder or tarball file `spec` names, as npm-package-arg tells them from a git repo, a URL or
 * a registry package, with the name it gives it, if any; undefined for anything else.
 */
export function localSpec(spec, cwd, home, platform = process.platform) {
  const windows = platform === "win32";
  const slashes = windows ? /[\\/]/ : /\//;
  const at = spec.indexOf("@", 1);
  const namePart = at > 0 ? spec.slice(0, at) : spec;
  let name;
  let where = spec;
  if (URL_SPEC.test(spec)) {
    // A URL, or a Windows path.
  } else if (SCP_GIT_SPEC.test(spec)) {
    return undefined;
  } else if (!namePart.startsWith("@") && (slashes.test(namePart) || TARBALL.test(namePart))) {
    // A path, @ and all.
  } else if (at > 0) {
    name = namePart;
    where = spec.slice(at + 1);
  } else if (PACKAGE_NAME.test(spec)) {
    return undefined;
  }
  const fileLike =
    /^file:/i.test(where) ||
    (windows ? /^(?:[.]|~[/\\]|[/\\]|[a-zA-Z]:)/ : /^(?:[.]|~\/|\/|[a-zA-Z]:)/).test(where);
  const pathLike =
    !/^npm:/i.test(where) &&
    !GITHUB_SHORTCUT.test(where) &&
    !URL_SPEC.test(where) &&
    (slashes.test(where) || TARBALL.test(where));
  if (!fileLike && !pathLike) return undefined;
  let file = where.replace(/^file:/i, "");
  // file:/../x is relative; file://x and file:///x are /x.
  if (/^\/{1,3}\.\.?(?:\/|$)/.test(file)) file = file.replace(/^\/+/, "");
  else file = file.replace(/^\/{2,3}(?=[^/])/, "/");
  if (windows) file = file.replace(/^\/+([a-z]:[/\\])/i, "$1");
  const resolved =
    file === "~" || /^~[/\\]/.test(file) ? path.join(home, file.slice(2)) : path.resolve(cwd, file);
  return { name, path: resolved, tarball: TARBALL.test(where) };
}

/**
 * pnpm's arguments to install `packages` into its dlx cache as npx would, with npxSettings'
 * `settings`: npm links a folder it is given rather than installing it and its dependencies, as
 * pnpm does with link:. pnpm reads a relative path from its dlx folder, so each local one goes
 * absolute.
 * @param {readonly string[]} packages
 * @param {readonly string[]} settings
 * @returns {string[]}
 */
export function npxToPnpm(packages, settings, cwd, home, platform = process.platform) {
  const specs = packages.map((spec) => {
    const local = localSpec(spec, cwd, home, platform);
    if (local === undefined) return spec;
    const name = local.name === undefined ? "" : `${local.name}@`;
    return `${name}${local.tarball ? "file" : "link"}:${local.path}`;
  });
  // pnpm keys a dlx install by its packages and --allow-build, never by these settings, so for a
  // day pnpx's or pnpm dlx's install of a package would serve npx, and npx's them, and one npx's
  // another's under other settings. A name no package can have, made from them, keys each apart.
  const key = createHash("sha256").update(settings.join("\n")).digest("hex").slice(0, 16);
  return [
    "--loglevel=error",
    ...settings,
    "dlx",
    `--allow-build=.npx-${key}`,
    ...specs.map((spec) => `--package=${spec}`),
  ];
}

function stat(file) {
  try {
    return statSync(file, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

const isFile = (file) => stat(file)?.isFile() === true;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
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

/** npm's reading of `pattern` as a glob, for workspaces' paths. */
const matches = (relative, pattern) =>
  path.posix.matchesGlob(relative, pattern.replace(/\/+$/, ""));

/** Whether `dir` is one of the workspaces the package.json in `root` declares, as npm maps them. */
function isWorkspace(root, dir) {
  const declared = readJson(path.join(root, "package.json"))?.workspaces;
  const list = Array.isArray(declared?.packages) ? declared.packages : declared;
  if (!Array.isArray(list) || !isFile(path.join(dir, "package.json"))) return false;
  const relative = path.relative(root, dir).split(path.sep).join("/");
  if (relative.split("/").includes("node_modules")) return false;
  const patterns = [];
  let negated = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const bangs = /^!+/.exec(entry)?.[0].length ?? 0;
    const pattern = entry
      .slice(bangs)
      .replace(/^\.?\/+/, "")
      .replace(/\\/g, "/");
    if (bangs % 2 === 1) {
      negated.push(pattern);
    } else {
      // A pattern brings back what a negation before it left out.
      negated = negated.filter((left) => !matches(pattern, left));
      patterns.push(pattern);
    }
  }
  return (
    patterns.some(
      (pattern) => !negated.some((left) => matches(pattern, left)) && matches(relative, pattern),
    ) && !negated.some((left) => matches(relative, left))
  );
}

/**
 * npm's local prefix from `cwd`: the first folder up with a package.json or a node_modules, or
 * the root of the workspaces it is one of, with `workspace` then that first folder.
 */
export function npmPrefix(cwd) {
  let found;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const hasManifest = isFile(path.join(dir, "package.json"));
    if (found === undefined) {
      if (hasManifest || stat(path.join(dir, "node_modules"))?.isDirectory()) found = dir;
    } else if (hasManifest && isWorkspace(dir, found)) {
      return { prefix: dir, workspace: found };
    }
    if (path.dirname(dir) === dir)
      return { prefix: found ?? path.resolve(cwd), workspace: undefined };
  }
}

/** The node_modules/.bin from `start` up that holds `name`, as libnpmexec's localFileExists. */
export function localBin(start, name) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const bin = path.join(dir, "node_modules", ".bin");
    if (isFile(path.resolve(bin, name))) return bin;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** The workspaces the package.json in `root` declares, as npm maps them. */
function workspacesOf(root) {
  const declared = readJson(path.join(root, "package.json"))?.workspaces;
  const list = Array.isArray(declared?.packages) ? declared.packages : declared;
  if (!Array.isArray(list)) return [];
  const found = new Set();
  for (const entry of list) {
    if (typeof entry !== "string" || (/^!+/.exec(entry)?.[0].length ?? 0) % 2 === 1) continue;
    const pattern = entry
      .replace(/^!+/, "")
      .replace(/^\.?\/+/, "")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
    let dirs = [];
    try {
      dirs = globSync(pattern, {
        cwd: root,
        exclude: (name) => path.basename(name) === "node_modules",
      });
    } catch {}
    for (const dir of dirs)
      if (isWorkspace(root, path.join(root, dir))) found.add(path.join(root, dir));
  }
  return [...found];
}

/** The package folders in the node_modules `dir`, scoped ones too, as Arborist reads them. */
function packagesIn(dir) {
  const names = (folder) => {
    try {
      return readdirSync(folder).filter((name) => !name.startsWith("."));
    } catch {
      return [];
    }
  };
  return names(dir).flatMap((name) =>
    name.startsWith("@")
      ? names(path.join(dir, name)).map((inner) => path.join(dir, name, inner))
      : [path.join(dir, name)],
  );
}

/**
 * npm's local tree at `prefix`, as Arborist loads it: the project, its workspaces, and every
 * package in a node_modules below them, a link's target too, nearest first.
 */
export function treePackages(prefix) {
  const packages = [];
  const seen = new Set();
  const queue = [prefix, ...workspacesOf(prefix)];
  for (const dir of queue) {
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const manifest = readJson(path.join(real, "package.json"));
    if (typeof manifest?.name === "string") packages.push({ dir: real, manifest });
    queue.push(...packagesIn(path.join(real, "node_modules")));
  }
  return packages;
}

let loadedSemver;
/** npm's semver, which the pnpm here carries for node-gyp. */
function semver() {
  loadedSemver ??= createRequire(import.meta.url)("../node_modules/pnpm/dist/node_modules/semver");
  return loadedSemver;
}

/**
 * The package of `packages` that `spec` names, as libnpmexec's missingFromTree finds one in the
 * local tree, which npm then runs rather than install: by its package.json's name, at any version
 * for a name alone, or one the version or range allows. A tag, an alias, or a spec that isn't a
 * registry's, it never finds there.
 */
export function inTree(packages, spec) {
  const at = spec.indexOf("@", 1);
  const name = at > 0 ? spec.slice(0, at) : spec;
  const wanted = at > 0 ? spec.slice(at + 1) || "*" : "*";
  if (!PACKAGE_NAME.test(name) || TARBALL.test(name)) return undefined;
  const named = packages.filter(({ manifest }) => manifest.name === name);
  if (wanted === "*") return named[0];
  if (named.length === 0 || semver().validRange(wanted.trim(), true) === null) return undefined;
  return named.find(
    ({ manifest }) =>
      `${name}@${manifest.version}` === spec || semver().satisfies(manifest.version, wanted),
  );
}

/**
 * What npx does with `args` from `cwd`, as libnpmexec decides it: the command, `undefined` for
 * the bin of the one package `install` names, the folders whose bins come first on its PATH, and
 * the folder it runs in; `install` lists what isn't here yet. An error carries npm's exit code.
 */
export function plan(args, cwd, home = homedir()) {
  const read = readNpx(args);
  if ("error" in read) return read;
  const { prefix, workspace } = npmPrefix(cwd);
  const runPath = workspace ?? cwd;
  const trees = workspace === undefined ? [prefix] : [workspace, prefix];
  let tree;
  const inLocalTree = (spec) => {
    tree ??= treePackages(prefix);
    return inTree(tree, spec);
  };
  let [command, ...rest] = read.command;
  let packages = read.packages;
  if (packages.length === 0) {
    const own = trees.find((dir) => {
      const manifest = readJson(path.join(dir, "package.json"));
      return manifest !== undefined && Object.hasOwn(binsOf(manifest, dir), command);
    });
    if (own !== undefined) {
      // npm installs the project as a link and runs its bin.
      packages = [own];
    } else {
      const bin = localBin(trees[0], command);
      if (bin !== undefined) return { command, args: rest, bins: [bin], runPath };
      const found = inLocalTree(command);
      if (found !== undefined) {
        const name = binOf(found.manifest, found.dir);
        if (name === undefined) return { error: "could not determine executable to run" };
        return { command: name, args: rest, bins: [], runPath };
      }
      packages = [command];
      command = undefined;
    }
  }
  const install = packages.filter((spec) => inLocalTree(spec) === undefined);
  for (const spec of install) {
    const local = localSpec(spec, cwd, home);
    if (local === undefined) continue;
    try {
      readFileSync(local.tarball ? local.path : path.join(local.path, "package.json"));
    } catch (error) {
      const what = local.tarball ? "the tarball" : "package.json";
      return { error: `could not read ${what}: ${error.message}`, code: error.errno ?? 1 };
    }
  }
  return { ...(install.length > 0 ? { install } : {}), command, args: rest, bins: [], runPath };
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

/**
 * The command's environment: `env` with every key that spells PATH set to `value`, and without
 * ELECTRON_RUN_AS_NODE, which npm doesn't set: the launchers set it again for what they run on
 * Eidolon's binary, and anything else, VS Code's `code` say, would run as Node with it.
 */
export function commandEnv(env, value) {
  const kept = Object.entries(env).filter(([key]) => key.toUpperCase() !== "ELECTRON_RUN_AS_NODE");
  const keys = kept.map(([key]) => key).filter((key) => /^path$/i.test(key));
  return {
    ...Object.fromEntries(kept),
    ...Object.fromEntries((keys.length > 0 ? keys : ["PATH"]).map((key) => [key, value])),
  };
}

const envValue = (env, name) =>
  Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];

/**
 * The file `command` names, searched for from `cwd` on `pathEnv` as sh does: the first executable
 * one, or with none the first there, which sh then fails to run. On Windows as cmd.exe does
 * through PATHEXT, but never in the working folder first.
 */
export function which(command, { pathEnv, cwd, platform = process.platform, pathext }) {
  const windows = platform === "win32";
  const dirs = windows
    ? pathEnv
        .split(";")
        .filter(Boolean)
        .map((dir) => dir.replace(/^"(.*)"$/, "$1"))
    : pathEnv.split(":");
  const bases = (windows ? /[\\/]/ : /\//).test(command)
    ? [path.resolve(cwd, command)]
    : dirs.map((dir) => path.resolve(cwd, dir, command));
  if (!windows) {
    const files = bases.filter(isFile);
    const executable = files.find((file) => {
      try {
        accessSync(file, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    return executable ?? files[0];
  }
  const extensions = (pathext || ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC")
    .split(";")
    .filter(Boolean);
  const tries = path.extname(command) === "" ? extensions : ["", ...extensions];
  for (const base of bases) {
    for (const extension of tries) {
      if (isFile(base + extension)) return base + extension;
    }
  }
  return undefined;
}

/**
 * How to start `file` without a shell: on Windows a .exe or .com directly, anything else through
 * cmd.exe, with a batch file's arguments escaped twice, as npm's npx escapes them.
 */
export function spawnArgs(file, args, { platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32" || /\.(?:exe|com)$/i.test(file)) {
    return { command: file, args, verbatim: false };
  }
  const batch = /\.(?:cmd|bat)$/i.test(file);
  return { ...cmdLine(envValue(env, "ComSpec") ?? "cmd.exe", file, args, batch), verbatim: true };
}

/**
 * Passes SIGINT and SIGTERM on to `child`, as npm does to what it runs; returns the undo. On
 * Windows only waits for it: kill() there is TerminateProcess, and a console's Ctrl-C reaches the
 * child itself.
 */
export function relay(child, platform = process.platform) {
  const forward = platform === "win32" ? () => {} : (signal) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  return () => {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  };
}

/** Ends as the child did: npm raises its signal again on itself, or exits with its code. */
function end(code, signal) {
  if (signal !== null && process.platform !== "win32") {
    process.kill(process.pid, signal);
    setTimeout(() => process.exit(1), 500);
    return;
  }
  process.exit(code ?? 1);
}

function fail(message, code = 1) {
  console.error(`npx: ${message}`);
  process.exit(code);
}

// The no-op pnpm runs once installed, which leaves its dlx folder's bins, first on its PATH.
const REPORT =
  'require("node:fs").writeFileSync(process.env.EIDOLON_NPX_REPORT, process.env.PATH ?? "")';

/** Installs `packages` in pnpm's dlx cache, resolving to its node_modules/.bin, or ends as pnpm. */
function install(packages) {
  const sources = npmConfig(process.env, npmPrefix(process.cwd()).prefix, homedir());
  const settings = npxSettings(sources);
  if ("error" in settings) fail(settings.error);
  const scratch = mkdtempSync(path.join(tmpdir(), "eidolon-npx-"));
  const report = path.join(scratch, "path");
  const pnpm = fileURLToPath(new URL("../node_modules/pnpm/bin/pnpm.mjs", import.meta.url));
  const args = [
    ...process.execArgv,
    pnpm,
    ...npxToPnpm(packages, settings, process.cwd(), homedir()),
    "--",
    process.execPath,
    ...process.execArgv,
    "-e",
    REPORT,
  ];
  // pnpm's stdout goes to stderr with its own, and it never reads the server's stdin.
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", 2, 2],
    env: { ...process.env, EIDOLON_NPX_REPORT: report },
    windowsHide: true,
  });
  const undo = relay(child);
  return new Promise((resolve) => {
    child.on("error", (error) => fail(`couldn't start pnpm: ${error.message}`));
    child.on("exit", (code, signal) => {
      undo();
      let bin;
      try {
        bin = readFileSync(report, "utf8").split(path.delimiter)[0];
      } catch {}
      rmSync(scratch, { recursive: true, force: true });
      if (code === 0 && bin) resolve(bin);
      else end(code || 1, signal);
    });
  });
}

/** The packages npx installed in the dlx folder whose node_modules/.bin is `bin`, in order. */
function installed(bin) {
  const dir = path.dirname(path.dirname(bin));
  const names = Object.keys(readJson(path.join(dir, "package.json"))?.dependencies ?? {});
  return names.flatMap((name) => {
    const packageDir = path.join(dir, "node_modules", name);
    const manifest = readJson(path.join(packageDir, "package.json"));
    return manifest === undefined ? [] : [{ dir: packageDir, manifest }];
  });
}

if (import.meta.main) {
  const decided = plan(process.argv.slice(2), process.cwd());
  if ("error" in decided) fail(decided.error, decided.code);
  let { command, bins } = decided;
  if (decided.install !== undefined) {
    const bin = await install(decided.install);
    bins = [bin];
    const packages = installed(bin);
    // With no command named, npm picks the bin of the package installed: see binOf.
    command ??= packages[0] && binOf(packages[0].manifest, packages[0].dir);
    if (command === undefined) fail("could not determine executable to run");
    // pnpm links no bin whose name or path it won't take, which npm names and links as binsOf
    // does: a program of that name further down PATH would run in its place.
    const theirs = packages.some(({ manifest, dir }) =>
      Object.hasOwn(binsOf(manifest, dir), command),
    );
    if (theirs && !isFile(path.join(bin, command))) {
      fail(`${command}: pnpm doesn't link a bin by this name`, 127);
    }
  }
  const nodeGyp = fileURLToPath(new URL("../node_modules/pnpm/dist/node-gyp-bin", import.meta.url));
  const env = commandEnv(process.env, npmPath(bins, decided.runPath, nodeGyp, pathOf(process.env)));
  const file = which(command, {
    pathEnv: pathOf(env),
    cwd: decided.runPath,
    pathext: envValue(env, "PATHEXT"),
  });
  if (file === undefined) {
    // As cmd.exe or sh would end.
    if (process.platform === "win32") fail(`'${command}' is not recognized as a command`);
    fail(`${command}: command not found`, 127);
  }
  const start = spawnArgs(file, decided.args, { env });
  const options = {
    cwd: decided.runPath,
    env,
    stdio: "inherit",
    windowsHide: true,
    windowsVerbatimArguments: start.verbatim,
  };
  let child;
  try {
    child = spawn(start.command, start.args, options);
  } catch (error) {
    // Node throws ENOEXEC rather than emit it. sh runs a file the system can't, one without a #!
    // line, as a script of its own.
    if (error.code !== "ENOEXEC" || process.platform === "win32") {
      fail(`${command}: ${error.message}`, 126);
    }
    child = spawn("/bin/sh", [file, ...decided.args], options);
  }
  const undo = relay(child);
  child.on("error", (error) =>
    fail(`${command}: ${error.message}`, error.code === "EACCES" ? 126 : 127),
  );
  child.on("exit", (code, signal) => {
    undo();
    end(code, signal);
  });
}
