// Stages the backend the desktop app ships for one target, in apps/desktop/.stage/<target>/eidolon
// (`node apps/desktop/scripts/stage-backend.ts [--target darwin-arm64|win32-x64]`, this machine's by
// default): what the npm package stages, plus its dependencies installed by npm for the target,
// pinned to pnpm-lock.yaml and pruned, and the node shim (node-shim.ts). On Windows the natives
// also get the VC++ runtime beside them, and .stage/win32-x64/unsigned-pe.json lists the PE files
// the release signs.
import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type Bundled,
  inlinedPackages,
  licenseText,
  spdxText,
  stage,
} from "../../eidolon/scripts/build.ts";
import { VC_RUNTIME_DLLS } from "../../eidolon/src/launcher.ts";
import { type LsNode, lockDrift, lockedTree, pinOverrides, readPnpmLock } from "./lockfile.ts";
import { NODE_SHIM, shimPnpm, stageNodeShim } from "./node-shim.ts";
import { compareVersions, type Pe, readPe } from "./pe.ts";
import { readZip } from "./zip.ts";

const DESKTOP = resolve(import.meta.dirname, "..");
const ROOT = resolve(DESKTOP, "../..");

/** What the app ships for, each with the onnxruntime-node files its CPU sessions load. */
export const TARGETS = {
  "darwin-arm64": {
    os: "darwin",
    cpu: "arm64",
    onnxruntime: ["onnxruntime_binding.node", "libonnxruntime.1.dylib"],
  },
  "win32-x64": {
    os: "win32",
    cpu: "x64",
    onnxruntime: ["onnxruntime_binding.node", "onnxruntime.dll"],
  },
} as const;

export type Target = keyof typeof TARGETS;

/** In the payload: the licenses of the third-party code and data it holds, for the Licenses item. */
export const LICENSES_FILE = "THIRD_PARTY_LICENSES.txt";
/** Beside win32-x64's payload: the names of its unsigned PE files, and Electron's, for signExts. */
export const UNSIGNED_PE_FILE = "unsigned-pe.json";
/**
 * The signers whose `.node` and `.dll` files ship with their own signature, which the release
 * mustn't replace: onnxruntime's, Electron's d3dcompiler_47.dll and the VC++ runtime's.
 */
export const MICROSOFT_SIGNERS: readonly string[] = [
  "Microsoft Corporation",
  "Microsoft Windows",
  "Microsoft Windows Software Compatibility Publisher",
];

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
 * darwin-arm64's second, identical dylib and Windows' DirectML, which CPU sessions never load, go.
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

/** What electron-builder never packs, whatever its filters: builder-util's walk skips these names. */
export const UNPACKED_NAMES: ReadonlySet<string> = new Set([".DS_Store", ".gitkeep"]);

/** Removes what electron-builder would leave out, at any depth, so the stage is what ships. */
export function dropUnpacked(payload: string): void {
  for (const entry of readdirSync(payload, { recursive: true, withFileTypes: true })) {
    if (UNPACKED_NAMES.has(entry.name)) {
      rmSync(join(entry.parentPath, entry.name), { recursive: true, force: true });
    }
  }
}

/** A Microsoft.VC14x.CRT folder of a Visual Studio install, with the redist version it's under. */
export interface VcRedist {
  readonly version: string;
  readonly dir: string;
}

/** The installs vswhere knows, which only Windows has. */
function visualStudioRoots(): string[] {
  const vswhere = join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (!existsSync(vswhere)) return [];
  const listed = spawnSync(vswhere, ["-all", "-products", "*", "-property", "installationPath"], {
    encoding: "utf8",
  });
  return listed.stdout.split(/\r?\n/).filter(Boolean);
}

/**
 * The newest x64 VC++ runtime among the Visual Studio installs at `roots`: every copy comes from
 * this one folder, since whichever copy loads first serves the whole process.
 */
