// The package build: each bundle where the resolvers look for it, importing only builtins and what
// the package installs, and the published manifest the workspaces' pins make.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  globSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliEntry, serverEntry, voiceModelsDir } from "@eidolon/config";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type Bundles,
  bundle,
  checkImports,
  copyTracked,
  inlinedPackages,
  inPackage,
  licenseText,
  type Manifest,
  notices,
  packageManifest,
  stage,
} from "../scripts/build.ts";
import { ENTRIES, NODE_MAJOR, PLATFORMS } from "../src/launcher.ts";

const ROOT = join(import.meta.dirname, "../../..");
const LAUNCHER = "bin/eidolon.mjs";

function manifestOf<T>(path: string): T {
  return JSON.parse(readFileSync(join(ROOT, path, "package.json"), "utf8")) as T;
}

let root: string;
let bundles: Bundles;
let manifest: Manifest;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "eidolon-package-"));
  bundles = await bundle(root);
  manifest = packageManifest();
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the bundles", () => {
  test("sit where the launcher and the resolvers look for them", () => {
    expect(inPackage(root, serverEntry)).toBe(join(root, "dist", "server.js"));
    expect(inPackage(root, cliEntry)).toBe(join(root, ENTRIES.cli));
    const files = [ENTRIES.app, ENTRIES.cli, "dist/server.js", LAUNCHER];
    expect([...bundles.imports.keys()].sort()).toEqual([...files].sort());
    for (const file of files) expect([file, existsSync(join(root, file))]).toEqual([file, true]);
    const launcher = join(root, LAUNCHER);
    expect(readFileSync(launcher, "utf8")).toStartWith("#!/usr/bin/env node\n");
    expect(statSync(launcher).mode & 0o111).toBe(0o111);
  });

  test("import only builtins and what the package installs", () => {
    expect(() => checkImports(bundles.imports, manifest)).not.toThrow();
    const stray = new Map([["dist/x.js", new Set(["left-pad", "node:fs", "bufferutil"])]]);
    expect(() => checkImports(stray, manifest)).toThrow(
      /^The bundles import what the package doesn't install:\ndist\/x\.js: left-pad$/,
    );
  });

  test("leave werift and apache-arrow to node_modules, one copy for the packages that share them", () => {
    const server = bundles.imports.get("dist/server.js");
    for (const name of ["werift", "libopus-wasm", "apache-arrow", "onnxruntime-node"]) {
      expect([name, server?.has(name)]).toEqual([name, true]);
    }
    expect([...bundles.inlined.keys()]).toContain("@lancedb/lancedb");
    for (const name of ["werift", "libopus-wasm", "apache-arrow", "onnxruntime-node"]) {
      expect([name, bundles.inlined.has(name)]).toEqual([name, false]);
    }
    expect([...bundles.inlined.keys()].filter((name) => name.startsWith("@eidolon/"))).toEqual([]);
    // ws requires its native speedups by name, and runs without them.
    for (const name of ["bufferutil", "utf-8-validate"]) {
      expect([name, server?.has(name)]).toEqual([name, true]);
    }
  });

  test("keep LanceDB's loader requiring each supported platform's binary by name", () => {
    for (const file of ["dist/server.js", "dist/cli.js"]) {
      const imports = bundles.imports.get(file);
      for (const lancedb of Object.values(PLATFORMS)) {
        expect([file, lancedb, imports?.has(lancedb)]).toEqual([file, lancedb, true]);
      }
    }
  });

  test("the launcher answers --help and --version, and refuses what isn't a command", () => {
    const launcher = join(root, LAUNCHER);
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [launcher, ...args], { encoding: "utf8" });
    const help = run("--help");
    expect([help.status, help.stdout]).toEqual([0, expect.stringContaining("ingest-facts")]);
    expect(run("--version").stdout).toBe(`${manifest.version}\n`);
    const unknown = run("serve");
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toStartWith('eidolon: unknown command "serve"');
  });
});

describe("the stage", () => {
  // The desktop app stages its backend the same way, into a folder of its own.
  test("writes the whole package into the folder it is given", async () => {
    const at = join(root, "staged", "eidolon");
    const staged = await stage(at);
    expect(staged).toEqual(manifest);
    expect(JSON.parse(readFileSync(join(at, "package.json"), "utf8"))).toEqual(manifest);
    for (const file of [
      ...Object.values(ENTRIES),
      "dist/server.js",
      LAUNCHER,
      "web/index.html",
      "personas/milky-green/persona.yaml",
      "skills/persona-update/SKILL.md",
      "data/jieba/dict.txt",
      "data/resampler/resampler.wasm",
      "data/models/silero_vad.onnx",
      "README.md",
      "LICENSE",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
    ]) {
      expect([file, existsSync(join(at, file))]).toEqual([file, true]);
    }
  }, 120_000);
});

