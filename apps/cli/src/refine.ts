// laplace-refine: has an LLM write each transcript scene's heading, summary and details.
import { activePersona, logger, sourceFolder } from "@eidolon/config";
import {
  acquireLock,
  type EventCode,
  LockedError,
  ndjsonSink,
  noProgress,
  type ParsedStream,
  type ProgressSink,
  refine,
  sourcesLockKey,
} from "@eidolon/ingest";
import {
  ArgparseExit,
  type ArgType,
  ArgumentTypeError,
  commandPersona,
  INT,
  PATH,
  type ParserSpec,
  parseArgs,
  parserError,
} from "./argparse.ts";
import { type CommandDeps, reportExit, resolveIo } from "./io.ts";

const USAGE = `usage: laplace-refine [-h] [--streams-dir STREAMS_DIR] [--model MODEL]
                      [--concurrency CONCURRENCY] [--force] [--dry-run]
                      [--persona PERSONA] [--json]
                      [paths ...]
`;

const HELP = `${USAGE}
LLM post-process raw stream transcripts into clean memory records.

positional arguments:
  paths                 Specific streams/*.md files to refine. Default: all
                        under --streams-dir

options:
  -h, --help            show this help message and exit
  --streams-dir STREAMS_DIR
                        Directory of *.md transcripts (default: the persona's
                        streams/ in the data home's sources)
  --model MODEL         OpenRouter model slug (default: refine.model or
                        $REFINE_MODEL, else ~google/gemini-pro-latest).
                        Cheaper bulk option: ~google/gemini-flash-latest.
  --concurrency CONCURRENCY
                        Max concurrent LLM calls (default: refine.concurrency
                        or $REFINE_CONCURRENCY, else 8)
  --force               Re-refine all chunks even if a sidecar already exists.
  --dry-run             Estimate cost without making any LLM calls.
  --persona PERSONA     Persona whose transcripts to refine (default: the
                        active persona)
  --json                Write progress events to stdout as JSON lines, and the
                        summary to stderr
`;

const COMMAND = "laplace-refine";

// Python's asyncio.Semaphore(0) hangs the run and a negative one crashes every stream.
const CONCURRENCY: ArgType<number> = {
  name: "int",
  parse(text: string): number {
    const value = INT.parse(text);
    if (value < 1) throw new ArgumentTypeError(`must be at least 1, not ${value}`);
    return value;
  },
};

/** The parser, with the defaults the settings and environment give right now. */
export function refineParser(): ParserSpec {
  return {
    prog: COMMAND,
    usage: USAGE,
    help: HELP,
    actions: [
      { dest: "paths", flags: [], kind: "store", nargs: "*", type: PATH },
      {
        dest: "streams_dir",
        flags: ["--streams-dir"],
        kind: "store",
        type: PATH,
        default: sourceFolder(activePersona().id, "streams"),
      },
      {
        dest: "model",
        flags: ["--model"],
        kind: "store",
        default: refine.refineModel(),
      },
      {
        dest: "concurrency",
        flags: ["--concurrency"],
        kind: "store",
        type: CONCURRENCY,
        default: refine.refineConcurrency(),
      },
      { dest: "force", flags: ["--force"], kind: "store_true" },
      { dest: "dry_run", flags: ["--dry-run"], kind: "store_true" },
      { dest: "persona", flags: ["--persona"], kind: "store" },
      { dest: "json", flags: ["--json"], kind: "store_true" },
    ],
  };
}

export interface RefineArgs {
  readonly paths: readonly string[];
  readonly streamsDir: string;
  readonly model: string;
  readonly concurrency: number;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly persona: string;
  readonly json: boolean;
}

/** Throws ArgparseExit for -h and usage errors. */
export function parseRefineArgs(argv: readonly string[]): RefineArgs {
  const spec = refineParser();
  const ns = parseArgs(spec, argv);
  const persona = commandPersona(spec, ns.persona as string | null);
  const concurrency = ns.concurrency as number;
  if (concurrency < 1) {
    throw parserError(spec, `REFINE_CONCURRENCY must be at least 1, not ${concurrency}`);
  }
  return {
    paths: ns.paths as string[],
    streamsDir: ns.streams_dir as string,
    model: ns.model as string,
    concurrency,
    force: ns.force as boolean,
    dryRun: ns.dry_run as boolean,
    persona,
    json: ns.json as boolean,
  };
}

