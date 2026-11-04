import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_USAGE, COMMANDS, runCli } from "../src/index.ts";
import { blockNetwork, captureIo, captureLogs } from "./helpers.ts";

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

test("one command per Python CLI", () => {
  expect(Object.keys(COMMANDS)).toEqual([
    "search",
    "eval-retrieval",
    "generate-image",
    "gate-decisions",
  ]);
});

test("no command, or an unknown one, is a usage error", async () => {
  for (const [argv, message] of [
    [[], "the following arguments are required: command"],
    [
      ["serach"],
      "argument command: invalid choice: 'serach' (choose from search, eval-retrieval, generate-image, gate-decisions)",
    ],
    [
      ["toString"],
      "argument command: invalid choice: 'toString' (choose from search, eval-retrieval, generate-image, gate-decisions)",
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

test("main.ts loads .env before any other module is evaluated", async () => {
  const source = await Bun.file(join(import.meta.dir, "../src/main.ts")).text();
  const imports = source.split("\n").filter((line) => line.startsWith("import "));
  expect(imports[0]).toBe('import "./load-env.ts";');
});
