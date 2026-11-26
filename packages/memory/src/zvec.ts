// Per-viewer memory vectors on Zvec: an in-process flat cosine index with inverted scalar indexes
// on the four mem0 scope columns and the full mem0 payload preserved verbatim as JSON.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  type ZVecCollection,
  ZVecCollectionSchema,
  ZVecCreateAndOpen,
  ZVecDataType,
  ZVecIndexType,
  ZVecInitialize,
  ZVecLogLevel,
  ZVecLogType,
  ZVecMetricType,
  ZVecOpen,
} from "@zvec/zvec";

/** Validated scope ids keyed as stored, in `user_id, agent_id, run_id` order. */
export type ScopeFilters = Readonly<Partial<Record<"user_id" | "agent_id" | "run_id", string>>>;

export interface StoredPoint {
  readonly id: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly score?: number;
}

export interface NewPoint {
  readonly id: string;
  readonly vector: readonly number[];
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ZvecSettings {
  readonly dir: string;
  readonly vectorSize: number;
  /** Embedding identity (`provider:model`); scopes the collection folder so model switches never mix vectors. */
  readonly embedModel?: string;
}

export interface VectorStore {
  ensureCollection(): Promise<void>;
  insert(points: readonly NewPoint[]): Promise<void>;
  search(vector: readonly number[], limit: number, filters: ScopeFilters): Promise<StoredPoint[]>;
  list(filters: ScopeFilters, limit: number): Promise<StoredPoint[]>;
  get(id: string): Promise<StoredPoint | null>;
  delete(id: string): Promise<void>;
  /** Deletes every point matching `filters` across all retained collections and returns them for history logging. */
  deleteScope?(filters: ScopeFilters): Promise<StoredPoint[]>;
  /** Lists points matching `filters` in retained inactive collections (excluding the active collection). */
  listRetainedScope?(filters: ScopeFilters): Promise<StoredPoint[]>;
}

interface DeletionTombstones {
  readonly ids: string[];
  readonly scopes: ScopeFilters[];
}

const INDEXED_FIELDS = ["user_id", "agent_id", "run_id", "actor_id"] as const;
// Zvec's native query topk ceiling is 100,000; upsertSync rejects batches above 1,024 docs.
const ZVEC_MAX_TOPK = 100_000;
const WRITE_BATCH = 512;
const FETCH_BATCH = 1_000;
const QDRANT_MIGRATED_MARKER = ".qdrant-migrated";
const TOMBSTONES_FILE = ".deleted-tombstones.json";
let atomicSeq = 0;

function writeAtomicPrivate(dir: string, filename: string, content: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, filename);
  const tmp = join(dir, `${filename}.${process.pid}.${++atomicSeq}.tmp`);
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Never written.
    }
    throw error;
  }
}
const INIT_KEY = Symbol.for("eidolon.zvec.initialized");
const STORES_KEY = Symbol.for("eidolon.zvec.memoryStores");

function initZvecOnce(): void {
  const state = globalThis as Record<symbol, unknown>;
  if (state[INIT_KEY]) return;
  ZVecInitialize({ logType: ZVecLogType.CONSOLE, logLevel: ZVecLogLevel.WARN });
  state[INIT_KEY] = true;
}

function openStores(): Map<string, ZVecCollection> {
  const state = globalThis as Record<symbol, unknown>;
  let map = state[STORES_KEY] as Map<string, ZVecCollection> | undefined;
  if (!map) {
    map = new Map<string, ZVecCollection>();
    state[STORES_KEY] = map;
  }
  return map;
}

function memorySchema(vectorSize: number): ZVecCollectionSchema {
  return new ZVecCollectionSchema({
    name: "eidolon_memories",
    fields: [
      ...INDEXED_FIELDS.map((name) => ({
        name,
        dataType: ZVecDataType.STRING,
        nullable: true,
        indexParams: { indexType: ZVecIndexType.INVERT, enableRangeOptimization: false },
      })),
      {
        name: "point_id",
        dataType: ZVecDataType.STRING,
        nullable: false,
        indexParams: { indexType: ZVecIndexType.INVERT, enableRangeOptimization: true },
      },
      { name: "payload_json", dataType: ZVecDataType.STRING, nullable: false },
    ],
    vectors: [
      {
        name: "embedding",
        dataType: ZVecDataType.VECTOR_FP32,
        dimension: vectorSize,
        indexParams: { indexType: ZVecIndexType.FLAT, metricType: ZVecMetricType.COSINE },
      },
    ],
  });
}

