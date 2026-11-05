// laplace-search: probe the stream archive through the exact retrieval path the bot uses, so what
// comes back here is what the bot would have recalled.
import {
  cpLen,
  cpSlice,
  isPlainObject,
  PyFloat,
  personaTimeZone,
  pyFixed,
  pyGet,
  pyJsonDumps,
  pyRepr,
  pyStr,
  pyStrip,
  pyTruthy,
  setLogLevel,
  splitlines,
} from "@eidolon/config";
import {
  formatChunks,
  overviewText,
  type RecallCatalog,
  type RecallResult,
  recallResult,
  StreamRecall,
} from "@eidolon/context";
import {
  dbPathArgument,
  decodeTopics,
  hasStreamTimeReference,
  type IsoDate,
  ingestHint,
  isStreamOverview,
  openStreamArchiveRetriever,
  type Retriever,
  type SearchRow,
  STREAM_ARCHIVE,
  STREAM_CHUNKS_TABLE,
  StreamCatalog,
  streamArchiveSearchParams,
} from "@eidolon/retrieval";
import {
  ArgparseExit,
  FROMISOFORMAT,
  INT,
  type ParserSpec,
  parseArgs,
  parserError,
} from "./argparse.ts";
import { type CliIo, printer, reportExit, resolveIo } from "./io.ts";
import { itemsOr } from "./py.ts";

const USAGE = `usage: laplace-search [-h] [--top-k TOP_K] [--db-path DB_PATH] [--table TABLE]
                      [--full] [--json] [--recall] [--today YYYY-MM-DD]
                      query
`;

export const SEARCH_PARSER: ParserSpec = {
  prog: "laplace-search",
  usage: USAGE,
  help: `${USAGE}
Probe the stream archive index from the command line.

positional arguments:
  query               Search query (the question you'd ask the bot)

options:
  -h, --help          show this help message and exit
  --top-k TOP_K       Number of results to return (default: 5)
  --db-path DB_PATH   LanceDB dir (default: the persona's index/)
  --table TABLE       Table name (default: stream_chunks)
  --full              Print full chunk text instead of a 200-char preview
  --json              Emit raw JSON (drops vector field for readability)
  --recall            Use broadcast recaps or details within a resolved period
                      (JSON emits an envelope)
  --today YYYY-MM-DD  Persona-local reference date for --recall (default:
                      today in PERSONA_TIMEZONE)
`,
  actions: [
    { dest: "query", flags: [], kind: "store" },
    { dest: "top_k", flags: ["--top-k"], kind: "store", type: INT, default: 5 },
    { dest: "db_path", flags: ["--db-path"], kind: "store", default: null },
    { dest: "table", flags: ["--table"], kind: "store", default: STREAM_CHUNKS_TABLE },
    { dest: "full", flags: ["--full"], kind: "store_true" },
    { dest: "json", flags: ["--json"], kind: "store_true" },
    { dest: "recall", flags: ["--recall"], kind: "store_true" },
    { dest: "today", flags: ["--today"], kind: "store", type: FROMISOFORMAT },
  ],
};

export interface SearchArgs {
  readonly query: string;
  readonly topK: number;
  readonly dbPath: string;
  readonly table: string;
  readonly full: boolean;
  readonly json: boolean;
  readonly recall: boolean;
  readonly today: IsoDate | null;
}

/** Throws ArgparseExit for -h and usage errors, including `--today` without `--recall`. */
export function parseSearchArgs(argv: readonly string[]): SearchArgs {
  const ns = parseArgs(SEARCH_PARSER, argv);
  const args: SearchArgs = {
    query: ns.query as string,
    topK: ns.top_k as number,
    dbPath: (ns.db_path as string | null) ?? dbPathArgument(),
    table: ns.table as string,
    full: ns.full as boolean,
    json: ns.json as boolean,
    recall: ns.recall as boolean,
    today: ns.today as IsoDate | null,
  };
  if (args.today !== null && !args.recall) {
    throw parserError(SEARCH_PARSER, "--today requires --recall");
  }
  return args;
}

