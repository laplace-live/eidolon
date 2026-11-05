// Concurrency and cancellation for the offline chain: a FIFO limiter (asyncio.Semaphore's order),
// the CLI's signal handling, and stopping child processes.
import type { Subprocess } from "bun";

/** Runs `task` once a slot frees, in the order tasks were queued. */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * At most `concurrency` tasks at once. Once `signal` aborts, a task that hasn't started never does:
 * it rejects with the signal's reason. Tasks already running carry on.
 */
export function createLimiter(concurrency: number, signal?: AbortSignal): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer, not ${concurrency}`);
  }
  let active = 0;
  const queue: (() => void)[] = [];
  const pump = (): void => {
    while (queue.length > 0 && (active < concurrency || signal?.aborted)) {
      (queue.shift() as () => void)();
    }
  };
  signal?.addEventListener("abort", pump, { once: true });
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        active++;
        let running: Promise<T>;
        try {
          running = task();
        } catch (error) {
          running = Promise.reject(error);
        }
        running.then(resolve, reject).finally(() => {
          active--;
          pump();
        });
      });
      pump();
    });
}

const SIGNALS = { SIGINT: 130, SIGTERM: 143 } as const;
type HandledSignal = keyof typeof SIGNALS;

/** How long a cancelled run may take to clean up before the process exits anyway. */
export const CLEANUP_LIMIT_MS = 10_000;

/** The parts of `process` runWithSignals uses; tests pass a fake. */
export interface SignalHost {
  on(event: HandledSignal, listener: () => void): unknown;
  off(event: HandledSignal, listener: () => void): unknown;
  exit(code: number): void;
  readonly stderr: { write(text: string): unknown };
}

/**
 * Runs a command with an AbortSignal that SIGINT and SIGTERM abort. The first signal starts a
 * graceful stop of at most `cleanupLimitMs`, saying how to skip it; a second signal, or a stop
 * that outlasts the limit, exits at once. Pass 0 for a run that never reads its signal, so the
 * first signal exits at once. A run a signal stopped exits 130 (SIGINT) or 143 (SIGTERM), whatever
 * it returned.
 */
export async function runWithSignals(
  run: (signal: AbortSignal) => Promise<number>,
  host: SignalHost = process,
  cleanupLimitMs: number = CLEANUP_LIMIT_MS,
): Promise<number> {
  const controller = new AbortController();
  let received: HandledSignal | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const listeners = (Object.keys(SIGNALS) as HandledSignal[]).map((name) => {
    const listener = (): void => {
      if (received !== null) {
        host.exit(SIGNALS[name]);
        return;
      }
      received = name;
      if (cleanupLimitMs > 0) {
        const again = name === "SIGINT" ? "press Ctrl-C" : "send SIGTERM";
        host.stderr.write(`Stopping; ${again} again to quit now.\n`);
      }
      deadline = setTimeout(() => host.exit(SIGNALS[name]), cleanupLimitMs);
      controller.abort(new DOMException(`Interrupted by ${name}`, "AbortError"));
    };
    host.on(name, listener);
    return [name, listener] as const;
  });
  try {
    const code = await run(controller.signal);
    return received === null ? code : SIGNALS[received];
  } finally {
    clearTimeout(deadline);
    for (const [name, listener] of listeners) host.off(name, listener);
  }
}

/** How long a child gets to exit after SIGTERM before it gets SIGKILL. */
export const KILL_GRACE_MS = 5_000;

/** The parts of a Bun Subprocess that terminate uses. */
export type ChildProcess = Pick<Subprocess, "exitCode" | "signalCode" | "exited" | "kill">;

/** SIGTERM, then SIGKILL if `child` hasn't exited within `graceMs`; resolves once it has exited. */
export async function terminate(
  child: ChildProcess,
  graceMs: number = KILL_GRACE_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
}

/** Terminates `child` once `signal` aborts. Call the returned function after the child exits. */
export function terminateOnAbort(
  child: ChildProcess,
  signal: AbortSignal | undefined,
  graceMs: number = KILL_GRACE_MS,
): () => void {
  if (signal === undefined) return () => {};
  const onAbort = (): void => {
    void terminate(child, graceMs);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