export function newestVcRedist(roots: readonly string[] = visualStudioRoots()): VcRedist {
  const found: VcRedist[] = [];
  for (const root of roots) {
    const msvc = join(root, "VC", "Redist", "MSVC");
    if (!existsSync(msvc)) continue;
    for (const name of readdirSync(msvc)) {
      const version = /^\d+\.\d+\.\d+/.exec(name)?.[0];
      const x64 = join(msvc, name, "x64");
      if (version === undefined || !existsSync(x64)) continue;
      for (const crt of readdirSync(x64).filter((name) => /^Microsoft\.VC\d+\.CRT$/.test(name))) {
        const dir = join(x64, crt);
        if (VC_RUNTIME_DLLS.every((dll) => existsSync(join(dir, dll)))) {
          found.push({ version, dir });
        }
      }
    }
  }
  const newest = found.sort((a, b) => compareVersions(b.version, a.version))[0];
  if (newest === undefined) {
    throw new Error(
      `No Visual Studio redist with ${VC_RUNTIME_DLLS.join(", ")} under ` +
        `${roots.join(", ") || "any install vswhere lists"}`,
    );
  }
  return newest;
}

/** The VC++ runtime DLLs a PE file imports, by their lowercase names. */
function vcImports(file: string): string[] {
  const pe = readPe(file);
  if (pe === null) return [];
  return [...pe.imports, ...pe.delayImports]
    .map((name) => name.toLowerCase())
    .filter((name) => VC_RUNTIME_DLLS.includes(name));
}

/**
 * Beside each native addon in `payload`, the node shim's included, copies from `redist` the VC++
 * runtime DLLs its folder's natives import and the ones those import in turn: Node loads an addon
 * with LOAD_WITH_ALTERED_SEARCH_PATH, which looks in the addon's folder first.
 */
export function copyVcRuntime(payload: string, redist: string): void {
  const runtime = new Map(VC_RUNTIME_DLLS.map((dll) => [dll, vcImports(join(redist, dll))]));
  const folders = new Set(
    files(payload)
      .filter((file) => file.endsWith(".node"))
      .map((file) => dirname(file)),
  );
  for (const folder of folders) {
    const needed = new Set(
      readdirSync(folder)
        .filter(
          (name) => /\.(node|dll)$/i.test(name) && !VC_RUNTIME_DLLS.includes(name.toLowerCase()),
        )
        .flatMap((name) => vcImports(join(folder, name))),
    );
    for (const dll of needed) for (const more of runtime.get(dll) ?? []) needed.add(more);
    for (const dll of needed) copyFileSync(join(redist, dll), join(folder, dll));
  }
}

/** A `.node` or `.dll` file, by the basename signExts matches it by, and what its headers say. */
export type PeFile = readonly [name: string, pe: Pe];

/** Each `.node` and `.dll` file under `dir`. */
export function peFilesIn(dir: string): PeFile[] {
  return files(dir)
    .filter((file) => /\.(node|dll)$/i.test(file))
    .flatMap((file) => {
      const pe = readPe(file);
      return pe === null ? [] : [[basename(file), pe] as const];
    });
}

/**
 * The same of Electron's zip at `zip`, under the names electron-builder gives them in the app: it
 * renames electron_wer.dll after the executable, `<productName>_wer.dll`.
 */
export function peFilesInZip(zip: string, productName: string): PeFile[] {
  const archive = readZip(zip);
  return archive.entries
    .filter((entry) => /\.(node|dll)$/i.test(entry.name))
    .flatMap((entry) => {
      const pe = readPe(archive.read(entry));
      const name = basename(entry.name);
      if (pe === null) return [];
      return [[name === "electron_wer.dll" ? `${productName}_wer.dll` : name, pe] as const];
    });
}

/** The names of the files among `pes` whose certificate table is empty, once each. */
export function unsignedNames(pes: readonly PeFile[]): string[] {
  return [...new Set(pes.filter(([, pe]) => !pe.signed).map(([name]) => name))].sort();
}

interface ElectronGet {
  downloadArtifact(details: {
    version: string;
    platform: string;
    arch: string;
    artifactName: string;
    checksums: Record<string, string>;
  }): Promise<string>;
}

/**
 * The Electron zip electron-builder packs for win32-x64, from @electron/get's cache or downloaded
 * into it, checked against the electron package's checksums as its own install checks them.
 */
