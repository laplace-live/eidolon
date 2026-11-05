// laplace-ingest-facts: embeds the persona's fact files into the persona_facts table.
import { errorText, logger, sourceFolder } from "@eidolon/config";
import {
  acquireLock,
  canonicalPath,
  type EventCode,
  embedCachePath,
  indexLockKey,
  indexWritePath,
  ingestFacts,
  LockedError,
  ndjsonSink,
  noProgress,
  type ProgressSink,
} from "@eidolon/ingest";
import { type EmbeddingClient, PERSONA_FACTS_TABLE } from "@eidolon/retrieval";
import {
  ArgparseExit,
  commandPersona,
  INT,
  type ParserSpec,
  parseArgs,
  parserError,
} from "./argparse.ts";
import { type CommandDeps, reportExit, resolveIo } from "./io.ts";

const COMMAND = "laplace-ingest-facts";

const USAGE = `usage: laplace-ingest-facts [-h] [--data-dir DATA_DIR] [--files [FILES ...]]
                            [--db-path DB_PATH] [--table TABLE]
                            [--min-chars MIN_CHARS] [--no-strip-prefix]
                            [--dry-run] [--cache-path CACHE_PATH] [--no-cache]
                            [--clear-cache] [--persona PERSONA] [--json]
`;

export const INGEST_FACTS_PARSER: ParserSpec = {
  prog: COMMAND,
  usage: USAGE,
  help: `${USAGE}
Ingest persona-fact .txt files into a local LanceDB index.

options:
  -h, --help            show this help message and exit
  --data-dir DATA_DIR   Directory to scan for fact files (default: the
                        persona's facts/ in the data home's sources)
  --files [FILES ...]   Explicit fact file paths. If omitted, scans data-dir
                        for the persona's knowledge.facts.files patterns
                        (default: *.txt).
  --db-path DB_PATH     LanceDB directory (default: the persona's index/,
                        where the bot reads it)
  --table TABLE         Table name (default: persona_facts)
  --min-chars MIN_CHARS
                        Drop lines shorter than this after cleaning (default:
                        4)
  --no-strip-prefix     Disable persona-prefix stripping for embed_input. The
                        vector will then encode the opening name and verb
                        (knowledge.facts.subject, then e.g. 声称) as part of
                        every fact, which tends to compress the embedding
                        space when most facts share them. Use with --table
                        persona_facts_unstripped to build a parallel index for
                        A/B benchmarking against the stripped default.
  --dry-run             Parse and dedupe but skip embedding and writing.
  --cache-path CACHE_PATH
                        SQLite file used to cache embedding vectors so a
                        crashed/re-run ingest skips work that already
                        succeeded (default: the data home's
                        cache/embed_cache.db). Cache key is (model, dim,
                        text); changing EMBED_MODEL or EMBED_DIM auto-
                        invalidates entries.
  --no-cache            Skip the embedding cache entirely (always re-embed).
  --clear-cache         Delete every cached vector, of every persona and
                        model, before this run.
  --persona PERSONA     Persona whose facts to ingest (default: the active
                        persona)
  --json                Write progress events to stdout as JSON lines
`,
  actions: [
    { dest: "data_dir", flags: ["--data-dir"], kind: "store" },
    { dest: "files", flags: ["--files"], kind: "store", nargs: "*" },
    { dest: "db_path", flags: ["--db-path"], kind: "store" },
    { dest: "table", flags: ["--table"], kind: "store", default: PERSONA_FACTS_TABLE },
    { dest: "min_chars", flags: ["--min-chars"], kind: "store", type: INT, default: 4 },
    { dest: "no_strip_prefix", flags: ["--no-strip-prefix"], kind: "store_true" },
    { dest: "dry_run", flags: ["--dry-run"], kind: "store_true" },
    { dest: "cache_path", flags: ["--cache-path"], kind: "store" },
    { dest: "no_cache", flags: ["--no-cache"], kind: "store_true" },
    { dest: "clear_cache", flags: ["--clear-cache"], kind: "store_true" },
    { dest: "persona", flags: ["--persona"], kind: "store" },
    { dest: "json", flags: ["--json"], kind: "store_true" },
  ],
};