export interface SearchDeps extends Partial<CliIo> {
  /** The stream-archive retriever over `table`; openStreamArchiveRetriever by default. */
  readonly openRetriever?: (dbPath: string, table: string) => Promise<Retriever>;
  /** The broadcast catalog `--recall` reads; a StreamCatalog over `dbPath` by default. */
  readonly openCatalog?: (dbPath: string) => RecallCatalog;
}

export const UNRESOLVED_PERIOD_NOTE =
  "无法直接确定这个时间范围；请给出明确日期。对话中的直播查询工具可解析复杂指代。";

/** A hit as Python's json.dumps writes it: no vector, and the scores LanceDB returns as floats. */
function jsonRow(row: SearchRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "vector") continue;
    out[key] =
      (key === "_relevance_score" || key === "_distance") && typeof value === "number"
        ? new PyFloat(value)
        : value;
  }
  return out;
}

async function recallMain(
  args: SearchArgs,
  retriever: Retriever,
  deps: SearchDeps,
  io: CliIo,
): Promise<number> {
  const print = printer(io.stdout);
  const today = args.today;
  const recall = new StreamRecall({
    retriever,
    catalog: deps.openCatalog?.(args.dbPath) ?? new StreamCatalog(args.dbPath),
    timeZone: personaTimeZone(),
    candidates: streamArchiveSearchParams().candidates,
    topK: args.topK,
    ...(today !== null ? { today: () => today } : {}),
  });
  const scope = recall.resolve(args.query);
  let result: RecallResult;
  if (scope === null && hasStreamTimeReference(args.query)) {
    result = recallResult({
      scope: null,
      overview: isStreamOverview(args.query),
      note: UNRESOLVED_PERIOD_NOTE,
    });
  } else {
    result = await recall.lookup(args.query, { scope });
  }
  const overview = result.broadcasts.length > 0 ? overviewText(result) : "";
  if (args.json) {
    const period =
      scope === null
        ? null
        : {
            start_date: scope.startDate,
            end_date: scope.endDate,
            latest: scope.latest,
            stream_ids: [...scope.streamIds],
            label: scope.label,
          };
    const envelope = {
      mode: result.overview ? "overview" : "details",
      period,
      broadcast_ids: result.broadcasts.map((broadcast) => broadcast.id),
      chunks: result.chunks.map(jsonRow),
      overview,
      note: result.note,
    };
    print(pyJsonDumps(envelope, { ensureAscii: false, indent: 2 }));
    return 0;
  }
  print(`Query: ${pyRepr(args.query)}`);
  if (scope !== null) print(`Period: ${scope.label}`);
  if (overview) print(overview);
  if (result.chunks.length > 0) print(formatChunks(result.chunks, "直播详细片段：\n"));
  if (result.note) print(result.note);
  return 0;
}

/** Python `value or ""` for a column, as an f-string renders it. */
function textOr(value: unknown): string {
  return pyTruthy(value) ? pyStr(value) : "";
}

