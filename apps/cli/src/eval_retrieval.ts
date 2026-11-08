// laplace-eval-retrieval: recall@k and MRR for the curated query set through every retrieval mode
// (vector-only, hybrid, hybrid+rerank), so tokenizer, reranker and top_k changes have one number to
// move.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  activePersona,
  cpSlice,
  envOptional,
  errorText,
  isPlainObject,
  ljust,
  logger,
  PyFloat,
  pyError,
  pyFixed,
  pyGet,
  pyIter,
  pyJsonDumps,
  pyPath,
  pyRepr,
  pyStr,
  pyTruthy,
  rjust,
  setLogLevel,
  sortedPy,
  sourceFolder,
} from "@eidolon/config";
import { accountOf } from "@eidolon/providers";
import {
  DEFAULT_RERANK_BASE_URL,
  dbPathArgument,
  embedTexts,
  extractDateFilter,
  type HybridSearchOptions,
  hybridSearch,
  type LanceTable,
  listTableNames,
  makeReranker,
  OpenRouterReranker,
  openTable,
  type Reranker,
  type SearchRow,
  vectorSearch,
} from "@eidolon/retrieval";
import { ArgparseExit, INT, type ParserSpec, parseArgs } from "./argparse.ts";
import { type CliIo, printer, reportExit, resolveIo } from "./io.ts";
import { mean, median } from "./py.ts";

/** `--queries` when unset: the eval set among the persona's sources in the data home. */
export function defaultQueriesPath(): string {
  return join(sourceFolder(activePersona().id, "eval"), "queries.toml");
}

export const K_VALUES = [1, 3, 5, 10] as const;
export const ALL_MODES = ["vector_only", "hybrid", "hybrid_rerank"] as const;
const MAX_K = Math.max(...K_VALUES);

const USAGE = `usage: laplace-eval-retrieval [-h] [--queries QUERIES] [--db-path DB_PATH]
                              [--table {persona_facts,stream_chunks}]
                              [--modes {vector_only,hybrid,hybrid_rerank} [{vector_only,hybrid,hybrid_rerank} ...]]
                              [--facts-candidates FACTS_CANDIDATES]
                              [--stream-candidates STREAM_CANDIDATES]
                              [--date-filter | --no-date-filter] [--verbose]
                              [--save SAVE] [--compare COMPARE]
                              [--rerank-models MODEL [MODEL ...]]
`;

export const EVAL_PARSER: ParserSpec = {
  prog: "laplace-eval-retrieval",
  usage: USAGE,
  help: `${USAGE}
Score retrieval quality for both LanceDB tables.

options:
  -h, --help            show this help message and exit
  --queries QUERIES     TOML file of [[query]] entries (default: the persona's
                        eval/queries.toml in the data home's sources)
  --db-path DB_PATH     LanceDB directory (default: the persona's index/)
  --table {persona_facts,stream_chunks}
                        Restrict eval to one table. Default: both.
  --modes {vector_only,hybrid,hybrid_rerank} [{vector_only,hybrid,hybrid_rerank} ...]
                        Subset of retrieval modes to test. Default: all of
                        ('vector_only', 'hybrid', 'hybrid_rerank').
  --facts-candidates FACTS_CANDIDATES
                        Hybrid-search candidate pool size for persona_facts
                        (default: 30).
  --stream-candidates STREAM_CANDIDATES
                        Hybrid-search candidate pool size for stream_chunks
                        (default: 15).
  --date-filter, --no-date-filter
                        Apply date pre-filter when query mentions a date
                        (default: on).
  --verbose             Print per-query rank breakdown after the summary
                        table.
  --save SAVE           Save metrics to a JSON file for later --compare.
  --compare COMPARE     Compare current run against a previously saved metrics
                        JSON.
  --rerank-models MODEL [MODEL ...]
                        Benchmark mode: run the query set through each named
                        Cohere reranker model and report quality + latency
                        side-by-side. Requires COHERE_API_KEY. Example:
                        --rerank-models rerank-multilingual-v3.0
                        rerank-v4.0-fast rerank-v4.0-pro. When set, the
                        regular --modes path is skipped — output is the model-
                        comparison table instead.
`,
  actions: [
    { dest: "queries", flags: ["--queries"], kind: "store" },
    { dest: "db_path", flags: ["--db-path"], kind: "store", default: null },
    {
      dest: "table",
      flags: ["--table"],
      kind: "store",
      choices: ["persona_facts", "stream_chunks"],
    },
    { dest: "modes", flags: ["--modes"], kind: "store", nargs: "+", choices: ALL_MODES },
    {
      dest: "facts_candidates",
      flags: ["--facts-candidates"],
      kind: "store",
      type: INT,
      default: 30,
    },
    {
      dest: "stream_candidates",
      flags: ["--stream-candidates"],
      kind: "store",
      type: INT,
      default: 15,
    },
    {
      dest: "date_filter",
      flags: ["--date-filter", "--no-date-filter"],
      kind: "boolean_optional",
      default: true,
    },
    { dest: "verbose", flags: ["--verbose"], kind: "store_true" },
    { dest: "save", flags: ["--save"], kind: "store" },
    { dest: "compare", flags: ["--compare"], kind: "store" },
    { dest: "rerank_models", flags: ["--rerank-models"], kind: "store", nargs: "+" },
  ],
};

