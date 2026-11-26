// npx for an MCP server where the computer has none, deciding as npm's npx does: a bin of the
// project's own or in a node_modules/.bin from npm's local prefix up, or a package the project has
// installed, runs as it is; anything else the pnpm Eidolon bundles installs into its dlx cache, set
// to install as npm does. The command then runs here, on npm's PATH and in npm's folder, and npx
// ends as it did. pnpm reports on stderr, so the server's stdout, which the MCP protocol owns,
// holds only what the server prints.
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
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
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatWithOptions } from "node:util";
import { cmdLine } from "./cross-spawn.ts";
import {
  type CurrentEnv,
  currentEnv,
  type DevEngineFailure,
  devEngineFailures,
  semver,
} from "./npm-checks.ts";
import {
  type ConfigSource,
  type ConfigValue,
  invalidConfig,
  npmConfig,
  settingOf,
  settingPath,
  userConfig,
} from "./npm-config.ts";
import {
  binOf,
  binsOf,
  type Env,
  isFile,
  localBin,
  npmPath,
  type PackageManifest,
  pathOf,
  SHIM_BIN,
} from "./npm-exec.ts";
import { npmSpec, type ParsedSpec, TARBALL } from "./npm-spec.ts";

const DROPPED = new Set(["-y", "--yes", "-q", "--quiet"]);

// The settings of npm's project config that pnpm reads from an .npmrc and npm installs by: the
// registries, their credentials (npm's nerf-darted keys) and certificates.
const NERF_DARTS = ["_auth", "_authToken", "_password", "certfile", "email", "keyfile", "username"];
const REGISTRY_SETTING = new RegExp(
  `^(?:registry|ca|cafile|cert|key|@[^:/]+:registry|//.*:(?:${NERF_DARTS.join("|")}))$`,
);

/**
 * An .npmrc for pnpm holding what npm installs by from its config `sources`, as npmConfig reads
 * them, that pnpm reads from neither: the registries its variables name, over the registries,
 * credentials and certificates of its project config, each file they name as npm finds it from
 * `cwd`; empty with none.
 */
export function pnpmNpmrc(
  [variables = {}, project = {}]: readonly ConfigSource[],
  cwd: string,
  home: string,
  platform: string = process.platform,
): string {
  // npm ranks its variables over its project config. pnpm would take their registries only on
  // its command line, which any process can read, and a registry's URL can hold its token.
  const settings: ConfigSource = { ...project };
  for (const [key, value] of Object.entries(variables)) {
    if (key === "registry" || /^@[^:/]+:registry$/.test(key)) settings[key] = value;
  }
  const lines: string[] = [];
  // npm takes a ${VAR} it left, VAR being unset, as written. pnpm ignores a registry or
  // credential holding one in a project's .npmrc, so the user's would serve in its place, and
  // expands any other again: percent-encoded, it reaches pnpm as npm has it, an invalid URL or a
  // wrong token. A key holding one names no registry. npm takes an empty value as none. Of these
  // settings only ca is a list.
  const placeholder = /\$\{[^}]+\}/;
  const asWritten = (text: string): string =>
    placeholder.test(text) ? text.replace(/[${}]/g, (char) => encodeURIComponent(char)) : text;
  for (const [key, value] of Object.entries(settings)) {
    if (!REGISTRY_SETTING.test(key) || /[=\r\n]/.test(key) || placeholder.test(key)) continue;
    if (Array.isArray(value) && key !== "ca") continue;
    const client = /^(.*):(?:certfile|keyfile)$/.exec(key)?.[1];
    // npm presents a client certificate only with both files there; pnpm ends on a missing one.
    const pair = [settings[`${client}:certfile`], settings[`${client}:keyfile`]];
    const there = (file: ConfigValue | undefined): boolean =>
      typeof file === "string" &&
      file !== "" &&
      stat(path.resolve(cwd, asWritten(file))) !== undefined;
    if (client !== undefined && !pair.every(there)) continue;
    for (const text of [value]
      .flat()
      .filter((item): item is string => typeof item === "string" && item !== "")
      .map(asWritten)) {
      let file = text;
      if (key === "cafile") {
        file = settingPath(text, cwd, home, platform);
      } else if (client !== undefined) {
        file = path.resolve(cwd, text);
      }
      // Quoted, pnpm's ini parser reads each back as it is.
      lines.push(
        `${JSON.stringify(Array.isArray(value) ? `${key}[]` : key)}=${JSON.stringify(file)}`,
      );
    }
  }
  return lines.join("\n");
}

