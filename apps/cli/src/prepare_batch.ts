// laplace-prepare-batch, the stream-archive-embed skill's batch step: turns a complete archive
// capture into a new batch of the videos no list has yet, after checking the capture against the
// archive's total.
import { pyJsonDumps } from "@eidolon/config";
import { canonicalPath, download, sourceFolder } from "@eidolon/ingest";
import {
  ArgparseExit,
  commandPersona,
  INT,
  type Namespace,
  PATH,
  type ParserSpec,
  parseArgs,
} from "./argparse.ts";
import { type CommandDeps, reportExit, resolveIo } from "./io.ts";

const USAGE = `usage: laplace-prepare-batch [-h] --expected-count EXPECTED_COUNT
                             [--lists-dir LISTS_DIR] [--source SOURCE]
                             [--dry-run] [--persona PERSONA]
                             capture
`;

export const PREPARE_BATCH_PARSER: ParserSpec = {
  prog: "laplace-prepare-batch",
  usage: USAGE,
  help: `${USAGE}
Turn a complete archive capture into a deduplicated pipeline URL list.

positional arguments:
  capture               Complete capture: one BV ID or URL per line

options:
  -h, --help            show this help message and exit
  --expected-count EXPECTED_COUNT
                        Archive's displayed total
  --lists-dir LISTS_DIR
                        Folder of URL lists, batches/ inside (default: the
                        persona's lists/ in the data home's sources)
  --source SOURCE       Where the capture came from, for the batch's header
  --dry-run             Print the plan without writing files
  --persona PERSONA     Persona whose lists to use (default: the active
                        persona)
`,
  actions: [
    { dest: "capture", flags: [], kind: "store", type: PATH },
    {
      dest: "expected_count",
      flags: ["--expected-count"],
      kind: "store",
      type: INT,
      required: true,
    },
    { dest: "lists_dir", flags: ["--lists-dir"], kind: "store", type: PATH },
    { dest: "source", flags: ["--source"], kind: "store" },
    { dest: "dry_run", flags: ["--dry-run"], kind: "store_true" },
    { dest: "persona", flags: ["--persona"], kind: "store" },
  ],
};

// OSError and ValueError with their subclasses, by the names pyError gives them: the expected
// failures, reported as their message alone; anything else keeps its stack.
const REPORTED = new Set([
  "OSError",
  "FileNotFoundError",
  "FileExistsError",
  "IsADirectoryError",
  "NotADirectoryError",
  "PermissionError",
  "ValueError",
  "UnicodeDecodeError",
]);

export interface PrepareBatchDeps extends CommandDeps {
  /** The batch's time; the wall clock by default. */
  readonly now?: () => Date;
}

/** The `laplace-prepare-batch` command; resolves to its exit code. */
export async function prepareBatchMain(
  argv: readonly string[],
  deps: PrepareBatchDeps = {},
): Promise<number> {
  const io = resolveIo(deps);
  let ns: Namespace;
  let persona: string;
  try {
    ns = parseArgs(PREPARE_BATCH_PARSER, argv);
    persona = commandPersona(PREPARE_BATCH_PARSER, ns.persona as string | null);
  } catch (error) {
    if (error instanceof ArgparseExit) return reportExit(io, error);
    throw error;
  }
  const listsDir = canonicalPath((ns.lists_dir as string | null) ?? sourceFolder(persona, "lists"));
  try {
    const result = download.prepareBatch(
      listsDir,
      ns.capture as string,
      ns.expected_count as number,
      {
        dryRun: ns.dry_run as boolean,
        ...(ns.source === null ? {} : { source: ns.source as string }),
        now: deps.now?.() ?? new Date(),
      },
    );
    io.stdout(`${pyJsonDumps(result, { ensureAscii: false, indent: 2 })}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Error && REPORTED.has(error.name)) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
