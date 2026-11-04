// Routes `main.ts <command> [args]` to the ports of the Python CLIs that share the bot's code.
import { pyRepr } from "@eidolon/config";
import { evalRetrievalMain } from "./eval_retrieval.ts";
import { gateDecisionsMain } from "./gate_decisions.ts";
import { generateImageMain } from "./generate_image.ts";
import { type CliIo, resolveIo } from "./io.ts";
import { searchMain } from "./search.ts";

type Command = (argv: readonly string[], io: CliIo) => Promise<number>;

/** Each command and the Python CLI it ports. */
export const COMMANDS: Readonly<Record<string, Command>> = {
  search: searchMain,
  "eval-retrieval": evalRetrievalMain,
  "generate-image": generateImageMain,
  "gate-decisions": gateDecisionsMain,
};

const NAMES = Object.keys(COMMANDS);
export const CLI_USAGE = `usage: main.ts [-h] {${NAMES.join(",")}} ...\n`;
const CLI_HELP = `${CLI_USAGE}
The Python CLIs the bot shares code with. Each takes its Python flags.

positional arguments:
  {${NAMES.join(",")}}
    search              laplace-search
    eval-retrieval      laplace-eval-retrieval
    generate-image      laplace-generate-image
    gate-decisions      docs/benchmarks/2026-09-19-retrieval-gate/decisions.py

options:
  -h, --help            show this help message and exit
`;

/**
 * Runs one command and resolves to the process exit code. An uncaught error is a Python
 * traceback's equivalent: its stack on stderr and exit 1.
 */
export async function runCli(argv: readonly string[], deps: Partial<CliIo> = {}): Promise<number> {
  const io = resolveIo(deps);
  const [name, ...rest] = argv;
  if (name === "-h" || name === "--help") {
    io.stdout(CLI_HELP);
    return 0;
  }
  const command = name === undefined ? undefined : COMMANDS[name];
  if (command === undefined) {
    const message =
      name === undefined
        ? "the following arguments are required: command"
        : `argument command: invalid choice: ${pyRepr(name)} (choose from ${NAMES.join(", ")})`;
    io.stderr(`${CLI_USAGE}main.ts: error: ${message}\n`);
    return 2;
  }
  try {
    return await command(rest, io);
  } catch (error) {
    io.stderr(`${error instanceof Error ? (error.stack ?? String(error)) : String(error)}\n`);
    return 1;
  }
}
