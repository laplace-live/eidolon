// Builds the npm package @laplace.live/eidolon-sdk in packages/sdk/pack/ (`bun run build:sdk`),
// and with --pack, packs it beside that folder (`bun run pack:sdk`).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { BunPlugin } from "bun";

const ROOT = resolve(import.meta.dir, "../../..");
const HERE = resolve(import.meta.dir, "..");
const PACK_DIR = join(HERE, "pack");

const CORE_EXTERNAL = ["@pipecat-ai/client-js", "@pipecat-ai/small-webrtc-transport"] as const;
const CORE_NODE_EXTERNAL = ["@pipecat-ai/client-js", "node:module"] as const;
const REACT_EXTERNAL = ["react", "react/*"] as const;

// @pipecat-ai/small-webrtc-transport's ESM build imports "lodash/cloneDeep" without an extension,
// which fails Node's native ESM resolver; its CJS build resolves cleanly through createRequire.
const nodeTransportCjsPlugin: BunPlugin = {
  name: "transport-cjs",
  setup(build) {
    build.onResolve({ filter: /^@pipecat-ai\/small-webrtc-transport$/ }, () => ({
      path: "@pipecat-ai/small-webrtc-transport",
      namespace: "transport-cjs",
    }));
    build.onLoad({ filter: /.*/, namespace: "transport-cjs" }, () => ({
      loader: "js",
      contents: [
        'import { createRequire } from "node:module";',
        'const cjs = createRequire(import.meta.url)("@pipecat-ai/small-webrtc-transport");',
        "export const { DailyMediaManager, SmallWebRTCTransport, WavMediaManager } = cjs;",
      ].join("\n"),
    }));
  },
};

interface SdkExportEntry {
  readonly types: string;
  readonly browser: string;
  readonly node: string;
  readonly default: string;
}

export interface SdkManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license: string;
  readonly repository: {
    readonly type: "git";
    readonly url: string;
    readonly directory: string;
  };
  readonly type: "module";
  readonly sideEffects: false;
  readonly exports: {
    readonly ".": SdkExportEntry;
    readonly "./react": SdkExportEntry;
  };
  readonly dependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta: Readonly<Record<string, { readonly optional: boolean }>>;
  readonly publishConfig: { readonly access: "public" };
}

interface RawManifest {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly dependencies: Record<string, string>;
  readonly peerDependencies: Record<string, string>;
  readonly peerDependenciesMeta: Record<string, { optional: boolean }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return (specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
}

function owningPackage(path: string): string | null {
  const marker = "/node_modules/";
  const at = path.lastIndexOf(marker);
  if (at === -1) return null;
  return packageName(path.slice(at + marker.length));
}

function walkFiles(dir: string, suffix: string): string[] {
  return Array.from(new Bun.Glob(`**/*${suffix}`).scanSync({ cwd: dir, absolute: true }));
}

export function packageManifest(): SdkManifest {
  const own = readJson<RawManifest>(join(HERE, "package.json"));
  for (const [name, version] of Object.entries(own.dependencies)) {
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`${name} must be pinned to an exact version, not ${version}`);
    }
  }
  return {
    name: own.name,
    version: own.version,
    description:
      "TypeScript and React client SDK for LAPLACE Eidolon WebRTC voice calls and stateless chats",
    license: own.license,
    repository: {
      type: "git",
      url: "git+https://github.com/laplace-live/eidolon.git",
      directory: "packages/sdk",
    },
    type: "module",
    sideEffects: false,
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        browser: "./dist/index.js",
        node: "./dist/index.node.js",
        default: "./dist/index.js",
      },
      "./react": {
        types: "./dist/react/index.d.ts",
        browser: "./dist/react/index.js",
        node: "./dist/react/index.node.js",
        default: "./dist/react/index.js",
      },
    },
    dependencies: Object.fromEntries(
      Object.entries(own.dependencies).sort(([a], [b]) => a.localeCompare(b)),
    ),
    peerDependencies: own.peerDependencies,
    peerDependenciesMeta: own.peerDependenciesMeta,
    publishConfig: { access: "public" },
  };
}

interface BundleTarget {
  readonly entry: string;
  readonly output: string;
  readonly node: boolean;
  readonly react: boolean;
}

