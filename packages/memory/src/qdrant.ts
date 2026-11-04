// mem0's Qdrant vector store. Two bots share the collection during cutover, so points are written
// exactly as mem0 writes them: one unnamed dense vector, no sparse vector.
//
// @qdrant/js-client-rest defaults differ from Python's qdrant-client: `delete` and
// `createPayloadIndex` don't wait, `query` omits payloads, and requests time out after 300 s
// instead of 5 s. Every call below states the Python behavior explicitly; `deleteAll` relies on
// waited deletes, or its next scroll returns the batch it just deleted.
import { errorText, logger } from "@eidolon/config";
import { QdrantClient } from "@qdrant/js-client-rest";

export type QdrantApi = Pick<
  QdrantClient,
  | "getCollections"
  | "getCollection"
  | "createCollection"
  | "createPayloadIndex"
  | "upsert"
  | "query"
  | "scroll"
  | "retrieve"
  | "delete"
>;

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

export interface QdrantSettings {
  readonly host: string;
  readonly port: number;
  readonly collection: string;
  readonly vectorSize: number;
}

export const QDRANT_TIMEOUT_MS = 5_000;
const INDEXED_FIELDS = ["user_id", "agent_id", "run_id", "actor_id"] as const;

function filterFor(filters: ScopeFilters) {
  const must = Object.entries(filters).map(([key, value]) => ({ key, match: { value } }));
  return must.length ? { must } : undefined;
}

function stored(point: {
  id: string | number;
  payload?: Record<string, unknown> | null;
  score?: number;
}): StoredPoint {
  const base = { id: String(point.id), payload: point.payload ?? {} };
  return point.score === undefined ? base : { ...base, score: point.score };
}

export class QdrantVectorStore {
  readonly #client: QdrantApi;
  readonly #collection: string;
  readonly #vectorSize: number;

  constructor(settings: QdrantSettings, client?: QdrantApi) {
    // Python checks the server version in a background thread and only warns; so does this.
    this.#client =
      client ??
      new QdrantClient({
        host: settings.host,
        port: settings.port,
        timeout: QDRANT_TIMEOUT_MS,
        checkCompatibility: true,
      });
    this.#collection = settings.collection;
    this.#vectorSize = settings.vectorSize;
  }

  /** mem0 `create_col`: create the collection if missing, then (re)create the keyword indexes. */
  async ensureCollection(): Promise<void> {
    const { collections } = await this.#client.getCollections();
    if (collections.some((c) => c.name === this.#collection)) {
      const info = await this.#client.getCollection(this.#collection);
      const sparse = info.config.params.sparse_vectors;
      if (!(sparse && "bm25" in sparse)) {
        logger.warning(
          `Collection '${this.#collection}' predates v3 hybrid search (no 'bm25' sparse slot). ` +
            "BM25 keyword scoring will be disabled for this collection; semantic search works normally. " +
            "To enable hybrid search, use a fresh collection.",
        );
      }
    } else {
      // Vectors on disk rather than mmap'd into RAM: at 3072 dims the resident set otherwise grows
      // with every viewer, on a box already running the bot itself. The bm25 slot stays empty
      // (the Python bot has no sparse encoder installed), but without it mem0 warns that the
      // collection predates hybrid search every time it opens it.
      await this.#client.createCollection(this.#collection, {
        vectors: { size: this.#vectorSize, distance: "Cosine", on_disk: true },
        sparse_vectors: { bm25: { modifier: "idf" } },
      });
    }
    for (const field_name of INDEXED_FIELDS) {
      try {
        await this.#client.createPayloadIndex(this.#collection, {
          field_name,
          field_schema: "keyword",
          wait: true,
        });
      } catch (error) {
        logger.trace(`Index for ${field_name} might already exist: ${errorText(error)}`);
      }
    }
  }

  async insert(points: readonly NewPoint[]): Promise<void> {
    await this.#client.upsert(this.#collection, {
      wait: true,
      points: points.map((p) => ({
        id: p.id,
        vector: { "": [...p.vector] },
        payload: { ...p.payload },
      })),
    });
  }

  /** Dense nearest neighbours, best first. No score threshold, no expiry filter. */
  async search(
    vector: readonly number[],
    limit: number,
    filters: ScopeFilters,
  ): Promise<StoredPoint[]> {
    const result = await this.#client.query(this.#collection, {
      query: [...vector],
      filter: filterFor(filters),
      limit,
      with_payload: true,
      with_vector: false,
    });
    return result.points.map(stored);
  }

  /** One scroll page, which Qdrant orders by point id. */
  async list(filters: ScopeFilters, limit: number): Promise<StoredPoint[]> {
    const result = await this.#client.scroll(this.#collection, {
      filter: filterFor(filters),
      limit,
      with_payload: true,
      with_vector: false,
    });
    return result.points.map(stored);
  }

  async get(id: string): Promise<StoredPoint | null> {
    const points = await this.#client.retrieve(this.#collection, {
      ids: [id],
      with_payload: true,
      with_vector: false,
    });
    const point = points[0];
    return point ? stored(point) : null;
  }

  async delete(id: string): Promise<void> {
    await this.#client.delete(this.#collection, { points: [id], wait: true });
  }
}
