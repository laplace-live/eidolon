import { afterEach, beforeEach, type Mock, spyOn } from "bun:test";
import { consoleSink, type LogRecord, logger } from "@eidolon/config";
import * as lancedb from "@lancedb/lancedb";
import {
  openTable,
  resetEmbeddingClient,
  resetRerankerCache,
  resolveDbPath,
} from "../src/index.ts";

/** Routes the logger into the returned array for each test, and back to the console after. */
export function captureLogs(): LogRecord[] {
  const records: LogRecord[] = [];
  beforeEach(() => {
    records.length = 0;
    logger.setSink((record) => records.push(record));
  });
  afterEach(() => {
    logger.setSink(consoleSink);
  });
  return records;
}

export function messages(records: readonly LogRecord[], level: LogRecord["level"]): string[] {
  return records.filter((r) => r.level === level).map((r) => r.message);
}

// Keys a shell may carry that would point a test at a billed service.
const ISOLATED = [
  "OPENROUTER_API_KEY",
  "RERANK_API_KEY",
  "RERANK_ENABLED",
  "RERANK_MODEL",
  "RERANK_BASE_URL",
  "EMBED_API_KEY",
  "EMBED_BASE_URL",
  "EMBED_MODEL",
  "EMBED_DIM",
  "LANCEDB_PATH",
  "PERSONA_FACTS_CANDIDATES",
  "STREAM_ARCHIVE_CANDIDATES",
  "OPENROUTER_APP_NAME",
  "OPENROUTER_APP_URL",
];

/**
 * Unsets ISOLATED for each test and restores the original values after, with the env-derived
 * reranker and embedding-client caches cleared, and makes the global fetch throw: a test that
 * wants it replaces the mock's implementation.
 */
export function isolateEnv(): { network: () => Mock<typeof fetch> } {
  const saved = new Map<string, string | undefined>();
  let network: Mock<typeof fetch> | null = null;
  beforeEach(() => {
    for (const key of ISOLATED) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    resetRerankerCache();
    resetEmbeddingClient();
    network = spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
      throw new Error(`network disabled in tests: ${String(input)}`);
    }) as unknown as typeof fetch);
  });
  afterEach(() => {
    network?.mockRestore();
    resetRerankerCache();
    resetEmbeddingClient();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return {
    network: () => {
      if (network === null) throw new Error("isolateEnv: no test is running");
      return network;
    },
  };
}

/** A fetch that answers from `replies` in order and records every request. */
export function fakeFetch(
  replies: ReadonlyArray<Response | ((init: RequestInit) => Response | Promise<Response>)>,
): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...replies];
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (next === undefined) throw new Error("fakeFetch: no reply left");
    return typeof next === "function" ? next(init) : next;
  };
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

export interface FactRow {
  id: string;
  source: string;
  date: string;
  floor: number;
  text: string;
  tokens: string;
  vector: number[];
}

export const FACT_ROWS: FactRow[] = [
  fact("f0", "a.txt", "2026-05-09", "坚果体重5.5kg", "坚果 体重 5.5 kg", [1, 0, 0, 0]),
  fact("f1", "b.txt", "", "坚果出生", "坚果 出生", [0.9, 0.1, 0, 0]),
  fact("f2", "a.txt", "2026-05-09", "猫粮", "猫粮", [0, 1, 0, 0]),
  fact("f3", "c.txt", "", "体重秤", "体重 秤", [0.5, 0, 0.5, 0]),
  fact("f4", "c.txt", "2025-01-02", "店长", "店长", [0, 0, 0, 1]),
];

function fact(
  id: string,
  source: string,
  date: string,
  text: string,
  tokens: string,
  vector: number[],
): FactRow {
  return { id, source, date, floor: Number(id.slice(1)), text, tokens, vector };
}

/** A fresh in-memory table with the whitespace FTS index the Python ingest builds. */
export async function memoryTable(rows: readonly FactRow[] = FACT_ROWS, name = "persona_facts") {
  const db = await lancedb.connect("memory://");
  const table = await db.createTable(
    name,
    rows.map((row) => ({ ...row })),
  );
  await table.createIndex("tokens", {
    config: lancedb.Index.fts({
      baseTokenizer: "whitespace",
      lowercase: false,
      stem: false,
      removeStopWords: false,
      withPosition: false,
    }),
  });
  return { db, table };
}

/** A table from the committed data/lancedb, or null when absent or only LFS pointer stubs. */
export async function realTable(name: string): Promise<lancedb.Table | null> {
  try {
    const table = await openTable(resolveDbPath(), name);
    if (table === null) return null;
    await table.countRows();
    return table;
  } catch {
    return null;
  }
}

/** The latest version and its commit time; any re-ingest changes it. */
export async function fingerprint(table: lancedb.Table): Promise<string> {
  const latest = (await table.listVersions()).at(-1);
  return latest === undefined ? "" : `${latest.version}@${latest.timestamp.toISOString()}`;
}
