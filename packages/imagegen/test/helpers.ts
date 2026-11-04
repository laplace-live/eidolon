import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { consoleSink, type LogRecord, logger } from "@eidolon/config";

const savedEnv = new Map<string, string | undefined>();

/** Set, or with `undefined` unset, an env var until `restoreEnv`. */
export function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export function restoreEnv(): void {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
}

const SELFIE_ENV = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_APP_NAME",
  "OPENROUTER_APP_URL",
  "PERSONA_TIMEZONE",
  "SELFIE_ASPECT_RATIO",
  "SELFIE_MODEL",
  "SELFIE_QUALITY",
  "SELFIE_REFERENCE_IMAGES",
  "SELFIE_TIMEOUT_SECONDS",
  "SELFIE_TTL_SECONDS",
];

/** Every variable the selfie path reads, unset. */
export function clearSelfieEnv(): void {
  for (const name of SELFIE_ENV) setEnv(name, undefined);
}

/** Route log records into the returned array until `restoreLogs`. */
export function captureLogs(): LogRecord[] {
  const records: LogRecord[] = [];
  logger.setSink((record) => {
    records.push(record);
  });
  return records;
}

export function restoreLogs(): void {
  logger.setSink(consoleSink);
}

export function logLines(records: readonly LogRecord[]): string[] {
  return records.map((record) => `${record.level} ${record.message}`);
}

const tempDirs: string[] = [];

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eidolon-imagegen-"));
  tempDirs.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Write `files` (relative path → bytes or text) under a new temp directory and return it. */
export function tempTree(files: Readonly<Record<string, Uint8Array | string>>): string {
  const root = tempDir();
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

/** Distinct bytes per file, so a test can tell which reference was sent. */
export function bytesOf(label: string): Uint8Array {
  return new TextEncoder().encode(`\x89PNG ${label}`);
}

export function dataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${bytes.toBase64()}`;
}

export interface FetchCall {
  readonly url: string;
  readonly init: BunFetchRequestInit;
  readonly payload: Record<string, unknown>;
}

/** A fetch that records each request and answers with `respond`. */
export function fakeFetch(respond: (call: FetchCall) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const impl = async (input: string | URL | Request, init: BunFetchRequestInit = {}) => {
    const call = { url: String(input), init, payload: JSON.parse(String(init.body)) };
    calls.push(call);
    return respond(call);
  };
  return { fetch: impl as typeof fetch, calls };
}

/** A fetch that never answers and rejects with the signal's reason once aborted, as Bun's does. */
export function hangingFetch(): { fetch: typeof fetch; started: Promise<void> } {
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const impl = (_input: string | URL | Request, init: BunFetchRequestInit = {}) =>
    new Promise<Response>((_resolve, reject) => {
      markStarted();
      const signal = init.signal;
      if (!signal) return;
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  return { fetch: impl as typeof fetch, started };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class CancelledError extends Error {
  override name = "CancelledError";
}