export interface EvalArgs {
  /** null: defaultQueriesPath(). */
  readonly queries: string | null;
  readonly dbPath: string;
  readonly table: string | null;
  readonly modes: readonly string[] | null;
  readonly factsCandidates: number;
  readonly streamCandidates: number;
  readonly dateFilter: boolean;
  readonly verbose: boolean;
  readonly save: string | null;
  readonly compare: string | null;
  readonly rerankModels: readonly string[] | null;
}

/** Throws ArgparseExit for -h and usage errors. */
export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const ns = parseArgs(EVAL_PARSER, argv);
  return {
    queries: ns.queries as string | null,
    dbPath: (ns.db_path as string | null) ?? dbPathArgument(),
    table: ns.table as string | null,
    modes: ns.modes as string[] | null,
    factsCandidates: ns.facts_candidates as number,
    streamCandidates: ns.stream_candidates as number,
    dateFilter: ns.date_filter as boolean,
    verbose: ns.verbose as boolean,
    save: ns.save as string | null,
    compare: ns.compare as string | null,
    rerankModels: ns.rerank_models as string[] | null,
  };
}

export interface EvalQuery {
  readonly table: string;
  readonly text: string;
  /** Any one, as a case-sensitive substring of the row's text/summary/details/heading, is a hit. */
  readonly expectSubstrings: readonly string[];
  readonly notes: string;
}

export interface QueryResult {
  readonly query: EvalQuery;
  readonly mode: string;
  /** 1-based rank of the first hit; null for a miss. */
  readonly rank: number | null;
  readonly topKHits: ReadonlyMap<number, boolean>;
  /** The rank-1 row's text, for eyeballing. */
  readonly topText: string;
}

export interface ModeReport {
  readonly mode: string;
  readonly table: string;
  readonly nQueries: number;
  readonly recallAt: ReadonlyMap<number, number>;
  readonly mrr: number;
  /** Query texts with no hit in the top 10. */
  readonly misses: readonly string[];
}

/** Quality and per-query wall clock for one reranker model. */
export interface RerankerBenchmark {
  readonly model: string;
  readonly table: string;
  readonly nQueries: number;
  readonly recallAt: ReadonlyMap<number, number>;
  readonly mrr: number;
  /** Milliseconds per query around the whole hybridSearch call; the embedding is outside it. */
  readonly rerankMs: readonly number[];
}

export function benchmarkMedianMs(bench: RerankerBenchmark): number {
  return bench.rerankMs.length > 0 ? median(bench.rerankMs) : 0;
}

/** Nearest-rank, no interpolation — crude at our N, but every model sees the same query set. */
export function benchmarkP95Ms(bench: RerankerBenchmark): number {
  if (bench.rerankMs.length === 0) return 0;
  const sorted = [...bench.rerankMs].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length)));
  return sorted[index] as number;
}

export function benchmarkMeanMs(bench: RerankerBenchmark): number {
  return bench.rerankMs.length > 0 ? mean(bench.rerankMs) : 0;
}

