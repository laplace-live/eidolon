// Stages the backend the desktop app ships for one target, in apps/desktop/.stage/<target>/eidolon
// (`node apps/desktop/scripts/stage-backend.ts [--target darwin-arm64]`, this machine's by
// default): what the npm package stages, plus its dependencies installed by npm for the target,
// pinned to bun.lock and pruned.
import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { type Bundled, inlinedPackages, licenseText, stage } from "../../eidolon/scripts/build.ts";
import { type LsNode, lockDrift, lockedTree, pinOverrides, readBunLock } from "./lockfile.ts";

const DESKTOP = resolve(import.meta.dirname, "..");
const ROOT = resolve(DESKTOP, "../..");

/** What the app ships for, each with the onnxruntime-node files its CPU sessions load. */
export const TARGETS = {
  "darwin-arm64": {
    os: "darwin",
    cpu: "arm64",
    onnxruntime: ["onnxruntime_binding.node", "libonnxruntime.1.dylib"],
  },
} as const;

export type Target = keyof typeof TARGETS;

/** The license texts of node_modules, which the app's Licenses item opens. */
export const LICENSES_FILE = "THIRD_PARTY_LICENSES.txt";

export function stageDir(target: Target): string {
  return join(DESKTOP, ".stage", target);
}

/** What main runs: `<payload>/dist/server.js`, with EIDOLON_APP_ROOT set to the payload. */
export function payloadDir(target: Target): string {
  return join(stageDir(target), "eidolon");
}

export function parseTarget(value: string): Target {
  if (Object.hasOwn(TARGETS, value)) return value as Target;
  throw new Error(`The desktop app ships for ${Object.keys(TARGETS).join(" and ")}, not ${value}`);
}

export function hostTarget(): Target {
  return parseTarget(`${process.platform}-${process.arch}`);
}

/** Every file under `dir`, symbolic links included. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * npm, with its output captured or shown. On Windows it is a .cmd, which starts only through
 * cmd.exe, so the line is one string: none of these arguments needs quoting.
 */
function npm(args: readonly string[], cwd: string, capture = false) {
  const options: SpawnSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
  };
  const run =
    process.platform === "win32"
      ? spawnSync(["npm", ...args].join(" "), { ...options, shell: true })
      : spawnSync("npm", args, options);
  if (run.error) throw run.error;
  return { status: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/** `npm ls --all --json` of the install at `payload`, which exits 1 for the problems it lists. */
export function npmLs(payload: string): LsNode {
  const { stdout, stderr } = npm(["ls", "--all", "--json"], payload, true);
  try {
    return JSON.parse(stdout) as LsNode;
  } catch {
    throw new Error(`npm ls printed no JSON in ${payload}:\n${stderr}`);
  }
}

/**
 * Keeps only the target's onnxruntime-node folder, and in it the binding and the library it loads:
 * darwin-arm64's second, identical dylib, which nothing loads, goes.
 */
export function pruneOnnxruntime(modules: string, target: Target): void {
  const bin = join(modules, "onnxruntime-node", "bin", "napi-v6");
  const { os, cpu, onnxruntime } = TARGETS[target];
  const kept = join(bin, os, cpu);
  const missing = onnxruntime.filter((name) => !existsSync(join(kept, name)));
  if (missing.length > 0) {
    throw new Error(`onnxruntime-node has no ${missing.join(" or ")} in ${os}/${cpu}`);
  }
  for (const platform of readdirSync(bin)) {
    if (platform !== os) {
      rmSync(join(bin, platform), { recursive: true, force: true });
      continue;
    }
    for (const arch of readdirSync(join(bin, platform))) {
      if (arch !== cpu) rmSync(join(bin, platform, arch), { recursive: true, force: true });
    }
  }
  for (const name of readdirSync(kept)) {
    if (!(onnxruntime as readonly string[]).includes(name)) {
      rmSync(join(kept, name), { recursive: true, force: true });
    }
  }
}

/** Every package folder under `modules`, by name, nested node_modules included. */
function installedPackages(modules: string): [name: string, dir: string][] {
  const found: [string, string][] = [];
  const visit = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).filter((name) => !name.startsWith("."))) {
      const names = entry.startsWith("@")
        ? readdirSync(join(dir, entry)).map((name) => `${entry}/${name}`)
        : [entry];
      for (const name of names) {
        found.push([name, join(dir, name)]);
        visit(join(dir, name, "node_modules"));
      }
    }
  };
  visit(modules);
  return found;
}

function section(title: string, text: string): string {
  const rule = "=".repeat(78);
  return `${rule}\n${title}\n${rule}\n\n${text}\n`;
}

