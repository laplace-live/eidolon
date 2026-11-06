import "../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliEntry, dataHome, personaIds, resetSettings, sourceFolder } from "@eidolon/config";
import { CLEANUP_LIMIT_MS } from "@eidolon/ingest";
import {
  buildStreamCatalogMain,
  CLI_USAGE,
  COMMANDS,
  cleanupLimitMs,
  commandPersona,
  downloadMain,
  EVAL_PARSER,
  extractUsersMain,
  ingestFactsMain,
  ingestStreamsMain,
  jobArgv,
  personaArg,
  pipelineMain,
  prepareBatchMain,
  refineMain,
  runCli,
  transcribeMain,
} from "../src/index.ts";
import { blockNetwork, captureIo, captureLogs, setEnv, spawnCli } from "./helpers.ts";

blockNetwork();

let work = "";
let logs!: ReturnType<typeof captureLogs>;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "cli-dispatch-"));
  logs = captureLogs();
});
afterEach(() => {
  logs.stop();
  rmSync(work, { recursive: true, force: true });
});

const NEW_COMMANDS = {
  download: downloadMain,
  transcribe: transcribeMain,
  refine: refineMain,
  "ingest-streams": ingestStreamsMain,
  "ingest-facts": ingestFactsMain,
  "build-stream-catalog": buildStreamCatalogMain,
  pipeline: pipelineMain,
  "extract-users": extractUsersMain,
  "prepare-batch": prepareBatchMain,
};

test("one command per Python CLI, each run by its own module", () => {
  expect(Object.keys(COMMANDS)).toEqual([
    "search",
    "eval-retrieval",
    "generate-image",
    "gate-decisions",
    ...Object.keys(NEW_COMMANDS),
  ]);
  for (const [name, main] of Object.entries(NEW_COMMANDS)) expect(COMMANDS[name], name).toBe(main);
});

test("every command has its root script", async () => {
  const { scripts } = (await Bun.file(join(import.meta.dir, "../../../package.json")).json()) as {
    scripts: Record<string, string>;
  };
  for (const name of Object.keys(NEW_COMMANDS)) {
    expect(scripts[`laplace-${name}`]).toBe(`bun apps/cli/src/main.ts ${name}`);
  }
});

test("Ctrl-C quits a command that never reads its signal at once; the others get time to stop", () => {
  const ignoring = [
    "search",
    "eval-retrieval",
    "generate-image",
    "gate-decisions",
    "prepare-batch",
  ];
  for (const name of ignoring) {
    expect(cleanupLimitMs([name, "--help"]), name).toBe(0);
  }
  for (const name of Object.keys(NEW_COMMANDS).filter((name) => !ignoring.includes(name))) {
    expect(cleanupLimitMs([name, "--help"]), name).toBe(CLEANUP_LIMIT_MS);
  }
});

test("the signal reaches the command", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const original = COMMANDS.download;
  (COMMANDS as Record<string, unknown>).download = async (
    _argv: readonly string[],
    deps: { signal?: AbortSignal },
  ) => {
    seen = deps.signal;
    return 0;
  };
  try {
    expect(await runCli(["download"], { signal: controller.signal })).toBe(0);
  } finally {
    (COMMANDS as Record<string, unknown>).download = original;
  }
  expect(seen).toBe(controller.signal);
});

test("no command, or an unknown one, is a usage error", async () => {
  for (const [argv, message] of [
    [[], "the following arguments are required: command"],
    [
      ["serach"],
      `argument command: invalid choice: 'serach' (choose from ${Object.keys(COMMANDS).join(", ")})`,
    ],
    [
      ["toString"],
      `argument command: invalid choice: 'toString' (choose from ${Object.keys(COMMANDS).join(", ")})`,
    ],
  ] as const) {
    const io = captureIo();
    expect(await runCli(argv, io.io)).toBe(2);
    expect(io.stderr()).toBe(`${CLI_USAGE}main.ts: error: ${message}\n`);
  }
});

test("-h lists the commands", async () => {
  const io = captureIo();
  expect(await runCli(["--help"], io.io)).toBe(0);
  expect(io.stdout()).toStartWith(CLI_USAGE);
  expect(io.stdout()).toContain("laplace-eval-retrieval");
  expect(io.stdout()).toContain("\n    prepare-batch       laplace-prepare-batch\n");
});

test("a command's own -h and usage errors keep their exit codes", async () => {
  const help = captureIo();
  expect(await runCli(["search", "-h"], help.io)).toBe(0);
  expect(help.stdout()).toStartWith("usage: laplace-search [-h]");
  const usage = captureIo();
  expect(await runCli(["generate-image", "-n", "x"], usage.io)).toBe(2);
  expect(usage.stderr()).toEndWith(
    "laplace-generate-image: error: argument -n: invalid int value: 'x'\n",
  );
});

test("an uncaught error is the traceback's equivalent: its stack on stderr, exit 1", async () => {
  const io = captureIo();
  const code = await runCli(["eval-retrieval", "--queries", join(work, "missing.toml")], io.io);
  expect(code).toBe(1);
  expect(io.stderr()).toStartWith(
    `FileNotFoundError: Queries file not found: ${join(work, "missing.toml")}\n`,
  );
});

test("eval-retrieval reports an empty post-filter set and exits 1", async () => {
  const queries = join(work, "q.toml");
  writeFileSync(
    queries,
    '[[query]]\ntable = "persona_facts"\ntext = "x"\nexpect_substrings = ["x"]\n',
  );
  const io = captureIo();
  expect(
    await runCli(["eval-retrieval", "--queries", queries, "--table", "stream_chunks"], io.io),
  ).toBe(1);
  expect(logs.records).toEqual([["ERROR", "No queries to evaluate (post-filter)."]]);
});