// Encode scope tokens to [A-Za-z0-9_.!~*()-] and %XX so arbitrary strings (quotes, trailing
// backslashes, control characters) match 1-to-1 without touching Zvec's filter escape lexer.
function scopeToken(value: string): string {
  return encodeURIComponent(value).replaceAll("'", "%27");
}

// Order-isomorphic UTF-16 hex encoding ([0-9a-f] only) so Zvec range pagination (`point_id > ...`)
// matches JavaScript's `<` / `>` string order for arbitrary IDs without filter escaping.
function idOrderKey(id: string): string {
  let out = "";
  for (let i = 0; i < id.length; i++) {
    out += id.charCodeAt(i).toString(16).padStart(4, "0");
  }
  return out;
}

function filterFor(filters: ScopeFilters): string | undefined {
  const clauses = Object.entries(filters)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key} = '${scopeToken(value)}'`);
  return clauses.length ? clauses.join(" AND ") : undefined;
}

function scopeValue(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? scopeToken(value) : null;
}

function parsePayload(raw: unknown): Readonly<Record<string, unknown>> {
  if (typeof raw !== "string" || !raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function hasZvecFiles(path: string): boolean {
  if (!existsSync(path)) return false;
  return readdirSync(path).some((name) => !name.endsWith(".tmp"));
}

function canonicalScope(filters: ScopeFilters): ScopeFilters {
  const out: Partial<Record<"user_id" | "agent_id" | "run_id", string>> = {};
  for (const key of ["user_id", "agent_id", "run_id"] as const) {
    if (typeof filters[key] === "string") out[key] = filters[key];
  }
  return out;
}

async function queryMatchingIds(
  col: ZVecCollection,
  filter: string | undefined,
): Promise<string[]> {
  const hasPointId = col.schema.fields().some((field) => field.name === "point_id");
  const allIds: string[] = [];
  let cursorKey: string | null = null;
  for (;;) {
    const pageFilter =
      cursorKey === null
        ? filter
        : filter
          ? `(${filter}) AND point_id > '${cursorKey}'`
          : `point_id > '${cursorKey}'`;
    const docs = await col.query({
      topk: ZVEC_MAX_TOPK,
      ...(pageFilter ? { filter: pageFilter } : {}),
      outputFields: [],
    });
    if (docs.length === 0) break;
    let maxId = "";
    for (const doc of docs) {
      allIds.push(doc.id);
      if (maxId === "" || doc.id > maxId) maxId = doc.id;
    }
    if (!hasPointId || docs.length < ZVEC_MAX_TOPK) break;
    cursorKey = idOrderKey(maxId);
  }
  allIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return allIds;
}

function fetchStoredPoints(col: ZVecCollection, ids: readonly string[]): StoredPoint[] {
  const points: StoredPoint[] = [];
  for (let start = 0; start < ids.length; start += FETCH_BATCH) {
    const slice = ids.slice(start, start + FETCH_BATCH);
    const fetched = col.fetchSync({
      ids: slice,
      outputFields: ["payload_json"],
      includeVector: false,
    });
    for (const id of slice) {
      const doc = fetched[id];
      if (doc) points.push({ id: doc.id, payload: parsePayload(doc.fields.payload_json) });
    }
  }
  return points;
}

/** Closes every cached writable memory collection in this process; for tests and shutdown. */
export function closeMemoryStores(): void {
  const stores = openStores();
  for (const col of stores.values()) {
    try {
      col.closeSync();
    } catch {
      // Already closed.
    }
  }
  stores.clear();
}

export class ZvecVectorStore implements VectorStore {
  readonly #dir: string;
  readonly #vectorSize: number;
  readonly #embedModel: string;

  constructor(settings: ZvecSettings) {
    this.#dir = resolve(settings.dir);
    this.#vectorSize = settings.vectorSize;
    this.#embedModel = settings.embedModel?.trim() ?? "";
  }

  #collectionPath(): string {
    // Dimension and embedding model are fixed per vector space; scoping the folder by both lets
    // EMBED_DIM or EMBED_MODEL change cleanly without mixing incompatible vectors.
    if (!this.#embedModel) return join(this.#dir, `v1_${this.#vectorSize}`);
    const hash = createHash("sha256").update(this.#embedModel).digest("hex").slice(0, 12);
    return join(this.#dir, `v1_${this.#vectorSize}_${hash}`);
  }

  #openExisting(path: string): ZVecCollection | null {
    initZvecOnce();
    const stores = openStores();
    const cached = stores.get(path);
    if (cached && hasZvecFiles(path)) return cached;
    if (cached) {
      try {
        cached.closeSync();
      } catch {
        // Directory was removed out from under the handle.
      }
      stores.delete(path);
    }
    if (!hasZvecFiles(path)) return null;
    const col = ZVecOpen(path, { readOnly: false, enableMMAP: true });
    stores.set(path, col);
    return col;
  }

  #open(): ZVecCollection {
    const path = this.#collectionPath();
    const existing = this.#openExisting(path);
    if (existing) return existing;
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    const col = ZVecCreateAndOpen(path, memorySchema(this.#vectorSize), {
      readOnly: false,
      enableMMAP: true,
    });
    openStores().set(path, col);
    return col;
  }

  #readTombstones(): DeletionTombstones {
    const file = join(this.#dir, TOMBSTONES_FILE);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ids: [], scopes: [] };
      throw new Error("Memory deletion tombstones are unreadable", { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error("Memory deletion tombstones are unreadable", { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Memory deletion tombstones are unreadable");
    }
    const record = parsed as Partial<DeletionTombstones>;
    if (
      (record.ids !== undefined &&
        (!Array.isArray(record.ids) || !record.ids.every((id) => typeof id === "string"))) ||
      (record.scopes !== undefined &&
        (!Array.isArray(record.scopes) ||
          !record.scopes.every(
            (scope) =>
              typeof scope === "object" &&
              scope !== null &&
              !Array.isArray(scope) &&
              Object.values(scope).every((v) => v === undefined || typeof v === "string"),
          )))
    ) {
      throw new Error("Memory deletion tombstones are unreadable");
    }
    return {
      ids: [...(record.ids ?? [])],
      scopes: (record.scopes ?? []).map(canonicalScope),
    };
  }

  #writeTombstones(tombstones: DeletionTombstones): void {
    writeAtomicPrivate(this.#dir, TOMBSTONES_FILE, `${JSON.stringify(tombstones)}\n`);
  }

  hasQdrantMigrationMarker(): boolean {
    return existsSync(join(this.#dir, QDRANT_MIGRATED_MARKER));
  }

  markQdrantMigrated(): void {
    writeAtomicPrivate(this.#dir, QDRANT_MIGRATED_MARKER, "1\n");
  }

  hasPoint(id: string): boolean {
    const found = this.#open().fetchSync({ ids: id, outputFields: [], includeVector: false });
    return found[id] !== undefined;
  }

  isTombstoned(id: string, payload: Readonly<Record<string, unknown>>): boolean {
    const tombstones = this.#readTombstones();
    if (tombstones.ids.includes(id)) return true;
    return tombstones.scopes.some((scope) => {
      const entries = Object.entries(scope);
      return entries.length > 0 && entries.every(([key, value]) => payload[key] === value);
    });
  }

  async ensureCollection(): Promise<void> {
    this.#open();
  }

  async insert(points: readonly NewPoint[]): Promise<void> {
    if (!points.length) return;
    const col = this.#open();
    for (let start = 0; start < points.length; start += WRITE_BATCH) {
      const slice = points.slice(start, start + WRITE_BATCH);
      const statuses = col.upsertSync(
        slice.map((point) => {
          // Zvec represents NULL on a nullable column by omitting the field from `fields`.
          const fields: Record<string, string> = {
            point_id: idOrderKey(point.id),
            payload_json: JSON.stringify(point.payload),
          };
          for (const key of INDEXED_FIELDS) {
            const value = scopeValue(point.payload, key);
            if (value !== null) fields[key] = value;
          }
          return {
            id: point.id,
            vectors: { embedding: Float32Array.from(point.vector) },
            fields,
          };
        }),
      );
      for (const status of statuses) {
        if (!status.ok) {
          throw new Error(`Zvec upsert failed (${status.code}): ${status.message}`);
        }
      }
    }
  }

  /** Dense nearest neighbours, best first, with cosine distance converted to similarity. */
  async search(
    vector: readonly number[],
    limit: number,
    filters: ScopeFilters,
  ): Promise<StoredPoint[]> {
    if (limit <= 0) return [];
    const col = this.#open();
    const filter = filterFor(filters);
    const docs = await col.query({
      fieldName: "embedding",
      vector: Float32Array.from(vector),
      topk: limit,
      ...(filter ? { filter } : {}),
      outputFields: ["payload_json"],
    });
    return docs.map((doc) => ({
      id: doc.id,
      payload: parsePayload(doc.fields.payload_json),
      score: 1 - doc.score,
    }));
  }

  /** Up to `limit` points in scope, ordered globally by point id. */
  async list(filters: ScopeFilters, limit: number): Promise<StoredPoint[]> {
    if (limit <= 0) return [];
    const col = this.#open();
    const ids = await queryMatchingIds(col, filterFor(filters));
    return fetchStoredPoints(col, ids.slice(0, limit));
  }

  async get(id: string): Promise<StoredPoint | null> {
    const col = this.#open();
    const found = col.fetchSync({ ids: id, outputFields: ["payload_json"], includeVector: false });
    const doc = found[id];
    return doc ? { id: doc.id, payload: parsePayload(doc.fields.payload_json) } : null;
  }

  async delete(id: string): Promise<void> {
    const col = this.#open();
    const tombstones = this.#readTombstones();
    if (!tombstones.ids.includes(id)) {
      this.#writeTombstones({ ids: [...tombstones.ids, id], scopes: tombstones.scopes });
    }
    const status = col.deleteSync(id);
    if (!status.ok && status.code !== "ZVEC_NOT_FOUND") {
      throw new Error(`Zvec delete failed (${status.code}): ${status.message}`);
    }
  }

  async listRetainedScope(filters: ScopeFilters): Promise<StoredPoint[]> {
    const filter = filterFor(filters);
    if (!filter || !existsSync(this.#dir)) return [];
    const activePath = this.#collectionPath();
    const retained: StoredPoint[] = [];
    for (const entry of readdirSync(this.#dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("v1_")) continue;
      const collectionPath = join(this.#dir, entry.name);
      if (collectionPath === activePath) continue;
      const col = this.#openExisting(collectionPath);
      if (!col) continue;
      const ids = await queryMatchingIds(col, filter);
      if (ids.length > 0) retained.push(...fetchStoredPoints(col, ids));
    }
    return retained;
  }

  async deleteScope(filters: ScopeFilters): Promise<StoredPoint[]> {
    const filter = filterFor(filters);
    if (!filter) return [];
    this.#open();
    const scope = canonicalScope(filters);
    if (Object.keys(scope).length > 0) {
      const tombstones = this.#readTombstones();
      const encoded = JSON.stringify(scope);
      if (!tombstones.scopes.some((existing) => JSON.stringify(existing) === encoded)) {
        this.#writeTombstones({ ids: tombstones.ids, scopes: [...tombstones.scopes, scope] });
      }
    }
    if (!existsSync(this.#dir)) return [];
    const removed: StoredPoint[] = [];
    for (const entry of readdirSync(this.#dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("v1_")) continue;
      const col = this.#openExisting(join(this.#dir, entry.name));
      if (!col) continue;
      const ids = await queryMatchingIds(col, filter);
      if (ids.length === 0) continue;
      const points = fetchStoredPoints(col, ids);
      for (const id of ids) {
        const status = col.deleteSync(id);
        if (!status.ok && status.code !== "ZVEC_NOT_FOUND") {
          throw new Error(`Zvec delete failed (${status.code}): ${status.message}`);
        }
      }
      removed.push(...points);
    }
    return removed;
  }
}
