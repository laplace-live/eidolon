// Read-only access to the persona's Zvec tables, which the offline ingest builds, and the
// per-table presets every caller (context, MCP, CLIs) searches with.
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  activePersona,
  envInt,
  envOptional,
  personaPath,
  pyRepr,
  pyStr,
  pyTruthy,
  resolveProjectPath,
  sortedPy,
} from "@eidolon/config";
import {
  type ZVecCollection,
  type ZVecDoc,
  ZVecInitialize,
  ZVecLogLevel,
  ZVecLogType,
  ZVecOpen,
} from "@zvec/zvec";
import type { SearchRow } from "./hybrid.ts";

/** Where a persona keeps its index, relative to its folder. */
export const INDEX_DIR = "index";
export const PERSONA_FACTS_TABLE = "persona_facts";
export const STREAM_CHUNKS_TABLE = "stream_chunks";
export const CURRENT_FILE = "CURRENT";

const INIT_KEY = Symbol.for("eidolon.zvec.initialized");
const READ_TABLES_KEY = Symbol.for("eidolon.zvec.readTables");
const SCAN_CHUNK = 1_000;
const STREAM_DATE_SCAN_LIMIT = 200_000;

export function initZvecOnce(): void {
  const state = globalThis as Record<symbol, unknown>;
  if (state[INIT_KEY]) return;
  ZVecInitialize({ logType: ZVecLogType.CONSOLE, logLevel: ZVecLogLevel.WARN });
  state[INIT_KEY] = true;
}

export function materializeRow(columns: readonly string[], doc: ZVecDoc): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const col of columns) {
    row[col] = Object.hasOwn(doc.fields, col) ? doc.fields[col] : null;
  }
  return row;
}

function readTableCache(): Map<string, ZvecTable> {
  const state = globalThis as Record<symbol, unknown>;
  let map = state[READ_TABLES_KEY] as Map<string, ZvecTable> | undefined;
  if (!map) {
    map = new Map<string, ZvecTable>();
    state[READ_TABLES_KEY] = map;
  }
  return map;
}

export function tableDir(dbPath: string, tableName: string): string {
  return join(dbPath, `${tableName}.zvec`);
}

export function readCurrentBuildId(dbPath: string, tableName: string): string | null {
  const pointer = join(tableDir(dbPath, tableName), CURRENT_FILE);
  try {
    const id = readFileSync(pointer, "utf8").trim();
    return id || null;
  } catch {
    return null;
  }
}

export function tableExists(dbPath: string, tableName: string): boolean {
  const buildId = readCurrentBuildId(dbPath, tableName);
  if (buildId === null) return false;
  return existsSync(join(tableDir(dbPath, tableName), buildId));
}

