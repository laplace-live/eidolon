// fixtures/extract_users/golden.json is tools/extract_users.py's main() over the exports beside
// it, with types 1 and 3 labelled gift and SC as the port labels them; fixtures/transcribe's
// parser.golden.json is argparse running the port's parser.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { extractUsers } from "@eidolon/ingest";
import { ArgparseExit, parseArgs } from "../src/argparse.ts";
import { runCli } from "../src/cli.ts";
import { EXTRACT_USERS_PARSER, extractUsersMain } from "../src/extract_users.ts";
import { captureIo } from "./helpers.ts";

const FIX = join(import.meta.dir, "fixtures/extract_users");

interface RunCase {
  argv: string[];
  code: number;
  raised: string | null;
  stdout: string;
  stderr: string;
}

interface ParseCase {
  argv: string[];
  code: number | "parsed";
  stdout?: string;
  stderr?: string;
  ns?: Record<string, unknown>;
}

const golden = (await Bun.file(join(FIX, "golden.json")).json()) as { cases: RunCase[] };
const parser = (await Bun.file(
  join(import.meta.dir, "fixtures/transcribe/parser.golden.json"),
).json()) as {
  extract_users: ParseCase[];
};

let signal: AbortController;
beforeEach(() => {
  signal = new AbortController();
});
afterEach(() => {
  signal.abort();
});

test("the parser is argparse's, --types errors included", () => {
  for (const c of parser.extract_users) {
    let got: ParseCase;
    try {
      const ns = parseArgs(EXTRACT_USERS_PARSER, c.argv);
      const types = ns.types as ReadonlySet<number> | null;
      got = {
        argv: c.argv,
        code: "parsed",
        ns: { ...ns, types: types === null ? null : [...types].sort((a, b) => a - b) },
      };
    } catch (error) {
      if (!(error instanceof ArgparseExit)) throw error;
      got = { argv: c.argv, code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    expect(got).toEqual(c);
  }
});

test("every run prints Python's names on stdout and Python's report on stderr", async () => {
  for (const c of golden.cases) {
    const argv = [join(FIX, c.argv[0] as string), ...c.argv.slice(1)];
    const io = captureIo();
    const code = await runCli(["extract-users", ...argv], { ...io.io, signal: signal.signal });
    const stderr = io.stderr().replaceAll(FIX, "<FIX>");
    expect([c.argv, code, io.stdout()]).toEqual([c.argv, c.code, c.stdout]);
    if (c.raised === null) {
      expect([c.argv, stderr]).toEqual([c.argv, c.stderr]);
    } else {
      // A traceback in Python; the port's uncaught error prints its stack after the same lines.
      expect(stderr.startsWith(c.stderr)).toBe(true);
      expect(stderr).toContain(c.raised);
    }
  }
});

test("a signal before parsing stops the run", async () => {
  signal.abort();
  const io = captureIo();
  expect(
    await extractUsersMain([join(FIX, "danmakus.json")], { ...io.io, signal: signal.signal }),
  ).toBe(1);
  expect(io.stdout()).toBe("");
});

test("float sums are Python's, Neumaier-compensated", () => {
  expect(extractUsers.pySumFloats([1e16, 1, -1e16, 0.5, 2.5])).toBe(4);
  expect(extractUsers.pySumFloats([0.1, 0.2, 0.3])).toBe(0.6);
  expect(extractUsers.pySumFloats([])).toBe(0);
});
