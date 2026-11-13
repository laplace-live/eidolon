import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkDistImports, type SdkManifest, stage } from "../scripts/build.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const SDK_NODE_MODULES = resolve(import.meta.dir, "../node_modules");

let stagedDir: string;
let manifest: SdkManifest;

beforeAll(async () => {
  stagedDir = mkdtempSync(join(tmpdir(), "eidolon-sdk-pack-"));
  manifest = await stage(stagedDir);
});

afterAll(() => {
  rmSync(stagedDir, { recursive: true, force: true });
});

describe("@laplace.live/eidolon-sdk package build", () => {
  test("stages clean ESM bundles, normalized declarations, license, and manifest", () => {
    for (const rel of [
      "package.json",
      "README.md",
      "LICENSE",
      "dist/index.js",
      "dist/index.node.js",
      "dist/index.d.ts",
      "dist/react/index.js",
      "dist/react/index.node.js",
      "dist/react/index.d.ts",
    ]) {
      expect([rel, existsSync(join(stagedDir, rel))]).toEqual([rel, true]);
    }

    const workspacePkg = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../package.json"), "utf8"),
    ) as { version: string };
    expect(workspacePkg.version).toMatch(/^\d+\.\d+\.\d+/);

    expect(manifest).toMatchObject({
      name: "@laplace.live/eidolon-sdk",
      version: workspacePkg.version,
      license: "AGPL-3.0-only",
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
      peerDependencies: { react: ">=18" },
      peerDependenciesMeta: { react: { optional: true } },
    });
    for (const forbidden of ["private", "scripts", "devDependencies", "workspaces"]) {
      expect([forbidden, forbidden in manifest]).toEqual([forbidden, false]);
    }
    expect(readFileSync(join(stagedDir, "LICENSE"), "utf8")).toContain("AFFERO GENERAL PUBLIC");
  });

  test("checkDistImports rejects unrewritten .ts extensions and undeclared packages", () => {
    const broken = mkdtempSync(join(tmpdir(), "eidolon-sdk-broken-"));
    try {
      mkdirSync(join(broken, "dist"), { recursive: true });
      writeFileSync(
        join(broken, "dist", "bad.d.ts"),
        'export { x } from "./other.ts";\nimport "left-pad";\n',
      );
      expect(() => checkDistImports(broken, manifest)).toThrow(
        /unrewritten TypeScript[\s\S]*undeclared import left-pad/,
      );
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  test("emitted declarations typecheck cleanly from an external consumer project via exports", () => {
    const consumer = mkdtempSync(join(tmpdir(), "eidolon-sdk-consumer-"));
    try {
      const nm = join(consumer, "node_modules");
      mkdirSync(join(nm, "@laplace.live"), { recursive: true });
      symlinkSync(stagedDir, join(nm, "@laplace.live", "eidolon-sdk"), "dir");
      // Also link into stagedDir/node_modules so declarations inside stagedDir resolve peers/deps.
      for (const dest of [nm, join(stagedDir, "node_modules")]) {
        mkdirSync(dest, { recursive: true });
        for (const pkg of ["@pipecat-ai", "@types", "react", "react-dom"]) {
          const fromPkg = join(SDK_NODE_MODULES, pkg);
          const target = existsSync(fromPkg) ? fromPkg : join(ROOT, "node_modules", pkg);
          symlinkSync(target, join(dest, pkg), "dir");
        }
      }

      writeFileSync(
        join(consumer, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2023",
            lib: ["ES2023", "DOM", "DOM.Iterable"],
            module: "ESNext",
            moduleResolution: "Bundler",
            jsx: "react-jsx",
            types: [],
            strict: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ["consumer.tsx"],
        }),
      );
      writeFileSync(
        join(consumer, "consumer.tsx"),
        [
          'import { EidolonClient, isAudioQuality, parseMarkup } from "@laplace.live/eidolon-sdk";',
          'import { EidolonClientProvider, useEidolonConversation } from "@laplace.live/eidolon-sdk/react";',
          "",
          "const client = new EidolonClient();",
          'const ok: boolean = isAudioQuality("best");',
          'const tokens = parseMarkup("[happy] hello");',
          "export function App() {",
          "  const { messages } = useEidolonConversation();",
          "  return <EidolonClientProvider client={client}>{String(ok)}{tokens.length}{messages.length}</EidolonClientProvider>;",
          "}",
        ].join("\n"),
      );

      const tsc = join(ROOT, "node_modules", ".bin", "tsc");
      const res = Bun.spawnSync([tsc, "-p", join(consumer, "tsconfig.json")], {
        cwd: consumer,
        stderr: "pipe",
        stdout: "pipe",
      });
      expect([res.exitCode, res.stdout.toString() + res.stderr.toString()]).toEqual([0, ""]);

      const nodeRes = Bun.spawnSync(
        [
          "node",
          "--input-type=module",
          "-e",
          'const core = await import("@laplace.live/eidolon-sdk"); const react = await import("@laplace.live/eidolon-sdk/react"); if (typeof core.EidolonClient !== "function" || typeof react.useEidolonClient !== "function") process.exit(1);',
        ],
        { cwd: consumer, stderr: "pipe", stdout: "pipe" },
      );
      expect([nodeRes.exitCode, nodeRes.stdout.toString() + nodeRes.stderr.toString()]).toEqual([
        0,
        "",
      ]);
    } finally {
      rmSync(join(stagedDir, "node_modules"), { recursive: true, force: true });
      rmSync(consumer, { recursive: true, force: true });
    }
  }, 20_000);

  test("Biome enforces SDK and server import boundaries in both directions", async () => {
    const cases: readonly (readonly [string, string, boolean])[] = [
      ["apps/bot/src/x.ts", 'import "@laplace.live/eidolon-sdk";\n', true],
      ["apps/bot/src/local/x.ts", 'import "@laplace.live/eidolon-sdk";\n', true],
      ["apps/cli/src/x.ts", 'import "@laplace.live/eidolon-sdk";\n', true],
      ["packages/runtime/src/x.ts", 'import "@laplace.live/eidolon-sdk";\n', true],
      ["packages/ingest/src/x.ts", 'import "@laplace.live/eidolon-sdk";\n', true],
      ["packages/chat/src/x.ts", 'import "../../sdk/src/index.ts";\n', true],
      ["packages/sdk/src/x.ts", 'import "@eidolon/chat";\n', true],
      ["packages/sdk/src/x.ts", 'import "node:fs";\n', true],
      ["packages/sdk/src/x.ts", 'import "react";\n', true],
      ["packages/sdk/src/react/x.ts", 'import "react";\n', false],
    ];
    const dir = mkdtempSync(join(tmpdir(), "eidolon-sdk-boundary-"));
    try {
      copyFileSync(join(ROOT, "biome.json"), join(dir, "biome.json"));
      const biome = join(ROOT, "node_modules/.bin/biome");
      const results = await Promise.all(
        cases.map(async ([rel, code, shouldFail], index) => {
          const sandbox = join(dir, `case-${index}`);
          mkdirSync(dirname(join(sandbox, rel)), { recursive: true });
          copyFileSync(join(ROOT, "biome.json"), join(sandbox, "biome.json"));
          writeFileSync(join(sandbox, rel), code);
          const proc = Bun.spawn([biome, "lint", rel], {
            cwd: sandbox,
            stdout: "ignore",
            stderr: "ignore",
          });
          return [`${rel} (${code.trim()})`, (await proc.exited) !== 0, shouldFail] as const;
        }),
      );
      for (const [label, failed, expected] of results) {
        expect([label, failed]).toEqual([label, expected]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
