// A test file that deletes a path in the data home imports isolated-guard.ts first: run from a
// subfolder, vitest.config.ts's setup file is skipped and the data home is the developer's own.
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { spawnProcess } from "../src/index.ts";

const ROOT = join(import.meta.dirname, "../../..");
const GUARD = join(import.meta.dirname, "isolated-guard.ts");

/** What names the data home or a folder in it. */
const HOME =
  /\b(?:dataHome|personaHomeDir|personaFolders|sourceFolder|sourcesDir|binDir|embedCachePath|indexWritePath|EIDOLON_HOME)\b/;
/** The real-data tests' read-only corpus, which no guard covers. */
const REAL_HOME = /\bEIDOLON_REAL_HOME\b/;
const DELETE =
  /\b(?:rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink)\s*\(|\b(?:spawn(?:Sync|Process)?|execFile(?:Sync)?)\s*\(\s*\[?\s*["'`]rm["'`]|\$`rm\b/g;
const ASSIGN =
  /(?:\b(?:const|let|var)\s+|^[ \t]*|[;{][ \t]*)([A-Za-z_$][\w$]*)[ \t]*(?::[^=;\n]*)?=(?![=>])([^;]*)/gm;
const IDENTIFIER = /(?<![.\w$])[A-Za-z_$][\w$]*/g;

/** Every .ts file under an app's or a package's test/, but this one. */
function testFiles(): string[] {
  const files: string[] = [];
  for (const group of ["apps", "packages"]) {
    for (const name of readdirSync(join(ROOT, group))) {
      const dir = join(ROOT, group, name, "test");
      let entries: string[];
      try {
        entries = readdirSync(dir, { recursive: true }) as string[];
      } catch {
        continue;
      }
      for (const entry of entries) {
        const path = join(dir, entry);
        if (
          entry.endsWith(".ts") &&
          !entry.includes("node_modules") &&
          path !== import.meta.filename
        ) {
          files.push(path);
        }
      }
    }
  }
  return files.sort();
}

/**
 * The patterns among `tokens` that a deletion's arguments name, directly or through the variables
 * they were assigned from in the file. Comment lines are skipped; any assignment to a name counts.
 */
function deletedTokens(source: string, tokens: readonly RegExp[]): Set<RegExp> {
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join("\n");
  const assigned = new Map<string, string[]>();
  for (const [, name, value] of code.matchAll(ASSIGN)) {
    assigned.set(name as string, [...(assigned.get(name as string) ?? []), value as string]);
  }
  const names = (text: string, token: RegExp, seen: Set<string>): boolean =>
    token.test(text) ||
    [...text.matchAll(IDENTIFIER)].some(([id]) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return (assigned.get(id) ?? []).some((value) => names(value, token, seen));
    });
  const found = new Set<RegExp>();
  for (const match of code.matchAll(DELETE)) {
    const start = (match.index as number) + match[0].length;
    const end = code.indexOf(";", start);
    const args = code.slice(start, end === -1 ? undefined : end);
    for (const token of tokens) if (names(args, token, new Set())) found.add(token);
  }
  return found;
}

/** Whether the file's first import is isolated-guard.ts. */
function guardedFirst(path: string, source: string): boolean {
  const first = /^import\s+(?:[^"';]*\sfrom\s+)?["']([^"']+)["']/m.exec(source);
  return first !== null && resolve(dirname(path), first[1] as string) === GUARD;
}

describe("isolated-guard.ts", () => {
  test("every test file that deletes in the data home imports it first", () => {
    const unguarded: string[] = [];
    const deleting: string[] = [];
    for (const path of testFiles()) {
      const source = readFileSync(path, "utf8");
      const found = deletedTokens(source, [HOME, REAL_HOME]);
      if (found.has(REAL_HOME)) deleting.push(relative(ROOT, path));
      if (found.has(HOME) && !guardedFirst(path, source)) unguarded.push(relative(ROOT, path));
    }
    expect(unguarded).toEqual([]);
    // No guard covers the real corpus, so nothing may delete there at all.
    expect(deleting).toEqual([]);
  });

  test("the scan sees a deletion through the variables it was assigned from", () => {
    const flagged = (source: string) => deletedTokens(source, [HOME]).has(HOME);
    expect(flagged("rmSync(join(dataHome(), 'personas'), { force: true });")).toBe(true);
    expect(flagged("const p = () => join(dataHome(), 'x');\nafterEach(() => rmSync(p()));")).toBe(
      true,
    );
    expect(
      flagged("const home = process.env.EIDOLON_HOME;\nconst dir = join(home, 'a');\nrmSync(dir);"),
    ).toBe(true);
    expect(flagged("let dir = '';\ndir = mkdtempSync(join(tmpdir(), 'x'));\nrmSync(dir);")).toBe(
      false,
    );
    expect(flagged("Bun.spawn(['rm', '-rf', binDir()]);")).toBe(true);
    expect(flagged("spawnProcess(['rm', '-rf', binDir()]);")).toBe(true);
    expect(flagged("spawnSync('rm', ['-rf', binDir()]);")).toBe(true);
    expect(flagged("// rmSync(dataHome());\nrmSync(work);")).toBe(false);
  });

  test("it refuses an unset or foreign EIDOLON_HOME, and loads under its run's own", async () => {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (name !== "EIDOLON_HOME" && value !== undefined) env[name] = value;
    }
    const load = async (home: string | undefined, setup = "") => {
      const child = spawnProcess(
        [process.execPath, "-e", `${setup}await import(${JSON.stringify(GUARD)});`],
        {
          env: home === undefined ? env : { ...env, EIDOLON_HOME: home },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      return { code, stderr };
    };
    const unset = await load(undefined);
    expect(unset.code).not.toBe(0);
    expect(unset.stderr).toContain("Refusing to run: EIDOLON_HOME is unset, not this run's");
    for (const foreign of [join(tmpdir(), "elsewhere"), join(tmpdir(), "eidolon-test-home-1")]) {
      const refused = await load(foreign);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain(
        `Refusing to run: EIDOLON_HOME is ${JSON.stringify(foreign)}`,
      );
    }
    const own = await load(
      undefined,
      `process.env.EIDOLON_HOME = (await import("node:path")).join((await import("node:os")).tmpdir(), "eidolon-test-home-" + process.pid);`,
    );
    expect(own).toEqual({ code: 0, stderr: "" });
  }, 20_000);
});
