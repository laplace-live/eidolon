// Read-only access to the LanceDB tables the offline Python ingest builds, and the per-table
// presets every caller (context, MCP, CLIs) searches with.
import { existsSync } from "node:fs";
import {
  envInt,
  envOptional,
  pyRepr,
  pyStr,
  pyTruthy,
  resolveProjectPath,
  sortedPy,
} from "@eidolon/config";
import * as lancedb from "@lancedb/lancedb";
import type { SearchRow } from "./hybrid.ts";

export const DEFAULT_DB_PATH = "data/lancedb";
export const PERSONA_FACTS_TABLE = "persona_facts";
export const STREAM_CHUNKS_TABLE = "stream_chunks";

/**
 * `LANCEDB_PATH` resolved against the repository root, not the working directory, so the bot
 * and /mcp open the same indexes under any launcher. An absolute value is used as is.
 */
export function resolveDbPath(): string {
  return resolveProjectPath(envOptional("LANCEDB_PATH") ?? DEFAULT_DB_PATH);
}

async function tableNames(db: lancedb.Connection): Promise<string[]> {
  const names: string[] = [];
  for await (const name of db.listTables()) names.push(name);
  return names;
}

/** [] for a directory that doesn't exist, which is never connected to. */
export async function listTableNames(dbPath: string): Promise<string[]> {
  if (!existsSync(dbPath)) return [];
  return tableNames(await lancedb.connect(dbPath));
}

/**
 * A table by name, or null if the directory or table doesn't exist yet: services boot before
 * their ingest has ever run. Never connects to a missing directory, never creates anything.
 */
export async function openTable(dbPath: string, tableName: string): Promise<lancedb.Table | null> {
  if (!existsSync(dbPath)) return null;
  const db = await lancedb.connect(dbPath);
  if (!(await tableNames(db)).includes(tableName)) return null;
  return db.openTable(tableName);
}

export interface TablePreset {
  readonly table: string;
  /** The column the date pre-filter targets when a query names a day. */
  readonly dateColumn: string;
  /** The prefix of this table's log lines. */
  readonly label: string;
  /** The command that builds the table, shown when it's absent. */
  readonly ingestHint: string;
  /** The per-table detail on a hit log line. */
  readonly summarize: (hits: readonly SearchRow[]) => string;
}

/** `sorted({...})` rendered as a Python list. */
function sortedSet(values: readonly unknown[]): string {
  return pyRepr(sortedPy(new Set(values.map((v) => (typeof v === "string" ? v : pyStr(v))))));
}

function field(row: SearchRow, key: string, fallback: unknown): unknown {
  return key in row ? row[key] : fallback;
}

export const PERSONA_FACTS: TablePreset = Object.freeze({
  table: PERSONA_FACTS_TABLE,
  dateColumn: "date",
  label: "Persona facts",
  ingestHint: "uv run laplace-ingest-facts",
  summarize: (hits: readonly SearchRow[]) => {
    const sources = sortedSet(hits.map((r) => field(r, "source", "?")));
    const dated = hits.filter((r) => pyTruthy(r.date)).length;
    return `sources=${sources}, dated=${dated}/${hits.length}`;
  },
});

export const STREAM_ARCHIVE: TablePreset = Object.freeze({
  table: STREAM_CHUNKS_TABLE,
  dateColumn: "stream_date",
  label: "Archive",
  ingestHint: "uv run laplace-ingest-streams",
  summarize: (hits: readonly SearchRow[]) => {
    const dates = sortedSet(hits.map((r) => field(r, "stream_date", "?")));
    const refined = hits.filter((r) => pyTruthy(r.refined)).length;
    const types = sortedSet(hits.map((r) => (pyTruthy(r.chunk_type) ? r.chunk_type : "raw")));
    return `dates=${dates}, refined=${refined}/${hits.length}, types=${types}`;
  },
});

export interface SearchParams {
  candidates: number;
  topK: number;
}

/**
 * Facts are short enough to afford a wide net: 30 candidates (PERSONA_FACTS_CANDIDATES) is the
 * sweet spot at ~3k facts, and each fact is ~30 chars, so topK 8 stays cheap. Out-of-range values
 * pass through unvalidated, as pydantic never validates a `default_factory`'s output.
 */
export function personaFactsSearchParams(): SearchParams {
  return { candidates: envInt("PERSONA_FACTS_CANDIDATES", 30), topK: 8 };
}

/**
 * Stream chunks are ~50× a fact, so the reranker scores ~750× the bytes per query: 15 candidates
 * (STREAM_ARCHIVE_CANDIDATES) is where quality stops improving at ~30k chunks, and topK 3 keeps
 * the prompt from ballooning. Out-of-range values pass through unvalidated, as in Python.
 */
export function streamArchiveSearchParams(): SearchParams {
  return { candidates: envInt("STREAM_ARCHIVE_CANDIDATES", 15), topK: 3 };
}

/** The `topics` column: a JSON `list[str]`, or the literal "[]" on unrefined rows. */
export function decodeTopics(row: SearchRow): string[] {
  const raw = pyTruthy(row.topics) ? row.topics : "";
  if (!raw) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(String(raw));
  } catch {
    return [];
  }
  return Array.isArray(decoded) ? decoded.map(pyStr) : [];
}

// LanceDB has no DISTINCT. A columnar scan of one narrow column over ~30k rows is 10-30 ms.
const STREAM_DATE_SCAN_LIMIT = 200_000;

/**
 * Raw non-empty `stream_date` values (at most 200,000 rows), or null when the table is missing.
 * Throws on read errors; context dedupes, sorts and caches.
 */
export async function scanStreamDates(
  dbPath: string,
  tableName: string = STREAM_CHUNKS_TABLE,
): Promise<string[] | null> {
  const table = await openTable(dbPath, tableName);
  if (table === null) return null;
  const rows = await table.query().select(["stream_date"]).limit(STREAM_DATE_SCAN_LIMIT).toArray();
  const dates: string[] = [];
  for (const row of rows) {
    const value: unknown = row.stream_date;
    if (pyTruthy(value)) dates.push(value as string);
  }
  return dates;
}
