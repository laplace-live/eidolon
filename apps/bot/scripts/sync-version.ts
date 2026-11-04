// Copies apps/bot/package.json's version, which changesets bumps, into every other place the bot
// states it. Run by `bun run version` after `changeset version`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Each file and the one pattern in it whose first group is the version. */
export const VERSION_SITES: readonly (readonly [string, RegExp])[] = [
  ["pyproject.toml", /^version = "([^"]+)"$/m],
  ["uv.lock", /^name = "laplace-eidolon"\nversion = "([^"]+)"$/m],
  ["laplace_eidolon/bot.py", /"library_version": "([^"]+)"/],
  ["packages/runtime/src/rtvi.ts", /library_version: "([^"]+)"/],
];

export function botVersion(root: string): string {
  const manifest = JSON.parse(readFileSync(join(root, "apps/bot/package.json"), "utf8"));
  return manifest.version as string;
}

/** Rewrites every site to `version`; throws if a pattern no longer matches, so drift can't pass. */
export function syncVersion(root: string, version = botVersion(root)): string[] {
  const changed: string[] = [];
  for (const [file, pattern] of VERSION_SITES) {
    const path = join(root, file);
    const text = readFileSync(path, "utf8");
    const match = pattern.exec(text);
    if (match === null) throw new Error(`${file}: no version matching ${pattern}`);
    if (match[1] === version) continue;
    const start = match.index + match[0].indexOf(match[1] as string);
    writeFileSync(
      path,
      text.slice(0, start) + version + text.slice(start + (match[1] as string).length),
    );
    changed.push(file);
  }
  return changed;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "../../..");
  for (const file of syncVersion(root)) console.log(`${file} → ${botVersion(root)}`);
}