// npm's settings for reaching a registry. pnpm takes these only from the user's .npmrc, its own
// variables or its command line, never from a project's .npmrc or npm's variables.
const NETWORK_SETTINGS = ["proxy", "https-proxy", "noproxy", "strict-ssl"];

/**
 * pnpm's variables for npm's network settings in its config `sources`, as npmConfig reads them,
 * each from the highest source that gives it, as npm ranks them.
 */
export function pnpmNetworkEnv(sources: readonly ConfigSource[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of NETWORK_SETTINGS) {
    const value = settingOf(sources, key);
    if (value === undefined || value === "") continue;
    env[`pnpm_config_${key.replaceAll("-", "_")}`] =
      key === "strict-ssl" ? String(flag(value)) : [value].flat().join(",");
  }
  return env;
}

/** A boolean setting as npm reads one: a number unless 0, any other word unless false or null. */
function flag(value: ConfigValue | undefined): boolean {
  if (value === undefined) return false;
  const number = Number(value);
  return Number.isNaN(number) ? value !== "false" && value !== "null" : number !== 0;
}

/**
 * The minutes npm's `before` or `min-release-age` holds a version back, from the highest source
 * that gives either, `before` first within one.
 */
function releaseAge(sources: readonly ConfigSource[], now: number): number {
  for (const source of sources) {
    const before = Date.parse(String(source.before ?? ""));
    if (!Number.isNaN(before)) return Math.max(0, Math.ceil((now - before) / 60_000));
    const days = Number(source["min-release-age"] ?? Number.NaN);
    if (!Number.isNaN(days)) return Math.max(0, Math.ceil(days * 1440));
  }
  return 0;
}

/**
 * pnpm's settings that make its dlx install what npm's npx would, as npx would, under npm's config
 * `sources` as npmConfig reads them, its variables first; or why it can't.
 */
export function npxSettings(
  sources: readonly ConfigSource[],
  now: number = Date.now(),
): string[] | { error: string } {
  const setting = (key: string) => settingOf(sources, key);
  const ignoreScripts = flag(setting("ignore-scripts"));
  // npm then fails an install holding a package with install scripts allow-scripts doesn't name,
  // before it runs any. pnpm's dlx runs the scripts of the packages it was asked for unasked, and
  // never fails on a dependency's.
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
  ];
}

/**
 * npx's arguments: the packages its -p and --package options name, then the command and the words
 * after it, which are the command's. An option this npx doesn't take is an error, named without
 * its value.
 */
export function readNpx(
  args: readonly string[],
): { packages: string[]; command: string[] } | { error: string } {
  const packages: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] as string;
    if (DROPPED.has(arg)) continue;
    const option = arg.split("=", 1)[0] as string;
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

/**
 * The folder or tarball file `spec` names, as npm-package-arg tells them from a git repo, a URL or
 * a registry package; undefined for anything else.
 */
export function localSpec(
  spec: string,
  cwd: string,
  home: string,
  platform: string = process.platform,
): { path: string; tarball: boolean } | undefined {
  const parsed = npmSpec(spec, cwd, home, platform);
  if (parsed?.type !== "file" && parsed?.type !== "directory") return undefined;
  return { path: parsed.path, tarball: parsed.type === "file" };
}

const ALLOWS: Partial<Record<ParsedSpec["type"], string>> = {
  git: "allow-git",
  remote: "allow-remote",
  file: "allow-file",
  directory: "allow-directory",
};

/**
 * npm's error, as it prints it, for the first of `specs` whose kind its allow-git, allow-remote,
 * allow-file or allow-directory setting in `sources` is none, if any. Those npx asks for are the
 * root's, which root lets through.
 */
export function refusal(
  specs: readonly string[],
  sources: readonly ConfigSource[],
  cwd: string,
  home: string,
  platform: string = process.platform,
): string | undefined {
  for (const spec of specs) {
    const parsed = npmSpec(spec, cwd, home, platform);
    if (parsed === undefined) continue;
    const allow = ALLOWS[parsed.type];
    if (allow === undefined || settingOf(sources, allow) !== "none") continue;
    const lines = [
      `code EALLOW${parsed.type.toUpperCase()}`,
      `Fetching packages of type "${parsed.type}" have been disabled`,
    ];
    if (parsed.type === "git") {
      lines.push(`Refusing to fetch "${parsed.name ? `${parsed.name}@` : ""}${parsed.saveSpec}"`);
    }
    return lines.join("\n");
  }
  return undefined;
}

