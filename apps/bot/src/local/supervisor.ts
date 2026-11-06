// `bun run local` keeps the server in a child process: when the server exits 75, it asks for a
// fresh one, which is how settings read once at boot take effect. Otherwise this process exits with
// the child's code. The child gets its own process group, so a terminal's Ctrl-C reaches it once,
// through here, and an IPC channel ends it if this process is killed outright.
import { join } from "node:path";
import type { Subprocess } from "bun";
import { localArgv, parseLocalArgs } from "./args.ts";

/** EX_TEMPFAIL: the server stopped so that a new one can start. */
export const RESTART_EXIT_CODE = 75;

export const SERVER_ENTRY = join(import.meta.dir, "server.ts");

/** What the server tells the supervisor once it listens. */
export interface ListeningMessage {
  readonly kind: "listening";
  readonly port: number;
}

function isListening(message: unknown): message is ListeningMessage {
  const value = message as Partial<ListeningMessage> | null;
  return value?.kind === "listening" && typeof value.port === "number";
}

export type ForwardedSignal = "SIGINT" | "SIGTERM";

/** Calls `forward` for each signal to pass on, and returns what stops listening for them. */
export type SignalSource = (forward: (signal: ForwardedSignal) => void) => () => void;

const processSignals: SignalSource = (forward) => {
  const handlers = {
    SIGINT: () => forward("SIGINT"),
    SIGTERM: () => forward("SIGTERM"),
    // The terminal closed: the child, in its own session, would never hear of it.
    SIGHUP: () => forward("SIGTERM"),
  };
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  return () => {
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
  };
};

export interface SuperviseOptions {
  readonly entry?: string;
  readonly signals?: SignalSource;
}

/**
 * Runs the server until it exits other than with 75; resolves with its exit code (128 + the
 * signal's number when a signal ended it). A restart keeps the port it was bound to and opens no
 * second browser tab.
 */
export async function supervise(
  argv: readonly string[],
  options: SuperviseOptions = {},
): Promise<number> {
  let args = parseLocalArgs(argv);
  let child: Subprocess | null = null;
  let stopping = false;
  let boundPort: number | null = null;
  const unsubscribe = (options.signals ?? processSignals)((signal) => {
    stopping = true;
    child?.kill(signal);
  });
  try {
    for (;;) {
      boundPort = null;
      // No env: the server applies the .env itself. Passing what this process applied from it
      // would keep a key deleted from the .env since alive across every restart.
      child = Bun.spawn(
        [process.execPath, "--no-env-file", options.entry ?? SERVER_ENTRY, ...localArgv(args)],
        {
          stdio: ["ignore", "inherit", "inherit"],
          detached: process.platform !== "win32",
          ipc(message) {
            if (isListening(message)) boundPort = message.port;
          },
        },
      );
      const code = await child.exited;
      child = null;
      if (code !== RESTART_EXIT_CODE || stopping) return code;
      args = { ...args, port: boundPort ?? args.port, open: false };
    }
  } finally {
    unsubscribe();
  }
}
