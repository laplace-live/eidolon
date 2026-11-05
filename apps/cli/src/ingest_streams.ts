// laplace-ingest-streams: embeds the refined scenes into the stream_chunks table.
import { errorText, logger, sourceFolder } from "@eidolon/config";
import {
  acquireLock,
  canonicalPath,
  embedCachePath,
  indexLockKey,
  indexWritePath,
  ingestStreams,
  LockedError,
  lockedOut,
  ndjsonSink,
  noProgress,
  refuseTemplatePath,
  zeroCounts,
} from "@eidolon/ingest";
import { type EmbeddingClient, STREAM_CHUNKS_TABLE } from "@eidolon/retrieval";
import {
  ArgparseExit,
  commandPersona,
  type ParserSpec,
  parseArgs,
  parserError,
} from "./argparse.ts";
import { type CommandDeps, reportExit, resolveIo } from "./io.ts";

const COMMAND = "laplace-ingest-streams";

const USAGE = `usage: laplace-ingest-streams [-h] [--streams-dir STREAMS_DIR]
                              [--db-path DB_PATH] [--table TABLE]
                              [--skip-types SKIP_TYPES] [--dry-run]
                              [--cache-path CACHE_PATH] [--no-cache]
                              [--clear-cache] [--persona PERSONA] [--json]
`;

const HELP = `${USAGE}
Ingest streams/*.md into a local LanceDB index.

options:
  -h, --help            show this help message and exit
  --streams-dir STREAMS_DIR
                        Directory of *.md transcripts (default: the persona's
                        streams/ in the data home's sources)
  --db-path DB_PATH     LanceDB directory (default: the index the bot reads:
                        knowledge.index or $LANCEDB_PATH, else the persona's
                        index/ in the data home)
  --table TABLE         Table name (default: stream_chunks)
  --skip-types SKIP_TYPES
                        Comma-separated chunk_type values to drop from the
                        index (default: knowledge.archive.skipTypes or
                        $INGEST_SKIP_TYPES, else 'anime_audio,karaoke'; none
                        drops nothing). Pass an empty string to disable
                        filtering.
  --dry-run             Parse and chunk but skip embedding and writing.
  --cache-path CACHE_PATH
                        SQLite file used to cache embedding vectors so a
                        crashed/re-run ingest skips work that already
                        succeeded (default: cache/embed_cache.db in the data
                        home). Cache key is (model, dim, text); changing
                        EMBED_MODEL or EMBED_DIM auto-invalidates entries.
  --no-cache            Skip the embedding cache entirely (always re-embed).
  --clear-cache         Empty the embedding cache before this run. Every
                        persona and model shares it, so this deletes all of
                        their vectors.
  --persona PERSONA     Persona whose transcripts to ingest (default: the
                        active persona)
  --json                Write progress events to stdout as JSON lines
`;

/** The parser, with the defaults the settings and environment give right now. */
export function ingestStreamsParser(): ParserSpec {
  return {
    prog: COMMAND,
    usage: USAGE,
    help: HELP,
    actions: [
      { dest: "streams_dir", flags: ["--streams-dir"], kind: "store" },
      { dest: "db_path", flags: ["--db-path"], kind: "store" },
      { dest: "table", flags: ["--table"], kind: "store", default: STREAM_CHUNKS_TABLE },
      {
        dest: "skip_types",
        flags: ["--skip-types"],
        kind: "store",
        default: ingestStreams.defaultSkipTypes(),
      },
      { dest: "dry_run", flags: ["--dry-run"], kind: "store_true" },
      { dest: "cache_path", flags: ["--cache-path"], kind: "store" },
      { dest: "no_cache", flags: ["--no-cache"], kind: "store_true" },
      { dest: "clear_cache", flags: ["--clear-cache"], kind: "store_true" },
      { dest: "persona", flags: ["--persona"], kind: "store" },
      { dest: "json", flags: ["--json"], kind: "store_true" },
    ],
  };
}

