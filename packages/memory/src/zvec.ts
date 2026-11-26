// Per-viewer memory vectors on Zvec: an in-process flat cosine index with inverted scalar indexes
// on the four mem0 scope columns and the full mem0 payload preserved verbatim as JSON.
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
}

export interface VectorStore {
  ensureCollection(): Promise<void>;
  insert(points: readonly NewPoint[]): Promise<void>;
  search(vector: readonly number[], limit: number, filters: ScopeFilters): Promise<StoredPoint[]>;
  list(filters: ScopeFilters, limit: number): Promise<StoredPoint[]>;
  get(id: string): Promise<StoredPoint | null>;
  delete(id: string): Promise<void>;
}

const INDEXED_FIELDS = ["user_id", "agent_id", "run_id", "actor_id"] as const;
const MAX_LIST_FETCH = 50_000;
// Zvec rejects upsertSync batches above 1024 docs.
const WRITE_BATCH = 512;
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

  constructor(settings: ZvecSettings) {
    this.#dir = resolve(settings.dir);
    this.#vectorSize = settings.vectorSize;
  }

  #collectionPath(): string {
    // Dimension is fixed per collection; scoping the folder by dimension lets EMBED_DIM change
    // without failing on vectors of the old width.
    return join(this.#dir, `v1_${this.#vectorSize}`);
  }

  #open(): ZVecCollection {
    initZvecOnce();
    const path = this.#collectionPath();
    const stores = openStores();
    const cached = stores.get(path);
    if (cached && existsSync(path)) return cached;
    if (cached) {
      try {
        cached.closeSync();
      } catch {
        // Directory was removed out from under the handle.
      }
      stores.delete(path);
    }
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const options = { readOnly: false, enableMMAP: true } as const;
    const populated = existsSync(path) && readdirSync(path).length > 0;
    if (!populated && existsSync(path)) rmSync(path, { recursive: true, force: true });
    const col = populated
      ? ZVecOpen(path, options)
      : ZVecCreateAndOpen(path, memorySchema(this.#vectorSize), options);
    stores.set(path, col);
    return col;
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

  /** Up to `limit` points in scope, ordered by point id. */
  async list(filters: ScopeFilters, limit: number): Promise<StoredPoint[]> {
    if (limit <= 0) return [];
    const col = this.#open();
    const filter = filterFor(filters);
    const topk = Math.min(Math.max(limit, col.stats.docCount, 1), MAX_LIST_FETCH);
    const docs = await col.query({
      topk,
      ...(filter ? { filter } : {}),
      outputFields: ["payload_json"],
    });
    docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return docs.slice(0, limit).map((doc) => ({
      id: doc.id,
      payload: parsePayload(doc.fields.payload_json),
    }));
  }

  async get(id: string): Promise<StoredPoint | null> {
    const col = this.#open();
    const found = col.fetchSync({ ids: id, outputFields: ["payload_json"], includeVector: false });
    const doc = found[id];
    return doc ? { id: doc.id, payload: parsePayload(doc.fields.payload_json) } : null;
  }

  async delete(id: string): Promise<void> {
    const col = this.#open();
    const status = col.deleteSync(id);
    if (!status.ok && status.code !== "ZVEC_NOT_FOUND") {
      throw new Error(`Zvec delete failed (${status.code}): ${status.message}`);
    }
  }
}