/** THIRD_PARTY_LICENSES.txt: each package in `modules` with its license text. */
export function thirdPartyLicenses(modules: string): string {
  const packages = new Map<string, Bundled>();
  for (const [name, dir] of installedPackages(modules)) {
    for (const pkg of inlinedPackages(new Map([[name, dir]]))) {
      packages.set(`${pkg.name}@${pkg.version}`, pkg);
    }
  }
  const sections = [...packages.values()]
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        a.version.localeCompare(b.version, undefined, { numeric: true }),
    )
    .map((pkg) => {
      const note = pkg.name.startsWith("@img/sharp-libvips-")
        ? "sharp links libvips dynamically. Its source is at https://github.com/libvips/libvips, " +
          "and the source of this build of it, with the libraries it includes, at " +
          "https://github.com/lovell/sharp-libvips; the package's README.md lists those " +
          "libraries and their licenses.\n\n"
        : "";
      const title = `${pkg.name} ${pkg.version} (${pkg.identifier ?? "no license field"})`;
      return section(title, `${note}${licenseText(pkg)}`);
    });
  return [
    "Third-party licenses\n",
    "Eidolon's backend runs on the packages below, from its node_modules folder, each with its",
    "license. The packages its bundles in dist/ and its web app in web/ include are listed in",
    "THIRD_PARTY_NOTICES.md, beside this file; NOTICE covers the code Eidolon ports from other",
    "projects, and the data and the font it ships.\n",
    ...sections,
  ].join("\n");
}

export interface StageSummary {
  readonly target: Target;
  readonly payload: string;
  readonly files: number;
  readonly bytes: number;
  /** Bytes by part of the payload. */
  readonly parts: Readonly<Record<string, number>>;
  readonly seconds: number;
}

function bytesUnder(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  return files(path).reduce((sum, file) => sum + lstatSync(file).size, 0);
}

/** Stages the payload for `target`, replacing what was there; a failed stage leaves none. */
export async function stageBackend(target: Target): Promise<StageSummary> {
  const started = performance.now();
  const payload = payloadDir(target);
  const modules = join(payload, "node_modules");
  const { os, cpu } = TARGETS[target];
  try {
    rmSync(stageDir(target), { recursive: true, force: true });
    const manifest = await stage(payload);
    const lock = readBunLock(join(ROOT, "bun.lock"));
    const roots = { ...manifest.dependencies, ...manifest.optionalDependencies };
    const overrides = pinOverrides(lockedTree(lock, roots).values());
    writeFileSync(
      join(payload, "package.json"),
      `${JSON.stringify({ ...manifest, overrides }, null, 2)}\n`,
    );
    const install = [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      `--os=${os}`,
      `--cpu=${cpu}`,
    ];
    console.log(`npm ${install.join(" ")}`);
    if (npm(install, payload).status !== 0) throw new Error("npm install failed");
    const drift = lockDrift(npmLs(payload), lock, { os, cpu });
    if (drift.length > 0) {
      throw new Error(`npm installed what bun.lock doesn't:\n${drift.join("\n")}`);
    }
    // npm's links to the packages' commands, which nothing runs, and its record of the install.
    const links = readdirSync(modules, { recursive: true, withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && entry.name === ".bin",
    );
    for (const entry of links) rmSync(join(entry.parentPath, entry.name), { recursive: true });
    rmSync(join(modules, ".package-lock.json"), { force: true });
    pruneOnnxruntime(modules, target);
    writeFileSync(join(payload, LICENSES_FILE), thirdPartyLicenses(modules));
  } catch (error) {
    rmSync(stageDir(target), { recursive: true, force: true });
    throw error;
  }
  const all = files(payload);
  return {
    target,
    payload,
    files: all.length,
    bytes: all.reduce((sum, file) => sum + lstatSync(file).size, 0),
    parts: {
      lancedb: bytesUnder(join(modules, "@lancedb")),
      onnxruntime: bytesUnder(join(modules, "onnxruntime-node")),
      sharp: bytesUnder(join(modules, "sharp")) + bytesUnder(join(modules, "@img")),
      web: bytesUnder(join(payload, "web")),
      dist: bytesUnder(join(payload, "dist")),
    },
    seconds: (performance.now() - started) / 1000,
  };
}

/** One line on what a stage made, and how long it took. */
export function describeStage(summary: StageSummary): string {
  const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MiB`;
  const parts = Object.entries(summary.parts).map(([part, bytes]) => `${part} ${mib(bytes)}`);
  return (
    `${relative(ROOT, summary.payload)}: ${summary.files} files, ${mib(summary.bytes)} ` +
    `(${parts.join(", ")}), staged in ${summary.seconds.toFixed(1)} s`
  );
}

if (import.meta.main) {
  const at = process.argv.indexOf("--target");
  const target = at === -1 ? hostTarget() : parseTarget(process.argv[at + 1] ?? "");
  console.log(describeStage(await stageBackend(target)));
}