export async function electronZip(): Promise<string> {
  const electron = dirname(createRequire(import.meta.url).resolve("electron/package.json"));
  const { version } = JSON.parse(readFileSync(join(electron, "package.json"), "utf8")) as {
    version: string;
  };
  const builder = readFileSync(join(DESKTOP, "electron-builder.yml"), "utf8");
  const packed = /^electronVersion:\s*(\S+)\s*$/m.exec(builder)?.[1];
  if (packed !== version) {
    throw new Error(`electron-builder.yml packs Electron ${packed}, but electron is ${version}`);
  }
  const get = createRequire(join(electron, "package.json")).resolve("@electron/get");
  const { downloadArtifact } = (await import(pathToFileURL(get).href)) as ElectronGet;
  return downloadArtifact({
    version,
    platform: "win32",
    arch: "x64",
    artifactName: "electron",
    checksums: JSON.parse(readFileSync(join(electron, "checksums.json"), "utf8")),
  });
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

/** sharp's libvips: its own package's on macOS, inside sharp's on Windows. */
const LIBVIPS = /^libvips[-.].*\.(dll|dylib|so)(\.\d+)*$/;
const LGPL = "LGPL-3.0-or-later";
/** The license files in the payload's data/. */
const DATA_LICENSE = /^(LICENSE|THIRD_PARTY_LICENSES)(\.\w+)?$/;

/** Whether the package at `dir` ships libvips, its own node_modules aside. */
function shipsLibvips(dir: string): boolean {
  return files(dir).some((file) => {
    const path = relative(dir, file).split(sep);
    return !path.includes("node_modules") && LIBVIPS.test(path.at(-1) ?? "");
  });
}

/**
 * A node_modules package's license text, and for one that ships libvips, which is LGPL-3.0-or-later
 * and linked dynamically, where its source is and the libraries its build includes. A license file
 * that covers only part of what the package declares, as sharp's Windows build's covers the Apache
 * half of `Apache-2.0 AND LGPL-3.0-or-later`, is followed by the LGPL's text.
 */
function packageLicense(pkg: Bundled, dir: string): string {
  const own = licenseText(pkg);
  const parts = [own];
  const declared: readonly string[] = pkg.identifier?.match(/[\w.+-]+/g) ?? [];
  if (declared.includes(LGPL)) {
    const lgpl = spdxText(LGPL);
    if (lgpl === null) throw new Error(`apps/eidolon/spdx/ has no text for ${LGPL}`);
    if (!own.includes(lgpl.split("\n", 1)[0] as string)) {
      parts.push(
        `The package also declares ${LGPL}, whose text its license file lacks; this is ` +
          "SPDX's text of it.",
        lgpl,
      );
    }
  }
  if (!shipsLibvips(dir)) return parts.join("\n\n");
  const readme = join(dir, "README.md");
  return [
    "sharp links libvips dynamically. Its source is at https://github.com/libvips/libvips, and " +
      "the source of this build of it, with the libraries it includes, at " +
      "https://github.com/lovell/sharp-libvips.",
    ...parts,
    ...(existsSync(readme)
      ? [
          "The package's README.md, which lists those libraries and their licenses:",
          readFileSync(readme, "utf8").trim(),
        ]
      : []),
  ].join("\n\n");
}

/**
 * THIRD_PARTY_LICENSES.txt, the one file the Licenses item opens, so it holds every license the
 * payload carries: each package's in npm's node_modules, the node shim's and the dist/ of its pnpm,
 * on Windows the VC++ runtime's copied from `vcRuntime`, then the payload's own NOTICE,
 * THIRD_PARTY_NOTICES.md and its data's licenses.
 */
export function thirdPartyLicenses(payload: string, vcRuntime: VcRedist | null): string {
  const packages = new Map<string, { pkg: Bundled; dir: string }>();
  const pnpm = shimPnpm(payload);
  for (const modules of [
    join(payload, "node_modules"),
    dirname(pnpm),
    join(pnpm, "dist", "node_modules"),
  ]) {
    for (const [name, dir] of installedPackages(modules)) {
      for (const pkg of inlinedPackages(new Map([[name, dir]]))) {
        packages.set(`${pkg.name}@${pkg.version}`, { pkg, dir });
      }
    }
  }
  const sections = [...packages.values()]
    .sort(
      ({ pkg: a }, { pkg: b }) =>
        a.name.localeCompare(b.name) ||
        a.version.localeCompare(b.version, undefined, { numeric: true }),
    )
    .map(({ pkg, dir }) =>
      section(
        `${pkg.name} ${pkg.version} (${pkg.identifier ?? "no license field"})`,
        packageLicense(pkg, dir),
      ),
    );
  const runtime =
    vcRuntime === null
      ? []
      : [
          section(
            `Microsoft Visual C++ runtime ${vcRuntime.version}`,
            `${VC_RUNTIME_DLLS.join(", ")}, beside the native modules that load them, are ` +
              "Microsoft's, from Visual Studio's redistributable files, and redistributed under " +
              "the Visual Studio license terms.",
          ),
        ];
  const data = join(payload, "data");
  const dataLicenses = existsSync(data)
    ? files(data).filter((file) => DATA_LICENSE.test(basename(file)))
    : [];
  const notices = [
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
    ...dataLicenses.map((file) => relative(payload, file).split(sep).join("/")).sort(),
  ].map((path) => section(path, readFileSync(join(payload, path), "utf8").trim()));
  return [
    "Third-party licenses\n",
    "Eidolon's backend includes the third-party code and data below, each with its license: first",
    "the packages its node_modules folders hold, the pnpm its node shim runs and the packages pnpm",
    "bundles among them, then NOTICE, which covers the code Eidolon ports from other projects and",
    "the data and the font it ships, then THIRD_PARTY_NOTICES.md, for the packages its bundles in",
    "dist/ and its web app in web/ include, and last the license files of its data.\n",
    ...sections,
    ...runtime,
    ...notices,
  ].join("\n");
}

const WIN32_ON_ANOTHER_OS =
  "win32-x64 can only be staged on Windows: its natives get the VC++ runtime copied beside them " +
  "from this machine's Visual Studio redistributable, which only Windows has";

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
export async function stageBackend(
  target: Target,
  { platform = process.platform }: { platform?: NodeJS.Platform } = {},
): Promise<StageSummary> {
  if (target === "win32-x64" && platform !== "win32") throw new Error(WIN32_ON_ANOTHER_OS);
  const started = performance.now();
  const payload = payloadDir(target);
  const modules = join(payload, "node_modules");
  const { os, cpu } = TARGETS[target];
  try {
    rmSync(stageDir(target), { recursive: true, force: true });
    const manifest = await stage(payload);
    const lock = readPnpmLock(join(ROOT, "pnpm-lock.yaml"));
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
    const drift = lockDrift(npmLs(payload), lock, roots, { os, cpu });
    if (drift.length > 0) {
      throw new Error(`npm installed what pnpm-lock.yaml doesn't:\n${drift.join("\n")}`);
    }
    // npm's links to the packages' commands, which nothing runs, and its record of the install.
    const links = readdirSync(modules, { recursive: true, withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && entry.name === ".bin",
    );
    for (const entry of links) rmSync(join(entry.parentPath, entry.name), { recursive: true });
    rmSync(join(modules, ".package-lock.json"), { force: true });
    pruneOnnxruntime(modules, target);
    stageNodeShim(payload, { os, cpu });
    dropUnpacked(payload);
    let vcRuntime: VcRedist | null = null;
    if (target === "win32-x64") {
      vcRuntime = newestVcRedist();
      copyVcRuntime(payload, vcRuntime.dir);
      const unsigned = unsignedNames([
        ...peFilesIn(payload),
        ...peFilesInZip(await electronZip(), "LAPLACE Eidolon"),
      ]);
      writeFileSync(
        join(stageDir(target), UNSIGNED_PE_FILE),
        `${JSON.stringify(unsigned, null, 2)}\n`,
      );
    }
    writeFileSync(join(payload, LICENSES_FILE), thirdPartyLicenses(payload, vcRuntime));
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
      "node shim": bytesUnder(join(payload, NODE_SHIM)),
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