/** The parsed command line, every path resolved as pathlib's `resolve()` would. */
export interface IngestFactsArgs {
  readonly persona: string;
  readonly dataDir: string;
  /** `--files`; empty or null scans `dataDir`. */
  readonly files: readonly string[] | null;
  /** `--db-path`; null for the persona's index. */
  readonly dbPath: string | null;
  readonly table: string;
  readonly minChars: number;
  readonly stripPrefix: boolean;
  readonly dryRun: boolean;
  /** Null under --no-cache. */
  readonly cachePath: string | null;
  readonly clearCache: boolean;
  readonly json: boolean;
}

/** Throws ArgparseExit for -h and usage errors. */
export function parseIngestFactsArgs(argv: readonly string[]): IngestFactsArgs {
  const spec = INGEST_FACTS_PARSER;
  const ns = parseArgs(spec, argv);
  const persona = commandPersona(spec, ns.persona as string | null);
  const dbPath = ns.db_path as string | null;
  // The environment's index belongs to whichever persona it was set for.
  if (dbPath === null && ns.persona && process.env.LANCEDB_PATH) {
    throw parserError(
      spec,
      `LANCEDB_PATH is set in the environment; pass --db-path to write persona ${persona}'s index.`,
    );
  }
  const files = ns.files as string[] | null;
  return {
    persona,
    dataDir: canonicalPath((ns.data_dir as string | null) ?? sourceFolder(persona, "facts")),
    files: files === null ? null : files.map(canonicalPath),
    dbPath: dbPath === null ? null : canonicalPath(dbPath),
    table: ns.table as string,
    minChars: ns.min_chars as number,
    stripPrefix: ns.no_strip_prefix !== true,
    dryRun: ns.dry_run === true,
    cachePath:
      ns.no_cache === true
        ? null
        : canonicalPath((ns.cache_path as string | null) ?? embedCachePath()),
    clearCache: ns.clear_cache === true,
    json: ns.json === true,
  };
}

export interface IngestFactsDeps extends CommandDeps {
  /** The embedding client; the env-configured one, built at the first cache miss, by default. */
  readonly client?: Pick<EmbeddingClient, "embedWithUsage">;
  readonly now?: () => Date;
}

/** A run that stopped before reading a fact: why, as a failed stage, then its summary. */
function refused(
  emit: ProgressSink,
  table: string,
  message: string,
  code: EventCode | null = null,
): number {
  logger.error(message);
  emit({
    type: "stage",
    stage: "ingest-facts",
    status: "failed",
    message,
    ...(code === null ? {} : { code }),
  });
  emit({
    type: "summary",
    stage: "ingest-facts",
    ok: false,
    counts: { files: 0, rows: 0, cacheHits: 0, embedded: 0 } satisfies ingestFacts.FactsCounts,
    durationSec: 0,
    failures: [{ item: table, error: message }],
  });
  return 1;
}

/** The `laplace-ingest-facts` command; resolves to its exit code. */
export async function ingestFactsMain(
  argv: readonly string[],
  deps: IngestFactsDeps = {},
): Promise<number> {
  const io = resolveIo(deps);
  let args: IngestFactsArgs;
  try {
    args = parseIngestFactsArgs(argv);
  } catch (error) {
    if (error instanceof ArgparseExit) return reportExit(io, error);
    throw error;
  }
  const emit = args.json ? ndjsonSink(io.stdout) : noProgress;
  let dbPath: string;
  try {
    dbPath = args.dbPath ?? canonicalPath(indexWritePath(args.persona));
  } catch (error) {
    return refused(emit, args.table, errorText(error));
  }
  logger.info(`Index for persona ${args.persona}: ${dbPath}`);
  // A dry run writes nothing, so it runs beside a writer rather than failing on its lock.
  let release = (): void => {};
  if (!args.dryRun) {
    try {
      release = acquireLock(indexLockKey(dbPath), COMMAND);
    } catch (error) {
      if (!(error instanceof LockedError)) throw error;
      return refused(emit, args.table, error.message, "locked");
    }
  }
  try {
    const report = await ingestFacts.ingestFactFiles({
      factsDir: args.dataDir,
      files: args.files,
      dbPath,
      table: args.table,
      minChars: args.minChars,
      stripPrefix: args.stripPrefix,
      dryRun: args.dryRun,
      cachePath: args.cachePath,
      clearCache: args.clearCache,
      onProgress: emit,
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.client ? { client: deps.client } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    return report.ok ? 0 : 1;
  } finally {
    release();
  }
}
