// The embedding cache both ingests share, in the format Python's EmbedCache wrote: one SQLite table
// of float32 vectors keyed by model, dimension and text, so every vector already paid for hits.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// SQLite's compiled-in default placeholder limit is 999.
const LOOKUP_CHUNK = 500;

/**
 * `sha1(f"{model}\0{dim}\0{text}")` in hex. A new model or dimension misses instead of returning
 * stale vectors; the old entries stay in the file.
 */
export function embedCacheKey(model: string, dim: number, text: string): string {
  return createHash("sha1").update(`${model}\0${dim}\0`, "utf8").update(text, "utf8").digest("hex");
}

// Typed arrays use the platform's byte order: little-endian wherever Bun runs, as numpy's
// tobytes() was wherever Python ran.
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
  readonly #db: Database;

  /** Opens the cache at `path`, creating the file and its folder when missing. */
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path, { create: true });
    // Python's sqlite3 waited up to 5 s for another writer's lock; bun:sqlite fails at once.
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS embed_cache (  key TEXT PRIMARY KEY,   vector BLOB NOT NULL)",
    );
    this.#db.exec("PRAGMA journal_mode=WAL");
  }

  /** The cached vector of each text that has one, by its index in `texts`. */
  getMany(model: string, dim: number, texts: readonly string[]): Map<number, Float32Array> {
    const found = new Map<number, Float32Array>();
    if (texts.length === 0) return found;
    const keys = texts.map((text) => embedCacheKey(model, dim, text));
    const blobs = new Map<string, Uint8Array>();
    for (let start = 0; start < keys.length; start += LOOKUP_CHUNK) {
      const chunk = keys.slice(start, start + LOOKUP_CHUNK);
      const query = this.#db.query<unknown, string[]>(
        `SELECT key, vector FROM embed_cache WHERE key IN (${chunk.map(() => "?").join(",")})`,
      );
      for (const [key, blob] of query.values(...chunk) as [string, Uint8Array][]) {
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
    const insert = this.#db.query<unknown, [string, Uint8Array]>(
      "INSERT OR REPLACE INTO embed_cache (key, vector) VALUES (?, ?)",
    );
    this.#db.transaction(() => {
      for (const [text, vector] of items) {
        insert.run(embedCacheKey(model, dim, text), encodeVector(vector));
      }
    })();
  }

  /** Vectors on disk, across every model and dimension. */
  count(): number {
    const row = this.#db.query("SELECT COUNT(*) FROM embed_cache").values()[0];
    return row === undefined ? 0 : Number(row[0]);
  }

  /**
   * Deletes every vector, of every persona, model and dimension, and returns their count. The file
   * stays, since another ingest may hold it open, and VACUUM gives the space back.
   */
  clear(): number {
    const { changes } = this.#db.run("DELETE FROM embed_cache");
    this.#db.exec("VACUUM");
    return changes;
  }

  close(): void {
    this.#db.close();
  }
}