/** Closes cached read-only handles whose build path lies at or under `targetPath`. */
export function closeReadTablesUnder(targetPath: string): void {
  const prefix = resolve(targetPath);
  const cache = readTableCache();
  for (const [key, table] of cache) {
    if (key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}\\`)) {
      table.close();
      cache.delete(key);
    }
  }
}

/** Closes every cached read-only Zvec table in this process; for tests and shutdown. */
export function closeAllReadTables(): void {
  const cache = readTableCache();
  for (const table of cache.values()) table.close();
  cache.clear();
}

export class ZvecTable {
  readonly name: string;
  readonly path: string;
  readonly buildId: string;
  readonly buildPath: string;
  readonly collection: ZVecCollection;
  readonly columnNames: readonly string[];
  readonly vectorDim: number;
  readonly #shadowPath: string | null;
  #closed = false;

  constructor(options: {
    name: string;
    path: string;
    buildId: string;
    buildPath: string;
    collection: ZVecCollection;
    shadowPath?: string | null;
  }) {
    this.name = options.name;
    this.path = options.path;
    this.buildId = options.buildId;
    this.buildPath = options.buildPath;
    this.collection = options.collection;
    this.#shadowPath = options.shadowPath ?? null;
    this.columnNames = options.collection.schema.fields().map((f) => f.name);
    this.vectorDim = options.collection.schema.vector("vector").dimension ?? 0;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  async countRows(): Promise<number> {
    return this.collection.stats.docCount;
  }

  /**
   * Reads rows `[0, limit)` in insertion order, filling `null` for nullable columns that were
   * omitted on write. When `includeVectors` is true, also returns all row vectors concatenated.
   */
  readAll(
    options: { includeVectors?: boolean; columns?: readonly string[]; limit?: number } = {},
  ): {
    rows: Record<string, unknown>[];
    vectors: Float32Array;
  } {
    const total = Math.min(
      this.collection.stats.docCount,
      options.limit ?? Number.POSITIVE_INFINITY,
    );
    const cols = options.columns ?? this.columnNames;
    const outputFields = [...cols];
    const includeVector = options.includeVectors === true;
    const rows: Record<string, unknown>[] = [];
    const vectors = includeVector ? new Float32Array(total * this.vectorDim) : new Float32Array(0);
    for (let start = 0; start < total; start += SCAN_CHUNK) {
      const end = Math.min(total, start + SCAN_CHUNK);
      const ids: string[] = [];
      for (let i = start; i < end; i++) ids.push(String(i));
      const fetched = this.collection.fetchSync({
        ids,
        outputFields,
        includeVector,
      });
      for (const id of ids) {
        const doc = fetched[id];
        if (!doc) continue;
        const row = materializeRow(cols, doc);
        if (includeVector) {
          const vec = doc.vectors.vector;
          if (vec instanceof Float32Array || Array.isArray(vec)) {
            vectors.set(vec, rows.length * this.vectorDim);
          }
        }
        rows.push(row);
      }
    }
    return { rows, vectors };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.collection.closeSync();
    } catch {
      // Already closed.
    }
    if (this.#shadowPath !== null) {
      rmSync(this.#shadowPath, { recursive: true, force: true });
    }
  }
}

const configuredIndex = (): string | undefined =>
  envOptional("INDEX_PATH") ?? envOptional("LANCEDB_PATH");

/**
 * The active persona's index/, or `INDEX_PATH` (legacy `LANCEDB_PATH`) resolved against the
 * repository root, not the working directory, so the bot and /mcp open the same indexes under any
 * launcher.
 */
export function resolveDbPath(): string {
  const configured = configuredIndex();
  return configured ? resolveProjectPath(configured) : personaPath(INDEX_DIR);
}

/**
 * The CLIs' `--db-path` default: `INDEX_PATH` (or legacy `LANCEDB_PATH`) as written, which they
 * open from the working directory, else the persona's index.
 */
export function dbPathArgument(): string {
  return configuredIndex() ?? personaPath(INDEX_DIR);
}

/** [] for a directory that doesn't exist, never creating anything. */
export async function listTableNames(dbPath: string): Promise<string[]> {
  if (!existsSync(dbPath)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(dbPath)) {
    if (!entry.endsWith(".zvec")) continue;
    const name = entry.slice(0, -".zvec".length);
    if (name && tableExists(dbPath, name)) names.push(name);
  }
  return sortedPy(names);
}

// Zvec's HNSW/FLAT streamer (`index_mapping.cc`) opens `*.proxima` with `O_RDWR` even under
// `readOnly: true`, which fails with EROFS/EACCES on Docker's `/data:ro` mount or 0444 files.
// RocksDB, roaring bitmaps and IPC files all open read-only, so only `*.proxima` needs a writable
// copy in tmpdir while everything else stays a symlink into `buildPath`.
function hasUnwritableProxima(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        !entry.name.endsWith(".rocksdb") &&
        !entry.name.startsWith("idmap.") &&
        hasUnwritableProxima(full)
      ) {
        return true;
      }
    } else if (entry.name.endsWith(".proxima")) {
      try {
        accessSync(full, constants.R_OK | constants.W_OK);
      } catch {
        return true;
      }
    }
  }
  return false;
}

function mirrorProximaWritable(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const sourcePath = join(src, entry.name);
    const targetPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith(".rocksdb") || entry.name.startsWith("idmap.")) {
        symlinkSync(sourcePath, targetPath, "dir");
      } else {
        mirrorProximaWritable(sourcePath, targetPath);
      }
    } else if (entry.name.endsWith(".proxima")) {
      copyFileSync(sourcePath, targetPath);
      chmodSync(targetPath, 0o600);
    } else {
      symlinkSync(sourcePath, targetPath, "file");
    }
  }
}

const SHADOW_EXIT_KEY = Symbol.for("eidolon.zvec.shadowExitHook");

function processShadowRoot(): string {
  const uid = process.getuid?.() ?? "user";
  const root = join(tmpdir(), `eidolon-zvec-ro-${uid}`, String(process.pid));
  const state = globalThis as Record<symbol, unknown>;
  if (!state[SHADOW_EXIT_KEY]) {
    state[SHADOW_EXIT_KEY] = true;
    process.once("exit", () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup at process exit.
      }
    });
  }
  return root;
}

function stageReadOnlyShadow(
  root: string,
  tableName: string,
  buildId: string,
  buildPath: string,
): string {
  const hash = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
  const bucket = join(processShadowRoot(), `${hash}-${tableName}`);
  mkdirSync(bucket, { recursive: true, mode: 0o700 });
  const shadowPath = join(bucket, buildId);
  if (!existsSync(shadowPath)) {
    const tmp = `${shadowPath}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      mirrorProximaWritable(buildPath, tmp);
      renameSync(tmp, shadowPath);
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true });
      if (!existsSync(shadowPath)) throw error;
    }
  }
  const activeBuilds = new Set([...readTableCache().values()].map((t) => t.buildId));
  activeBuilds.add(buildId);
  for (const sibling of readdirSync(bucket)) {
    if (!activeBuilds.has(sibling) && !sibling.endsWith(".tmp")) {
      rmSync(join(bucket, sibling), { recursive: true, force: true });
    }
  }
  return shadowPath;
}