function printHit(print: (line?: string) => void, i: number, hit: SearchRow, full: boolean): void {
  const date = pyStr(pyGet(hit, "stream_date", "?"));
  const summary = textOr(hit.summary);
  const details = textOr(hit.details);
  const text = pyStr(pyGet(hit, "text", ""));
  const chunkType = textOr(hit.chunk_type);
  const relevance = hit._relevance_score;

  let extras: Record<string, unknown> = {};
  const extrasRaw = textOr(hit.extras_json);
  if (extrasRaw) {
    try {
      extras = JSON.parse(extrasRaw) as Record<string, unknown>;
    } catch {
      extras = {};
    }
  }
  const topics = decodeTopics(hit);

  let header =
    relevance !== null && relevance !== undefined
      ? `[${i}] score=${pyFixed(Number(relevance), 3)}  ${date}`
      : `[${i}] dist=${pyFixed(Number(pyGet(hit, "_distance", 0)), 3)}  ${date}`;
  if (topics.length > 0) header += `  (${topics.join(", ")})`;
  if (chunkType) {
    const tag = details ? "v2" : pyTruthy(hit.refined) ? "v1" : "raw";
    header += `  [${chunkType} · ${tag}]`;
  }
  print(header);
  print(`     ${pyStr(pyGet(hit, "heading", ""))}`);
  if (summary) print(`     SUMMARY: ${summary}`);

  if (full) {
    if (details) {
      print();
      print("     DETAILS:");
      for (const line of splitlines(details)) print(`     ${line}`);
    }

    const scEvents = itemsOr(extras.sc_events);
    if (scEvents.length > 0) {
      print();
      print("     SC EVENTS:");
      for (const sc of scEvents) {
        if (!isPlainObject(sc)) continue;
        const viewer = textOr(sc.viewer) || "?";
        const suffix = pyTruthy(sc.amount_yuan) ? `（¥${pyStr(sc.amount_yuan)}）` : "";
        print(`       • ${viewer}${suffix}: ${pyStr(pyGet(sc, "content", ""))}`);
        const response = textOr(sc.response);
        if (response) print(`         → ${response}`);
      }
    }

    const songs = itemsOr(extras.songs);
    if (songs.length > 0) {
      const titles = songs.map((song) =>
        isPlainObject(song) ? `《${pyStr(pyGet(song, "title", "?"))}》` : `《${pyStr(song)}》`,
      );
      print(`     SONGS:    ${titles.join(" ")}`);
    }

    for (const [label, key] of [
      ["EVENTS  ", "events"],
      ["PROMISES", "promises"],
    ] as const) {
      const items = itemsOr(extras[key]);
      if (items.length > 0) print(`     ${label}: ${items.map(pyStr).join("; ")}`);
    }

    const quotes = itemsOr(extras.key_quotes);
    if (quotes.length > 0) {
      print("     QUOTES:");
      for (const quote of quotes) print(`       「${pyStr(quote)}」`);
    }

    print();
    print("     RAW TRANSCRIPT:");
    for (const line of splitlines(text)) print(`     ${line}`);
  } else if (!summary) {
    let preview = pyStrip(text.replaceAll("\n", " "));
    if (cpLen(preview) > 200) preview = `${cpSlice(preview, 0, 197)}…`;
    print(`     ${preview}`);
  }
  print();
}

/** The `laplace-search` command; resolves to its exit code. */
export async function searchMain(argv: readonly string[], deps: SearchDeps = {}): Promise<number> {
  const io = resolveIo(deps);
  let args: SearchArgs;
  try {
    args = parseSearchArgs(argv);
  } catch (error) {
    if (error instanceof ArgparseExit) return reportExit(io, error);
    throw error;
  }
  // Keeps the retriever's own INFO lines out of the middle of the output.
  setLogLevel("WARNING");

  const open =
    deps.openRetriever ??
    ((dbPath: string, table: string) => openStreamArchiveRetriever(dbPath, { tableName: table }));
  const retriever = await open(args.dbPath, args.table);
  if (args.recall) return recallMain(args, retriever, deps, io);
  if (!retriever.hasTable) {
    io.stderr(`No LanceDB table at ${args.dbPath}/${args.table}.lance\n`);
    io.stderr(`Run \`${ingestHint(STREAM_ARCHIVE.ingestCommand)}\` first.\n`);
    return 1;
  }

  const hits = await retriever.search(args.query, {
    candidates: streamArchiveSearchParams().candidates,
    topK: args.topK,
  });

  const print = printer(io.stdout);
  if (args.json) {
    print(pyJsonDumps(hits.map(jsonRow), { ensureAscii: false, indent: 2 }));
    return 0;
  }
  const first = hits[0];
  if (first === undefined) {
    print(`No hits for ${pyRepr(args.query)}.`);
    return 0;
  }
  const scoreHint =
    first._relevance_score !== null && first._relevance_score !== undefined
      ? "higher relevance = better match"
      : "lower distance = better match";
  print(`Query: ${pyRepr(args.query)}`);
  print(`Index: ${await retriever.rowCount()} rows in ${args.dbPath}/${args.table}.lance`);
  print(`Hits:  ${hits.length} (${scoreHint})`);
  print();
  hits.forEach((hit, index) => {
    printHit(print, index + 1, hit, args.full);
  });
  return 0;
}
