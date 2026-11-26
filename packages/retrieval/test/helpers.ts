import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleSink, type LogRecord, logger } from "@eidolon/config";
import { afterEach, beforeEach, expect, type Mock, vi } from "vitest";
import {
  closeReadTablesUnder,
  openTable,
  personaFactsSchema,
  resetEmbeddingModel,
  resetRerankerCache,
  writeTable,
  type ZvecTable,
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

// Keys a shell may carry that would point a test at a billed service or custom index.
const ISOLATED = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_API_BASE",
  "EMBED_PROVIDER",
  "RERANK_PROVIDER",
  "COHERE_API_KEY",
  "RERANK_API_KEY",
  "RERANK_ENABLED",
  "RERANK_MODEL",
  "RERANK_BASE_URL",
  "EMBED_API_KEY",
  "EMBED_BASE_URL",
  "EMBED_MODEL",
  "EMBED_DIM",
  "INDEX_PATH",
  "LANCEDB_PATH",
  "PERSONA_FACTS_CANDIDATES",
  "STREAM_ARCHIVE_CANDIDATES",
  "OPENROUTER_APP_NAME",
  "OPENROUTER_APP_URL",
];

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    closeReadTablesUnder(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Unsets ISOLATED for each test and restores the original values after, with the env-derived
 * reranker and embedding-model caches cleared, and makes the global fetch throw: a test that
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
    resetEmbeddingModel();
    network = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
      throw new Error(`network disabled in tests: ${String(input)}`);
    }) as unknown as typeof fetch);
  });
  afterEach(() => {
    network?.mockRestore();
    resetRerankerCache();
    resetEmbeddingModel();
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

/** A fresh Zvec table in a temporary directory with the HNSW + whitespace FTS indexes. */
export async function memoryTable(
  rows: readonly FactRow[] = FACT_ROWS,
  name = "persona_facts",
): Promise<{ dir: string; table: ZvecTable }> {
  const dir = mkdtempSync(join(tmpdir(), "retrieval-zvec-"));
  tempDirs.push(dir);
  const dim = rows[0]?.vector.length ?? 4;
  const vectors = Float32Array.from(rows.flatMap((row) => row.vector));
  await writeTable(dir, name, rows, personaFactsSchema(dim), vectors);
  const table = (await openTable(dir, name)) as ZvecTable;
  return { dir, table };
}

/** 奶绿's real index, where the developer's data home holds one; the parity tests skip without it. */
export const REAL_INDEX = join(
  process.env.EIDOLON_REAL_HOME ?? "",
  "personas",
  "milky-green",
  "index",
);

export async function realTable(name: string): Promise<ZvecTable | null> {
  try {
    return await openTable(REAL_INDEX, name);
  } catch {
    return null;
  }
}

/** The vectors' bytes, to compare bit for bit. */
export const f32Bytes = (v: Float32Array): Buffer =>
  Buffer.from(v.buffer, v.byteOffset, v.byteLength);

/**
 * Zvec's COSINE index stores `(v / ||v||)` and `||v||`, so `fetchSync` reconstructs each float32
 * element within a couple of ULPs (`<= 1e-6` relative, or subnormal underflow `< 1e-30`).
 */
export function expectVectorsClose(actual: Float32Array, expected: Float32Array): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i] as number;
    const b = expected[i] as number;
    const tol = Math.max(1e-6 * Math.abs(b), 1e-30);
    if (!Number.isFinite(a) || Math.abs(a - b) > tol) {
      expect.fail(`vector[${i}] = ${a}, expected ${b} (±${tol})`);
    }
  }
}
