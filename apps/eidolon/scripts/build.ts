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
import { cliEntry, jiebaDir, serverEntry, templatesDir, webDist } from "@eidolon/config";
import { ENTRIES, PLATFORMS } from "../src/launcher.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const HERE = resolve(import.meta.dir, "..");
export const PACK_DIR = join(HERE, "pack");

/**
 * What the bundles leave in node_modules, each a dependency of the package: files read beside the
 * code (@pipedog's models, onnxruntime-node's binaries, LanceDB's per-platform binary, which its
 * inlined loader requires by name), and packages whose prototypes or classes an external one
 * shares: the runtime patches werift's prototype for @pipedog's copy, and LanceDB checks
 * apache-arrow's tables, which must be one copy for both.
 */
export const EXTERNAL = [
  "@pipedog/*",
  "onnxruntime-node",
  "werift",
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
    files: [
      "bin",
      "dist",
      "web",
      "personas",
      "data",
      "bunfig.toml",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
    ],
    os: [...new Set(platforms.map(([os]) => os))],
    cpu: [...new Set(platforms.map(([, cpu]) => cpu))],
    engines: { node: ">=20" },
    dependencies,
    optionalDependencies,
    publishConfig: { access: "public" },
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

/** The web app, built into `out` with the licenses of what it bundles, which it returns. */
async function buildWeb(out: string): Promise<string> {
  const web = join(ROOT, "apps/web");
  const vite = (await import(Bun.resolveSync("vite", web))) as {
    build(config: Record<string, unknown>): Promise<unknown>;
  };
  await vite.build({
    root: web,
    configFile: join(web, "vite.config.ts"),
    logLevel: "warn",
    build: { outDir: out, emptyOutDir: true, license: true },
  });
  const licenses = readFileSync(join(out, ".vite", "license.md"), "utf8");
  rmSync(join(out, ".vite"), { recursive: true });
  return licenses;
}

const LICENSE_FILE = /^(licen[cs]e|copying)([.-].*)?$/i;

/** THIRD_PARTY_NOTICES.md: each package the bundles inline, with its license text, then the web app's. */
export function notices(inlined: ReadonlyMap<string, string>, webLicenses: string): string {
  const sections = [...inlined]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, dir]) => {
      const { version, license } = readJson<{ version: string; license?: string }>(
        join(dir, "package.json"),
      );
      const file = readdirSync(dir).find((entry) => LICENSE_FILE.test(entry));
      const text = file
        ? readFileSync(join(dir, file), "utf8").trim()
        : "The package ships no license file.";
      return `## ${name} ${version} (${license ?? "no license field"})\n\n${text}\n`;
    });
  return [
    "# Third-party notices\n",
    "The bundles in dist/ include the packages below, each with its license, and the web app's",
    "notices for what web/ includes follow them. NOTICE covers the data and the font it ships.\n",
    ...sections,
    webLicenses.trim(),
    "",
  ].join("\n");
}

/** Copies the repository's files under `from`, so an untracked index or picture never ships. */
function copyTracked(from: string, to: string): void {
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
export async function stage(): Promise<Manifest> {
  const manifest = packageManifest(productionBun());
  rmSync(PACK_DIR, { recursive: true, force: true });
  mkdirSync(PACK_DIR);
  const inlined = await bundle(PACK_DIR);
  checkImports(PACK_DIR, manifest);
  const webLicenses = await buildWeb(inPackage(PACK_DIR, webDist));
  copyTracked(templatesDir(), inPackage(PACK_DIR, templatesDir));
  copyTracked(jiebaDir(), inPackage(PACK_DIR, jiebaDir));
  writeFileSync(join(PACK_DIR, "bunfig.toml"), BUNFIG);
  writeFileSync(join(PACK_DIR, "THIRD_PARTY_NOTICES.md"), notices(inlined, webLicenses));
  cpSync(join(HERE, "README.md"), join(PACK_DIR, "README.md"));
  for (const file of ["LICENSE", "NOTICE"]) cpSync(join(ROOT, file), join(PACK_DIR, file));
  writeFileSync(join(PACK_DIR, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** `npm pack` of PACK_DIR into apps/eidolon/; returns the tarball's path. */
export function pack(): string {
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
