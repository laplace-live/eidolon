// How the web app runs a command as a job: this CLI as a child process, reporting NDJSON. Keep this
// module import-free: the web app imports it (`@eidolon/cli/job`) without Node's modules.

/**
 * The argv of a job running `command` through the CLI at `entry` (@eidolon/config's cliEntry), with
 * progress events on stdout.
 */
export function jobArgv(
  entry: string,
  command: string,
  args: readonly string[],
): [string, ...string[]] {
  return [process.execPath, entry, command, "--json", ...args];
}

/** What the web app sends a job over its IPC channel to stop it, as SIGTERM would: Windows has none. */
export const STOP_MESSAGE = { kind: "stop" } as const;

/** The parts of `process` relayStopMessages uses; tests pass a fake. */
export interface MessageHost {
  readonly channel?: { unref(): void };
  on(event: "message", listener: (message: unknown) => void): unknown;
  emit(event: "SIGTERM", signal: "SIGTERM"): unknown;
}

/**
 * Turns each STOP_MESSAGE that reaches `host` over its IPC channel into a SIGTERM for its listeners,
 * the channel never keeping `host` alive. A no-op without a channel.
 */
export function relayStopMessages(host: MessageHost): void {
  const { channel } = host;
  if (channel === undefined) return;
  host.on("message", (message) => {
    if ((message as { kind?: unknown } | null)?.kind === STOP_MESSAGE.kind) {
      host.emit("SIGTERM", "SIGTERM");
    }
  });
  channel.unref();
}
