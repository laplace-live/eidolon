// Builds the npm package @laplace.live/eidolon in apps/eidolon/pack/ (`bun run build:npm`), and
// with --pack, packs it beside that folder (`bun run pack:npm`).
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  cliEntry,
  jiebaDir,
  resamplerDir,
  serverEntry,
  templatesDir,
  voiceModelsDir,
  webDist,
} from "@eidolon/config";
import { ENTRIES, PLATFORMS } from "../src/launcher.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const HERE = resolve(import.meta.dir, "..");
const PACK_DIR = join(HERE, "pack");
/** SPDX's license texts (github.com/spdx/license-list-data, text/), named by identifier. */
const SPDX_DIR = join(HERE, "spdx");

/**
 * What the bundles leave in node_modules, each a dependency of the package: files read beside the
 * code (onnxruntime-node's binaries, LanceDB's per-platform binary, which its inlined loader
 * requires by name), and packages whose prototypes or classes are shared: @eidolon/webrtc patches
 * werift's, and LanceDB checks apache-arrow's tables, which must be one copy for both.
 * libopus-wasm stays a package: inlined, the notices would carry its MIT license but not
 * libopus's, which its THIRD_PARTY_NOTICES.md holds.
 */
const EXTERNAL = [
  "onnxruntime-node",
  "werift",
  "libopus-wasm",
  "apache-arrow",
  "@lancedb/lancedb-*",
];

/** LanceDB requires it inside its OpenAI embedding function only, which nothing calls. */
const NEVER_LOADED = ["openai"];

const BUNFIG = `# The launcher passes this file to every Bun it starts (BUN_OPTIONS), in place of a bunfig.toml
# in the working directory, which is the user's.
env = false
`;

export interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly [field: string]: unknown;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Where `resolver` looks in the package at `root`, which the launcher names in EIDOLON_APP_ROOT. */
export function inPackage(root: string, resolver: () => string): string {
  process.env.EIDOLON_APP_ROOT = root;
  try {
    return resolver();
  } finally {
    delete process.env.EIDOLON_APP_ROOT;
  }
}

function matches(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

/** `@scope/name` or `name`, from a specifier that may go deeper. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return (specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
}

/** The package a file in node_modules belongs to, and its folder. */
function owningPackage(path: string): { name: string; dir: string } | null {
  const marker = "/node_modules/";
  const at = path.lastIndexOf(marker);
  if (at === -1) return null;
  const name = packageName(path.slice(at + marker.length));
  return { name, dir: path.slice(0, at + marker.length + name.length) };
}

/** Every exact version the workspaces pin in `dependencies`, which must agree. */
function workspacePins(): Map<string, string> {
  const pins = new Map<string, string>();
  for (const group of ["apps", "packages"]) {
    for (const name of readdirSync(join(ROOT, group))) {
      let manifest: { dependencies?: Record<string, string> };
      try {
        manifest = readJson(join(ROOT, group, name, "package.json"));
      } catch {
        continue;
      }
      for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
        if (version.startsWith("workspace:")) continue;
        const pinned = pins.get(dependency);
        if (pinned !== undefined && pinned !== version) {
          throw new Error(`${dependency} is pinned to both ${pinned} and ${version}`);
        }
        pins.set(dependency, version);
      }
    }
  }
  return pins;
}

/** The published package.json: the externals at the workspaces' pins, and the per-platform builds. */
export function packageManifest(bunVersion: string): Manifest {
  const own = readJson<{ name: string; version: string; license: string }>(
    join(HERE, "package.json"),
  );
  const pins = workspacePins();
  const dependencies = Object.fromEntries(
    [...pins]
      .filter(([name]) => EXTERNAL.some((pattern) => matches(pattern, name)))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const lancedb = pins.get("@lancedb/lancedb");
  if (lancedb === undefined) throw new Error("No workspace depends on @lancedb/lancedb");
  for (const [name, version] of Object.entries({ ...dependencies, "@lancedb/lancedb": lancedb })) {
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`${name} must be pinned to an exact version, not ${version}`);
    }
  }
  const optionalDependencies = Object.fromEntries(
    Object.values(PLATFORMS)
      .flatMap(({ bun, lancedb: binary }) => [
        [bun, bunVersion],
        [binary, lancedb],
      ])
      .sort(([a], [b]) => (a as string).localeCompare(b as string)),
  );
  const platforms = Object.keys(PLATFORMS).map((key) => key.split("-") as [string, string]);
  return {
    name: own.name,
    version: own.version,
    description: "Build a voice persona and call her from your browser, on your own computer",
    license: own.license,
    repository: {
      type: "git",
      url: "git+https://github.com/laplace-live/eidolon.git",
      directory: "apps/eidolon",
    },
    type: "module",
    bin: { eidolon: "bin/eidolon.mjs" },
    os: [...new Set(platforms.map(([os]) => os))],
    cpu: [...new Set(platforms.map(([, cpu]) => cpu))],
    engines: { node: ">=20" },
    dependencies,
    optionalDependencies,
    publishConfig: { access: "public", provenance: true },
  };
}

