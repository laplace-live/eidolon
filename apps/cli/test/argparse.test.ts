import { describe, expect, test } from "bun:test";
import {
  ArgparseExit,
  ArgumentTypeError,
  EVAL_PARSER,
  FROMISOFORMAT,
  generateImageParser,
  INT,
  type Namespace,
  PATH,
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

// The goldens default --db-path to data/lancedb, where these commands leave it unset and open the
// persona's index, and --queries to data/eval/queries.toml, where they read the eval set among the
// persona's sources in the data home.
const PYTHON_DEFAULTS: Record<string, string> = {
  db_path: "data/lancedb",
  queries: "data/eval/queries.toml",
};
const HELP_LINES: [string, string][] = [
  ["LanceDB dir (default: data/lancedb)", "LanceDB dir (default: the persona's index/)"],
  [
    "LanceDB directory (default: data/lancedb)",
    "LanceDB directory (default: the persona's index/)",
  ],
  [
    "entries (default:\n                        data/eval/queries.toml)",
    "entries (default: the persona's\n                        eval/queries.toml in the data home's sources)",
  ],
];

function withPortDefaults(argv: string[], expected: Omit<Case, "argv">): Omit<Case, "argv"> {
  const help = (text: string) =>
    HELP_LINES.reduce((out, [from, to]) => out.replace(from, to), text);
  let ns = expected.ns;
  for (const [dest, value] of Object.entries(PYTHON_DEFAULTS)) {
    if (ns && ns[dest] === value && !argv.includes(value)) ns = { ...ns, [dest]: null };
  }
  return { ...expected, stdout: help(expected.stdout), stderr: help(expected.stderr), ns };
}

function expectGoldens(cases: Case[], parse: (argv: string[]) => Namespace): void {
  for (const { argv, ...expected } of cases) {
    expect({ argv, ...outcome(() => parse(argv)) }).toEqual({
      argv,
      ...withPortDefaults(argv, expected),
    });
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

// fixtures/goldens/argparse-features.json pins Python 3.13 argparse's results for this parser:
// paths (nargs="*", type=Path), --no-auto-slice (store_false, dest="auto_slice"), --files
// (nargs="*"), --stages (a type raising ArgumentTypeError) and --out (type=Path).
const FEATURES_USAGE = `usage: prog [-h] [--no-auto-slice] [--files [FILES ...]] [--stages STAGES]
            [--out OUT]
            [paths ...]
`;
const STAGES = {
  name: "stages",
  parse(text: string): string[] {
    const names = text.split(",").map((s) => s.trim());
    const bad = names.filter((n) => !["download", "transcribe"].includes(n));
    if (bad.length > 0) throw new ArgumentTypeError(`Unknown stage(s): ${bad.join(", ")}`);
    return names;
  },
};
const FEATURES: ParserSpec = {
  prog: "prog",
  usage: FEATURES_USAGE,
  help: FEATURES_USAGE,
  actions: [
    { dest: "paths", flags: [], kind: "store", nargs: "*", type: PATH },
    { dest: "auto_slice", flags: ["--no-auto-slice"], kind: "store_false" },
    { dest: "files", flags: ["--files"], kind: "store", nargs: "*" },
    { dest: "stages", flags: ["--stages"], kind: "store", type: STAGES },
    { dest: "out", flags: ["--out"], kind: "store", type: PATH },
  ],
};

test("store_false, nargs '*', ArgumentTypeError and type=Path parse as Python's", async () => {
  const cases = await golden<Omit<Case, "stdout">[]>("argparse-features.json");
  for (const { argv, ...expected } of cases) {
    const { stdout, ...got } = outcome(() => parseArgs(FEATURES, argv));
    expect(stdout).toBe("");
    expect({ argv, ...got }).toEqual({ argv, ...expected });
  }
});

test("a '*' positional with a default takes it when no value comes", () => {
  const spec: ParserSpec = {
    ...FEATURES,
    actions: [{ dest: "paths", flags: [], kind: "store", nargs: "*", default: ["x"] }],
  };
  expect(parseArgs(spec, []).paths).toEqual(["x"]);
});

test("parserError writes the usage, then `<prog>: error:`", () => {
  const spec: ParserSpec = { prog: "p", usage: "usage: p [-h]\n", help: "", actions: [] };
  const exit = parserError(spec, "boom");
  expect(exit.code).toBe(2);
  expect(exit.stdout).toBe("");
  expect(exit.stderr).toBe("usage: p [-h]\np: error: boom\n");
});
