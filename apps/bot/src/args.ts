// argparse parity for the three runner flags the bot keeps; the Docker CMD passes --host/--port.
import { pyRepr } from "@eidolon/config";

export interface BotArgs {
  readonly host: string;
  /** 0 picks a free port. */
  readonly port: number;
  /** The -v count; above 0 logs at TRACE. */
  readonly verbose: number;
}

const PROG = "main.ts";
export const BOT_USAGE = `usage: ${PROG} [-h] [--host HOST] [--port PORT] [-v]`;
const HELP = `${BOT_USAGE}

options:
  -h, --help     show this help message and exit
  --host HOST    Host address
  --port PORT    Port number
  -v, --verbose  Increase logging verbosity
`;

// Python int(): surrounding whitespace, a sign and digit underscores.
const INT = /^[+-]?\d+(?:_\d+)*$/;
const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/;

/** argparse `_parse_optional`: a dash-led word is a flag unless it is `-`, a negative number or has a space. */
function looksLikeFlag(word: string): boolean {
  return (
    word.length > 1 && word.startsWith("-") && !NEGATIVE_NUMBER.test(word) && !word.includes(" ")
  );
}

function usageError(message: string): never {
  process.stderr.write(`${BOT_USAGE}\n${PROG}: error: ${message}\n`);
  process.exit(2);
}

function help(): never {
  process.stdout.write(HELP);
  process.exit(0);
}

/** A usage error writes argparse's usage and message to stderr and exits 2; -h exits 0. */
export function parseBotArgs(argv: readonly string[]): BotArgs {
  let host = "localhost";
  let port = 7860;
  let verbose = 0;
  const unrecognized: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || looksLikeFlag(next)) {
        usageError(`argument ${flag}: expected one argument`);
      }
      i++;
      return next;
    };
    if (flag === "--host") {
      host = value();
    } else if (flag === "--port") {
      const raw = value();
      if (!INT.test(raw.trim())) usageError(`argument --port: invalid int value: ${pyRepr(raw)}`);
      port = Number(raw.trim().replaceAll("_", ""));
    } else if (flag === "--verbose") {
      if (inline !== undefined) {
        usageError(`argument -v/--verbose: ignored explicit argument ${pyRepr(inline)}`);
      }
      verbose++;
    } else if (flag === "--help") {
      help();
    } else if (looksLikeFlag(arg) && !arg.startsWith("--")) {
      for (let j = 1; j < arg.length; j++) {
        if (arg[j] === "v") verbose++;
        else if (arg[j] === "h") help();
        else {
          unrecognized.push(`-${arg.slice(j)}`);
          break;
        }
      }
    } else {
      unrecognized.push(arg);
    }
  }
  if (unrecognized.length > 0) usageError(`unrecognized arguments: ${unrecognized.join(" ")}`);
  return { host, port, verbose };
}
