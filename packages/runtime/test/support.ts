import { networkInterfaces } from "node:os";
import type { AllowedOffer } from "@eidolon/access";
import { consoleSink, type LogLevel, type LogRecord, logger, setLogLevel } from "@eidolon/config";

/** werift offers no loopback host candidate, so a peer on this machine needs another interface. */
export const CAN_DIAL = Object.values(networkInterfaces()).some((addresses) =>
  addresses?.some((a) => a.family === "IPv4" && !a.internal),
);

/** Candidate rules that keep every candidate, for a peer on this machine. */
export const PASS_THROUGH_RULES = {
  dropUnreachableCandidates: (sdp: string) => ({ sdp, dropped: [] }),
  candidateReachable: () => true,
  scrubRelayRelatedAddresses: (sdp: string) => sdp,
};

/** An anonymous viewer's offer, let through. */
export function admission(body: Record<string, unknown>): AllowedOffer {
  return {
    allowed: true,
    user: { mid: null, uname: null, face: null, isLoggedIn: false },
    token: null,
    body,
    requestData: { audioQuality: "medium" },
    opusBitrateBps: 96000,
    clientIp: "127.0.0.1",
    quota: null,
  };
}

export interface LogCapture {
  readonly records: LogRecord[];
  messages(level?: LogLevel): string[];
  restore(): void;
}

/** Captures every log line at DEBUG; restore() puts the console back. */
export function captureLogs(): LogCapture {
  const records: LogRecord[] = [];
  setLogLevel("DEBUG");
  logger.setSink((record) => records.push(record));
  return {
    records,
    messages: (level) =>
      records.filter((r) => level === undefined || r.level === level).map((r) => r.message),
    restore: () => logger.setSink(consoleSink),
  };
}

/** Sets (or, for undefined, deletes) env vars; the returned function restores them. */
export function setEnv(vars: Record<string, string | undefined>): () => void {
  const saved = Object.entries(vars).map(([name]) => [name, process.env[name]] as const);
  const apply = (entries: readonly (readonly [string, string | undefined])[]) => {
    for (const [name, value] of entries) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(Object.entries(vars));
  return () => apply(saved);
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Resolves once `check` holds, polling the event loop. */
export async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