describe("the voice models", () => {
  test("ship byte for byte in data/models, with their licenses", () => {
    const dir = inPackage(root, voiceModelsDir);
    expect(dir).toBe(join(root, "data", "models"));
    copyTracked(voiceModelsDir(), dir);
    const sha256 = (file: string) =>
      createHash("sha256")
        .update(readFileSync(join(dir, file)))
        .digest("hex");
    expect({
      silero: sha256("silero_vad.onnx"),
      smartTurn: sha256("smart-turn-v3.2-cpu.onnx"),
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
    const dist = inlinedPackages(bundles.inlined);
    const lancedb = dist.find((pkg) => pkg.name === "@lancedb/lancedb");
    expect(lancedb).toMatchObject({ identifier: "Apache-2.0", text: undefined });
    const text = notices(dist, []);
    expect(text).toContain(
      `### @lancedb/lancedb ${lancedb?.version} (Apache-2.0)\n\nThe package ships no license ` +
        "file; this is SPDX's text of Apache-2.0",
    );
    expect(text.match(/^### /gm)?.length).toBe(dist.length);
  });

  test("NOTICE, which the package ships, names every copyright a ported file's header does", () => {
    const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");
    // pipedog's and npm-install-checks' ports are BSD-2, those of npm's other packages ISC, and
    // pi-mono's, deepseek-harness's and cross-spawn's MIT.
    const holders = new Map<string, Set<string>>([
      ["BSD-2-Clause", new Set()],
      ["ISC", new Set()],
      ["MIT", new Set()],
    ]);
    const ported = ["{apps,packages}/*/src/**/*.ts", "apps/desktop/node-shim/*.mjs"];
    for (const file of globSync(ported, { cwd: ROOT })) {
      const source = readFileSync(join(ROOT, file), "utf8");
      const license = /^\/\/ SPDX-License-Identifier: (BSD-2-Clause|ISC|MIT)$/m.exec(source)?.[1];
      if (license === undefined) continue;
      for (const [, line] of source.matchAll(/^\/\/ (Copyright \(c\) .+)$/gm)) {
        holders.get(license)?.add(line as string);
      }
    }
    for (const [license, lines] of holders) {
      expect([license, lines.size > 0]).toEqual([license, true]);
      expect([license, [...lines].filter((line) => !notice.includes(line))]).toEqual([license, []]);
    }
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
      bin: { eidolon: LAUNCHER },
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      engines: { node: `>=${NODE_MAJOR}` },
      publishConfig: { access: "public", provenance: true },
    });
    for (const field of ["private", "scripts", "devDependencies", "workspaces"]) {
      expect([field, field in manifest]).toEqual([field, false]);
    }
  });

  test("depends on the externals at the workspaces' pins, and each platform's LanceDB", () => {
    const runtime = manifestOf<{ dependencies: Record<string, string> }>("packages/runtime");
    const retrieval = manifestOf<{ dependencies: Record<string, string> }>("packages/retrieval");
    const voice = manifestOf<{ dependencies: Record<string, string> }>("packages/voice");
    const webrtc = manifestOf<{ dependencies: Record<string, string> }>("packages/webrtc");
    const bot = manifestOf<{ dependencies: Record<string, string> }>("apps/bot");
    expect(manifest.dependencies).toEqual({
      "onnxruntime-node": voice.dependencies["onnxruntime-node"],
      werift: webrtc.dependencies.werift,
      "libopus-wasm": webrtc.dependencies["libopus-wasm"],
      "apache-arrow": retrieval.dependencies["apache-arrow"],
      sharp: bot.dependencies.sharp,
    });
    expect(webrtc.dependencies.werift).toBe(runtime.dependencies.werift);
    expect(manifest.optionalDependencies).toEqual({
      "@lancedb/lancedb-darwin-arm64": retrieval.dependencies["@lancedb/lancedb"],
      "@lancedb/lancedb-linux-arm64-gnu": retrieval.dependencies["@lancedb/lancedb"],
      "@lancedb/lancedb-linux-x64-gnu": retrieval.dependencies["@lancedb/lancedb"],
      "@lancedb/lancedb-win32-x64-msvc": retrieval.dependencies["@lancedb/lancedb"],
    });
  });
});
