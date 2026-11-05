import type { ArgparseExit } from "./argparse.ts";

/** Where a command writes: Python's `print` and `print(..., file=sys.stderr)`. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const processIo: CliIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** What every command takes: where it writes, and the signal SIGINT and SIGTERM abort. */
export interface CommandDeps extends Partial<CliIo> {
  readonly signal?: AbortSignal;
}

export function resolveIo(deps: Partial<CliIo>): CliIo {
  return { stdout: deps.stdout ?? processIo.stdout, stderr: deps.stderr ?? processIo.stderr };
}

/** `print(line)` onto `write`. */
export function printer(write: (text: string) => void): (line?: string) => void {
  return (line = "") => write(`${line}\n`);
}

/** What argparse writes on its way out; the exit code. */
export function reportExit(io: CliIo, exit: ArgparseExit): number {
  if (exit.stdout) io.stdout(exit.stdout);
  if (exit.stderr) io.stderr(exit.stderr);
  return exit.code;
}
