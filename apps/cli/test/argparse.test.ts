import { describe, expect, test } from "bun:test";
import {
  ArgparseExit,
  EVAL_PARSER,
  FROMISOFORMAT,
  generateImageParser,
  INT,
  type Namespace,
  type ParserSpec,
  parseArgs,
  parserError,
  parseSearchArgs,
  SEARCH_PARSER,
} from "../src/index.ts";
import { golden } from "./helpers.ts";

interface Case {
  argv: string[];
  code: number | "parsed";
  stdout: string;
  stderr: string;
  ns: Namespace | null;
}

const goldens = await golden<Record<"search" | "eval" | "genimg", Case[]>>("argparse.json");

function outcome(parse: () => Namespace): Omit<Case, "argv"> {
  try {
    const ns = parse();
    if (typeof ns.today === "string") ns.today = { date: ns.today };
    return { code: "parsed", stdout: "", stderr: "", ns };
  } catch (error) {
    if (!(error instanceof ArgparseExit)) throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr, ns: null };
  }
}

function expectGoldens(cases: Case[], parse: (argv: string[]) => Namespace): void {
  for (const { argv, ...expected } of cases) {
    expect({ argv, ...outcome(() => parse(argv)) }).toEqual({ argv, ...expected });
  }
}

describe("argparse parity with Python 3.13", () => {
  test("laplace-search: namespaces, --today rule, errors, help", () => {
    expectGoldens(goldens.search, (argv) => {
      parseSearchArgs(argv);
      return parseArgs(SEARCH_PARSER, argv);
    });
  });

  test("laplace-eval-retrieval: nargs '+', choices, BooleanOptionalAction, abbreviations", () => {
    expectGoldens(goldens.eval, (argv) => parseArgs(EVAL_PARSER, argv));
  });

  test("laplace-generate-image: appends, short-option clusters, friend choices", () => {
    expectGoldens(goldens.genimg, (argv) => parseArgs(generateImageParser(["七海Nana7mi"]), argv));
  });

  test("--friend takes anything when no friend images exist", () => {
    const ns = parseArgs(generateImageParser([]), ["--friend", "x"]);
    expect(ns.friend).toEqual(["x"]);
  });
});

describe("types", () => {
  test("int() accepts whitespace, signs, underscores and any decimal digit", () => {
    expect(INT.parse(" 1_0 ")).toBe(10);
    expect(INT.parse("-3")).toBe(-3);
    expect(INT.parse("+4")).toBe(4);
    expect(INT.parse("５")).toBe(5);
    expect(INT.parse("٢٠")).toBe(20);
    for (const bad of ["", "1__0", "_1", "1.0", "1e3", "abc"]) {
      expect(() => INT.parse(bad)).toThrow();
    }
  });

  test("date.fromisoformat reads the C parser's grammar", () => {
    expect(FROMISOFORMAT.parse("2026-09-09")).toBe("2026-09-09");
    expect(FROMISOFORMAT.parse("20260909")).toBe("2026-09-09");
    expect(FROMISOFORMAT.parse("2026-W37-3")).toBe("2026-09-09");
    expect(FROMISOFORMAT.parse("2026W37")).toBe("2026-09-07");
    expect(FROMISOFORMAT.parse("20260909xx")).toBe("2026-09-09");
    expect(FROMISOFORMAT.parse("2020-W53-7")).toBe("2021-01-03");
    expect(FROMISOFORMAT.parse("0001-W01-1")).toBe("0001-01-01");
    for (const bad of [
      "2026-13-01",
      "2026-9-9",
      "2026-W53-1x",
      "2021-W53-1",
      "9999-W52-6",
      "0000-01-01",
    ]) {
      expect(() => FROMISOFORMAT.parse(bad)).toThrow();
    }
  });
});

test("parserError writes the usage, then `<prog>: error:`", () => {
  const spec: ParserSpec = { prog: "p", usage: "usage: p [-h]\n", help: "", actions: [] };
  const exit = parserError(spec, "boom");
  expect(exit.code).toBe(2);
  expect(exit.stdout).toBe("");
  expect(exit.stderr).toBe("usage: p [-h]\np: error: boom\n");
});