/** Parses queries.toml. Throws FileNotFoundError / ValueError with the Python messages. */
export function loadQueries(path: string): EvalQuery[] {
  const shown = pyPath(path);
  if (!existsSync(path)) throw pyError("FileNotFoundError", `Queries file not found: ${shown}`);
  const data = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const rawQueries = "query" in data ? data.query : [];
  if (!pyTruthy(rawQueries)) throw pyError("ValueError", `No [[query]] entries in ${shown}`);
  return pyIter(rawQueries).map((q, i) => {
    const field = (key: string): unknown => {
      if (!isPlainObject(q))
        throw pyError("TypeError", "string indices must be integers, not 'str'");
      if (!(key in q)) {
        throw pyError(
          "ValueError",
          `Query #${i} in ${shown} missing required field ${pyRepr(key)}`,
        );
      }
      return q[key];
    };
    const table = pyStr(field("table"));
    const text = pyStr(field("text"));
    const expectSubstrings = pyIter(field("expect_substrings")).map(pyStr);
    const notes = pyStr(isPlainObject(q) && "notes" in q ? q.notes : "");
    return { table, text, expectSubstrings, notes };
  });
}

/** Every candidate field across both schemas; a missing one contributes "". */
export function rowTextForMatch(row: SearchRow): string {
  return ["text", "summary", "details", "heading"]
    .map((key) => (pyTruthy(row[key]) ? pyStr(row[key]) : ""))
    .join(" ");
}

export function matches(rowBlob: string, expects: readonly string[]): boolean {
  return expects.some((s) => rowBlob.includes(s));
}

export interface EvalDeps extends Partial<CliIo> {
  readonly listTables?: (dbPath: string) => Promise<string[]>;
  readonly openTable?: (dbPath: string, name: string) => Promise<unknown>;
  readonly embed?: (texts: string[]) => Promise<number[][]>;
  readonly vectorSearch?: (
    table: unknown,
    options: { vector: readonly number[]; limit: number; where: string | null },
  ) => Promise<SearchRow[]>;
  readonly hybridSearch?: (table: unknown, options: HybridSearchOptions) => Promise<SearchRow[]>;
  /** The configured cross-encoder, or null; makeReranker by default. */
  readonly makeReranker?: () => Reranker | null;
  /** A fresh reranker for one benchmarked model; throws without an API key. */
  readonly namedReranker?: (model: string) => Reranker;
  /** Milliseconds, for the benchmark's timer; performance.now by default. */
  readonly now?: () => number;
}

type Resolved = Required<Omit<EvalDeps, keyof CliIo>>;

/** Bypasses makeReranker's process cache so each model is measured on its own. */
export function namedReranker(model: string): Reranker {
  const apiKey = envOptional("RERANK_API_KEY") ?? accountOf("openrouter")?.apiKey;
  if (!apiKey) {
    throw new Error(
      "--rerank-models requires RERANK_API_KEY or OPENROUTER_API_KEY " +
        "in .env (no key = nothing to benchmark, since the fallback path " +
        "is the same RRF for every 'model').",
    );
  }
  return new OpenRouterReranker({
    modelName: model,
    apiKey,
    baseUrl: envOptional("RERANK_BASE_URL") ?? DEFAULT_RERANK_BASE_URL,
  });
}

function resolveDeps(deps: EvalDeps): Resolved {
  return {
    listTables: deps.listTables ?? listTableNames,
    openTable: deps.openTable ?? openTable,
    embed: deps.embed ?? ((texts) => embedTexts(texts)),
    vectorSearch:
      deps.vectorSearch ?? ((table, options) => vectorSearch(table as LanceTable, options)),
    hybridSearch:
      deps.hybridSearch ?? ((table, options) => hybridSearch(table as LanceTable, options)),
    makeReranker: deps.makeReranker ?? (() => makeReranker()),
    namedReranker: deps.namedReranker ?? namedReranker,
    now: deps.now ?? (() => performance.now()),
  };
}

interface QueryOptions {
  readonly candidates: number;
  readonly maxK: number;
  readonly useDateFilter: boolean;
}

