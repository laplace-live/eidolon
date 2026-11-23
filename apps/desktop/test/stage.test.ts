// The payloads staged in apps/desktop/.stage (`bun run build:desktop` stages this machine's): what
// each holds, pinned to bun.lock and pruned, its natives loading from it, its node shim, on Windows
// the VC++ runtime and the signatures, and the packaged app holding it file for file. A target with
// no stage, or one staged from another version or bun.lock, skips, unless EIDOLON_REQUIRE_STAGE=1
// and it is this machine's.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, test } from "vitest";
import { packageManifest } from "../../eidolon/scripts/build.ts";
import { PLATFORMS, VC_RUNTIME_DLLS } from "../../eidolon/src/launcher.ts";
import {
  lockDrift,
  lockedTree,
  pinOverrides,
  readBunLock,
  resolveFrom,
  supports,
} from "../scripts/lockfile.ts";
import { checkNatives } from "../scripts/natives.ts";
import {
  LAUNCHER_FILES,
  LAUNCHER_SOURCES,
  NODE_SHIM,
  POSIX_LAUNCHERS,
} from "../scripts/node-shim.ts";
import { compareVersions, readPe } from "../scripts/pe.ts";
import {
  electronZip,
  LICENSES_FILE,
  MICROSOFT_SIGNERS,
  npmLs,
  payloadDir,
  peFilesIn,
  peFilesInZip,
  stageDir,
  TARGETS,
  type Target,
  UNSIGNED_PE_FILE,
} from "../scripts/stage-backend.ts";

const ROOT = join(import.meta.dirname, "../../..");
const DESKTOP = join(ROOT, "apps", "desktop");
const REQUIRED = process.env.EIDOLON_REQUIRE_STAGE === "1";
const HOST = `${process.platform}-${process.arch}`;
/** Where electron-builder puts each target's payload in the unpacked app. */
const PACKAGED: Record<Target, string> = {
  "darwin-arm64": join(DESKTOP, ".out", "mac-arm64", "Eidolon.app", "Contents", "Resources"),
  "win32-x64": join(DESKTOP, ".out", "win-unpacked", "resources"),
};
const STALE = "the stage is from another version or bun.lock: run bun run build:desktop";

/** The package.json a stage of this checkout holds: the npm package's, pinned to bun.lock. */
function currentManifest(): Record<string, unknown> {
  const npm = packageManifest();
  const roots = { ...npm.dependencies, ...npm.optionalDependencies };
  const overrides = pinOverrides(lockedTree(readBunLock(join(ROOT, "bun.lock")), roots).values());
  return { ...npm, overrides };
}

function readManifest(payload: string): {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(payload, "package.json"), "utf8"));
}

/** Whether the stage at `payload` is this checkout's, so a version bump leaves an old one alone. */
function isCurrent(payload: string): boolean {
  try {
    return isDeepStrictEqual(readManifest(payload), currentManifest());
  } catch {
    return false;
  }
}

/** Every file under `dir`, relative to it with `/`, and every symbolic link among them. */
function listing(dir: string): { files: string[]; links: string[] } {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  const path = (entry: (typeof entries)[number]) =>
    relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/");
  return {
    files: entries
      .filter((entry) => !entry.isDirectory())
      .map(path)
      .sort(),
    links: entries.filter((entry) => entry.isSymbolicLink()).map(path),
  };
}

/** A path compared as the OS compares them. */
function same(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** The folder, under node_modules, of the package a path there belongs to. */
function packageOf(path: string): string {
  const parts = path.split("/");
  const at = parts.lastIndexOf("node_modules");
  const rest = parts.slice(at + 1);
  const name = rest[0]?.startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
  return [...parts.slice(0, at + 1), ...name].join("/");
}

/** Each package folder directly under `modules`, a scope's included. */
function packageDirs(modules: string): string[] {
  const dirs = (parent: string) =>
    readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(parent, entry.name));
  return dirs(modules).flatMap((dir) => (basename(dir).startsWith("@") ? dirs(dir) : [dir]));
}

