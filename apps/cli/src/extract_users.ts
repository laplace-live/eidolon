// laplace-extract-users: mines danmaku JSON for the viewer names a glossary should know. Stdout is
// one name per line, so it pipes straight into a file; the summary goes to stderr.
import { existsSync, statSync } from "node:fs";
import { pyFixed, pyJsonLoadsFast, thousands, utcIsoDate } from "@eidolon/config";
import { extractUsers } from "@eidolon/ingest";
import {
  ArgparseExit,
  type ArgType,
  ArgumentTypeError,
  commandPersona,
  INT,
  type Namespace,
  PATH,
  type ParserSpec,
  parseArgs,
} from "./argparse.ts";
import { type CommandDeps, printer, reportExit, resolveIo } from "./io.ts";

const USAGE = `usage: laplace-extract-users [-h] [-n TOP] [--types TYPES] [--persona PERSONA]
                             input
`;

const TYPES: ArgType<Set<number> | null> = {
  name: "_parse_types",
  parse(text: string) {
    try {
      return extractUsers.parseTypes(text);
    } catch (error) {
      throw new ArgumentTypeError((error as Error).message);
    }
  },
};

export const EXTRACT_USERS_PARSER: ParserSpec = {
  prog: "laplace-extract-users",
  usage: USAGE,
  help: `${USAGE}
Extract the top-N most-spoken usernames from a danmakus.com chat export.

positional arguments:
  input              Path to a danmakus.com JSON export.

options:
  -h, --help         show this help message and exit
  -n, --top TOP      How many top usernames to emit on stdout (default: 50).
  --types TYPES      Comma-separated message-type integers to include in the
                     ranking. Default '1,2,3' counts gifts, memberships and
                     super chats — the events where the streamer reads names
                     aloud. Pass 'all' to disable filtering, or e.g. '0,1,2,3'
                     to also include free chat.
  --persona PERSONA  Persona to run for (default: the active persona)
`,
  actions: [
    { dest: "input", flags: [], kind: "store", type: PATH },
    { dest: "top", flags: ["-n", "--top"], kind: "store", type: INT, default: 50 },
    {
      dest: "types",
      flags: ["--types"],
      kind: "store",
      type: TYPES,
      default: extractUsers.DEFAULT_INCLUDE_TYPES,
    },
    { dest: "persona", flags: ["--persona"], kind: "store" },
  ],
};

/** `{value:,.0f}`. */
function money(value: number): string {
  return thousands(pyFixed(value, 0));
}

function utcDate(ms: number | null): string {
  return ms ? utcIsoDate(ms * 1000) : "?";
}

function typeList(counts: readonly [number, number][]): string {
  return counts
    .map(([type, n]) => `${extractUsers.TYPE_LABELS.get(type) ?? `type=${type}`}=${thousands(n)}`)
    .join(", ");
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `json.load` of a UTF-8 file's bytes, floats kept. */
function loadJson(bytes: Uint8Array): unknown {
  return pyJsonLoadsFast(UTF8.decode(bytes));
}

/** The `laplace-extract-users` command; resolves to its exit code. */
export async function extractUsersMain(
  argv: readonly string[],
  deps: CommandDeps = {},
): Promise<number> {
  const io = resolveIo(deps);
  const out = printer(io.stdout);
  const err = printer(io.stderr);
  let ns: Namespace;
  try {
    ns = parseArgs(EXTRACT_USERS_PARSER, argv);
    commandPersona(EXTRACT_USERS_PARSER, ns.persona as string | null);
  } catch (error) {
    if (error instanceof ArgparseExit) return reportExit(io, error);
    throw error;
  }
  const input = ns.input as string;
  const top = ns.top as number;
  if (!existsSync(input)) {
    err(`error: file not found: ${input}`);
    return 1;
  }
  err(`Reading ${input} (${pyFixed(statSync(input).size / 1024 / 1024, 1)} MB)…`);
  const bytes = await Bun.file(input).bytes();
  // The rest runs without a pause, so a signal is honoured here or not at all.
  if (deps.signal?.aborted) return 1;
  const payload = loadJson(bytes);
  let items: unknown[];
  try {
    items = extractUsers.danmakuItems(payload);
  } catch (error) {
    if (!(error instanceof extractUsers.DanmakuShapeError)) throw error;
    err(`error: ${error.message}`);
    return 1;
  }
  const report = extractUsers.rankUsers(items, {
    types: ns.types as ReadonlySet<number> | null,
    top,
  });
  if (report.counted === 0) {
    err("error: no entries matched the type filter. Try --types all.");
    return 1;
  }
  err("");
  err(`  total entries  : ${thousands(report.totalEntries)}`);
  err(`  unique users   : ${thousands(report.uniqueUsers)}`);
  err(`  date range     : ${utcDate(report.earliestMs)} → ${utcDate(report.latestMs)}`);
  if (report.skippedNoId) {
    err(`  skipped (no uId/uName): ${thousands(report.skippedNoId)}`);
  }
  err(`  all types      : ${typeList(report.typeCountsAll)}`);
  err(`  counted types  : ${typeList(report.typeCountsKept)}`);
  if (report.totalSpend) err(`  total spend    : ¥${money(report.totalSpend)} across all types`);
  // Ranked by spend: if the top names look familiar, this is the right streamer's archive.
  if (report.topSpenders.length > 0) {
    err("");
    err("  top 10 spenders (informational, not in stdout):");
    for (const { name, spend } of report.topSpenders) {
      err(`    ¥${money(spend).padStart(9)}  ${name}`);
    }
  }
  err("");
  err(`top ${top} usernames by message frequency → stdout:`);
  err("");
  for (const name of report.names) out(name);
  return 0;
}