export interface RefineDeps extends CommandDeps {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  /** Seconds on a monotonic clock. */
  readonly monotonic?: () => number;
}

const ZERO_COUNTS = {
  streams: 0,
  chunksNew: 0,
  chunksSkipped: 0,
  chunksFailed: 0,
  tokensIn: 0,
  tokensOut: 0,
} as const;

/** A run that stopped before refining: why, as a failed stage, then its summary. */
function refused(emit: ProgressSink, code: EventCode, message: string): number {
  logger.error(message);
  emit({ type: "stage", stage: "refine", status: "failed", code, message });
  emit({ type: "summary", stage: "refine", ok: false, counts: ZERO_COUNTS, durationSec: 0 });
  return 1;
}

/** A run a signal stopped before refining: a cancelled stage, then its summary. */
function cancelled(emit: ProgressSink, durationSec: number): number {
  emit({ type: "stage", stage: "refine", status: "cancelled" });
  emit({
    type: "summary",
    stage: "refine",
    ok: false,
    cancelled: true,
    counts: ZERO_COUNTS,
    durationSec,
  });
  return 1;
}

/** The `laplace-refine` command; resolves to its exit code. */
export async function refineMain(argv: readonly string[], deps: RefineDeps = {}): Promise<number> {
  const io = resolveIo(deps);
  let args: RefineArgs;
  try {
    args = parseRefineArgs(argv);
  } catch (error) {
    if (error instanceof ArgparseExit) return reportExit(io, error);
    throw error;
  }
  // Under --json stdout carries only the events.
  const print = args.json ? io.stderr : io.stdout;
  const emit = args.json ? ndjsonSink(io.stdout) : noProgress;
  const clock = deps.monotonic ?? (() => performance.now() / 1000);
  const started = clock();

  let streams: ParsedStream[];
  try {
    streams = await refine.selectStreams(args.paths, args.streamsDir, deps.signal);
  } catch (error) {
    if (!deps.signal?.aborted) throw error;
    return cancelled(emit, clock() - started);
  }
  if (streams.length === 0) {
    logger.warning("No streams to process. Add files under streams/ or pass paths.");
    emit({ type: "summary", stage: "refine", ok: true, counts: ZERO_COUNTS, durationSec: 0 });
    return 0;
  }

  if (args.dryRun) {
    let report: refine.DryRunReport;
    try {
      report = await refine.dryRun(streams, args.model, deps.signal);
    } catch (error) {
      if (!deps.signal?.aborted) throw error;
      return cancelled(emit, clock() - started);
    }
    print(report.text);
    emit({
      type: "summary",
      stage: "refine",
      ok: true,
      counts: {
        streams: report.streams,
        chunksNew: report.chunks,
        chunksSkipped: report.skipped,
        chunksFailed: 0,
        tokensIn: report.tokensIn,
        tokensOut: report.tokensOut,
      },
      durationSec: clock() - started,
      ...(report.costUsd === null
        ? { costSource: "unpriced" as const }
        : { costUsd: report.costUsd, costSource: "estimated" as const }),
    });
    return 0;
  }

  const apiKey = refine.refineApiKey();
  if (apiKey === undefined) return refused(emit, "missing-credential", refine.MISSING_API_KEY);
  let release: () => void;
  try {
    release = acquireLock(sourcesLockKey(args.persona), COMMAND);
  } catch (error) {
    if (!(error instanceof LockedError)) throw error;
    return refused(emit, "locked", error.message);
  }
  try {
    const client = refine.refineClient(apiKey, { signal: deps.signal, fetch: deps.fetch });
    logger.info(
      `Refining ${streams.length} stream(s) with ${args.model} ` +
        `(concurrency=${args.concurrency}, force=${args.force ? "True" : "False"})`,
    );
    const report = await refine.refineStreams(streams, {
      client,
      model: args.model,
      concurrency: args.concurrency,
      force: args.force,
      identity: activePersona().identity,
      onProgress: emit,
      signal: deps.signal,
      now: deps.now,
      monotonic: clock,
    });
    print(refine.formatRunSummary(report.results, args.model, report.durationSec));
    return report.ok ? 0 : 1;
  } finally {
    release();
  }
}
