// The goldens under fixtures/goldens are the Python CLIs' own output for the same fixtures and
// fakes these tests use; "<FIX>" stands for this fixtures directory.
import { afterAll, beforeAll } from "bun:test";
import { join } from "node:path";
import { consoleSink, type LogLevel, type LogRecord, logger, setLogLevel } from "@eidolon/config";
import type { Subprocess } from "bun";

export const FIX = join(import.meta.dir, "fixtures");

/** Call at a test file's top level: a fetch nobody injected fails instead of going out. */
export function blockNetwork(): void {
  const real = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = (async (input: unknown) => {
      throw new Error(`unexpected network call in a test: ${String(input)}`);
    }) as unknown as typeof globalThis.fetch;
  });
  afterAll(() => {
    globalThis.fetch = real;
  });
}

export function golden<T>(name: string): Promise<T> {
  return Bun.file(join(FIX, "goldens", name)).json() as Promise<T>;
}

/** Replaces each placeholder in `text` with its path. */
export function substitute(text: string, paths: Readonly<Record<string, string>>): string {
  let out = text;
  for (const [placeholder, path] of Object.entries(paths)) out = out.replaceAll(placeholder, path);
  return out;
}

/** The inverse of substitute, for comparing output against a golden. */
export function placehold(text: string, paths: Readonly<Record<string, string>>): string {
  let out = text;
  for (const [placeholder, path] of Object.entries(paths)) out = out.replaceAll(path, placeholder);
  return out;
}

export interface Captured {
  readonly io: { stdout: (text: string) => void; stderr: (text: string) => void };
  readonly stdout: () => string;
  readonly stderr: () => string;
}

export function captureIo(): Captured {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

/** Records every log line from here on; `stop` restores the console sink and the DEBUG level. */
export function captureLogs(): { readonly records: [LogLevel, string][]; stop(): void } {
  const records: [LogLevel, string][] = [];
  logger.setSink((record: LogRecord) => {
    records.push([record.level, record.message]);
  });
  return {
    records,
    stop() {
      logger.setSink(consoleSink);
      setLogLevel("DEBUG");
    },
  };
}

/** The CLI in a process of its own, as main.ts runs it minus the .env load, in this environment. */
export function spawnCli(argv: readonly string[]): Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn(
    [process.execPath, "--no-env-file", join(import.meta.dir, "cli_child.ts"), ...argv],
    {
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

/** Sets (or, for undefined, deletes) env vars; the returned function restores them. */
export function setEnv(vars: Readonly<Record<string, string | undefined>>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
