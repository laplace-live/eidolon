// stage-backend's parts, on made-up lockfiles and folders: the pinning to bun.lock, what is pruned
// and the license texts. The staged payload itself is stage.test.ts's.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { packageManifest } from "../../eidolon/scripts/build.ts";
import {
  type BunLock,
  type LsNode,
  lockDrift,
  lockedTree,
  type Overrides,
  parseBunLock,
  pinOverrides,
  readBunLock,
  resolveFrom,
  supports,
} from "../scripts/lockfile.ts";
import { parseTarget, pruneOnnxruntime, thirdPartyLicenses } from "../scripts/stage-backend.ts";

const ROOT = join(import.meta.dirname, "../../..");
const temps: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "eidolon-stage-test-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function put(file: string, content: string | Buffer = ""): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

// a nests its own b, which nests its own c; d takes the top-level b. One optional package is for
// macOS on Apple silicon, one for Windows x64, one for anything but Windows; q is an optional peer.
const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "a, ] and } in a string", "dependencies": { "a": "1.0.0", }, }, },
  "packages": {
    "a": ["a@1.0.0", "", { "dependencies": { "b": "^1", "c": "^2", }, "optionalDependencies": { "mac-only": "1.0.0", "win-only": "1.0.0", }, "peerDependencies": { "p": "*", "q": "*", }, "optionalPeers": ["q",], }, "sha512-a"],
    "a/b": ["b@1.1.0", "", { "dependencies": { "c": "^1", }, }, "sha512-ab"],
    "a/b/c": ["c@1.0.0", "", {}, "sha512-abc"],
    "b": ["b@2.0.0", "", {}, "sha512-b"],
    "c": ["c@2.0.0", "", {}, "sha512-c"],
    "d": ["d@1.0.0", "", { "dependencies": { "b": "^2", }, "optionalDependencies": { "not-win": "1.0.0", }, }, "sha512-d"],
    "mac-only": ["mac-only@1.0.0", "", { "os": "darwin", "cpu": "arm64", }, "sha512-m"],
    "not-win": ["not-win@1.0.0", "", { "os": ["!win32",], }, "sha512-n"],
    "p": ["p@1.0.0", "", {}, "sha512-p"],
    "q": ["q@1.0.0", "", {}, "sha512-q"],
    "win-only": ["win-only@1.0.0", "", { "os": ["win32",], "cpu": ["x64",], }, "sha512-w"],
  },
}
`;
const ROOTS = { a: "1.0.0", d: "1.0.0" };
const DARWIN = { os: "darwin", cpu: "arm64" };
const WIN32 = { os: "win32", cpu: "x64" };

describe("bun.lock", () => {
  const lock: BunLock = parseBunLock(LOCK);

  test("reads its trailing commas as JSON, and leaves the ones inside strings", () => {
    expect(Object.keys(lock.packages)).toHaveLength(11);
    expect(parseBunLock(LOCK)).toMatchObject({
      workspaces: { "": { name: "a, ] and } in a string" } },
    });
    expect(parseBunLock('["a\\", ]",]')).toEqual(['a", ]']);
  });

  test("resolves a dependency from the nearest folder above, as Node does", () => {
    expect(resolveFrom(lock, ["a"], "b")?.version).toBe("1.1.0");
    expect(resolveFrom(lock, ["a", "b"], "c")?.version).toBe("1.0.0");
    expect(resolveFrom(lock, ["a"], "c")?.version).toBe("2.0.0");
    expect(resolveFrom(lock, ["d"], "b")?.version).toBe("2.0.0");
    expect(resolveFrom(lock, ["d"], "zzz")).toBeNull();
  });

  test("follows dependencies, required peers, and the optional ones a platform supports", () => {
    const keys = (platform?: { os: string; cpu: string }) =>
      [...lockedTree(lock, ROOTS, platform).keys()].sort();
    const always = ["a", "a/b", "a/b/c", "b", "c", "d", "p"];
    expect(keys()).toEqual([...always, "mac-only", "not-win", "win-only"].sort());
    expect(keys(DARWIN)).toEqual([...always, "mac-only", "not-win"].sort());
    expect(keys(WIN32)).toEqual([...always, "win-only"].sort());
    expect([
      supports(["!win32"], "linux"),
      supports("none", "x64"),
      supports(undefined, "x64"),
    ]).toEqual([true, false, true]);
  });

  test("refuses a root bun.lock has at another version", () => {
    expect(() => lockedTree(lock, { a: "1.0.1" })).toThrow(
      "bun.lock has a at 1.0.0, not 1.0.1: run bun install",
    );
  });

  test("pins each package where bun.lock puts it, nesting its second versions", () => {
    expect(pinOverrides(lockedTree(lock, ROOTS).values())).toEqual({
      a: { ".": "1.0.0", b: { ".": "1.1.0", c: "1.0.0" } },
      b: "2.0.0",
      c: "2.0.0",
      d: "1.0.0",
      "mac-only": "1.0.0",
      "not-win": "1.0.0",
      p: "1.0.0",
      "win-only": "1.0.0",
    });
  });

  test("pins every package the externals reach, those npx drifted on among them, and none of LanceDB's own", () => {
    const manifest = packageManifest();
    const tree = lockedTree(readBunLock(join(ROOT, "bun.lock")), {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    });
    const overrides = pinOverrides(tree.values());
    const pinned = (path: readonly string[]): string | undefined => {
      let at: string | Overrides | undefined = overrides;
      for (const name of path) at = typeof at === "object" ? at[name] : undefined;
      return typeof at === "object" ? (at["."] as string) : at;
    };
    for (const locked of tree.values()) {
      expect([locked.path.join("/"), pinned(locked.path)]).toEqual([
        locked.path.join("/"),
        locked.version,
      ]);
    }
    const names = new Set([...tree.values()].map((locked) => locked.name));
    for (const name of ["mediabunny", "global-agent", "@lancedb/lancedb-win32-x64-msvc"]) {
      expect([name, names.has(name)]).toEqual([name, true]);
    }
    for (const name of ["@lancedb/lancedb", "@huggingface/transformers", "openai"]) {
      expect([name, names.has(name)]).toEqual([name, false]);
    }
  });
});

describe("an install against bun.lock", () => {
  const lock = parseBunLock(LOCK);
  const darwin = (): LsNode => ({
    dependencies: {
      a: {
        version: "1.0.0",
        dependencies: {
          b: { version: "1.1.0", dependencies: { c: { version: "1.0.0" } } },
          c: { version: "2.0.0" },
          "mac-only": { version: "1.0.0" },
          "win-only": {},
          p: { version: "1.0.0" },
        },
      },
      d: {
        version: "1.0.0",
        dependencies: { b: { version: "2.0.0" }, "not-win": { version: "1.0.0" } },
      },
    },
  });

  test("agrees when npm installed bun.lock's tree, the platform's skips aside", () => {
    expect(lockDrift(darwin(), lock, DARWIN)).toEqual([]);
  });

  test("names a version npm resolved otherwise, what either side lacks, and npm's problems", () => {
    const ls = darwin() as { dependencies: Record<string, LsNode> };
    const a = ls.dependencies.a as { dependencies: Record<string, LsNode> };
    a.dependencies.b = { version: "1.1.0", dependencies: { c: { version: "1.0.1" } } };
    delete a.dependencies.p;
    ls.dependencies.d = {
      version: "1.0.0",
      dependencies: { b: { version: "2.0.0" }, x: { version: "9.0.0" }, "not-win": {} },
    };
    expect(lockDrift({ ...ls, problems: ["invalid: c@1.0.1"] }, lock, DARWIN)).toEqual([
      "invalid: c@1.0.1",
      "a > b > c: npm installed 1.0.1, bun.lock has 1.0.0",
      "d > x@9.0.0: not in bun.lock",
      "p@1.0.0 (p): not installed",
      "not-win@1.0.0 (not-win): not installed",
    ]);
    expect(lockDrift({ dependencies: { a: { version: "1.0.1" } } }, lock, DARWIN)).toEqual([
      "bun.lock has a at 1.0.0, not 1.0.1: run bun install",
    ]);
  });
});

describe("onnxruntime-node", () => {
  const ORT = {
    "darwin/arm64": [
      "onnxruntime_binding.node",
      "libonnxruntime.1.dylib",
      "libonnxruntime.1.30.0.dylib",
    ],
    "linux/x64": ["onnxruntime_binding.node", "libonnxruntime.so.1"],
    "win32/x64": [
      "onnxruntime_binding.node",
      "onnxruntime.dll",
      "DirectML.dll",
      "dxcompiler.dll",
      "dxil.dll",
    ],
    "win32/arm64": ["onnxruntime_binding.node", "onnxruntime.dll"],
  };
  function modules(): string {
    const dir = temp();
    for (const [folder, names] of Object.entries(ORT)) {
      for (const name of names) put(join(dir, "onnxruntime-node", "bin", "napi-v6", folder, name));
    }
    put(join(dir, "onnxruntime-node", "dist", "index.js"));
    return dir;
  }
  const left = (dir: string) =>
    (readdirSync(join(dir, "onnxruntime-node"), { recursive: true }) as string[])
      .map((path) => path.split("\\").join("/"))
      .filter((path) => path.split("/").length === 5 || path.startsWith("dist"))
      .sort();

  test("keeps the target's binding and the library it loads, and nothing else", () => {
    const darwin = modules();
    pruneOnnxruntime(darwin, "darwin-arm64");
    expect(left(darwin)).toEqual([
      "bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib",
      "bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
      "dist",
      "dist/index.js",
    ]);
  });

  test("refuses a build that lacks them", () => {
    const dir = modules();
    rmSync(
      join(dir, "onnxruntime-node", "bin", "napi-v6", "darwin", "arm64", "libonnxruntime.1.dylib"),
    );
    expect(() => pruneOnnxruntime(dir, "darwin-arm64")).toThrow(
      "onnxruntime-node has no libonnxruntime.1.dylib in darwin/arm64",
    );
  });
});

describe("THIRD_PARTY_LICENSES.txt", () => {
  test("gives each package its own license, else SPDX's, and says where libvips's source is", () => {
    const modules = temp();
    const manifest = (dir: string, fields: Record<string, string>) =>
      put(join(dir, "package.json"), JSON.stringify(fields));
    manifest(join(modules, "own"), { name: "own", version: "1.0.0", license: "MIT" });
    put(join(modules, "own", "LICENSE.md"), "Copyright (c) Own\n");
    manifest(join(modules, "bare"), { name: "bare", version: "2.0.0", license: "Apache-2.0" });
    manifest(join(modules, "own", "node_modules", "bare"), {
      name: "bare",
      version: "1.0.0",
      license: "MIT",
    });
    manifest(join(modules, "@img", "sharp-libvips-darwin-arm64"), {
      name: "@img/sharp-libvips-darwin-arm64",
      version: "1.3.4",
      license: "LGPL-3.0-or-later",
    });
    put(join(modules, ".package-lock.json"), "{}");
    const text = thirdPartyLicenses(modules);
    const titles = [...text.matchAll(/^=+\n(.+)\n=+$/gm)].map((match) => match[1]);
    expect(titles).toEqual([
      "@img/sharp-libvips-darwin-arm64 1.3.4 (LGPL-3.0-or-later)",
      "bare 1.0.0 (MIT)",
      "bare 2.0.0 (Apache-2.0)",
      "own 1.0.0 (MIT)",
    ]);
    for (const line of [
      "Copyright (c) Own",
      "Permission is hereby granted, free of charge",
      "Version 2.0, January 2004",
      "sharp links libvips dynamically. Its source is at https://github.com/libvips/libvips",
      "GNU LESSER GENERAL PUBLIC LICENSE",
      "GNU GENERAL PUBLIC LICENSE",
      "THIRD_PARTY_NOTICES.md",
    ]) {
      expect([line, text.includes(line)]).toEqual([line, true]);
    }
  });
});

describe("staging", () => {
  test("is for darwin-arm64", () => {
    expect(parseTarget("darwin-arm64")).toBe("darwin-arm64");
    expect(() => parseTarget("linux-x64")).toThrow(
      "The desktop app ships for darwin-arm64, not linux-x64",
    );
  });
});
