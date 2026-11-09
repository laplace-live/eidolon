// laplace-refine: has an LLM write each transcript scene's heading, summary and details.
import { activePersona, logger, sourceFolder } from "@eidolon/config";
import {
  acquireLock,
  type EventCode,
  estimatedCost,
  LockedError,
  ndjsonSink,
  noProgress,
  type ProgressSink,
  refine,
  sourcesLockKey,
  zeroCounts,
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

// A usage error up front: createLimiter throws on fewer than 1 slot only once a stream has chunks
// to refine.
export const CONCURRENCY: ArgType<number> = {
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

/** A REFINE_CONCURRENCY below 1 as a usage error; a flag's value is checked by CONCURRENCY. */
export function checkConcurrency(spec: ParserSpec, concurrency: number): void {
  if (concurrency < 1) {
    throw parserError(spec, `REFINE_CONCURRENCY must be at least 1, not ${concurrency}`);
  }
}

/** Throws ArgparseExit for -h and usage errors. */
export function parseRefineArgs(argv: readonly string[]): RefineArgs {
  const spec = refineParser();
  const ns = parseArgs(spec, argv);
  const persona = commandPersona(spec, ns.persona as string | null);
  const concurrency = ns.concurrency as number;
  checkConcurrency(spec, concurrency);
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

/** A run that stopped before refining: why, as a failed stage, then its summary. */
function refused(emit: ProgressSink, code: EventCode, message: string): number {
  logger.error(message);
  emit({ type: "stage", stage: "refine", status: "failed", code, message });
  emit({
    type: "summary",
    stage: "refine",
    ok: false,
    counts: zeroCounts("refine"),
    durationSec: 0,
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
  const emit = args.json ? ndjsonSink(io.stdout) : noProgress;
  let run: refine.RefineRun;
  try {
    run = await refine.runRefine({
      paths: args.paths,
      streamsDir: args.streamsDir,
      model: args.model,
      concurrency: args.concurrency,
      force: args.force,
      dryRun: args.dryRun,
      // Under --json stdout carries only the events.
      print: args.json ? io.stderr : io.stdout,
      hold: () => acquireLock(sourcesLockKey(args.persona), COMMAND),
      fetch: deps.fetch,
      now: deps.now,
      monotonic: deps.monotonic,
      onProgress: emit,
      signal: deps.signal,
    });
  } catch (error) {
    if (!(error instanceof LockedError)) throw error;
    return refused(emit, "locked", error.message);
  }
  switch (run.kind) {
    case "cancelled":
      return 1;
    case "unreadable":
      throw run.error;
    case "empty":
      emit({
        type: "summary",
        stage: "refine",
        ok: true,
        counts: zeroCounts("refine"),
        durationSec: 0,
      });
      return 0;
    case "dry-run": {
      const { report } = run;
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
        durationSec: run.durationSec,
        ...estimatedCost(report.costUsd),
      });
      return 0;
    }
    case "no-key":
      return refused(emit, "missing-credential", refine.missingApiKey());
    case "done":
      return run.report.ok ? 0 : 1;
  }
}