/**
 * pnpm's arguments to install `packages` into its dlx cache as npx would, with npxSettings'
 * `settings`: npm links a folder it is given rather than installing it and its dependencies, as
 * pnpm does with link:. pnpm reads a relative path from its dlx folder, so each local one goes
 * absolute, and without the name a spec gives it: npm runs the package's own bins whatever the
 * name, where pnpm's dlx makes a named one's path relative to the folder it runs in, which from
 * the cache folder it installs in points nowhere.
 */
export function npxToPnpm(
  packages: readonly string[],
  settings: readonly string[],
  cwd: string,
  home: string,
  platform: string = process.platform,
): string[] {
  const specs = packages.map((spec) => {
    const local = localSpec(spec, cwd, home, platform);
    return local === undefined ? spec : `${local.tarball ? "file" : "link"}:${local.path}`;
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

function stat(file: string): Stats | undefined {
  try {
    return statSync(file, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

function readJson(file: string): PackageManifest | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as PackageManifest;
  } catch {
    return undefined;
  }
}

/** npm's reading of `pattern` as a glob, for workspaces' paths. */
const matches = (relative: string, pattern: string): boolean =>
  path.posix.matchesGlob(relative, pattern.replace(/\/+$/, ""));

function workspacePatterns(declared: unknown): unknown[] | undefined {
  if (Array.isArray(declared)) return declared;
  const packages = (declared as { packages?: unknown } | null | undefined)?.packages;
  return Array.isArray(packages) ? packages : undefined;
}

/** Whether `dir` is one of the workspaces the package.json in `root` declares, as npm maps them. */
function isWorkspace(root: string, dir: string): boolean {
  const list = workspacePatterns(readJson(path.join(root, "package.json"))?.workspaces);
  if (list === undefined || !isFile(path.join(dir, "package.json"))) return false;
  const relative = path.relative(root, dir).split(path.sep).join("/");
  if (relative.split("/").includes("node_modules")) return false;
  const patterns: string[] = [];
  let negated: string[] = [];
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
export function npmPrefix(cwd: string): { prefix: string; workspace: string | undefined } {
  let found: string | undefined;
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

/** The workspaces the package.json in `root` declares, as npm maps them. */
function workspacesOf(root: string): string[] {
  const list = workspacePatterns(readJson(path.join(root, "package.json"))?.workspaces);
  if (list === undefined) return [];
  const found = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== "string" || (/^!+/.exec(entry)?.[0].length ?? 0) % 2 === 1) continue;
    const pattern = entry
      .replace(/^!+/, "")
      .replace(/^\.?\/+/, "")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
    let dirs: string[] = [];
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
function packagesIn(dir: string): string[] {
  const names = (folder: string): string[] => {
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

export interface InstalledPackage {
  readonly dir: string;
  readonly manifest: PackageManifest & { readonly name: string; readonly version?: string };
}

/**
 * npm's local tree at `prefix`, as Arborist loads it: the project, its workspaces, and every
 * package in a node_modules below them, a link's target too, nearest first.
 */
export function treePackages(prefix: string): InstalledPackage[] {
  const packages: InstalledPackage[] = [];
  const seen = new Set<string>();
  const queue = [prefix, ...workspacesOf(prefix)];
  for (const dir of queue) {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const manifest = readJson(path.join(real, "package.json"));
    if (typeof manifest?.name === "string") {
      packages.push({
        dir: real,
        manifest: manifest as InstalledPackage["manifest"],
      });
    }
    queue.push(...packagesIn(path.join(real, "node_modules")));
  }
  return packages;
}

const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i;

/**
 * The package of `packages` that `spec` names, as libnpmexec's missingFromTree finds one in the
 * local tree, which npm then runs rather than install: by its package.json's name, at any version
 * for a name alone, or one the version or range allows. A tag, an alias, or a spec that isn't a
 * registry's, it never finds there.
 */
export function inTree<T extends { dir: string; manifest: { name: string; version?: unknown } }>(
  packages: readonly T[],
  spec: string,
): T | undefined {
  const at = spec.indexOf("@", 1);
  const name = at > 0 ? spec.slice(0, at) : spec;
  const wanted = at > 0 ? spec.slice(at + 1) || "*" : "*";
  if (!PACKAGE_NAME.test(name) || TARBALL.test(name)) return undefined;
  const named = packages.filter(({ manifest }) => manifest.name === name);
  if (wanted === "*") return named[0];
  if (named.length === 0 || semver().validRange(wanted.trim(), true) === null) return undefined;
  return named.find(({ manifest }) => {
    const version = typeof manifest.version === "string" ? manifest.version : "";
    return `${name}@${version}` === spec || semver().satisfies(version, wanted);
  });
}

// The npm whose npx this one behaves as, the package manager a project's devEngines checks.
const NPM_VERSION = "11.19.1";

/**
 * What npm makes of the devEngines in the package.json `manifest` at its local prefix, against
 * `current`, before any command: the lines it warns with, and those it ends on, each as it prints
 * them; under `force`, every failure only warns.
 */
export function devEngines(
  manifest: unknown,
  force: boolean,
  current: CurrentEnv,
): { warnings: string[]; error?: string } {
  const wanted = (manifest as { devEngines?: unknown } | null | undefined)?.devEngines;
  if (wanted === undefined) return { warnings: [] };
  let failures: DevEngineFailure[];
  try {
    failures = devEngineFailures(wanted, current);
  } catch (error) {
    return { warnings: [], error: (error as Error).message };
  }
  // npm's log puts the code before each line of a message, or of an object as inspect shows it.
  const logged = (value: unknown): string[] =>
    formatWithOptions({ colors: false }, value)
      .split(/\r?\n/)
      .map((line) => (line ? `EBADDEVENGINES ${line}` : "EBADDEVENGINES"));
  const header = "The developer of this package has specified the following through devEngines";
  const printed = (
    { engine, errors, current: now, required }: DevEngineFailure,
    first: boolean,
  ): string[] => {
    const message = [...(first ? [header] : []), `Invalid devEngines.${engine}`, ...errors];
    return [...logged(message.join("\n")), ...logged({ current: now, required })];
  };
  const ending = failures.filter(({ onFail }) => onFail === "error");
  const warned = failures.filter(({ onFail }) => onFail === "warn");
  // Under force npm warns of those it would end on too, after the others.
  if (force) warned.push(...ending);
  const warnings = warned.flatMap((failure, at) =>
    printed(failure, at === 0).map((line) => `warn ${line}`),
  );
  if (force || ending.length === 0) return { warnings };
  return {
    warnings,
    error: ["code EBADDEVENGINES", ...printed(ending[0] as DevEngineFailure, true)].join("\n"),
  };
}

export type NpxDecision =
  | { error: string; code?: number }
  | {
      install?: string[];
      command?: string;
      args: string[];
      bins: string[];
      runPath: string;
    };

export type NpxPlan = NpxDecision & { warnings?: string[] };

/**
 * What npx does with `args` from `cwd`, as libnpmexec decides it: the command, `undefined` for
 * the bin of the one package `install` names, the folders whose bins come first on its PATH, and
 * the folder it runs in; `install` lists what isn't here yet. An error carries npm's exit code,
 * and `warnings` what npm warns of first. `env` and `home` give npm's config, and `current` the
 * computer a project's devEngines is checked against.
 */
export function plan(
  args: readonly string[],
  cwd: string,
  home: string = homedir(),
  env: Env = process.env,
  current: CurrentEnv = currentEnv(NPM_VERSION),
): NpxPlan {
  const { prefix, workspace } = npmPrefix(cwd);
  const sources = npmConfig(env, prefix, home);
  // npm refuses such config, then a project whose devEngines this computer misses, before it
  // looks at what to run.
  const invalid = invalidConfig(sources);
  if (invalid !== undefined) return { error: invalid, code: 1 };
  const force = flag(settingOf(sources, "force"));
  const { warnings, error } = devEngines(
    readJson(path.join(prefix, "package.json")),
    force,
    current,
  );
  const decided: NpxDecision =
    error === undefined ? decide(args, cwd, home, sources, prefix, workspace) : { error, code: 1 };
  return warnings.length > 0 ? { ...decided, warnings } : decided;
}

/** plan's decision once npm's config lets npx run. */
function decide(
  args: readonly string[],
  cwd: string,
  home: string,
  sources: readonly ConfigSource[],
  prefix: string,
  workspace: string | undefined,
): NpxDecision {
  const read = readNpx(args);
  if ("error" in read) return read;
  const runPath = workspace ?? cwd;
  const trees: [string, ...string[]] = workspace === undefined ? [prefix] : [workspace, prefix];
  let tree: InstalledPackage[] | undefined;
  const inLocalTree = (spec: string) => {
    tree ??= treePackages(prefix);
    return inTree(tree, spec);
  };
  const [command, ...rest] = read.command as [string, ...string[]];
  let chosen: string | undefined = command;
  let packages = read.packages;
  let own: string | undefined;
  if (packages.length === 0) {
    own = trees.find((dir) => {
      const manifest = readJson(path.join(dir, "package.json"));
      return manifest !== undefined && Object.hasOwn(binsOf(manifest, dir), command);
    });
    if (own !== undefined) {
      // npm installs the project as a link and runs its bin, whatever allow-directory says.
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
      chosen = undefined;
    }
  }
  // npm refuses one before it looks for it in the local tree.
  if (own === undefined) {
    const refused = refusal(packages, sources, cwd, home);
    if (refused !== undefined) return { error: refused, code: 1 };
  }
  const install = packages.filter((spec) => inLocalTree(spec) === undefined);
  for (const spec of install) {
    const local = localSpec(spec, cwd, home);
    if (local === undefined) continue;
    try {
      readFileSync(local.tarball ? local.path : path.join(local.path, "package.json"));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      const what = local.tarball ? "the tarball" : "package.json";
      return { error: `could not read ${what}: ${err.message}`, code: err.errno ?? 1 };
    }
  }
  return {
    ...(install.length > 0 ? { install } : {}),
    command: chosen,
    args: rest,
    bins: [],
    runPath,
  };
}

/**
 * The command's environment: `env` with every key that spells PATH set to `value`, and without
 * ELECTRON_RUN_AS_NODE, which npm doesn't set: the launchers set it again for what they run on
 * Eidolon's binary, and anything else, VS Code's `code` say, would run as Node with it.
 */
export function commandEnv(env: Env, value: string): Record<string, string | undefined> {
  const kept = Object.entries(env).filter(([key]) => key.toUpperCase() !== "ELECTRON_RUN_AS_NODE");
  const keys = kept.map(([key]) => key).filter((key) => /^path$/i.test(key));
  return {
    ...Object.fromEntries(kept),
    ...Object.fromEntries((keys.length > 0 ? keys : ["PATH"]).map((key) => [key, value])),
  };
}

const envValue = (env: Env, name: string): string | undefined =>
  Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];

/** `env` with `variables` set, each in place of every spelling of its name `env` has. */
function withVariables(
  env: Env,
  variables: Readonly<Record<string, string>>,
): Record<string, string | undefined> {
  const names = new Set(Object.keys(variables).map((name) => name.toUpperCase()));
  const kept = Object.entries(env).filter(([key]) => !names.has(key.toUpperCase()));
  return { ...Object.fromEntries(kept), ...variables };
}

export interface WhichOptions {
  readonly pathEnv: string;
  readonly cwd: string;
  readonly platform?: string;
  readonly pathext?: string;
  readonly cwdFirst?: boolean;
}

/**
 * The file `command` names, searched for from `cwd` on `pathEnv` as sh does: the first executable
 * one, or with none the first there, which sh then fails to run. On Windows as cmd.exe does
 * through PATHEXT, but in the working folder first only with `cwdFirst`, as cmd.exe looks up a
 * name a batch file runs.
 */
export function which(
  command: string,
  { pathEnv, cwd, platform = process.platform, pathext, cwdFirst }: WhichOptions,
): string | undefined {
  const windows = platform === "win32";
  const dirs = windows
    ? pathEnv
        .split(";")
        .filter(Boolean)
        .map((dir) => dir.replace(/^"(.*)"$/, "$1"))
    : pathEnv.split(":");
  const bases = (windows ? /[\\/]/ : /\//).test(command)
    ? [path.resolve(cwd, command)]
    : [...(cwdFirst ? [cwd] : []), ...dirs].map((dir) => path.resolve(cwd, dir, command));
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

// pnpm's cmd-shim, and npm's before it set _prog: the node.exe beside it, else a bare node, looked up
// with .JS out of PATHEXT.
const PNPM_CMD_SHIM =
  /^@IF EXIST "%~dp0\\node\.exe" \(\r?\n[ \t]*"%~dp0\\node\.exe" [^\r\n]*%\*\r?\n\) ELSE \(\r?\n(?:[ \t]*@SETLOCAL\r?\n)?[ \t]*@SET PATHEXT=%PATHEXT:;\.JS;=;%\r?\n[ \t]*node [^\r\n]*%\*\r?\n\)/im;
// npm's: _prog is the node.exe beside it, else a bare node; the endLocal that leads the line running
// it in npm's later shims has put PATHEXT back by then.
const NPM_CMD_SHIM =
  /^IF EXIST "%dp0%\\node\.exe" \(\r?\n[ \t]*SET "_prog=%dp0%\\node\.exe"\r?\n\) ELSE \(\r?\n[ \t]*SET "_prog=node"\r?\n[ \t]*SET PATHEXT=%PATHEXT:;\.JS;=;%\r?\n\)\r?\n(?:[ \t]*\r?\n)*(endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & )?"%_prog%" [^\r\n]*%\*\r?$/im;

/**
 * Whether the batch file `text` is a cmd-shim, pnpm's or npm's, that runs its bin on the node.exe
 * beside it, else on a bare `node`, with `lessJs` when cmd.exe looks that up with .JS out of
 * PATHEXT; undefined for any other.
 */
export function nodeCmdShim(text: string): { lessJs: boolean } | undefined {
  if (PNPM_CMD_SHIM.test(text)) return { lessJs: true };
  const npm = NPM_CMD_SHIM.exec(text);
  return npm === null ? undefined : { lessJs: npm[1] === undefined };
}

/** Whether `a` and `b` name one file as Windows compares them: links followed, without case. */
function sameFile(a: string, b: string): boolean {
  const real = (file: string): string => {
    try {
      return realpathSync.native(file);
    } catch {
      return path.resolve(file);
    }
  };
  return real(a).toLowerCase() === real(b).toLowerCase();
}

/** This shim's node.cmd, which hands its words on through `%*`. */
const NODE_CMD = fileURLToPath(new URL("node.cmd", SHIM_BIN));

export interface RereadsOptions {
  readonly env: Env;
  readonly cwd: string;
  readonly nodeCmd?: string;
}

/**
 * How many times more than once cmd.exe reads the words npx starts the Windows `file` with: none
 * for a file it runs as it is; once for a batch file, whose `%*` hands them on, as npm's npx counts;
 * twice for a cmd-shim with no node.exe beside it whose bare `node` cmd.exe would find to be
 * `nodeCmd`, the shim's own, which hands them on again. cmd.exe looks `node` up in `cwd` first,
 * unless NoDefaultCurrentDirectoryInExePath is set, then on `env`'s PATH. Set means there at
 * all, empty too: Windows checks only that it exists
 * (https://learn.microsoft.com/windows/win32/api/processenv/nf-processenv-needcurrentdirectoryforexepathw).
 */
export function rereads(file: string, { env, cwd, nodeCmd = NODE_CMD }: RereadsOptions): number {
  if (!/\.(?:cmd|bat)$/i.test(file)) return 0;
  let text = "";
  try {
    text = readFileSync(file, "latin1");
  } catch {}
  const shim = nodeCmdShim(text);
  // IF EXIST, which a folder answers too.
  if (shim === undefined || stat(path.join(path.dirname(file), "node.exe")) !== undefined) return 1;
  const pathext = envValue(env, "PATHEXT");
  const node = which("node", {
    pathEnv: pathOf(env, ";"),
    cwd,
    platform: "win32",
    pathext: shim.lessJs ? pathext?.replace(/;\.JS;/gi, ";") : pathext,
    cwdFirst: envValue(env, "NoDefaultCurrentDirectoryInExePath") === undefined,
  });
  return node !== undefined && sameFile(node, nodeCmd) ? 2 : 1;
}

export interface SpawnArgsOptions {
  readonly platform?: string;
  readonly env?: Env;
  readonly cwd?: string;
  readonly nodeCmd?: string;
}

/**
 * How to start `file` from `cwd` without a shell: on Windows a .exe or .com directly, anything
 * else through cmd.exe, each word escaped once for each time cmd.exe reads it (rereads).
 */
export function spawnArgs(
  file: string,
  args: readonly string[],
  {
    platform = process.platform,
    env = process.env,
    cwd = process.cwd(),
    nodeCmd,
  }: SpawnArgsOptions = {},
): { command: string; args: string[]; verbatim: boolean } {
  if (platform !== "win32" || /\.(?:exe|com)$/i.test(file)) {
    return { command: file, args: [...args], verbatim: false };
  }
  const comspec = envValue(env, "ComSpec") ?? "cmd.exe";
  return { ...cmdLine(comspec, file, args, rereads(file, { env, cwd, nodeCmd })), verbatim: true };
}

/**
 * Passes SIGINT and SIGTERM on to `child`, as npm does to what it runs; returns the undo. On
 * Windows only waits for it: kill() there is TerminateProcess, and a console's Ctrl-C reaches the
 * child itself.
 */
export function relay(
  child: { kill(signal: NodeJS.Signals): void },
  platform: string = process.platform,
): () => void {
  const forward: NodeJS.SignalsListener =
    platform === "win32" ? () => {} : (signal) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  return () => {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  };
}

/** Ends as the child did: npm raises its signal again on itself, or exits with its code. */
function end(code: number | null, signal: NodeJS.Signals | null): Promise<never> {
  if (signal !== null && process.platform !== "win32") {
    process.kill(process.pid, signal);
    setTimeout(() => process.exit(1), 500);
    return new Promise(() => {});
  }
  process.exit(code ?? 1);
}

function fail(message: string, code = 1): never {
  console.error(message.replace(/^/gm, "npx: "));
  process.exit(code);
}

/** The interpreter the #! line `file` starts with names, if it has one. */
function interpreterOf(file: string): string | undefined {
  try {
    return /^#!\s*(\S+)/.exec(readFileSync(file, "latin1"))?.[1];
  } catch {
    return undefined;
  }
}

// The no-op pnpm runs once installed, which leaves its dlx folder's bins, first on its PATH.
const REPORT =
  'require("node:fs").writeFileSync(process.env.EIDOLON_NPX_REPORT, process.env.PATH ?? "")';

interface PnpmRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: string;
}

function spawnErrorExit(error: NodeJS.ErrnoException): number {
  return error.code === "ENOENT" ? 127 : error.code === "EACCES" ? 126 : 1;
}

function runPnpm(dir: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<PnpmRun> {
  const pnpm = fileURLToPath(new URL("../node_modules/pnpm/bin/pnpm.mjs", SHIM_BIN));
  const child = spawn(
    process.execPath,
    [...process.execArgv, pnpm, `--dir=${dir}`, "--ignore-workspace", ...args],
    {
      cwd: dir,
      stdio: ["ignore", 2, 2],
      env,
      windowsHide: true,
    },
  );
  const undo = relay(child);
  return new Promise((resolve) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      undo();
      resolve({ code: spawnErrorExit(error), signal: null, error: error.message });
    });
    child.on("exit", (code, signal) => {
      undo();
      resolve({ code, signal });
    });
  });
}

/** Installs `packages` in pnpm's dlx cache, resolving to its node_modules/.bin, or ends as pnpm. */
async function install(packages: readonly string[]): Promise<string> {
  const sources = npmConfig(process.env, npmPrefix(process.cwd()).prefix, homedir());
  const settings = npxSettings(sources);
  if ("error" in settings) fail(settings.error);
  const ignoreScripts = settings.includes("--config.ignore-scripts=true");
  const scratch = mkdtempSync(path.join(tmpdir(), "eidolon-npx-"));
  // pnpm reads the .npmrc of the project it finds itself in, not the one npm reads at its local
  // prefix, and expands no ${VAR} in one's registries or credentials. So it runs in a folder of
  // its own, with that .npmrc written there as npm reads it, the registries npm's variables name
  // over its own, and no pnpm workspace around it. The folder is the user's alone, and goes once
  // pnpm ends.
  const npmrc = pnpmNpmrc(sources, process.cwd(), homedir());
  const report = path.join(scratch, "path");
  // pnpm's stdout goes to stderr with its own, and it never reads the server's stdin. Its
  // variables carry npm's network settings, which a proxy's URL can hold credentials in: only the
  // owner's processes read them. A relative userconfig pnpm would read from its own folder.
  const variables = sources[0] ?? {};
  const userconfig =
    typeof variables.userconfig === "string" && variables.userconfig
      ? { npm_config_userconfig: userConfig(variables, homedir()) }
      : undefined;
  const baseEnv = withVariables(process.env, {
    ...pnpmNetworkEnv(sources),
    ...userconfig,
  }) as NodeJS.ProcessEnv;
  let bin: string | undefined;
  let dlx: PnpmRun;
  try {
    if (npmrc) writeFileSync(path.join(scratch, ".npmrc"), `${npmrc}\n`, { mode: 0o600 });
    dlx = await runPnpm(
      scratch,
      [
        ...npxToPnpm(packages, settings, process.cwd(), homedir()),
        ...(ignoreScripts ? [] : ["--config.ignore-scripts=true"]),
        "--",
        process.execPath,
        ...process.execArgv,
        "-e",
        REPORT,
      ],
      { ...baseEnv, EIDOLON_NPX_REPORT: report },
    );
    try {
      bin = readFileSync(report, "utf8").split(path.delimiter)[0];
    } catch {}
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (dlx.error !== undefined) fail(`couldn't start pnpm: ${dlx.error}`, dlx.code ?? 1);
  if (dlx.code !== 0 || !bin) return end(dlx.code || 1, dlx.signal);
  // pnpm dlx clears dangerously_allow_all_builds in .modules.yaml's cache policy, running root
  // scripts before subdependencies can build; defer all scripts on dlx and rebuild --pending in
  // dependency order unless ignore-scripts is set.
  if (ignoreScripts) return bin;
  const cachedDir = path.dirname(path.dirname(bin));
  const pending = readJson(path.join(cachedDir, "node_modules", ".modules.yaml"))?.pendingBuilds;
  if (!Array.isArray(pending) || pending.length === 0) return bin;
  const cachedNpmrc = path.join(cachedDir, ".npmrc");
  const wroteNpmrc = npmrc !== "" && !isFile(cachedNpmrc);
  let rebuilt: PnpmRun;
  try {
    if (wroteNpmrc) writeFileSync(cachedNpmrc, `${npmrc}\n`, { mode: 0o600 });
    rebuilt = await runPnpm(
      cachedDir,
      ["--loglevel=error", ...settings, "rebuild", "--pending"],
      baseEnv,
    );
  } finally {
    if (wroteNpmrc) rmSync(cachedNpmrc, { force: true });
  }
  if (rebuilt.error !== undefined) fail(`couldn't start pnpm: ${rebuilt.error}`, rebuilt.code ?? 1);
  if (rebuilt.code !== 0) return end(rebuilt.code || 1, rebuilt.signal);
  return bin;
}

/** The packages npx installed in the dlx folder whose node_modules/.bin is `bin`, in order. */
function installed(bin: string): { dir: string; manifest: PackageManifest }[] {
  const dir = path.dirname(path.dirname(bin));
  const dependencies = readJson(path.join(dir, "package.json"))?.dependencies;
  const names =
    typeof dependencies === "object" && dependencies !== null ? Object.keys(dependencies) : [];
  return names.flatMap((name) => {
    const packageDir = path.join(dir, "node_modules", name);
    const manifest = readJson(path.join(packageDir, "package.json"));
    return manifest === undefined ? [] : [{ dir: packageDir, manifest }];
  });
}

if (import.meta.main) {
  const decided = plan(process.argv.slice(2), process.cwd());
  for (const line of decided.warnings ?? []) console.error(`npx: ${line}`);
  if ("error" in decided) fail(decided.error, decided.code);
  const bin = decided.install !== undefined ? await install(decided.install) : undefined;
  const packages = bin !== undefined ? installed(bin) : [];
  // With no command named, npm picks the bin of the package installed: see binOf.
  const command = decided.command ?? (packages[0] && binOf(packages[0].manifest, packages[0].dir));
  if (command === undefined) fail("could not determine executable to run");
  if (bin !== undefined) {
    // pnpm links no bin whose name or path it won't take, which npm names and links as binsOf
    // does: a program of that name further down PATH would run in its place.
    const theirs = packages.some(({ manifest, dir }) =>
      Object.hasOwn(binsOf(manifest, dir), command),
    );
    if (theirs && !isFile(path.join(bin, command))) {
      fail(`${command}: pnpm doesn't link a bin by this name`, 127);
    }
  }
  const bins = bin !== undefined ? [bin] : decided.bins;
  const nodeGyp = fileURLToPath(new URL("../node_modules/pnpm/dist/node-gyp-bin", SHIM_BIN));
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
  const start = spawnArgs(file, decided.args, { env, cwd: decided.runPath });
  const options: SpawnOptions = {
    cwd: decided.runPath,
    env: env as NodeJS.ProcessEnv,
    stdio: "inherit",
    windowsHide: true,
    windowsVerbatimArguments: start.verbatim,
  };
  let child: ChildProcess | undefined;
  // Listening before the command starts: a signal npx gets once it runs would otherwise end npx
  // alone, as nothing listened yet, and leave the command running. Node calls the listener only
  // after this block, when child is set.
  const undo = relay({ kill: (signal) => child?.kill(signal) });
  try {
    child = spawn(start.command, start.args, options);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // Node throws ENOEXEC rather than emit it. sh runs a file the system can't, one without a #!
    // line, as a script of its own.
    if (err.code !== "ENOEXEC" || process.platform === "win32") {
      fail(`${command}: ${err.message}`, 126);
    }
    child = spawn("/bin/sh", [file, ...decided.args], options);
  }
  child.on("error", (error: NodeJS.ErrnoException) => {
    // spawn reports a script whose #! interpreter isn't there as the script missing; sh names the
    // interpreter and ends 126.
    const interpreter =
      error.code === "ENOENT" && process.platform !== "win32" ? interpreterOf(file) : undefined;
    if (interpreter !== undefined) {
      fail(`${command}: ${interpreter}: bad interpreter: No such file or directory`, 126);
    }
    fail(`${command}: ${error.message}`, error.code === "EACCES" ? 126 : 127);
  });
  child.on("exit", (code, signal) => {
    undo();
    end(code, signal);
  });
}
