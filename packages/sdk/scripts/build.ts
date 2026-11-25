// Builds the npm package @laplace.live/eidolon-sdk in packages/sdk/pack/ (`pnpm build:sdk`),
// and with --pack, packs it beside that folder (`pnpm pack:sdk`).
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { type Plugin, rolldown } from "rolldown";
import { parseAst } from "rolldown/parseAst";

const ROOT = resolve(import.meta.dirname, "../../..");
const HERE = resolve(import.meta.dirname, "..");
const PACK_DIR = join(HERE, "pack");

const CORE_EXTERNAL = ["@pipecat-ai/client-js", "@pipecat-ai/small-webrtc-transport"] as const;
const CORE_NODE_EXTERNAL = ["@pipecat-ai/client-js", "node:module"] as const;
const REACT_EXTERNAL = ["react", "react/*"] as const;

// @pipecat-ai/small-webrtc-transport's ESM build imports "lodash/cloneDeep" without an extension,
// which fails Node's native ESM resolver; its CJS build resolves cleanly through createRequire:
// https://github.com/pipecat-ai/pipecat-client-web-transports/blob/main/transports/small-webrtc-transport/src/smallWebRTCTransport.ts
const TRANSPORT_CJS = "\0transport-cjs";
const nodeTransportCjsPlugin: Plugin = {
  name: "transport-cjs",
  resolveId(source) {
    return source === "@pipecat-ai/small-webrtc-transport" ? TRANSPORT_CJS : null;
  },
  load(id) {
    if (id !== TRANSPORT_CJS) return null;
    return [
      'import { createRequire } from "node:module";',
      'const cjs = createRequire(import.meta.url)("@pipecat-ai/small-webrtc-transport");',
      "export const { DailyMediaManager, SmallWebRTCTransport, WavMediaManager } = cjs;",
    ].join("\n");
  },
};

interface SdkExportEntry {
  readonly types: string;
  readonly browser: string;
  readonly node: string;
  readonly default: string;
}

/** An entry with one bundle for every runtime. */
interface SdkBrowserEntry {
  readonly types: string;
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
  readonly types: string;
  readonly typesVersions: {
    readonly "*": { readonly react: readonly string[]; readonly avatar: readonly string[] };
  };
  readonly exports: {
    readonly ".": SdkExportEntry;
    readonly "./react": SdkExportEntry;
    readonly "./avatar": SdkBrowserEntry;
  };
  readonly dependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta: Readonly<Record<string, { readonly optional: boolean }>>;
  readonly publishConfig: { readonly access: "public"; readonly provenance: true };
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
  return globSync(`**/*${suffix}`, { cwd: dir }).map((file) => join(dir, file));
}

/** Whether `id` is among `externals`: a package's name, or a `name/*` that takes its subpaths. */
function isExternal(id: string, externals: readonly string[]): boolean {
  return externals.some((name) =>
    name.endsWith("/*") ? id.startsWith(name.slice(0, -1)) : id === name,
  );
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
      "TypeScript and React client SDK for LAPLACE Eidolon WebRTC voice calls, stateless chats and PSD2Live avatars",
    license: own.license,
    repository: {
      type: "git",
      url: "git+https://github.com/laplace-live/eidolon.git",
      directory: "packages/sdk",
    },
    type: "module",
    sideEffects: false,
    // TypeScript's `moduleResolution: "node"` (the default under `module: "commonjs"`) ignores exports.
    types: "./dist/index.d.ts",
    typesVersions: {
      "*": { react: ["./dist/react/index.d.ts"], avatar: ["./dist/avatar/index.d.ts"] },
    },
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
      // It imports no pipecat, so the browser bundle runs on Node as it is.
      "./avatar": {
        types: "./dist/avatar/index.d.ts",
        default: "./dist/avatar/index.js",
      },
    },
    dependencies: Object.fromEntries(
      Object.entries(own.dependencies).sort(([a], [b]) => a.localeCompare(b)),
    ),
    peerDependencies: own.peerDependencies,
    peerDependenciesMeta: own.peerDependenciesMeta,
    publishConfig: { access: "public", provenance: true },
  };
}

interface BundleTarget {
  readonly entry: string;
  readonly output: string;
  readonly node: boolean;
  readonly react: boolean;
}