/**
 * A read-only Zvec table by name, shared across callers in this process for the same build, or
 * null if the directory or table doesn't exist yet: services boot before their ingest has ever
 * run. Never creates anything under `dbPath`.
 */
export async function openTable(dbPath: string, tableName: string): Promise<ZvecTable | null> {
  const buildId = readCurrentBuildId(dbPath, tableName);
  if (buildId === null) return null;
  const root = tableDir(dbPath, tableName);
  const buildPath = resolve(root, buildId);
  if (!existsSync(buildPath)) return null;

  const cache = readTableCache();
  const existing = cache.get(buildPath);
  if (existing && !existing.isClosed) return existing;
  if (existing) cache.delete(buildPath);

  initZvecOnce();
  const openOptions = { readOnly: true, enableMMAP: true } as const;
  const openShadow = (): { collection: ZVecCollection; shadowPath: string } => {
    const shadowPath = stageReadOnlyShadow(root, tableName, buildId, buildPath);
    try {
      return { collection: ZVecOpen(shadowPath, openOptions), shadowPath };
    } catch (error) {
      rmSync(shadowPath, { recursive: true, force: true });
      throw error;
    }
  };
  let opened: { collection: ZVecCollection; shadowPath: string | null };
  if (hasUnwritableProxima(buildPath)) {
    opened = openShadow();
  } else {
    try {
      opened = { collection: ZVecOpen(buildPath, openOptions), shadowPath: null };
    } catch (error) {
      try {
        opened = openShadow();
      } catch {
        throw error;
      }
    }
  }
  const table = new ZvecTable({
    name: tableName,
    path: root,
    buildId,
    buildPath,
    collection: opened.collection,
    shadowPath: opened.shadowPath,
  });
  cache.set(buildPath, table);
  return table;
}

/** How a checkout runs the CLI commands that hints name. */
export const CLI_LAUNCHER = "pnpm";

/** `pnpm <command> --persona <id>`: what a message tells the user to run. */
export function ingestHint(command: string, persona: string = activePersona().id): string {
  return `${CLI_LAUNCHER} ${command} --persona ${persona}`;
}

export interface TablePreset {
  readonly table: string;
  /** The column the date pre-filter targets when a query names a day. */
  readonly dateColumn: string;
  /** The prefix of this table's log lines. */
  readonly label: string;
  /** The command that builds the table, without a launcher (see ingestHint). */
  readonly ingestCommand: string;
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
  ingestCommand: "laplace-ingest-facts",
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
  ingestCommand: "laplace-ingest-streams",
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
 * pass through unvalidated.
 */
export function personaFactsSearchParams(): SearchParams {
  return { candidates: envInt("PERSONA_FACTS_CANDIDATES", 30), topK: 8 };
}

/**
 * Stream chunks are ~50× a fact, so the reranker scores ~750× the bytes per query: 15 candidates
 * (STREAM_ARCHIVE_CANDIDATES) is where quality stops improving at ~30k chunks, and topK 3 keeps
 * the prompt from ballooning. Out-of-range values pass through unvalidated.
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
  const { rows } = table.readAll({ columns: ["stream_date"], limit: STREAM_DATE_SCAN_LIMIT });
  const dates: string[] = [];
  for (const row of rows) {
    const value: unknown = row.stream_date;
    if (pyTruthy(value)) dates.push(value as string);
  }
  return dates;
}
