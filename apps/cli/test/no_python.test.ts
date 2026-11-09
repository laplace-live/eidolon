// The Python in this repository is for human readers only (AGENTS.md, "The Python"): no TypeScript
// under apps/ or packages/ runs it, and no agent-facing doc names it or says how to run it outside
// that rule.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const SELF = relative(ROOT, import.meta.path);
/** uv, uvx, pytest, or python, versioned or not: `python3`, `python3.13`. */
const COMMANDS = String.raw`(?:uvx?|pytest|python(?:\d+(?:\.\d+)*)?)(?![\w.-])`;
/** A string that is one of the commands: `Bun.which("uv")`, `[UV, "run", "python", script]`. */
const COMMAND_STRING = new RegExp(`(["'\`])${COMMANDS}\\1`);
/** A Bun shell template that runs one. */
const SHELL = new RegExp(`\\$\`\\s*${COMMANDS}`);
const SPAWN = /\b(?:exec|execFile|execFileSync|execSync|fork|spawn|spawnSync)\s*\(/g;
/** In a spawn's arguments: a `.py` path, or a command line that starts with one of the commands. */
const PYTHON_ARGUMENT = new RegExp(`["'\`][^"'\`\\n]*[\\w-]\\.py\\b|["'\`]${COMMANDS}\\s`);
/** The Python's package, any `.py` file, or a command line that runs it. */
const NAMES_PYTHON = new RegExp(
  [
    "laplace_eidolon",
    String.raw`[\w*-]\.py\b`,
    String.raw`\buv\s+(?:run|sync)\b`,
    String.raw`\b(?:uvx|pytest)\b`,
    String.raw`\bpython(?:\d+(?:\.\d+)*)?\s+-m\b`,
    String.raw`\bpython3(?:\.\d+)*\s+\S`,
  ].join("|"),
);
const SKIPPED_DIRS = new Set(["node_modules", "dist", "pack"]);
const TRANSPILERS = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

function typescriptFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...typescriptFiles(path));
    else if (entry.isFile() && /\.(ts|tsx|mts)$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** From `open`, the `(`, to its matching `)`, in code that holds no comments. */
function callArguments(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return code.slice(open, i + 1);
  }
  return code.slice(open);
}

/** What in `source` runs the Python: a command string, a shell template, a spawn's argument. */
function pythonRuns(source: string, loader: keyof typeof TRANSPILERS = "ts"): string[] {
  // Transpiled, so comments and types are gone and only code is checked.
  const code = TRANSPILERS[loader].transformSync(source);
  const found: string[] = [];
  const command = COMMAND_STRING.exec(code) ?? SHELL.exec(code);
  if (command) found.push(command[0]);
  for (const call of code.matchAll(SPAWN)) {
    const named = PYTHON_ARGUMENT.exec(callArguments(code, call.index + call[0].length - 1));
    if (named) found.push(`${call[0]}… ${named[0]}`);
  }
  return found;
}

/** The lines AGENTS.md may name the Python on: its rule, and the layout's one line. */
function allowedAgentsLines(lines: readonly string[]): Set<number> {
  const allowed = new Set<number>();
  const rule = lines.indexOf("### The Python");
  expect(rule, "AGENTS.md has no ### The Python section").toBeGreaterThan(-1);
  for (let i = rule; i < lines.length && !(i > rule && /^#{2,3} /.test(lines[i] as string)); i++) {
    allowed.add(i);
  }
  const layout = lines.flatMap((line, i) => (line.startsWith("laplace_eidolon/ ") ? [i] : []));
  expect(layout).toHaveLength(1);
  allowed.add(layout[0] as number);
  return allowed;
}

describe("no TypeScript runs the Python", () => {
  test("an exec, a versioned python and a uvx shell are flagged, a message that names it isn't", () => {
    for (const source of [
      `exec("uv run python x.py");`,
      `spawn(["python3.13", "-c", "print(1)"]);`,
      "await Bun.$`uvx ruff check .`;",
    ]) {
      expect([source, pythonRuns(source).length > 0]).toEqual([source, true]);
    }
    const message = `logger.warning("The Python is for human readers: uv run python bot.py");`;
    expect(pythonRuns(message)).toEqual([]);
  });

  test("nothing under apps/ or packages/ spawns uv, python or pytest, or hands a spawn a .py", () => {
    const offenders: string[] = [];
    const files = ["apps", "packages"].flatMap((dir) => typescriptFiles(join(ROOT, dir)));
    for (const file of files) {
      const path = relative(ROOT, file);
      if (path === SELF) continue;
      const source = readFileSync(file, "utf8");
      const runs = pythonRuns(source, path.endsWith(".tsx") ? "tsx" : "ts");
      offenders.push(...runs.map((run) => `${path}: ${run}`));
    }
    expect(files.length).toBeGreaterThan(500);
    expect(offenders).toEqual([]);
  });
});

describe("no agent-facing doc names the Python", () => {
  test("a run instruction is flagged, pyproject.toml and uv.lock aren't", () => {
    for (const line of [
      "uv run laplace-refine",
      "uv sync --extra tools",
      "uvx ruff check",
      "run pytest",
      "python -m venv .venv",
      "python3 bot",
      "python3.13 -c 1",
    ]) {
      expect([line, NAMES_PYTHON.test(line)]).toEqual([line, true]);
    }
    for (const line of ["writes `pyproject.toml` and `uv.lock`", "python-dotenv's rules"]) {
      expect([line, NAMES_PYTHON.test(line)]).toEqual([line, false]);
    }
  });

  test("AGENTS.md names it only in its rule and its one layout line", () => {
    const lines = readFileSync(join(ROOT, "AGENTS.md"), "utf8").split("\n");
    const allowed = allowedAgentsLines(lines);
    const naming = lines.flatMap((line, i) =>
      !allowed.has(i) && NAMES_PYTHON.test(line) ? [`AGENTS.md:${i + 1}: ${line}`] : [],
    );
    expect(naming).toEqual([]);
  });

  test("docs/*.md never names it; the benchmarks under docs/benchmarks/ are history", () => {
    const docs = readdirSync(join(ROOT, "docs")).filter((name) => name.endsWith(".md"));
    expect(docs.length).toBeGreaterThan(5);
    const naming = docs.flatMap((name) =>
      readFileSync(join(ROOT, "docs", name), "utf8")
        .split("\n")
        .flatMap((line, i) => (NAMES_PYTHON.test(line) ? [`docs/${name}:${i + 1}: ${line}`] : [])),
    );
    expect(naming).toEqual([]);
  });
});
