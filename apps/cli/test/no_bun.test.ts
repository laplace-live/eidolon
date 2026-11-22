// Runtime code runs on Node: no Bun module, global or import.meta field reaches it. Biome bans the
// globals (noRestrictedGlobals); its boundary overrides own noRestrictedImports, so the imports, and
// import.meta's fields, are checked here.
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { withoutComments } from "./code.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const RUNTIME_DIRS = [
  "apps/bot/src",
  "apps/cli/src",
  "apps/desktop/src",
  "apps/eidolon/src",
  ...readdirSync(join(ROOT, "packages")).map((name) => `packages/${name}/src`),
];
const SKIPPED_DIRS = new Set(["node_modules", "dist", "pack"]);
const BUN_MODULE = String.raw`["']bun(?::[\w-]+)?["']`;
/** What Node lacks: Bun's modules, its globals, and import.meta's Bun-only fields. */
const BANNED = new RegExp(
  [
    String.raw`\b(?:from|import)\s*${BUN_MODULE}`,
    String.raw`\b(?:import|require)\s*\(\s*${BUN_MODULE}\s*\)`,
    String.raw`(?<![.\w$])Bun\s*[.[]`,
    String.raw`(?<![.\w$])HTMLRewriter\b`,
    String.raw`\bimport\.meta\.(?:dir|path)\b`,
  ].join("|"),
  "g",
);

function sourceFiles(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.isFile() && /\.(?:[cm]?ts|tsx|[cm]?js)$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** Each banned use in `source`, as `line: text`. */
function bunUses(source: string): string[] {
  const code = withoutComments(source);
  return [...code.matchAll(BANNED)].map((match) => {
    const line = code.slice(0, match.index).split("\n").length;
    return `${line}: ${match[0]}`;
  });
}

describe("no runtime code needs Bun", () => {
  test("a Bun module, global or import.meta field is flagged; a comment that names one isn't", () => {
    for (const source of [
      `import { Database } from "bun:sqlite";`,
      `import type { Server } from "bun";`,
      `const { dlopen } = await import("bun:ffi");`,
      "const id = Bun.randomUUIDv7();",
      'const yaml = Bun["YAML"];',
      "const rewriter = new HTMLRewriter();",
      "const root = import.meta.dir;",
      "const self = import.meta.path;",
      "const re = /[\"'`]/; const id = Bun.randomUUIDv7();",
      "if (x) return /\\/\\//.test(s) && Bun.which(s);",
      `const t = \`\${a / b}\`; Bun.sleep(1);`,
      `const t = \`child: \${JSON.stringify(x)} await Bun.sleep(1)\`;`,
    ]) {
      expect([source, bunUses(source).length]).toEqual([source, 1]);
    }
    for (const source of [
      "// Bun.spawn threw where Node reports a tick later.",
      "/** As Bun.serve did, with HTMLRewriter's callbacks and import.meta.dir. */",
      "const root = import.meta.dirname; const self = import.meta.filename;",
      "if (process.versions.bun !== undefined) refuse();",
      "const bunny = obj.Bun.x; const half = a / b / c; // Bun.sleep",
      'const text = "/* not a comment */" + x; // HTMLRewriter',
      "const re = /\\/\\/ Bun.sleep/; // Bun.file",
    ]) {
      expect([source, bunUses(source)]).toEqual([source, []]);
    }
  });

  test("apps/{bot,cli,desktop,eidolon}/src and packages/*/src use no Bun module, global or field", () => {
    const files = RUNTIME_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir)));
    expect(files.length).toBeGreaterThan(300);
    const offenders = files.flatMap((file) =>
      bunUses(readFileSync(file, "utf8")).map((use) => `${relative(ROOT, file)}:${use}`),
    );
    expect(offenders).toEqual([]);
  });
});
