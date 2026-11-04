import { afterEach, beforeEach } from "bun:test";
import { consoleSink, type LogRecord, logger } from "@eidolon/config";

/** Records the current test's log lines instead of printing them. */
export function captureLogs(): LogRecord[] {
  const records: LogRecord[] = [];
  beforeEach(() => {
    records.length = 0;
    logger.setLevel("DEBUG");
    logger.setSink((record) => records.push(record));
  });
  afterEach(() => logger.setSink(consoleSink));
  return records;
}

export function lines(records: readonly LogRecord[]): string[] {
  return records.map((r) => `${r.level} ${r.message}`);
}

export const NETWORK_BLOCKED = "tests must inject fetch";

/** Makes the global fetch throw for this file's tests, so none can reach Cloudflare. */
export function blockNetwork(): void {
  const real = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (() => {
      throw new Error(NETWORK_BLOCKED);
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });
}

export interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

/** A `fetch` that answers from `respond` and records every call. */
export function fakeFetch(respond: (call: FetchCall) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  };
  return { fetch: impl as typeof fetch, calls };
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Sets env vars for one test (undefined unsets); each is restored afterwards. */
export function useEnv(): (name: string, value: string | undefined) => void {
  const saved = new Map<string, string | undefined>();
  afterEach(() => {
    for (const [name, value] of saved) setEnv(name, value);
    saved.clear();
  });
  return (name, value) => {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    setEnv(name, value);
  };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