/** LanceDB raises a Schema error on the wrong date column, so the query's table picks it. */
function dateWhere(query: EvalQuery, useDateFilter: boolean): string | null {
  const column = query.table === "stream_chunks" ? "stream_date" : "date";
  return useDateFilter ? extractDateFilter(query.text, { column }) : null;
}

function scored(query: EvalQuery, mode: string, rows: readonly SearchRow[]): QueryResult {
  const index = rows.findIndex((row) => matches(rowTextForMatch(row), query.expectSubstrings));
  const rank = index === -1 ? null : index + 1;
  const first = rows[0];
  return {
    query,
    mode,
    rank,
    topKHits: new Map(K_VALUES.map((k) => [k, rank !== null && rank <= k])),
    topText: first === undefined ? "" : cpSlice(rowTextForMatch(first), 0, 120),
  };
}

/** One query in one mode: its rank and per-k hits. */
export async function evaluateQuery(
  query: EvalQuery,
  table: unknown,
  mode: string,
  options: QueryOptions,
  deps: EvalDeps = {},
): Promise<QueryResult> {
  const d = resolveDeps(deps);
  const where = dateWhere(query, options.useDateFilter);
  if (!(ALL_MODES as readonly string[]).includes(mode)) {
    throw pyError("ValueError", `Unknown mode: ${pyRepr(mode)}`);
  }
  const vectors = await d.embed([query.text]);
  const vector = vectors[0];
  let rows: SearchRow[] = [];
  if (vector !== undefined && mode === "vector_only") {
    rows = await d.vectorSearch(table, { vector, limit: options.maxK, where });
  } else if (vector !== undefined) {
    const reranker = mode === "hybrid_rerank" ? d.makeReranker() : null;
    rows = await d.hybridSearch(table, {
      vector,
      queryText: query.text,
      candidates: options.candidates,
      where,
      finalK: options.maxK,
      rerank: reranker !== null,
      reranker,
    });
  }
  return scored(query, mode, rows);
}

function recallAt(results: readonly { topKHits: ReadonlyMap<number, boolean> }[]) {
  const n = results.length;
  return new Map(
    K_VALUES.map((k) => [k, results.filter((r) => r.topKHits.get(k) ?? false).length / n]),
  );
}

function meanReciprocalRank(results: readonly { rank: number | null }[]): number {
  let total = 0;
  for (const r of results) total += r.rank ? 1.0 / r.rank : 0.0;
  return total / results.length;
}

/** recall@k and MRR across one mode's results. */
export function aggregate(results: readonly QueryResult[], table: string): ModeReport {
  const first = results[0];
  if (first === undefined) {
    return {
      mode: "(none)",
      table,
      nQueries: 0,
      recallAt: new Map(K_VALUES.map((k) => [k, 0])),
      mrr: 0,
      misses: [],
    };
  }
  return {
    mode: first.mode,
    table,
    nQueries: results.length,
    recallAt: recallAt(results),
    mrr: meanReciprocalRank(results),
    misses: results.filter((r) => r.rank === null).map((r) => r.query.text),
  };
}

export function fmtPct(x: number): string {
  return `${rjust(pyFixed(x * 100, 1), 5)}%`;
}

type Print = (line?: string) => void;

/** Modes side by side for one table, then the best mode's misses. */
export function printTableReport(print: Print, perMode: ReadonlyMap<string, ModeReport>): void {
  const reports = [...perMode.values()];
  const head = reports[0];
  if (head === undefined) return;
  print(`\n${"=".repeat(78)}`);
  print(`  Table: ${head.table}  (${head.nQueries} queries)`);
  print("=".repeat(78));
  const header =
    `  ${ljust("mode", 22)}` +
    K_VALUES.map((k) => ` ${rjust(`R@${k}`, 7)}`).join("") +
    ` ${rjust("MRR", 7)}`;
  print(header);
  print(`  ${"-".repeat(header.length - 2)}`);
  for (const modeKey of ALL_MODES) {
    const r = perMode.get(modeKey);
    if (r === undefined) continue;
    const cells = K_VALUES.map((k) => fmtPct(r.recallAt.get(k) as number));
    print(
      `  ${ljust(modeKey, 22)}` +
        cells.map((c) => ` ${rjust(c, 7)}`).join("") +
        ` ${rjust(pyFixed(r.mrr, 3), 7)}`,
    );
  }
  print();
  // Misses from the best mode are the genuinely adversarial queries; max keeps the first of ties.
  let best = head;
  for (const r of reports) if (r.mrr > best.mrr) best = r;
  if (best.misses.length > 0) {
    print(`  Misses (best mode = ${best.mode}, ${best.misses.length} of ${best.nQueries}):`);
    for (const m of best.misses) print(`    · ${m}`);
  }
}

