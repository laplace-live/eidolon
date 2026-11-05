// laplace-build-stream-catalog: writes stream_catalog.json, the broadcasts recalled by date.
import { type Clock, logger, sourceFolder } from "@eidolon/config";
import {
  acquireLock,
  canonicalPath,
  catalog,
  indexLockKey,
  LockedError,
  ndjsonSink,
  noProgress,
} from "@eidolon/ingest";
import { CATALOG_FILENAME } from "@eidolon/retrieval";
import { ArgparseExit, commandPersona, PATH, type ParserSpec, parseArgs } from "./argparse.ts";
import { lockedOut, writerDbPath } from "./ingest_streams.ts";
import { type CommandDeps, reportExit, resolveIo } from "./io.ts";

const COMMAND = "laplace-build-stream-catalog";

const USAGE = `usage: laplace-build-stream-catalog [-h] [--streams-dir STREAMS_DIR]
                                    [--db-path DB_PATH] [--persona PERSONA]
                                    [--json]
`;

const HELP = `${USAGE}
Build broadcast overviews from every transcript scene, including songs and
anime playback.

options:
  -h, --help            show this help message and exit
  --streams-dir STREAMS_DIR
                        Directory of *.md transcripts (default: the persona's
                        streams/ in the data home's sources)
  --db-path DB_PATH     Where stream_catalog.json goes (default: the index the
                        bot reads: knowledge.index or $LANCEDB_PATH, else the
                        persona's index/ in the data home)
  --persona PERSONA     Persona whose transcripts to read (default: the active
                        persona)
  --json                Write progress events to stdout as JSON lines
`;

export const BUILD_STREAM_CATALOG_PARSER: ParserSpec = {
  prog: COMMAND,
  usage: USAGE,
  help: HELP,
  actions: [
    { dest: "streams_dir", flags: ["--streams-dir"], kind: "store", type: PATH },
    { dest: "db_path", flags: ["--db-path"], kind: "store", type: PATH },
    { dest: "persona", flags: ["--persona"], kind: "store" },
    { dest: "json", flags: ["--json"], kind: "store_true" },
  ],
};

export interface BuildStreamCatalogArgs {
  /** As given: `source_paths` are relative to its parent, unresolved. */
  readonly streamsDir: string;
  readonly dbPath: string;
  readonly persona: string;
  readonly json: boolean;
}

/** Throws ArgparseExit for -h and usage errors. */
export function parseBuildStreamCatalogArgs(argv: readonly string[]): BuildStreamCatalogArgs {
  const spec = BUILD_STREAM_CATALOG_PARSER;
  const ns = parseArgs(spec, argv);
  const personaFlag = ns.persona as string | null;
  const persona = commandPersona(spec, personaFlag);
  return {
    streamsDir: (ns.streams_dir as string | null) ?? sourceFolder(persona, "streams"),
    dbPath: writerDbPath(spec, ns.db_path as string | null, personaFlag, persona),
    persona,
    json: ns.json as boolean,
  };
}

export interface BuildStreamCatalogDeps extends CommandDeps {
  /** Microseconds since the epoch, for `built_at`. */
  readonly clock?: Clock;
}

/** The `laplace-build-stream-catalog` command; resolves to its exit code. */
export async function buildStreamCatalogMain(
  argv: readonly string[],
  deps: BuildStreamCatalogDeps = {},
): Promise<number> {
  const io = resolveIo(deps);
  let args: BuildStreamCatalogArgs;
  try {
    args = parseBuildStreamCatalogArgs(argv);
  } catch (error) {
    if (error instanceof ArgparseExit) return reportExit(io, error);
    throw error;
  }
  const emit = args.json ? ndjsonSink(io.stdout) : noProgress;
  logger.info(`Persona ${args.persona}'s index: ${canonicalPath(args.dbPath)}`);
  let release: () => void;
  try {
    release = acquireLock(indexLockKey(args.dbPath), COMMAND);
  } catch (error) {
    if (!(error instanceof LockedError)) throw error;
    return lockedOut(emit, "catalog", error, { broadcasts: 0, parts: 0 }, CATALOG_FILENAME);
  }
  try {
    const report = await catalog.writeStreamCatalog({
      streamsDir: args.streamsDir,
      dbPath: args.dbPath,
      clock: deps.clock,
      onProgress: emit,
      signal: deps.signal,
    });
    return report.ok ? 0 : 1;
  } finally {
    release();
  }
}