/**
 * Bundles `.` and `./react` for browsers and Node ESM, and `./avatar` once for both, rejecting any
 * third-party package inlined by mistake.
 */
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
    {
      entry: join(HERE, "src/avatar/index.ts"),
      output: join(root, "dist/avatar/index.js"),
      node: false,
      react: false,
    },
  ];
  await Promise.all(
    targets.map(async ({ entry, output, node, react }) => {
      const baseExternal = node ? CORE_NODE_EXTERNAL : CORE_EXTERNAL;
      const externals = react ? [...baseExternal, ...REACT_EXTERNAL] : [...baseExternal];
      const build = await rolldown({
        input: entry,
        platform: node ? "node" : "browser",
        external: (id) => isExternal(id, externals),
        plugins: node ? [nodeTransportCjsPlugin] : [],
        // jsxDEV, from react/jsx-dev-runtime, is undefined in React's production build of that
        // module, so consumers' production renders would throw.
        transform: { jsx: { runtime: "automatic", development: false } },
      });
      let moduleIds: readonly string[];
      try {
        const { output: chunks } = await build.write({
          file: output,
          format: "es",
          codeSplitting: false,
          // The React entry calls createContext at import, which React Server Components lack.
          ...(react ? { banner: '"use client";' } : {}),
        });
        moduleIds = chunks.flatMap((chunk) => (chunk.type === "chunk" ? chunk.moduleIds : []));
      } finally {
        await build.close();
      }
      const inlined = moduleIds
        .map((id) => owningPackage(id))
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
const DTS_SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']\s*\)?/g;

/** Emits `.d.ts` declarations into `${root}/dist` and normalizes relative specifiers to `.js`. */
function emitTypes(root: string): void {
  const tsc = join(ROOT, "node_modules", ".bin", "tsc");
  const outDir = join(root, "dist");
  const proc = spawnSync(tsc, ["-p", join(HERE, "tsconfig.build.json"), "--outDir", outDir], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (proc.status !== 0) throw new Error(`tsc exited ${proc.status}`);
  for (const file of walkFiles(outDir, ".d.ts")) {
    const text = readFileSync(file, "utf8");
    const rewritten = text.replace(RELATIVE_TS_SPECIFIER, "$1.js$3");
    if (rewritten !== text) writeFileSync(file, rewritten);
  }
}

/** Every specifier a module imports or re-exports, statically or through import(). */
function jsSpecifiers(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) jsSpecifiers(item, found);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const { type, source } = node as { type?: unknown; source?: { value?: unknown } | null };
  const importing =
    type === "ImportDeclaration" ||
    type === "ImportExpression" ||
    type === "ExportNamedDeclaration" ||
    type === "ExportAllDeclaration";
  if (importing && typeof source?.value === "string") found.add(source.value);
  for (const value of Object.values(node)) jsSpecifiers(value, found);
}

function moduleSpecifiers(file: string): Set<string> {
  const source = readFileSync(file, "utf8");
  const found = new Set<string>();
  if (file.endsWith(".js")) {
    jsSpecifiers(parseAst(source), found);
  } else {
    for (const [, spec] of source.matchAll(DTS_SPECIFIER)) {
      if (spec !== undefined) found.add(spec);
    }
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
      if (spec === "react/jsx-dev-runtime") {
        violations.push(`${rel}: development JSX runtime ${spec}`);
        continue;
      }
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

// rolldown keeps `new URL("./…", import.meta.url)` as written and copies nothing it names: the
// stage copies each file there, beside the bundle that names it.
const ASSET_URL = /new\s+URL\(\s*(["'`])(\.{1,2}\/[^"'`]+)\1\s*,\s*import\.meta\.url\s*\)/g;

/** Verifies every file a bundle in `${root}/dist` names by `new URL("./…", import.meta.url)` is there. */
export function checkAssetUrls(root: string): void {
  const dist = join(root, "dist");
  const missing: string[] = [];
  for (const file of walkFiles(dist, ".js")) {
    for (const [, , path] of readFileSync(file, "utf8").matchAll(ASSET_URL)) {
      if (path !== undefined && !existsSync(resolve(dirname(file), path))) {
        missing.push(`${relative(dist, file).replaceAll("\\", "/")}: ${path}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing assets in ${relative(ROOT, dist)}:\n${missing.join("\n")}`);
  }
}

export async function stage(outDir: string = PACK_DIR): Promise<SdkManifest> {
  const manifest = packageManifest();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  emitTypes(outDir);
  await bundle(outDir);
  cpSync(join(HERE, "src/avatar/psd2live/wasm"), join(outDir, "dist/avatar/wasm"), {
    recursive: true,
    filter: (source) => !basename(source).startsWith("."),
  });
  checkDistImports(outDir, manifest);
  checkAssetUrls(outDir);
  cpSync(join(HERE, "README.md"), join(outDir, "README.md"));
  cpSync(join(ROOT, "LICENSE"), join(outDir, "LICENSE"));
  // The avatar bundle carries PSD2Live's MIT code without its header, which the bundler drops.
  cpSync(join(HERE, "LICENSE-psd2live"), join(outDir, "LICENSE-psd2live"));
  cpSync(join(HERE, "THIRD_PARTY.md"), join(outDir, "THIRD_PARTY.md"));
  if (existsSync(join(HERE, "CHANGELOG.md"))) {
    cpSync(join(HERE, "CHANGELOG.md"), join(outDir, "CHANGELOG.md"));
  }
  // pnpm publish packs the folder by the checkout's .gitignore, whose dist/ would leave the bundles
  // out, unless the folder has an .npmignore of its own.
  writeFileSync(join(outDir, ".npmignore"), "");
  writeFileSync(join(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function pack(): string {
  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", HERE], {
    cwd: PACK_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (packed.status !== 0) throw new Error(`npm pack exited ${packed.status}`);
  const [result] = JSON.parse(packed.stdout) as { filename: string }[];
  if (result === undefined) throw new Error("npm pack reported no tarball");
  return join(HERE, result.filename);
}

if (import.meta.main) {
  const manifest = await stage();
  console.log(`${manifest.name}@${manifest.version} staged in ${relative(ROOT, PACK_DIR)}`);
  if (process.argv.includes("--pack")) console.log(pack());
}