/** Ranks per query for each mode, keyed by query text. */
export function printPerQueryBreakdown(
  print: Print,
  allResults: readonly QueryResult[],
  tableName: string,
): void {
  const texts = [
    ...new Set(allResults.filter((r) => r.query.table === tableName).map((r) => r.query.text)),
  ];
  if (texts.length === 0) return;
  print(`\n  ${"─".repeat(76)}`);
  print(`  Per-query ranks for ${tableName} (lower = better, ✗ = miss):`);
  print(`  ${"─".repeat(76)}`);
  print(`  ${ljust("query", 40)}${ALL_MODES.map((m) => ` ${rjust(m, 14)}`).join("")}`);
  for (const text of texts) {
    let line = `  ${ljust(cpSlice(text, 0, 38), 40)}`;
    for (const mode of ALL_MODES) {
      const match = allResults.find((r) => r.query.text === text && r.mode === mode);
      const cell = match === undefined ? "—" : match.rank ? `#${match.rank}` : "✗";
      line += ` ${rjust(cell, 14)}`;
    }
    print(line);
  }
}

/** The `--save` blob, with Python's float/int split kept for a byte-stable file. */
export function toJsonBlob(
  perTable: ReadonlyMap<string, ReadonlyMap<string, ModeReport>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [tableName, modes] of perTable) {
    const byMode: Record<string, unknown> = {};
    for (const [mode, rep] of modes) {
      byMode[mode] = {
        recall_at: Object.fromEntries(
          [...rep.recallAt].map(([k, v]) => [String(k), new PyFloat(v)]),
        ),
        mrr: new PyFloat(rep.mrr),
        n_queries: rep.nQueries,
        miss_count: rep.misses.length,
      };
    }
    out[tableName] = byMode;
  }
  return out;
}

/** The current run's MRR against a saved baseline, per mode present in both. */
export function printComparison(
  print: Print,
  current: ReadonlyMap<string, ReadonlyMap<string, ModeReport>>,
  baseline: unknown,
): void {
  print(`\n${"=".repeat(78)}`);
  print("  Comparison vs baseline");
  print("=".repeat(78));
  for (const [tableName, modes] of current) {
    const baseModes = pyGet(baseline, tableName, {});
    if (!pyTruthy(baseModes)) continue;
    print(`\n  ${tableName}:`);
    for (const [modeKey, rep] of modes) {
      const base = pyGet(baseModes, modeKey, null);
      if (!pyTruthy(base)) continue;
      const baseMrr = Number(pyGet(base, "mrr", 0));
      const delta = rep.mrr - baseMrr;
      const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "·";
      print(
        `    ${ljust(modeKey, 20)}  MRR ${pyFixed(baseMrr, 3)} → ${pyFixed(rep.mrr, 3)}  ` +
          `${arrow}${pyFixed(Math.abs(delta), 3)}`,
      );
    }
  }
}

/** One query through one model; the timer spans hybridSearch only, the embedding sits outside. */
async function evaluateWithReranker(
  query: EvalQuery,
  table: unknown,
  options: QueryOptions,
  reranker: Reranker,
  d: Resolved,
): Promise<[QueryResult, number]> {
  const where = dateWhere(query, options.useDateFilter);
  const mode = `rerank:${reranker.modelName}`;
  const vector = (await d.embed([query.text]))[0];
  if (vector === undefined) {
    return [{ query, mode, rank: null, topKHits: new Map(), topText: "" }, 0];
  }
  const t0 = d.now();
  const rows = await d.hybridSearch(table, {
    vector,
    queryText: query.text,
    candidates: options.candidates,
    where,
    finalK: options.maxK,
    rerank: true,
    reranker,
  });
  const elapsedMs = d.now() - t0;
  return [scored(query, mode, rows), elapsedMs];
}

