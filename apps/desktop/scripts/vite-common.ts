// The Vite builds of the app's own code, for build.ts and dev.ts: main as one ES module, the preload as
// CommonJS (a sandboxed preload can't be an ES module), and the shell pages.
import { join, resolve } from "node:path";
import type { InlineConfig, Rolldown } from "vite";

const DESKTOP = resolve(import.meta.dirname, "..");

interface NodeBundle {
  readonly entry: string;
  readonly outDir: string;
  readonly fileName: string;
  readonly format: Rolldown.ModuleFormat;
  /** Whether the licenses of the packages it inlines go beside it, as THIRD_PARTY_LICENSES.md. */
  readonly licenses: boolean;
}

/** One file with every dependency inlined, undici included, but `electron` and Node's builtins. */
function nodeBundle(
  { entry, outDir, fileName, format, licenses }: NodeBundle,
  dev: boolean,
): InlineConfig {
  return {
    configFile: false,
    envDir: false,
    publicDir: false,
    root: DESKTOP,
    logLevel: "warn",
    ssr: { noExternal: true },
    build: {
      ssr: join(DESKTOP, entry),
      outDir: join(DESKTOP, outDir),
      emptyOutDir: true,
      // Electron 45 runs Node 24.
      target: "node24",
      minify: false,
      // Dev builds only: electron-builder leaves maps out of the asar.
      sourcemap: dev,
      reportCompressedSize: false,
      license: licenses && !dev ? { fileName: "THIRD_PARTY_LICENSES.md" } : false,
      rolldownOptions: {
        external: ["electron"],
        output: { format, entryFileNames: fileName, codeSplitting: false },
      },
    },
  };
}

export function mainBundle({ dev = false } = {}): InlineConfig {
  return nodeBundle(
    {
      entry: "src/main/index.ts",
      outDir: "dist/main",
      fileName: "index.js",
      format: "es",
      licenses: true,
    },
    dev,
  );
}

export function preloadBundle({ dev = false } = {}): InlineConfig {
  return nodeBundle(
    {
      entry: "src/preload/index.ts",
      outDir: "dist/preload",
      fileName: "index.cjs",
      format: "cjs",
      licenses: false,
    },
    dev,
  );
}

/** The pages main serves at eidolon-app://shell/, each linking its assets relatively. */
export function shellPages(): InlineConfig {
  const root = join(DESKTOP, "src", "shell");
  return {
    configFile: false,
    envDir: false,
    publicDir: false,
    root,
    base: "./",
    logLevel: "warn",
    build: {
      outDir: join(DESKTOP, "dist", "shell"),
      emptyOutDir: true,
      reportCompressedSize: false,
      rolldownOptions: { input: { loading: join(root, "loading.html") } },
    },
  };
}
