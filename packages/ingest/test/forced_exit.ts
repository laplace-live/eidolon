// A cancel that reaches the cleanup limit while writeTable rebuilds: the new table is written but
// its FTS index is not built yet.
import { existsSync } from "node:fs";
import { logger } from "@eidolon/config";
import { runWithSignals, type SignalHost } from "../src/index.ts";

/**
 * Runs `ingest` under runWithSignals with a 1 ms cleanup limit, sends SIGINT from writeTable's
 * `Wrote N rows` line and blocks past the limit. Resolves to the exit code and, for each forced
 * exit, whether `metaPath` existed at that moment.
 */
export async function cancelMidRebuild(
  ingest: (signal: AbortSignal) => Promise<{ readonly ok: boolean }>,
  metaPath: string,
): Promise<{ code: number; exits: boolean[] }> {
  const listeners = new Map<string, () => void>();
  const exits: boolean[] = [];
  const host: SignalHost = {
    on: (event, listener) => listeners.set(event, listener),
    off: (event) => listeners.delete(event),
    exit: () => exits.push(existsSync(metaPath)),
    stderr: { write: () => {} },
  };
  logger.setSink((record) => {
    if (!/^Wrote \d+ rows to /.test(record.message)) return;
    listeners.get("SIGINT")?.();
    Bun.sleepSync(5);
  });
  const code = await runWithSignals(async (signal) => ((await ingest(signal)).ok ? 0 : 1), host, 1);
  return { code, exits };
}
