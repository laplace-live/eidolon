// The package build: each bundle where the resolvers look for it, importing only builtins and what
// the package installs, and the published manifest the workspaces' pins make.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliEntry, serverEntry, voiceModelsDir } from "@eidolon/config";
import {
  bareImports,
  bundle,
  checkImports,
  copyTracked,
  inlinedPackages,
  inPackage,
  licenseText,
  type Manifest,
  notices,
  packageManifest,
} from "../scripts/build.ts";
import { ENTRIES, PLATFORMS } from "../src/launcher.ts";

const ROOT = join(import.meta.dir, "../../..");

function manifestOf<T>(path: string): T {
  return JSON.parse(readFileSync(join(ROOT, path, "package.json"), "utf8")) as T;
}

let root: string;
let inlined: Map<string, string>;
let manifest: Manifest;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "eidolon-package-"));
  inlined = await bundle(root);
  manifest = packageManifest(Bun.version);
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the bundles", () => {
  test("sit where the launcher and the resolvers look for them", () => {
    expect(inPackage(root, serverEntry)).toBe(join(root, "dist", "server.js"));
    expect(inPackage(root, cliEntry)).toBe(join(root, ENTRIES.cli));
    for (const file of [ENTRIES.app, ENTRIES.cli, "dist/server.js"]) {
      expect([file, readFileSync(join(root, file), "utf8").startsWith("// @bun")]).toEqual([
        file,
        true,
      ]);
    }
    const launcher = join(root, "bin", "eidolon.mjs");
    expect(readFileSync(launcher, "utf8")).toStartWith("#!/usr/bin/env node\n");
    expect(statSync(launcher).mode & 0o111).toBe(0o111);
  });

  test("import only builtins and what the package installs", () => {
    expect(() => checkImports(root, manifest)).not.toThrow();
    const stray = mkdtempSync(join(tmpdir(), "eidolon-package-"));
    try {
      mkdirSync(join(stray, "dist"));
      writeFileSync(join(stray, "dist", "x.js"), 'import "left-pad";\nimport "node:fs";\n');
      expect(() => checkImports(stray, manifest)).toThrow("x.js: left-pad");
    } finally {
      rmSync(stray, { recursive: true, force: true });
    }
  });

  test("leave werift and apache-arrow to node_modules, one copy for the packages that share them", () => {
    const server = bareImports(join(root, "dist", "server.js"));
    for (const name of ["werift", "libopus-wasm", "apache-arrow", "onnxruntime-node"]) {
      expect([name, server.has(name)]).toEqual([name, true]);
    }
    expect([...inlined.keys()]).toContain("@lancedb/lancedb");
    for (const name of ["werift", "libopus-wasm", "apache-arrow", "onnxruntime-node"]) {
      expect([name, inlined.has(name)]).toEqual([name, false]);
    }
    expect([...inlined.keys()].filter((name) => name.startsWith("@eidolon/"))).toEqual([]);
  });

  test("keep LanceDB's loader requiring each supported platform's binary by name", () => {
    for (const file of ["server.js", "cli.js"]) {
      const imports = bareImports(join(root, "dist", file));
      for (const { lancedb } of Object.values(PLATFORMS)) {
        expect([file, lancedb, imports.has(lancedb)]).toEqual([file, lancedb, true]);
      }
    }
  });

  test("the launcher answers --help and --version, and refuses what isn't a command", () => {
    const launcher = join(root, "bin", "eidolon.mjs");
    const help = Bun.spawnSync([process.execPath, launcher, "--help"]);
    expect([help.exitCode, help.stdout.toString()]).toEqual([
      0,
      expect.stringContaining("ingest-facts"),
    ]);
    const version = Bun.spawnSync([process.execPath, launcher, "--version"]);
    expect(version.stdout.toString()).toBe(`${manifest.version}\n`);
    const unknown = Bun.spawnSync([process.execPath, launcher, "serve"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr.toString()).toStartWith('eidolon: unknown command "serve"');
  });
});

describe("the voice models", () => {
  test("ship byte for byte in data/models, with their licenses", async () => {
    const dir = inPackage(root, voiceModelsDir);
    expect(dir).toBe(join(root, "data", "models"));
    copyTracked(voiceModelsDir(), dir);
    const sha256 = async (file: string) =>
      new Bun.CryptoHasher("sha256")
        .update(await Bun.file(join(dir, file)).arrayBuffer())
        .digest("hex");
    expect({
      silero: await sha256("silero_vad.onnx"),
      smartTurn: await sha256("smart-turn-v3.2-cpu.onnx"),
    }).toEqual({
      silero: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
      smartTurn: "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f",
    });
    const licenses = readFileSync(join(dir, "THIRD_PARTY_LICENSES.md"), "utf8");
    for (const line of [
      "Copyright (c) 2020-present Silero Team",
      "Copyright (c) 2024–2025, Daily",
      "Apache License",
    ]) {
      expect([line, licenses.includes(line)]).toEqual([line, true]);
    }
  });
});

