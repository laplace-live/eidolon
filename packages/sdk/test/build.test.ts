// The SDK's build script runs on Bun, so these tests drive it through `bun`.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const SDK_NODE_MODULES = resolve(import.meta.dirname, "../node_modules");
const SCRIPT = resolve(import.meta.dirname, "../scripts/build.ts");
const FIXTURE = resolve(ROOT, "apps/bot/test/local/fixtures/psd2live/tml.p2lrt");
const WASM_SHA256 = "d8bbff52f27aebd40baca94139f9eca5af0f9d2a07c1c70fc5c15633121862a7";

/** Runs `code` on Bun, with the build script's exports as `build`. */
function onBun(code: string) {
  const source = `const build = await import(${JSON.stringify(SCRIPT)});\n${code}`;
  return spawnSync("bun", ["--no-env-file", "-e", source], { cwd: ROOT, encoding: "utf8" });
}

let stagedDir: string;
let manifest: Record<string, unknown>;

beforeAll(() => {
  stagedDir = mkdtempSync(join(tmpdir(), "eidolon-sdk-pack-"));
  const staged = onBun(`await build.stage(${JSON.stringify(stagedDir)});`);
  if (staged.status !== 0) throw new Error(`stage exited ${staged.status}:\n${staged.stderr}`);
  manifest = JSON.parse(readFileSync(join(stagedDir, "package.json"), "utf8"));
}, 60_000);

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
      "dist/avatar/index.js",
      "dist/avatar/index.d.ts",
      "dist/avatar/wasm/p2l_runtime.wasm",
      "dist/avatar/wasm/LICENSE",
      "dist/avatar/wasm/THIRD_PARTY_LICENSES.md",
      "LICENSE-psd2live",
      "THIRD_PARTY.md",
    ]) {
      expect([rel, existsSync(join(stagedDir, rel))]).toEqual([rel, true]);
    }
    expect(existsSync(join(stagedDir, "dist/avatar/index.node.js"))).toBe(false);

    const workspacePkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { version: string; private?: boolean; publishConfig?: Record<string, unknown> };
    expect(workspacePkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(workspacePkg.private).toBeUndefined();
    expect(workspacePkg.publishConfig).toEqual({
      access: "public",
      provenance: true,
      directory: "pack",
    });

    expect(manifest).toMatchObject({
      name: "@laplace.live/eidolon-sdk",
      version: workspacePkg.version,
      license: "AGPL-3.0-only",
      type: "module",
      sideEffects: false,
      publishConfig: { access: "public", provenance: true },
      types: "./dist/index.d.ts",
      typesVersions: { "*": { react: ["./dist/react/index.d.ts"] } },
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
    // toMatchObject lets extra keys through, so the avatar entry's are pinned whole.
    expect((manifest.exports as Record<string, unknown>)["./avatar"]).toEqual({
      types: "./dist/avatar/index.d.ts",
      default: "./dist/avatar/index.js",
    });
    expect(manifest.typesVersions).toEqual({
      "*": { react: ["./dist/react/index.d.ts"], avatar: ["./dist/avatar/index.d.ts"] },
    });
    expect(workspacePkg).toMatchObject({
      exports: { "./avatar": "./src/avatar/index.ts" },
    });
    for (const forbidden of ["private", "scripts", "devDependencies", "workspaces"]) {
      expect([forbidden, forbidden in manifest]).toEqual([forbidden, false]);
    }
    expect(readFileSync(join(stagedDir, "LICENSE"), "utf8")).toContain("AFFERO GENERAL PUBLIC");
  });

  test("ships PSD2Live's runtime beside the avatar bundle that names it, with its license", () => {
    const wasm = readFileSync(join(stagedDir, "dist/avatar/wasm/p2l_runtime.wasm"));
    expect(createHash("sha256").update(wasm).digest("hex")).toBe(WASM_SHA256);
    const holder = "Copyright (c) 2026 PSD2Live contributors";
    for (const rel of ["LICENSE-psd2live", "THIRD_PARTY.md", "dist/avatar/wasm/LICENSE"]) {
      expect([rel, readFileSync(join(stagedDir, rel), "utf8").includes(holder)]).toEqual([
        rel,
        true,
      ]);
    }
    const avatar = readFileSync(join(stagedDir, "dist/avatar/index.js"), "utf8");
    expect(avatar).toContain('new URL("./wasm/p2l_runtime.wasm", import.meta.url)');
    for (const rel of ["dist/index.js", "dist/index.node.js", "dist/react/index.js"]) {
      const bundle = readFileSync(join(stagedDir, rel), "utf8");
      expect([rel, bundle.includes("p2l_runtime"), bundle.includes("PSD2Live")]).toEqual([
        rel,
        false,
        false,
      ]);
    }
  });

  test("checkDistImports rejects unrewritten .ts extensions, undeclared packages, and jsxDEV", () => {
    for (const rel of ["dist/react/index.js", "dist/react/index.node.js"]) {
      const bundle = readFileSync(join(stagedDir, rel), "utf8");
      expect([rel, bundle.startsWith('"use client";\n')]).toEqual([rel, true]);
      expect([rel, bundle.includes('from "react/jsx-runtime"')]).toEqual([rel, true]);
    }
    const broken = mkdtempSync(join(tmpdir(), "eidolon-sdk-broken-"));
    try {
      mkdirSync(join(broken, "dist", "react"), { recursive: true });
      writeFileSync(
        join(broken, "dist", "bad.d.ts"),
        'export { x } from "./other.ts";\nimport "left-pad";\n',
      );
      writeFileSync(
        join(broken, "dist", "react", "index.js"),
        'import { jsxDEV } from "react/jsx-dev-runtime";\nexport const el = jsxDEV("div", {});\n',
      );
      const check = onBun(
        `try { build.checkDistImports(${JSON.stringify(broken)}, ${JSON.stringify(manifest)}); }\n` +
          "catch (error) { console.log(error.message); }",
      );
      expect(check.stdout).toMatch(/unrewritten TypeScript[\s\S]*undeclared import left-pad/);
      expect(check.stdout).toMatch(/development JSX runtime react\/jsx-dev-runtime/);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  test("checkAssetUrls rejects a bundle naming a file the stage didn't copy", () => {
    const check = (root: string) =>
      onBun(
        `try { build.checkAssetUrls(${JSON.stringify(root)}); console.log("ok"); }\n` +
          "catch (error) { console.log(error.message); }",
      );
    expect(check(stagedDir).stdout.trim()).toBe("ok");
    const broken = mkdtempSync(join(tmpdir(), "eidolon-sdk-assets-"));
    try {
      mkdirSync(join(broken, "dist", "avatar", "wasm"), { recursive: true });
      writeFileSync(join(broken, "dist", "avatar", "wasm", "here.wasm"), "");
      writeFileSync(
        join(broken, "dist", "avatar", "index.js"),
        [
          'export const a = () => new URL("./wasm/here.wasm", import.meta.url);',
          "export const b = () => new URL('./wasm/p2l_runtime.wasm', import.meta.url);",
          'export const c = () => new URL("https://example.test/x.wasm", import.meta.url);',
        ].join("\n"),
      );
      expect(check(broken).stdout).toMatch(
        /^Missing assets in .*\navatar\/index\.js: \.\/wasm\/p2l_runtime\.wasm\n$/,
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
          'import { AvatarStage, type Direction, directionOf, directionState, inspectPsd2liveRig, moodTags } from "@laplace.live/eidolon-sdk/avatar";',
          "",
          'const mood: readonly string[] = moodTags("[懒洋洋的，带点笑意]");',
          "const direction: Direction = directionOf(directionState());",
          "export const show = (canvas: HTMLCanvasElement) => new AvatarStage(canvas, { fps: 30 }).direct(direction);",
          "export const read = (bytes: Uint8Array) => inspectPsd2liveRig(bytes).then((inventory) => inventory.clips.length + mood.length);",
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
      const res = spawnSync(tsc, ["-p", join(consumer, "tsconfig.json")], {
        cwd: consumer,
        encoding: "utf8",
      });
      expect([res.status, res.stdout + res.stderr]).toEqual([0, ""]);

      const nodeRes = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'const core = await import("@laplace.live/eidolon-sdk"); const react = await import("@laplace.live/eidolon-sdk/react"); if (typeof core.EidolonClient !== "function" || typeof react.useEidolonClient !== "function") process.exit(1);',
        ],
        { cwd: consumer, encoding: "utf8" },
      );
      expect([nodeRes.status, nodeRes.stdout + nodeRes.stderr]).toEqual([0, ""]);

      // The packed entry finds the runtime beside it, as a bundler would.
      const avatarRes = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          [
            'import { readFileSync } from "node:fs";',
            'const avatar = await import("@laplace.live/eidolon-sdk/avatar");',
            "const url = avatar.psd2liveRuntimeUrl();",
            `const inventory = await avatar.inspectPsd2liveRig(readFileSync(${JSON.stringify(FIXTURE)}), { runtime: readFileSync(url) });`,
            "console.log(JSON.stringify({ url: url.href, clips: inventory.clips.map((clip) => clip.group), textures: inventory.textures }));",
          ].join("\n"),
        ],
        { cwd: consumer, encoding: "utf8" },
      );
      expect([avatarRes.status, avatarRes.stderr]).toEqual([0, ""]);
      expect(JSON.parse(avatarRes.stdout)).toEqual({
        url: pathToFileURL(join(realpathSync(stagedDir), "dist/avatar/wasm/p2l_runtime.wasm")).href,
        clips: ["Idle", "Blink", "Nod", "Shake", "Talk"],
        textures: 6,
      });
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
      ["packages/sdk/src/avatar/x.ts", 'import "react";\n', true],
      ["packages/sdk/src/avatar/x.ts", 'import "node:fs";\n', true],
      ["packages/sdk/src/avatar/x.ts", 'import "@eidolon/config";\n', true],
      ["packages/sdk/src/avatar/x.ts", 'import "../react/index.ts";\n', true],
      ["packages/sdk/src/avatar/x.ts", 'import "../markup.ts";\n', false],
    ];
    const dir = mkdtempSync(join(tmpdir(), "eidolon-sdk-boundary-"));
    try {
      const biome = join(ROOT, "node_modules/.bin/biome");
      const results = await Promise.all(
        cases.map(async ([rel, code, shouldFail], index) => {
          const sandbox = join(dir, `case-${index}`);
          mkdirSync(dirname(join(sandbox, rel)), { recursive: true });
          copyFileSync(join(ROOT, "biome.json"), join(sandbox, "biome.json"));
          writeFileSync(join(sandbox, rel), code);
          const exitCode = await new Promise<number | null>((done) => {
            spawn(biome, ["lint", rel], { cwd: sandbox, stdio: "ignore" }).on("exit", done);
          });
          return [`${rel} (${code.trim()})`, exitCode !== 0, shouldFail] as const;
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