/**
 * Bundles the supervisor, the server and the CLI for Bun into the package at `root`, and the
 * launcher for Node. Returns the node_modules packages the Bun bundles inline, by name.
 */
export async function bundle(root: string): Promise<Map<string, string>> {
  const builds: [string, string][] = [
    [join(ROOT, "apps/bot/src/local/main.ts"), join(root, ENTRIES.app)],
    [serverEntry(), inPackage(root, serverEntry)],
    [cliEntry(), inPackage(root, cliEntry)],
  ];
  const inlined = new Map<string, string>();
  // One build per entry: entries built together are named after their folders, and the chunks
  // they share land elsewhere, each with its own import.meta.dir.
  for (const [entry, output] of builds) {
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      outdir: dirname(output),
      naming: `${basename(output, ".js")}.[ext]`,
      external: [...EXTERNAL, ...NEVER_LOADED],
      metafile: true,
    });
    if (!result.success) throw new AggregateError(result.logs, `bun build ${entry} failed`);
    for (const input of Object.keys(result.metafile?.inputs ?? {})) {
      const owner = owningPackage(resolve(input));
      if (owner !== null) inlined.set(owner.name, owner.dir);
    }
  }
  const launcher = await Bun.build({
    entrypoints: [join(HERE, "src/bin.ts")],
    target: "node",
    outdir: join(root, "bin"),
    naming: "eidolon.mjs",
    banner: "#!/usr/bin/env node",
  });
  if (!launcher.success) throw new AggregateError(launcher.logs, "bun build src/bin.ts failed");
  chmodSync(join(root, "bin", "eidolon.mjs"), 0o755);
  return inlined;
}

/** The bare specifiers `file` imports or requires. */
export function bareImports(file: string): Set<string> {
  const source = readFileSync(file, "utf8");
  const specifiers = new Bun.Transpiler({ loader: "js" })
    .scanImports(source)
    .map(({ path }) => path);
  // A CommonJS module inlined into the bundle keeps its requires as __require calls.
  for (const [, specifier] of source.matchAll(/\b__require\("([^"]+)"\)/g)) {
    specifiers.push(specifier as string);
  }
  return new Set(specifiers.filter((s) => !s.startsWith(".") && !s.startsWith("/")));
}

/**
 * Throws when a bundle in `root/dist` imports something the package doesn't install. LanceDB's
 * loader names a binary for every platform it supports, and requires only the running one's.
 */
export function checkImports(root: string, manifest: Manifest): void {
  const installed = new Set([
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.optionalDependencies),
  ]);
  const stray: string[] = [];
  const dist = join(root, "dist");
  for (const file of readdirSync(dist).filter((name) => name.endsWith(".js"))) {
    for (const specifier of bareImports(join(dist, file))) {
      const name = packageName(specifier);
      if (isBuiltin(specifier) || installed.has(name) || NEVER_LOADED.includes(name)) continue;
      if (name.startsWith("@lancedb/lancedb-")) continue;
      stray.push(`${file}: ${specifier}`);
    }
  }
  if (stray.length > 0) {
    throw new Error(`The bundles import what the package doesn't install:\n${stray.join("\n")}`);
  }
}

/** A package a bundle includes, as Vite's license.json lists one. */
export interface Bundled {
  readonly name: string;
  readonly version: string;
  /** Its package.json's `license`. */
  readonly identifier?: string;
  /** Its license file's. */
  readonly text?: string;
}

/** The web app, built into `out`; returns the packages it bundles. */
async function buildWeb(out: string): Promise<Bundled[]> {
  const web = join(ROOT, "apps/web");
  const vite = (await import(Bun.resolveSync("vite", web))) as {
    build(config: Record<string, unknown>): Promise<unknown>;
  };
  await vite.build({
    root: web,
    configFile: join(web, "vite.config.ts"),
    logLevel: "warn",
    build: { outDir: out, emptyOutDir: true, license: { fileName: ".vite/license.json" } },
  });
  const licenses = readJson<Bundled[]>(join(out, ".vite", "license.json"));
  rmSync(join(out, ".vite"), { recursive: true });
  return licenses;
}

const LICENSE_FILE = /^(licen[cs]e|copying)([.-].*)?$/i;

/** The packages the Bun bundles inline, with what their folders hold, as Vite reads the web app's. */
export function inlinedPackages(inlined: ReadonlyMap<string, string>): Bundled[] {
  return [...inlined].map(([name, dir]) => {
    const { version, license } = readJson<{ version: string; license?: string }>(
      join(dir, "package.json"),
    );
    const file = readdirSync(dir).find((entry) => LICENSE_FILE.test(entry));
    return {
      name,
      version,
      identifier: license,
      text: file === undefined ? undefined : readFileSync(join(dir, file), "utf8").trim(),
    };
  });
}