describe("the third-party notices", () => {
  test("carry a package's own license file, else SPDX's text of the license it declares", () => {
    const own = { name: "own", version: "1.0.0", identifier: "MIT", text: "Copyright (c) Own" };
    expect(notices([own], [])).toContain("### own 1.0.0 (MIT)\n\nCopyright (c) Own\n");
    for (const [identifier, line] of [
      ["Apache-2.0", "Version 2.0, January 2004"],
      ["BSD-2-Clause", "Redistribution and use in source and binary forms"],
      ["MIT", "Permission is hereby granted, free of charge"],
    ] as const) {
      const text = licenseText({ name: "bare", version: "1.0.0", identifier });
      expect(text).toStartWith(
        `The package ships no license file; this is SPDX's text of ${identifier}`,
      );
      expect(text).toContain(line);
    }
  });

  test("fail the build for a package with no license file and no license SPDX's text covers", () => {
    for (const identifier of ["(MIT OR Apache-2.0)", undefined]) {
      expect(() => licenseText({ name: "bare", version: "1.0.0", identifier })).toThrow(
        "bare ships no license file, and apps/eidolon/spdx/ has no text for",
      );
    }
  });

  test("give each package the bundles inline its text, LanceDB's from SPDX", () => {
    const dist = inlinedPackages(inlined);
    const lancedb = dist.find((pkg) => pkg.name === "@lancedb/lancedb");
    expect(lancedb).toMatchObject({ identifier: "Apache-2.0", text: undefined });
    const text = notices(dist, []);
    expect(text).toContain(
      `### @lancedb/lancedb ${lancedb?.version} (Apache-2.0)\n\nThe package ships no license ` +
        "file; this is SPDX's text of Apache-2.0",
    );
    expect(text.match(/^### /gm)?.length).toBe(dist.length);
  });

  test("NOTICE, which the package ships, names every copyright a ported file's BSD-2 header does", () => {
    const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");
    const holders = new Set<string>();
    for (const file of new Bun.Glob("packages/*/src/**/*.ts").scanSync(ROOT)) {
      const source = readFileSync(join(ROOT, file), "utf8");
      if (!source.includes("SPDX-License-Identifier: BSD-2-Clause")) continue;
      for (const [, line] of source.matchAll(/^\/\/ (Copyright \(c\) .+)$/gm)) {
        holders.add(line as string);
      }
    }
    expect(holders.size).toBeGreaterThan(0);
    expect([...holders].filter((line) => !notice.includes(line))).toEqual([]);
  });
});

describe("the published manifest", () => {
  test("is @laplace.live/eidolon at the bot's version, AGPL-3.0-only, with nothing to run at install", () => {
    const bot = manifestOf<{ version: string }>("apps/bot");
    const own = manifestOf<{
      version: string;
      name: string;
      private?: boolean;
      publishConfig?: Record<string, unknown>;
    }>("apps/eidolon");
    expect(own).toMatchObject({
      name: "@laplace.live/eidolon",
      version: bot.version,
      publishConfig: { access: "public", provenance: true, directory: "pack" },
    });
    expect(own.private).toBeUndefined();
    expect(manifest).toMatchObject({
      name: "@laplace.live/eidolon",
      version: bot.version,
      license: "AGPL-3.0-only",
      bin: { eidolon: "bin/eidolon.mjs" },
      os: ["darwin", "linux"],
      cpu: ["arm64", "x64"],
      publishConfig: { access: "public", provenance: true },
    });
    for (const field of ["private", "scripts", "devDependencies", "workspaces"]) {
      expect([field, field in manifest]).toEqual([field, false]);
    }
  });

  test("depends on the externals at the workspaces' pins, and each platform's Bun and LanceDB", () => {
    const runtime = manifestOf<{ dependencies: Record<string, string> }>("packages/runtime");
    const retrieval = manifestOf<{ dependencies: Record<string, string> }>("packages/retrieval");
    const voice = manifestOf<{ dependencies: Record<string, string> }>("packages/voice");
    const webrtc = manifestOf<{ dependencies: Record<string, string> }>("packages/webrtc");
    expect(manifest.dependencies).toEqual({
      "onnxruntime-node": voice.dependencies["onnxruntime-node"],
      werift: webrtc.dependencies.werift,
      "libopus-wasm": webrtc.dependencies["libopus-wasm"],
      "apache-arrow": retrieval.dependencies["apache-arrow"],
    });
    expect(webrtc.dependencies.werift).toBe(runtime.dependencies.werift);
    expect(manifest.optionalDependencies).toEqual({
      "@lancedb/lancedb-darwin-arm64": retrieval.dependencies["@lancedb/lancedb"],
      "@lancedb/lancedb-linux-arm64-gnu": retrieval.dependencies["@lancedb/lancedb"],
      "@lancedb/lancedb-linux-x64-gnu": retrieval.dependencies["@lancedb/lancedb"],
      "@oven/bun-darwin-aarch64": Bun.version,
      "@oven/bun-linux-aarch64": Bun.version,
      "@oven/bun-linux-x64": Bun.version,
    });
  });
});