/**
 * The same queries through each reranker model. A throwaway warmup query per model goes first:
 * without it the first model absorbs DNS, HTTP/2 setup and Cohere cold-start, and always looks
 * slower than it is.
 */
export async function benchmarkRerankerModels(
  queries: readonly EvalQuery[],
  table: unknown,
  tableName: string,
  options: QueryOptions & { readonly models: readonly string[]; readonly warmup?: boolean },
  deps: EvalDeps = {},
): Promise<RerankerBenchmark[]> {
  const d = resolveDeps(deps);
  const out: RerankerBenchmark[] = [];
  for (const model of options.models) {
    let reranker: Reranker;
    try {
      reranker = d.namedReranker(model);
    } catch (error) {
      logger.error(`Skipping ${model}: ${errorText(error)}`);
      continue;
    }
    const first = queries[0];
    if ((options.warmup ?? true) && first !== undefined) {
      try {
        await evaluateWithReranker(first, table, options, reranker, d);
      } catch (error) {
        logger.warning(`Warmup failed for ${model} (${errorText(error)}); proceeding`);
      }
    }
    const results: QueryResult[] = [];
    const latencies: number[] = [];
    for (const q of queries) {
      let outcome: [QueryResult, number];
      try {
        outcome = await evaluateWithReranker(q, table, options, reranker, d);
      } catch (error) {
        logger.error(`${model} failed on query ${pyRepr(q.text)}: ${errorText(error)}`);
        continue;
      }
      results.push(outcome[0]);
      latencies.push(outcome[1]);
    }
    if (results.length === 0) continue;
    out.push({
      model,
      table: tableName,
      nQueries: results.length,
      recallAt: recallAt(results),
      mrr: meanReciprocalRank(results),
      rerankMs: latencies,
    });
  }
  return out;
}

/** Quality and latency per model for one table, best MRR first. */
export function printBenchmarkReport(print: Print, benches: readonly RerankerBenchmark[]): void {
  const head = benches[0];
  if (head === undefined) return;
  print(`\n${"=".repeat(88)}`);
  print(`  Reranker model benchmark — ${head.table}  (${head.nQueries} queries)`);
  print("=".repeat(88));
  const header =
    `  ${ljust("model", 28)}` +
    K_VALUES.map((k) => ` ${rjust(`R@${k}`, 6)}`).join("") +
    ` ${rjust("MRR", 6)}` +
    ` ${rjust("mean", 7)}` +
    ` ${rjust("p50", 7)}` +
    ` ${rjust("p95", 7)}`;
  print(header);
  print(`  ${"-".repeat(header.length - 2)}`);
  for (const b of [...benches].sort((x, y) => y.mrr - x.mrr)) {
    const cells = K_VALUES.map((k) => fmtPct(b.recallAt.get(k) as number));
    print(
      `  ${ljust(b.model, 28)}` +
        cells.map((c) => ` ${rjust(c, 6)}`).join("") +
        ` ${rjust(pyFixed(b.mrr, 3), 6)}` +
        ` ${rjust(pyFixed(benchmarkMeanMs(b), 0), 6)}m` +
        ` ${rjust(pyFixed(benchmarkMedianMs(b), 0), 6)}m` +
        ` ${rjust(pyFixed(benchmarkP95Ms(b), 0), 6)}m`,
    );
  }
  print("  (latency is end-to-end hybrid_search wall-clock in ms; lower is better)");
}