/** Bundles `.` and `./react` for browsers and Node ESM, rejecting any third-party package inlined by mistake. */
async function bundle(root: string): Promise<void> {
  const targets: readonly BundleTarget[] = [
    {
      entry: join(HERE, "src/index.ts"),
      output: join(root, "dist/index.js"),
      node: false,
      react: false,
    },
    {
      entry: join(HERE, "src/index.ts"),
      output: join(root, "dist/index.node.js"),
      node: true,
      react: false,
    },
    {
      entry: join(HERE, "src/react/index.ts"),
      output: join(root, "dist/react/index.js"),
      node: false,
      react: true,
    },
    {
      entry: join(HERE, "src/react/index.ts"),
      output: join(root, "dist/react/index.node.js"),
      node: true,
      react: true,
    },
  ];
  await Promise.all(
    targets.map(async ({ entry, output, node, react }) => {
      const baseExternal = node ? CORE_NODE_EXTERNAL : CORE_EXTERNAL;
      const result = await Bun.build({
        entrypoints: [entry],
        target: node ? "node" : "browser",
        format: "esm",
        outdir: dirname(output),
        naming: basename(output),
        external: react ? [...baseExternal, ...REACT_EXTERNAL] : [...baseExternal],
        plugins: node ? [nodeTransportCjsPlugin] : [],
        metafile: true,
      });
      if (!result.success) throw new AggregateError(result.logs, `bun build ${entry} failed`);
      const inlined = Object.keys(result.metafile?.inputs ?? {})
        .map((input) => owningPackage(resolve(input)))
        .filter((pkg): pkg is string => pkg !== null);
      if (inlined.length > 0) {
        throw new Error(
          `Unexpected node_modules packages inlined into ${relative(root, output)}: ${[...new Set(inlined)].join(", ")}`,
        );
      }
    }),
  );
}

const RELATIVE_TS_SPECIFIER = /((\bfrom\s+|\bimport\s*\(\s*)["']\.\.?\/[^"']+)\.tsx?(["'])/g;

/** Emits `.d.ts` declarations into `${root}/dist` and normalizes relative specifiers to `.js`. */
function emitTypes(root: string): void {
  const tsc = join(ROOT, "node_modules", ".bin", "tsc");
  const outDir = join(root, "dist");
  const res = Bun.spawnSync([tsc, "-p", join(HERE, "tsconfig.build.json"), "--outDir", outDir], {
    cwd: ROOT,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (res.exitCode !== 0) throw new Error(`tsc exited ${res.exitCode}`);
  for (const file of walkFiles(outDir, ".d.ts")) {
    const text = readFileSync(file, "utf8");
    const rewritten = text.replace(RELATIVE_TS_SPECIFIER, "$1.js$3");
    if (rewritten !== text) writeFileSync(file, rewritten);
  }
}

function moduleSpecifiers(file: string): Set<string> {
  const source = readFileSync(file, "utf8");
  const found = new Set<string>();
  if (file.endsWith(".js")) {
    for (const { path } of new Bun.Transpiler({ loader: "js" }).scanImports(source)) {
      found.add(path);
    }
  }
  for (const [, spec] of source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']\s*\)?/g)) {
    if (spec !== undefined) found.add(spec);
  }
  return found;
}

/** Verifies every emitted `.js` and `.d.ts` imports only rewritten relative `.js` paths or declared externals. */
export function checkDistImports(root: string, manifest: SdkManifest): void {
  const corePackages = new Set(Object.keys(manifest.dependencies));
  const peerPackages = new Set(Object.keys(manifest.peerDependencies));
  const dist = join(root, "dist");
  const files = [...walkFiles(dist, ".js"), ...walkFiles(dist, ".d.ts")];
  if (files.length === 0) throw new Error("dist/ contains no emitted files");

  const violations: string[] = [];
  for (const file of files) {
    const rel = relative(dist, file).replaceAll("\\", "/");
    const isNodeBundle = rel.endsWith(".node.js");
    const isReactEntry = rel.startsWith("react/");
    for (const spec of moduleSpecifiers(file)) {
      if (spec.startsWith("./") || spec.startsWith("../")) {
        if (/\.(ts|tsx)$/.test(spec)) {
          violations.push(`${rel}: unrewritten TypeScript extension ${spec}`);
        }
        continue;
      }
      if (isNodeBundle && spec === "node:module") continue;
      const pkg = packageName(spec);
      if (!corePackages.has(pkg) && !(isReactEntry && peerPackages.has(pkg))) {
        violations.push(`${rel}: undeclared import ${spec}`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`Invalid imports in ${relative(ROOT, dist)}:\n${violations.join("\n")}`);
  }
}

export async function stage(outDir: string = PACK_DIR): Promise<SdkManifest> {
  const manifest = packageManifest();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  await bundle(outDir);
  emitTypes(outDir);
  checkDistImports(outDir, manifest);
  cpSync(join(HERE, "README.md"), join(outDir, "README.md"));
  cpSync(join(ROOT, "LICENSE"), join(outDir, "LICENSE"));
  if (existsSync(join(HERE, "CHANGELOG.md"))) {
    cpSync(join(HERE, "CHANGELOG.md"), join(outDir, "CHANGELOG.md"));
  }
  writeFileSync(join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

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
  const manifest = await stage();
  console.log(`${manifest.name}@${manifest.version} staged in ${relative(ROOT, PACK_DIR)}`);
  if (Bun.argv.includes("--pack")) console.log(pack());
}
