// The embedding cache both ingests share: one SQLite table of float32 vectors keyed by model,
// dimension and text, so every vector already paid for hits.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

// SQLite's compiled-in default placeholder limit is 999.
const LOOKUP_CHUNK = 500;

/**
 * `sha1(f"{model}\0{dim}\0{text}")` in hex. A new model or dimension misses instead of returning
 * stale vectors; the old entries stay in the file.
 */
export function embedCacheKey(model: string, dim: number, text: string): string {
  return createHash("sha1").update(`${model}\0${dim}\0`, "utf8").update(text, "utf8").digest("hex");
}

// Typed arrays use the platform's byte order: little-endian on x64 and arm64.
function encodeVector(vector: ArrayLike<number>): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

function decodeVector(blob: Uint8Array): Float32Array {
  const vector = new Float32Array(blob.byteLength / 4);
  new Uint8Array(vector.buffer).set(blob);
  return vector;
}

/** The SQLite file of embedding vectors every persona's ingests share. */
export class EmbedCache {
  readonly #db: DatabaseSync;
  /** Each lookup's statement, by how many keys it takes. */
  readonly #lookups = new Map<number, StatementSync>();
  readonly #insert: StatementSync;
  readonly #count: StatementSync;

  /** Opens the cache at `path`, creating the file and its folder when missing. */
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    // node:sqlite fails at once on another writer's lock; this waits up to 5 s for it.
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS embed_cache (  key TEXT PRIMARY KEY,   vector BLOB NOT NULL)",
    );
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#insert = this.#db.prepare(
      "INSERT OR REPLACE INTO embed_cache (key, vector) VALUES (?, ?)",
    );
    this.#count = this.#db.prepare("SELECT COUNT(*) FROM embed_cache");
    this.#count.setReturnArrays(true);
  }

  #lookup(keys: number): StatementSync {
    let statement = this.#lookups.get(keys);
    if (statement === undefined) {
      statement = this.#db.prepare(
        `SELECT key, vector FROM embed_cache WHERE key IN (${Array(keys).fill("?").join(",")})`,
      );
      statement.setReturnArrays(true);
      this.#lookups.set(keys, statement);
    }
    return statement;
  }

  /** The cached vector of each text that has one, by its index in `texts`. */
  getMany(model: string, dim: number, texts: readonly string[]): Map<number, Float32Array> {
    const found = new Map<number, Float32Array>();
    if (texts.length === 0) return found;
    const keys = texts.map((text) => embedCacheKey(model, dim, text));
    const blobs = new Map<string, Uint8Array>();
    for (let start = 0; start < keys.length; start += LOOKUP_CHUNK) {
      const chunk = keys.slice(start, start + LOOKUP_CHUNK);
      for (const [key, blob] of this.#lookup(chunk.length).all(...chunk) as unknown as [
        string,
        Uint8Array,
      ][]) {
        blobs.set(key, blob);
      }
    }
    keys.forEach((key, i) => {
      const blob = blobs.get(key);
      if (blob !== undefined) found.set(i, decodeVector(blob));
    });
    return found;
  }

  /** Stores each `[text, vector]` in one transaction, so a crash loses at most this batch. */
  putMany(
    model: string,
    dim: number,
    items: readonly (readonly [text: string, vector: ArrayLike<number>])[],
  ): void {
    if (items.length === 0) return;
    this.#db.exec("BEGIN");
    try {
      for (const [text, vector] of items) {
        this.#insert.run(embedCacheKey(model, dim, text), encodeVector(vector));
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      // SQLite may have rolled it back already, as it can on SQLITE_BUSY or SQLITE_FULL.
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Vectors on disk, across every model and dimension. */
  count(): number {
    const row = this.#count.get() as unknown as [number] | undefined;
    return row === undefined ? 0 : Number(row[0]);
  }

  /**
   * Deletes every vector, of every persona, model and dimension, and returns their count. The file
   * stays, since another ingest may hold it open, and VACUUM gives the space back.
   */
  clear(): number {
    const { changes } = this.#db.prepare("DELETE FROM embed_cache").run();
    this.#db.exec("VACUUM");
    return Number(changes);
  }

  close(): void {
    this.#db.close();
  }
}