/**
 * A package's license text: its own file's, else SPDX's text of the license it declares. One with
 * neither fails the build, so no notice ships without its text.
 */
export function licenseText(pkg: Bundled): string {
  if (pkg.text) return pkg.text;
  const known = readdirSync(SPDX_DIR).map((file) => basename(file, ".txt"));
  if (pkg.identifier === undefined || !known.includes(pkg.identifier)) {
    throw new Error(
      `${pkg.name} ships no license file, and ${relative(ROOT, SPDX_DIR)}/ has no text for ` +
        `${pkg.identifier === undefined ? "its license, which it doesn't name" : pkg.identifier}`,
    );
  }
  const spdx = readFileSync(join(SPDX_DIR, `${pkg.identifier}.txt`), "utf8").trim();
  return (
    `The package ships no license file; this is SPDX's text of ${pkg.identifier}, the license ` +
    `its package.json declares.\n\n${spdx}`
  );
}

function sections(packages: readonly Bundled[]): string[] {
  return [...packages]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (pkg) =>
        `### ${pkg.name} ${pkg.version} (${pkg.identifier ?? "no license field"})\n\n` +
        `${licenseText(pkg)}\n`,
    );
}

/** THIRD_PARTY_NOTICES.md: each package the bundles and the web app include, with its license. */
export function notices(dist: readonly Bundled[], web: readonly Bundled[]): string {
  return [
    "# Third-party notices\n",
    "The bundles in dist/ and the web app in web/ include the packages below, each with its",
    "license. NOTICE covers the code ported from pipedog, and the data and the font the package",
    "ships.\n",
    "## dist/\n",
    ...sections(dist),
    "## web/\n",
    ...sections(web),
  ].join("\n");
}

/** Copies the repository's files under `from`, so an untracked index or picture never ships. */
export function copyTracked(from: string, to: string): void {
  const dir = relative(ROOT, from);
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", dir], { cwd: ROOT });
  if (listed.exitCode !== 0) throw new Error(`git ls-files ${dir} failed`);
  for (const file of listed.stdout.toString().split("\0").filter(Boolean)) {
    const target = join(to, relative(dir, file));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(ROOT, file), target);
  }
}

/** The Bun the production image runs: the package ships it, and builds with no other. */
function productionBun(): string {
  const dockerfile = readFileSync(join(ROOT, "apps/bot/Dockerfile"), "utf8");
  const version = /^FROM oven\/bun:(\d+\.\d+\.\d+)\b/m.exec(dockerfile)?.[1];
  if (version === undefined) throw new Error("apps/bot/Dockerfile names no oven/bun version");
  if (Bun.version !== version) {
    throw new Error(`Build the package with Bun ${version}, the image's, not ${Bun.version}`);
  }
  return version;
}

/** Writes the package into PACK_DIR, replacing what was there. */
async function stage(): Promise<Manifest> {
  const manifest = packageManifest(productionBun());
  rmSync(PACK_DIR, { recursive: true, force: true });
  mkdirSync(PACK_DIR);
  const inlined = await bundle(PACK_DIR);
  checkImports(PACK_DIR, manifest);
  const web = await buildWeb(inPackage(PACK_DIR, webDist));
  copyTracked(templatesDir(), inPackage(PACK_DIR, templatesDir));
  copyTracked(jiebaDir(), inPackage(PACK_DIR, jiebaDir));
  copyTracked(resamplerDir(), inPackage(PACK_DIR, resamplerDir));
  copyTracked(voiceModelsDir(), inPackage(PACK_DIR, voiceModelsDir));
  writeFileSync(join(PACK_DIR, "bunfig.toml"), BUNFIG);
  writeFileSync(join(PACK_DIR, "THIRD_PARTY_NOTICES.md"), notices(inlinedPackages(inlined), web));
  cpSync(join(HERE, "README.md"), join(PACK_DIR, "README.md"));
  for (const file of ["LICENSE", "NOTICE"]) cpSync(join(ROOT, file), join(PACK_DIR, file));
  writeFileSync(join(PACK_DIR, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** `npm pack` of PACK_DIR into apps/eidolon/; returns the tarball's path. */
function pack(): string {
  const packed = Bun.spawnSync(["npm", "pack", "--json", "--pack-destination", HERE], {
    cwd: PACK_DIR,
    stderr: "inherit",
  });
  if (packed.exitCode !== 0) throw new Error(`npm pack exited ${packed.exitCode}`);
  const [result] = JSON.parse(packed.stdout.toString()) as { filename: string }[];
  if (result === undefined) throw new Error("npm pack reported no tarball");
  return join(HERE, result.filename);
}

if (import.meta.main) {
  // The sources are this checkout's, whatever the shell exports.
  delete process.env.EIDOLON_APP_ROOT;
  const manifest = await stage();
  console.log(`${manifest.name}@${manifest.version} staged in ${relative(ROOT, PACK_DIR)}`);
  if (Bun.argv.includes("--pack")) console.log(pack());
}