/** The `laplace-eval-retrieval` command; resolves to its exit code. */
export async function evalRetrievalMain(
  argv: readonly string[],
  deps: EvalDeps = {},
): Promise<number> {
  const io = resolveIo(deps);
  // Embedding and index init log at INFO; the report is the signal here.
  setLogLevel("WARNING");
  let args: EvalArgs;
  try {
    args = parseEvalArgs(argv);
  } catch (error) {
    if (error instanceof ArgparseExit) return reportExit(io, error);
    throw error;
  }
  const d = resolveDeps(deps);
  const print = printer(io.stdout);

  const queriesPath = args.queries ?? defaultQueriesPath();
  if (args.queries === null && !existsSync(queriesPath)) {
    logger.error(`Queries file not found: ${queriesPath}. Pass --queries <file>.`);
    return 1;
  }
  let queries = loadQueries(queriesPath);
  if (args.table) queries = queries.filter((q) => q.table === args.table);
  if (queries.length === 0) {
    logger.error("No queries to evaluate (post-filter).");
    return 1;
  }
  const tableNames = sortedPy(new Set(queries.map((q) => q.table)));
  // Facts are short enough to afford a wide net; stream chunks are long,
  // and 15 is where quality stops improving.
  const candidatesFor = new Map([
    ["persona_facts", args.factsCandidates],
    ["stream_chunks", args.streamCandidates],
  ]);

  if (args.rerankModels) {
    for (const tableName of tableNames) {
      if (!(await d.listTables(args.dbPath)).includes(tableName)) {
        logger.warning(`Table ${tableName} not found in ${args.dbPath}; skipping.`);
        continue;
      }
      const table = await d.openTable(args.dbPath, tableName);
      const tableQueries = queries.filter((q) => q.table === tableName);
      const candidates = candidatesFor.get(tableName) ?? 30;
      logger.info(
        `Benchmarking ${args.rerankModels.length} reranker(s) on ${tableName} — ` +
          `${tableQueries.length} queries × ${args.rerankModels.length} models ` +
          `(candidates=${candidates})`,
      );
      const benches = await benchmarkRerankerModels(
        tableQueries,
        table,
        tableName,
        { candidates, maxK: MAX_K, useDateFilter: args.dateFilter, models: args.rerankModels },
        deps,
      );
      printBenchmarkReport(print, benches);
    }
    return 0;
  }

  const modes = args.modes ?? [...ALL_MODES];
  if (modes.includes("hybrid_rerank") && !d.makeReranker()) {
    logger.warning(
      "hybrid_rerank requested but no reranker is configured — that mode " +
        "will use LinearCombinationReranker (vector-weighted) as fallback. " +
        "Set OPENROUTER_API_KEY (and leave RERANK_ENABLED on) for the " +
        "actual cross-encoder eval.",
    );
  }

  const perTable = new Map<string, Map<string, ModeReport>>();
  const allResults: QueryResult[] = [];
  for (const tableName of tableNames) {
    if (!(await d.listTables(args.dbPath)).includes(tableName)) {
      logger.warning(`Table ${tableName} not found in ${args.dbPath}; skipping.`);
      continue;
    }
    const table = await d.openTable(args.dbPath, tableName);
    const reports = new Map<string, ModeReport>();
    perTable.set(tableName, reports);
    const candidates = candidatesFor.get(tableName) ?? 30;
    const tableQueries = queries.filter((q) => q.table === tableName);
    logger.info(
      `Evaluating ${tableName} — ${tableQueries.length} queries × ${modes.length} modes ` +
        `(candidates=${candidates}, k≤${MAX_K})`,
    );
    for (const mode of modes) {
      const results: QueryResult[] = [];
      for (const q of tableQueries) {
        const r = await evaluateQuery(
          q,
          table,
          mode,
          { candidates, maxK: MAX_K, useDateFilter: args.dateFilter },
          deps,
        );
        results.push(r);
        allResults.push(r);
      }
      reports.set(mode, aggregate(results, tableName));
    }
  }

  for (const tableName of tableNames) {
    const reports = perTable.get(tableName);
    if (reports === undefined) continue;
    printTableReport(print, reports);
    if (args.verbose) printPerQueryBreakdown(print, allResults, tableName);
  }

  if (args.save) {
    const target = pyPath(args.save);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      pyJsonDumps(toJsonBlob(perTable), { ensureAscii: false, indent: 2 }),
      "utf8",
    );
    logger.info(`Saved metrics to ${args.save}`);
  }

  if (args.compare) {
    const baselinePath = pyPath(args.compare);
    if (!existsSync(baselinePath)) {
      logger.error(`Baseline file not found: ${baselinePath}`);
      return 1;
    }
    printComparison(print, perTable, JSON.parse(readFileSync(baselinePath, "utf8")));
  }
  return 0;
}
