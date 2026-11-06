// The local entry's flags, with the bot's argparse rules (apps/bot/src/args.ts) and prog `eidolon`,
// the command a packaged install runs. --host must stay on this computer: there is no remote mode.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { pyParseInt, pyRepr } from "@eidolon/config";
import { isLoopbackAddress } from "./guard.ts";

export interface LocalArgs {
  readonly host: string;
  /** 0 picks a free port. */
  readonly port: number;
  /** The -v count: 0 logs at INFO, 1 at DEBUG, more at TRACE. */
  readonly verbose: number;
  readonly open: boolean;
}

const PROG = "eidolon";
export const LOCAL_USAGE = `usage: ${PROG} [-h] [--host HOST] [--port PORT] [-v] [--open | --no-open]`;
const HELP = `${LOCAL_USAGE}

Runs Eidolon's web app on this computer and prints the link that signs a browser in.

options:
  -h, --help         show this help message and exit
  --host HOST        Loopback address to listen on (default: localhost)
  --port PORT        Port number (default: 7860; 0 picks a free one)
  -v, --verbose      Increase logging verbosity
  --open, --no-open  Open the link in a browser (default: open, except over SSH)

From another computer, forward the port instead: ssh -L 7860:localhost:7860 <this computer>
`;

const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/;

function looksLikeFlag(word: string): boolean {
  return (
    word.length > 1 && word.startsWith("-") && !NEGATIVE_NUMBER.test(word) && !word.includes(" ")
  );
}

function usageError(message: string): never {
  process.stderr.write(`${LOCAL_USAGE}\n${PROG}: error: ${message}\n`);
  process.exit(2);
}

function help(): never {
  process.stdout.write(HELP);
  process.exit(0);
}

/** A usage error writes the usage and message to stderr and exits 2; -h exits 0. */
export function parseLocalArgs(argv: readonly string[]): LocalArgs {
  let host = "localhost";
  let port = 7860;
  let verbose = 0;
  let open = true;
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
    const noValue = (name: string): void => {
      if (inline !== undefined) {
        usageError(`argument ${name}: ignored explicit argument ${pyRepr(inline)}`);
      }
    };
    if (flag === "--host") {
      host = value();
    } else if (flag === "--port") {
      const raw = value();
      const parsed = pyParseInt(raw);
      if (parsed === null) usageError(`argument --port: invalid int value: ${pyRepr(raw)}`);
      if (parsed < 0 || parsed > 65535) {
        usageError(`argument --port: ${parsed} is not a port number (0 to 65535)`);
      }
      port = parsed;
    } else if (flag === "--verbose") {
      noValue("-v/--verbose");
      verbose++;
    } else if (flag === "--open" || flag === "--no-open") {
      noValue("--open/--no-open");
      open = flag === "--open";
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
  return { host, port, verbose, open };
}

/** The flags that parse back to `args`, for the supervisor's child. */
export function localArgv(args: LocalArgs): string[] {
  return [
    `--host=${args.host}`,
    `--port=${args.port}`,
    ...(args.verbose > 0 ? [`-${"v".repeat(args.verbose)}`] : []),
    args.open ? "--open" : "--no-open",
  ];
}

export interface LocalHost {
  /** startBotServer's host: `localhost` listens on every address it resolves to. */
  readonly bind: string;
  /** How the printed link names this computer. */
  readonly urlHost: string;
  /** Bound IP literals that Host may name besides localhost, 127.0.0.1 and [::1]. */
  readonly literals: readonly string[];
}

export type LookupAll = (host: string) => Promise<readonly { address: string }[]>;

const lookupAll: LookupAll = (host) => lookup(host, { all: true });

/**
 * --host resolved as startBotServer binds it: a usage error (exit 2) unless every address it
 * resolves to is loopback, 127.0.0.0/8 or ::1.
 */
export async function resolveLocalHost(host: string, resolve = lookupAll): Promise<LocalHost> {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  let addresses: string[];
  if (isIP(bare)) {
    addresses = [bare];
  } else {
    try {
      addresses = (await resolve(bare)).map((entry) => entry.address);
    } catch {
      usageError(`argument --host: cannot resolve ${pyRepr(host)}`);
    }
  }
  if (addresses.length === 0 || !addresses.every(isLoopbackAddress)) {
    usageError(
      `argument --host: ${pyRepr(host)} is not a loopback address; Eidolon serves this ` +
        "computer only (from another one, forward the port: ssh -L 7860:localhost:7860 <host>)",
    );
  }
  const literal = isIP(bare) ? (bare.includes(":") ? `[${bare}]` : bare) : null;
  return {
    bind: bare,
    urlHost: literal ?? "localhost",
    literals: literal === null ? [] : [literal],
  };
}