/**
 * `--db-path` when given, else where the bot reads `persona`'s index. A `LANCEDB_PATH` from the
 * environment names one index for every persona, so with `--persona` spelled out it must be
 * overridden explicitly.
 */
export function writerDbPath(
  spec: ParserSpec,
  dbPath: string | null,
  personaFlag: string | null,
  persona: string,
): string {
  if (dbPath !== null) {
    try {
      refuseTemplatePath(persona, dbPath, "--db-path");
    } catch (error) {
      throw parserError(spec, errorText(error));
    }
    return dbPath;
  }
  if (personaFlag && process.env.LANCEDB_PATH) {
    throw parserError(
      spec,
      `LANCEDB_PATH is set in the environment; pass --db-path to write persona ${persona}'s index.`,
    );
  }
  try {
    return indexWritePath(persona);
  } catch (error) {
    throw parserError(spec, errorText(error));
  }
}

export interface IngestStreamsArgs {
  readonly streamsDir: string;
  readonly dbPath: string;
  readonly table: string;
  readonly skipTypes: ReadonlySet<string>;
  readonly dryRun: boolean;
  /** null under --no-cache. */
  readonly cachePath: string | null;
  readonly clearCache: boolean;
  readonly persona: string;
  readonly json: boolean;
}

/** Throws ArgparseExit for -h and usage errors. */
export function parseIngestStreamsArgs(argv: readonly string[]): IngestStreamsArgs {
  const spec = ingestStreamsParser();
  const ns = parseArgs(spec, argv);
  const personaFlag = ns.persona as string | null;
  const persona = commandPersona(spec, personaFlag);
  return {
    streamsDir: (ns.streams_dir as string | null) ?? sourceFolder(persona, "streams"),
    dbPath: writerDbPath(spec, ns.db_path as string | null, personaFlag, persona),
    table: ns.table as string,
    // `--skip-types ''` drops nothing, as in Python.
    skipTypes: ingestStreams.parseSkipTypes(ns.skip_types as string),
    dryRun: ns.dry_run as boolean,
    cachePath: ns.no_cache ? null : ((ns.cache_path as string | null) ?? embedCachePath()),
    clearCache: ns.clear_cache as boolean,
    persona,
    json: ns.json as boolean,
  };
}

export interface IngestStreamsDeps extends CommandDeps {
  readonly embeddingClient?: Pick<EmbeddingClient, "embedWithUsage">;
  /** When the table was built, for the meta file. */
  readonly now?: () => Date;
}

/** The `laplace-ingest-streams` command; resolves to its exit code. */
export async function ingestStreamsMain(
  argv: readonly string[],
  deps: IngestStreamsDeps = {},
): Promise<number> {
  const io = resolveIo(deps);
  let args: IngestStreamsArgs;
  try {
    args = parseIngestStreamsArgs(argv);
  } catch (error) {
    if (error instanceof ArgparseExit) return reportExit(io, error);
    throw error;
  }
  const emit = args.json ? ndjsonSink(io.stdout) : noProgress;
  logger.info(`Persona ${args.persona}'s index: ${canonicalPath(args.dbPath)}`);
  let release = () => {};
  if (!args.dryRun) {
    try {
      release = acquireLock(indexLockKey(args.dbPath), COMMAND);
    } catch (error) {
      if (!(error instanceof LockedError)) throw error;
      lockedOut(emit, "ingest-streams", error, zeroCounts("ingest-streams"), args.table);
      return 1;
    }
  }
  try {
    const report = await ingestStreams.ingestStreams({
      streamsDir: args.streamsDir,
      dbPath: args.dbPath,
      table: args.table,
      skipTypes: args.skipTypes,
      dryRun: args.dryRun,
      cachePath: args.cachePath,
      clearCache: args.clearCache,
      client: deps.embeddingClient,
      now: deps.now,
      onProgress: emit,
      signal: deps.signal,
    });
    return report.ok ? 0 : 1;
  } finally {
    release();
  }
}