test("eval-retrieval's queries default to the persona's eval sources", async () => {
  const io = captureIo();
  expect(await runCli(["eval-retrieval"], io.io)).toBe(1);
  const path = join(sourceFolder("milky-green", "eval"), "queries.toml");
  expect(logs.records).toEqual([
    ["ERROR", `Queries file not found: ${path}. Pass --queries <file>.`],
  ]);
});

test("main.ts loads .env before any other module is evaluated, then logs to stderr", async () => {
  const source = await Bun.file(join(import.meta.dir, "../src/main.ts")).text();
  const imports = source.split("\n").filter((line) => line.startsWith("import "));
  expect(imports[0]).toBe('import "./load-env.ts";');
  expect(source).toContain("logToStderr();");
  expect(source).toContain("const argv = Bun.argv.slice(2);");
  expect(source).toContain(
    "await runWithSignals(\n  (signal) => runCli(argv, { signal }),\n  process,\n  cleanupLimitMs(argv),\n);",
  );
});

test("load-env.ts installs the settings for the persona --persona names", async () => {
  const source = await Bun.file(join(import.meta.dir, "../src/load-env.ts")).text();
  expect(source.indexOf("personaArg(Bun.argv.slice(2))")).toBeGreaterThan(-1);
  expect(source.indexOf("personaArg(")).toBeLessThan(source.indexOf("installSettings();"));
});

describe("--persona", () => {
  test("personaArg reads it as argparse stores it", () => {
    const cases: [string[], string | undefined][] = [
      [["refine", "--persona", "a"], "a"],
      [["refine", "--persona=b"], "b"],
      [["refine", "--persona", "a", "--persona", "b"], "b"],
      [["refine", "--", "--persona", "a"], undefined],
      [["refine", "--persona"], undefined],
      [["refine", "--persona", "-x"], undefined],
      [["refine", "--persona="], undefined],
      [["refine", "--personas", "a"], undefined],
      [["refine", "x.md"], undefined],
    ];
    for (const [argv, expected] of cases)
      expect([argv, personaArg(argv)]).toEqual([argv, expected]);
  });

  test("commandPersona refuses a --persona other than the one installed", () => {
    expect(commandPersona(EVAL_PARSER, null)).toBe("milky-green");
    expect(commandPersona(EVAL_PARSER, "milky-green")).toBe("milky-green");
    expect(() => commandPersona(EVAL_PARSER, "other")).toThrow(
      expect.objectContaining({
        code: 2,
        stderr: expect.stringContaining(
          "error: argument --persona: write --persona other in full\n",
        ),
      }),
    );
  });

  test("commandPersona refuses a persona with no folder, in the data home or the templates", () => {
    const folder = join(dataHome(), "personas", "other");
    const restore = setEnv({ EIDOLON_PERSONA: "other" });
    try {
      resetSettings();
      // Named or only active, a typo would start a new persona's sources and index.
      for (const value of ["other", null]) {
        expect(() => commandPersona(EVAL_PARSER, value)).toThrow(
          expect.objectContaining({
            code: 2,
            stderr: expect.stringContaining(
              "error: argument --persona: unknown persona 'other' " +
                `(choose from ${personaIds().join(", ")})\n`,
            ),
          }),
        );
      }
      mkdirSync(folder, { recursive: true });
      expect(commandPersona(EVAL_PARSER, "other")).toBe("other");
    } finally {
      rmSync(folder, { recursive: true, force: true });
      restore();
      resetSettings();
    }
  });

  test("a real run with a misspelt --persona exits 2 before it reads or writes anything", async () => {
    const child = spawnCli(["ingest-facts", "--persona", "milky-gren", "--json"]);
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toEndWith(
      "laplace-ingest-facts: error: argument --persona: unknown persona 'milky-gren' " +
        `(choose from ${personaIds().join(", ")})\n`,
    );
    expect(existsSync(join(dataHome(), "personas", "milky-gren"))).toBe(false);
  }, 20_000);
});

/** Every import or re-export statement in `source`, type-only ones included. */
function importStatements(source: string): string[] {
  return (
    source.match(
      /^\s*(?:import\s[^;]*?from\s*["'][^"']*["']|import\s*["'][^"']*["']|export\s[^;]*?from\s*["'][^"']*["'])/gm,
    ) ?? []
  );
}

test("@eidolon/cli/job and @eidolon/ingest/progress are import-free leaves the web app can import", async () => {
  const manifest = await Bun.file(join(import.meta.dir, "../package.json")).json();
  expect(manifest.exports["./job"]).toBe("./src/job.ts");
  const progress = Bun.resolveSync("@eidolon/ingest/progress", import.meta.dir);
  expect(progress).toEndWith(join("packages", "ingest", "src", "progress.ts"));
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const path of [join(import.meta.dir, "../src/job.ts"), progress]) {
    const source = await Bun.file(path).text();
    expect(transpiler.scanImports(source), path).toEqual([]);
    expect(importStatements(source), path).toEqual([]);
  }
  // The check itself: a type-only import counts too.
  expect(importStatements('import type { A } from "a";\nexport { b } from "b";')).toHaveLength(2);
});

test("a job runs the CLI without a .env from its folder and reports NDJSON", () => {
  expect(jobArgv(cliEntry(), "refine", ["--persona", "milky-green"])).toEqual([
    process.execPath,
    "--no-env-file",
    cliEntry(),
    "refine",
    "--json",
    "--persona",
    "milky-green",
  ]);
});
