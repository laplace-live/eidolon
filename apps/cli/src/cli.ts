// Routes `main.ts <command> [args]`, which every `laplace-*` script runs, to its command.
import { pyRepr } from "@eidolon/config";
import { CLEANUP_LIMIT_MS } from "@eidolon/ingest";
import { buildStreamCatalogMain } from "./build_stream_catalog.ts";
import { downloadMain } from "./download.ts";
import { evalRetrievalMain } from "./eval_retrieval.ts";
import { extractUsersMain } from "./extract_users.ts";
import { gateDecisionsMain } from "./gate_decisions.ts";
import { generateImageMain } from "./generate_image.ts";
import { ingestFactsMain } from "./ingest_facts.ts";
import { ingestStreamsMain } from "./ingest_streams.ts";
import { type CommandDeps, resolveIo } from "./io.ts";
import { pipelineMain } from "./pipeline.ts";
import { prepareBatchMain } from "./prepare_batch.ts";
import { refineMain } from "./refine.ts";
import { searchMain } from "./search.ts";
import { transcribeMain } from "./transcribe.ts";

type Command = (argv: readonly string[], deps: CommandDeps) => Promise<number>;

export const COMMANDS: Readonly<Record<string, Command>> = {
  search: searchMain,
  "eval-retrieval": evalRetrievalMain,
  "generate-image": generateImageMain,
  "gate-decisions": gateDecisionsMain,
  download: downloadMain,
  transcribe: transcribeMain,
  refine: refineMain,
  "ingest-streams": ingestStreamsMain,
  "ingest-facts": ingestFactsMain,
  "build-stream-catalog": buildStreamCatalogMain,
  pipeline: pipelineMain,
  "extract-users": extractUsersMain,
  "prepare-batch": prepareBatchMain,
};

// These never read deps.signal, so the first Ctrl-C quits them at once instead of leaving them
// running, silently, until the cleanup limit.
const IGNORE_SIGNAL: ReadonlySet<string> = new Set([
  "search",
  "eval-retrieval",
  "generate-image",
  "gate-decisions",
  "prepare-batch",
]);

/** How long the command `argv` names may take to stop after the first SIGINT or SIGTERM. */
export function cleanupLimitMs(argv: readonly string[]): number {
  return IGNORE_SIGNAL.has(argv[0] ?? "") ? 0 : CLEANUP_LIMIT_MS;
}

const NAMES = Object.keys(COMMANDS);
export const CLI_USAGE = `usage: main.ts [-h]\n               {${NAMES.join(",")}} ...\n`;
const CLI_HELP = `${CLI_USAGE}
The TypeScript ports of the Python CLIs. Each takes its Python flags.

positional arguments:
  {${NAMES.join(",")}}
    search              laplace-search
    eval-retrieval      laplace-eval-retrieval
    generate-image      laplace-generate-image
    gate-decisions      docs/benchmarks/2026-09-19-retrieval-gate/decisions.py
    download            laplace-download
    transcribe          laplace-transcribe
    refine              laplace-refine
    ingest-streams      laplace-ingest-streams
    ingest-facts        laplace-ingest-facts
    build-stream-catalog
                        laplace-build-stream-catalog
    pipeline            laplace-pipeline
    extract-users       laplace-extract-users
    prepare-batch       laplace-prepare-batch

options:
  -h, --help            show this help message and exit
`;

/**
 * Runs one command and resolves to the process exit code. An uncaught error prints its stack on
 * stderr and exits 1.
 */
export async function runCli(argv: readonly string[], deps: CommandDeps = {}): Promise<number> {
  const io = resolveIo(deps);
  const [name, ...rest] = argv;
  if (name === "-h" || name === "--help") {
    io.stdout(CLI_HELP);
    return 0;
  }
  const command = name === undefined || !Object.hasOwn(COMMANDS, name) ? undefined : COMMANDS[name];
  if (command === undefined) {
    const message =
      name === undefined
        ? "the following arguments are required: command"
        : `argument command: invalid choice: ${pyRepr(name)} (choose from ${NAMES.join(", ")})`;
    io.stderr(`${CLI_USAGE}main.ts: error: ${message}\n`);
    return 2;
  }
  try {
    return await command(rest, { ...io, signal: deps.signal });
  } catch (error) {
    io.stderr(`${error instanceof Error ? (error.stack ?? String(error)) : String(error)}\n`);
    return 1;
  }
}