function manifestOf(dir: string): {
  name: string;
  version: string;
  license?: string;
  os?: string[];
  cpu?: string[];
} {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

/** THIRD_PARTY_LICENSES.txt's sections, by title. */
function licenseSections(text: string): Map<string, string> {
  const parts = text.split(/^={78}\n(.+)\n={78}\n/m);
  const found = new Map<string, string>();
  for (let i = 1; i < parts.length; i += 2) {
    found.set(parts[i] as string, (parts[i + 1] as string).trim());
  }
  return found;
}

for (const target of Object.keys(TARGETS) as Target[]) {
  const payload = payloadDir(target);
  const staged = existsSync(payload);
  const current = staged && isCurrent(payload);
  const { os, cpu, onnxruntime } = TARGETS[target];
  const modules = join(payload, "node_modules");
  const pnpm = join(payload, NODE_SHIM, "node_modules", "pnpm");
  const title = `the ${target} payload${staged && !current ? ` (${STALE})` : ""}`;

  describe.skipIf(!current && !(REQUIRED && target === HOST))(title, () => {
    test("holds what the npm package does, its node_modules and their licenses, and no links", () => {
      expect(staged, `no stage at ${payload}: run bun run build:desktop`).toBe(true);
      expect(readManifest(payload), STALE).toEqual(currentManifest());
      const { files, links } = listing(payload);
      // What main runs, and what the resolvers find under EIDOLON_APP_ROOT.
      for (const file of [
        "dist/server.js",
        "dist/cli.js",
        "dist/app.js",
        "bin/eidolon.mjs",
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
        LICENSES_FILE,
      ]) {
        expect([file, files.includes(file)]).toEqual([file, true]);
      }
      expect(links).toEqual([]);
      expect(files.filter((file) => /(^|\/)(\.bin\/|\.?package-lock\.json$)/.test(file))).toEqual(
        [],
      );
    });

    test("gives every license it holds in the one file the Licenses item opens", () => {
      const licenses = licenseSections(readFileSync(join(payload, LICENSES_FILE), "utf8"));
      const titles = [...licenses.keys()];
      for (const name of [
        "onnxruntime-node",
        "sharp",
        "werift",
        "apache-arrow",
        PLATFORMS[target],
      ]) {
        expect([name, titles.some((title) => title.startsWith(`${name} `))]).toEqual([name, true]);
      }
      for (const file of [
        "NOTICE",
        "THIRD_PARTY_NOTICES.md",
        "data/jieba/LICENSE",
        "data/models/THIRD_PARTY_LICENSES.md",
        "data/resampler/LICENSE",
        "data/resampler/THIRD_PARTY_LICENSES.md",
      ]) {
        expect([file, licenses.get(file)]).toEqual([
          file,
          readFileSync(join(payload, file), "utf8").trim(),
        ]);
      }
      // libvips is LGPL-3.0-or-later: in its own package on macOS, in sharp's build on Windows.
      const libvips = new Set(
        listing(modules)
          .files.filter((file) => /(^|\/)libvips[-.][^/]*\.(dll|dylib|so)/.test(file))
          .map((file) => {
            const dir = join(modules, packageOf(file));
            const { name, version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
            return `${name} ${version} `;
          }),
      );
      expect(libvips.size).toBeGreaterThan(0);
      for (const prefix of libvips) {
        const text = [...licenses].find(([title]) => title.startsWith(prefix))?.[1] ?? "";
        for (const line of [
          "Its source is at https://github.com/libvips/libvips",
          "GNU LESSER GENERAL PUBLIC LICENSE",
        ]) {
          expect([prefix, line, text.includes(line)]).toEqual([prefix, line, true]);
        }
      }
      // The node shim's pnpm, and each package its dist/ bundles.
      for (const dir of [pnpm, ...packageDirs(join(pnpm, "dist", "node_modules"))]) {
        const { name, version, license } = manifestOf(dir);
        const section = `${name} ${version} (${license})`;
        expect([section, licenses.has(section)]).toEqual([section, true]);
      }
      expect(licenses.get(`pnpm ${manifestOf(pnpm).version} (MIT)`)).toBe(
        readFileSync(join(pnpm, "LICENSE"), "utf8").trim(),
      );
    });

    test("holds the node shim: the checkout's launchers, sh's executable, and the pnpm bun.lock pins", () => {
      const bin = join(payload, NODE_SHIM, "bin");
      for (const file of LAUNCHER_FILES) {
        expect([file, readFileSync(join(bin, file), "utf8")], STALE).toEqual([
          file,
          readFileSync(join(LAUNCHER_SOURCES, file), "utf8"),
        ]);
      }
      if (process.platform !== "win32") {
        for (const name of POSIX_LAUNCHERS) {
          expect([name, statSync(join(bin, name)).mode & 0o777]).toEqual([name, 0o755]);
        }
      }
      const { version } = manifestOf(pnpm);
      const { devDependencies } = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8"));
      expect(version).toBe(devDependencies.pnpm);
      expect(resolveFrom(readBunLock(join(ROOT, "bun.lock")), [], "pnpm")?.version).toBe(version);
      for (const file of ["bin/pnpm.mjs", "bin/pnpx.mjs", "dist/pnpm.mjs"]) {
        expect([file, existsSync(join(pnpm, file))]).toEqual([file, true]);
      }
      // The Windows release signs every .exe it packs.
      const { files } = listing(join(payload, NODE_SHIM));
      expect(files.filter((file) => file.endsWith(".exe"))).toEqual([]);
    });

    test("keeps only the target's natives among the packages pnpm bundles", () => {
      const natives = packageDirs(join(pnpm, "dist", "node_modules"))
        .map(manifestOf)
        .filter((fields) => fields.os !== undefined || fields.cpu !== undefined);
      expect(natives.length).toBeGreaterThan(0);
      for (const fields of natives) {
        const admitted = supports(fields.os, os) && supports(fields.cpu, cpu);
        expect([fields.name, admitted]).toEqual([fields.name, true]);
      }
    });

    test("is the tree bun.lock pins, as npm ls shows it", () => {
      const { dependencies, optionalDependencies } = readManifest(payload);
      const roots = { ...dependencies, ...optionalDependencies };
      const lock = readBunLock(join(ROOT, "bun.lock"));
      expect(lockDrift(npmLs(payload), lock, roots, { os, cpu })).toEqual([]);
    }, 60_000);

    test("keeps only the target's onnxruntime binding and the library it loads", () => {
      const bin = join(modules, "onnxruntime-node", "bin", "napi-v6");
      expect(readdirSync(bin)).toEqual([os]);
      expect(readdirSync(join(bin, os))).toEqual([cpu]);
      const kept = readdirSync(join(bin, os, cpu)).filter(
        (name) => !VC_RUNTIME_DLLS.includes(name.toLowerCase()),
      );
      expect(kept.sort()).toEqual([...onnxruntime].sort());
    });

    test.skipIf(target !== HOST)(
      "loads its natives from itself: a LanceDB table, a Silero session, a JPEG",
      () => {
        const report = checkNatives(payload, PLATFORMS[target], { command: process.execPath });
        expect(report).toMatchObject({ rows: 2, image: "jpeg 2x1" });
        expect(report.speech).toBeGreaterThanOrEqual(0);
        expect(report.speech).toBeLessThanOrEqual(1);
        const home = same(realpathSync(payload));
        const natives = report.loaded.filter((path) => /\.(node|dll|dylib)$/i.test(path));
        for (const name of ["lancedb", "onnxruntime_binding", "sharp-", "vips"]) {
          expect([name, natives.some((path) => basename(path).includes(name))]).toEqual([
            name,
            true,
          ]);
        }
        expect(natives.filter((path) => !same(realpathSync(path)).startsWith(home))).toEqual([]);
      },
      60_000,
    );

    test.skipIf(target !== "win32-x64")(
      "has the VC++ runtime from one redist beside the natives that import it, as new as their linker",
      () => {
        const copies = new Map<string, string[]>();
        for (const file of listing(modules).files) {
          if (VC_RUNTIME_DLLS.includes(basename(file).toLowerCase())) {
            copies.set(dirname(file), [...(copies.get(dirname(file)) ?? []), basename(file)]);
          }
        }
        expect(copies.get("onnxruntime-node/bin/napi-v6/win32/x64")?.sort()).toEqual(
          [...VC_RUNTIME_DLLS].sort(),
        );
        expect(copies.get("@lancedb/lancedb-win32-x64-msvc")).toEqual(["vcruntime140.dll"]);
        const hashes = new Map<string, Set<string>>();
        for (const [folder, dlls] of copies) {
          const natives = readdirSync(join(modules, folder)).filter(
            (name) => /\.(node|dll)$/i.test(name) && !dlls.includes(name),
          );
          for (const dll of dlls) {
            const file = join(modules, folder, dll);
            const version = readPe(file)?.fileVersion ?? "0";
            for (const native of natives) {
              const linker = readPe(join(modules, folder, native))?.linker ?? "99";
              expect([dll, version, native, linker, compareVersions(version, linker) >= 0]).toEqual(
                [dll, version, native, linker, true],
              );
            }
            const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
            hashes.set(dll, new Set([...(hashes.get(dll) ?? []), hash]));
          }
        }
        for (const [dll, distinct] of hashes) expect([dll, distinct.size]).toEqual([dll, 1]);
      },
    );

    // The release signs only the listed files; every other keeps the signature it came with, and
    // the only ones vetted are Microsoft's.
    test.skipIf(target !== "win32-x64")(
      "has each .node and .dll, Electron's included, signed by Microsoft or listed to sign",
      async () => {
        const listed: string[] = JSON.parse(
          readFileSync(join(stageDir(target), UNSIGNED_PE_FILE), "utf8"),
        );
        expect(listed).toEqual([...new Set(listed)].sort());
        const pes = [...peFilesIn(payload), ...peFilesInZip(await electronZip(), "Eidolon")];
        const neither = pes
          .filter(
            ([name, { signer }]) =>
              !listed.includes(name) && !MICROSOFT_SIGNERS.includes(signer ?? ""),
          )
          .map(
            ([name, { signed, signer }]) =>
              `${name}: ${signed ? (signer ?? "unreadable") : "unsigned"}`,
          );
        expect(neither).toEqual([]);
      },
      120_000,
    );

    // An app packaged before the last stage holds an older payload.
    const packaged = join(PACKAGED[target], "eidolon");
    const repackaged =
      staged && existsSync(packaged) && statSync(packaged).mtimeMs >= statSync(payload).mtimeMs;
    test.skipIf(!repackaged)("is what the app packaged after it holds, file for file", () => {
      expect(listing(packaged).files).toEqual(listing(payload).files);
      if (process.platform !== "win32") {
        for (const name of POSIX_LAUNCHERS) {
          const mode = statSync(join(packaged, NODE_SHIM, "bin", name)).mode & 0o777;
          expect([name, mode]).toEqual([name, 0o755]);
        }
      }
    });
  });
}
