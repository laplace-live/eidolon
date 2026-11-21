// The payloads staged in apps/desktop/.stage (`bun run build:desktop` stages this machine's): what
// each holds, pinned to bun.lock and pruned, its natives loading from it, and the packaged app
// holding it file for file. A target with no stage skips, unless EIDOLON_REQUIRE_STAGE=1 and it is
// this machine's.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { packageManifest } from "../../eidolon/scripts/build.ts";
import { PLATFORMS } from "../../eidolon/src/launcher.ts";
import { lockDrift, lockedTree, pinOverrides, readBunLock } from "../scripts/lockfile.ts";
import { checkNatives } from "../scripts/natives.ts";
import {
  LICENSES_FILE,
  npmLs,
  payloadDir,
  TARGETS,
  type Target,
} from "../scripts/stage-backend.ts";

const ROOT = join(import.meta.dirname, "../../..");
const DESKTOP = join(ROOT, "apps", "desktop");
const REQUIRED = process.env.EIDOLON_REQUIRE_STAGE === "1";
const HOST = `${process.platform}-${process.arch}`;
/** Where electron-builder puts each target's payload in the unpacked app. */
const PACKAGED: Record<Target, string> = {
  "darwin-arm64": join(DESKTOP, ".out", "mac-arm64", "Eidolon.app", "Contents", "Resources"),
};

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

for (const target of Object.keys(TARGETS) as Target[]) {
  const payload = payloadDir(target);
  const staged = existsSync(payload);
  const { os, cpu, onnxruntime } = TARGETS[target];
  const modules = join(payload, "node_modules");

  describe.skipIf(!staged && !(REQUIRED && target === HOST))(`the ${target} payload`, () => {
    test("holds what the npm package does, its node_modules and their licenses, and no links", () => {
      expect(staged, `no stage at ${payload}: run bun run build:desktop`).toBe(true);
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
      const manifest = JSON.parse(readFileSync(join(payload, "package.json"), "utf8"));
      const npm = packageManifest();
      const roots = { ...npm.dependencies, ...npm.optionalDependencies };
      expect(manifest).toEqual({
        ...npm,
        overrides: pinOverrides(lockedTree(readBunLock(join(ROOT, "bun.lock")), roots).values()),
      });
      const licenses = readFileSync(join(payload, LICENSES_FILE), "utf8");
      for (const name of [
        "onnxruntime-node",
        "sharp",
        "werift",
        "apache-arrow",
        PLATFORMS[target],
      ]) {
        expect([name, licenses.includes(`\n${name} `)]).toEqual([name, true]);
      }
    });

    test("is the tree bun.lock pins, as npm ls shows it", () => {
      expect(lockDrift(npmLs(payload), readBunLock(join(ROOT, "bun.lock")), { os, cpu })).toEqual(
        [],
      );
    }, 60_000);

    test("keeps only the target's onnxruntime binding and the library it loads", () => {
      const bin = join(modules, "onnxruntime-node", "bin", "napi-v6");
      expect(readdirSync(bin)).toEqual([os]);
      expect(readdirSync(join(bin, os))).toEqual([cpu]);
      expect(readdirSync(join(bin, os, cpu)).sort()).toEqual([...onnxruntime].sort());
    });

    test.skipIf(target !== HOST)(
      "loads its natives from itself: a LanceDB table, a Silero session, a JPEG",
      () => {
        const report = checkNatives(payload, PLATFORMS[target], { command: process.execPath });
        expect(report).toMatchObject({ rows: 2, image: "jpeg 2x1" });
        expect(report.speech).toBeGreaterThanOrEqual(0);
        expect(report.speech).toBeLessThanOrEqual(1);
        const home = realpathSync(payload);
        const natives = report.loaded.filter((path) => /\.(node|dylib)$/.test(path));
        for (const name of ["lancedb", "onnxruntime_binding", "sharp-", "vips"]) {
          expect([name, natives.some((path) => basename(path).includes(name))]).toEqual([
            name,
            true,
          ]);
        }
        expect(natives.filter((path) => !realpathSync(path).startsWith(home))).toEqual([]);
      },
      60_000,
    );

    // An app packaged before the last stage holds an older payload.
    const packaged = join(PACKAGED[target], "eidolon");
    const repackaged =
      staged && existsSync(packaged) && statSync(packaged).mtimeMs >= statSync(payload).mtimeMs;
    test.skipIf(!repackaged)("is what the app packaged after it holds, file for file", () => {
      expect(listing(packaged).files).toEqual(listing(payload).files);
    });
  });
}
