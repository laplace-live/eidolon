// mem0's OSS engine as it runs without spaCy and fastembed: entity linking and BM25 never run, so
// `text_lemmatized` is a copy of `data`, no sparse vector is written, and search is dense cosine
// similarity behind a threshold. Writing anything else would desync the points mem0 reads from the
// same collection.
import {
  type Clock,
  errorText,
  isPlainObject,
  logger,
  type OpenAIClientOptions,
  pyError,
  pyFloatRepr,
  pyGet,
  pyIsoformatUtc,
  pyIter,
  pyStr,
  pyStrip,
  pyTruthy,
  pyTypeName,
  sortedPy,
  utcDateParts,
  utcIsoDate,
  wallClockMicros,
} from "@eidolon/config";
import { billingProvider, jsonPoster, reportUsage, usageHook } from "@eidolon/providers";
import { type MemoryConfig, requireLlmKey } from "./config.ts";
import { ADDITIVE_EXTRACTION_PROMPT, AGENT_CONTEXT_SUFFIX } from "./extraction-prompt.ts";
import { type HistoryEntry, HistoryStore } from "./history.ts";
import {
  type Embedder,
  type ExtractionLlm,
  OpenAICompatibleChat,
  OpenAICompatibleEmbedder,
} from "./openai.ts";
import { generateAdditiveExtractionPrompt } from "./prompts.ts";
import {
  type QdrantApi,
  QdrantVectorStore,
  type ScopeFilters,
  type StoredPoint,
} from "./qdrant.ts";
import { buildSessionScope, type MemoryScope, scopeFilters } from "./scope.ts";
import { md5Hex, parseExtraction, parseMessages } from "./text.ts";
import { normalizeIsoTimestampToUtc, parseIsoDate, parseIsoDatetime } from "./time.ts";
import type { MemoryItem } from "./types.ts";

export const LIST_LIMIT = 1000;
export const DELETE_ALL_BATCH_SIZE = 1000;
const EXISTING_MEMORY_LOOKUP = 10;
const LAST_MESSAGES = 10;

/** A user/assistant message with string content, as the provider hands it over. */
export type ConversationMessage = Readonly<Record<string, unknown>> & {
  readonly role: string;
  readonly content: string;
};

export interface AddResult {
  readonly id: string;
  readonly memory: string;
  readonly event: "ADD";
}

export interface MemoryEngineDeps {
  readonly store: QdrantVectorStore;
  readonly embedder: Embedder;
  readonly llm: ExtractionLlm;
  readonly history: HistoryStore;
  readonly clock?: Clock;
  readonly newId?: () => string;
}

const PROMOTED = [
  "user_id",
  "agent_id",
  "run_id",
  "actor_id",
  "role",
  "attributed_to",
  "expiration_date",
];
const NOT_METADATA = new Set([
  "data",
  "hash",
  "created_at",
  "updated_at",
  "id",
  "text_lemmatized",
  ...PROMOTED,
]);

function get(
  payload: Readonly<Record<string, unknown>>,
  key: string,
  fallback: unknown = null,
): unknown {
  return Object.hasOwn(payload, key) ? payload[key] : fallback;
}

/** mem0's MemoryItem projection of a point, keys in its order; `score` only for search hits. */
function project(point: StoredPoint, score?: number): MemoryItem {
  const p = point.payload;
  const item: Record<string, unknown> = {
    id: point.id,
    memory: get(p, "data", ""),
    hash: get(p, "hash"),
    metadata: null,
  };
  if (score !== undefined) item.score = score;
  item.created_at = get(p, "created_at");
  item.updated_at = get(p, "updated_at");
  for (const key of PROMOTED) if (Object.hasOwn(p, key)) item[key] = p[key];
  const extra = Object.entries(p).filter(([key]) => !NOT_METADATA.has(key));
  if (extra.length) item.metadata = Object.fromEntries(extra);
  return item as unknown as MemoryItem;
}

function validateSearchParams(threshold: number | null, topK: number): void {
  if (threshold !== null && (threshold < 0 || threshold > 1)) {
    throw pyError(
      "ValueError",
      `Invalid threshold: ${pyFloatRepr(threshold)}. Must be between 0 and 1 (inclusive).`,
    );
  }
  if (!Number.isInteger(topK)) throw pyError("ValueError", "top_k must be a valid integer");
  if (topK < 0)
    throw pyError("ValueError", `Invalid top_k: ${topK}. Must be a non-negative integer.`);
}

function requireScope(filters: ScopeFilters): ScopeFilters {
  if (Object.keys(filters).length) return filters;
  throw pyError(
    "ValueError",
    "filters must contain at least one of: user_id, agent_id, run_id. Example: filters={'user_id': 'u1'}",
  );
}

function compareDates(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return 0;
}

interface PendingRecord {
  readonly id: string;
  readonly text: string;
  readonly vector: readonly number[];
  readonly payload: Record<string, unknown>;
}

export class MemoryEngine {
  readonly #store: QdrantVectorStore;
  readonly #embedder: Embedder;
  readonly #llm: ExtractionLlm;
  readonly #history: HistoryStore;
  readonly #clock: Clock;
  readonly #newId: () => string;

  constructor(deps: MemoryEngineDeps) {
    this.#store = deps.store;
    this.#embedder = deps.embedder;
    this.#llm = deps.llm;
    this.#history = deps.history;
    this.#clock = deps.clock ?? wallClockMicros;
    this.#newId = deps.newId ?? (() => crypto.randomUUID());
  }

  ensureCollection(): Promise<void> {
    return this.#store.ensureCollection();
  }

  /**
   * mem0 `add(infer=True)`: one extraction call over the whole transcript, ADD-only, hash-deduped
   * against the ten nearest existing memories. Takes no signal on purpose: an add that is under
   * way when the viewer hangs up still finishes and writes, as mem0's worker thread does.
   */
  async add(
    messages: readonly ConversationMessage[],
    options: { readonly scope: MemoryScope; readonly metadata: Readonly<Record<string, unknown>> },
  ): Promise<AddResult[]> {
    const filters = scopeFilters(options.scope);
    if (!Object.keys(filters).length) {
      throw pyError(
        "ValidationError",
        "At least one of 'user_id', 'agent_id', or 'run_id' must be provided.",
      );
    }
    const metadata = { ...options.metadata, ...filters };
    const sessionScope = buildSessionScope(filters);
    const lastMessages = this.#history.getLastMessages(sessionScope, LAST_MESSAGES);
    const transcript = parseMessages(messages);

    const queryVector = await this.#embedder.embed(transcript);
    const existing = await this.#store.search(queryVector, EXISTING_MEMORY_LOOKUP, filters);
    // mem0 shows the model integer ids instead of UUIDs, and never reads its links back.
    const existingMemories = existing.map((hit, i) => ({
      id: String(i),
      text: get(hit.payload, "data", ""),
    }));

    const agentScoped = Boolean(filters.agent_id) && !filters.user_id;
    const system = agentScoped
      ? ADDITIVE_EXTRACTION_PROMPT + AGENT_CONTEXT_SUFFIX
      : ADDITIVE_EXTRACTION_PROMPT;
    const user = generateAdditiveExtractionPrompt({
      existingMemories,
      newMessages: transcript,
      lastKMessages: lastMessages,
      currentDate: utcIsoDate(this.#clock()),
    });
    let reply: unknown;
    try {
      reply = await this.#llm.complete([
        { role: "system", content: system },
        { role: "user", content: user },
      ]);
    } catch (error) {
      logger.error(`LLM extraction failed: ${errorText(error)}`);
      throw pyError("LLMError", `LLM extraction failed: ${errorText(error)}`);
    }

    const extracted = parseExtraction(reply);
    if (!pyTruthy(extracted)) {
      this.#history.saveMessages(messages, sessionScope);
      return [];
    }
    // Iterated as Python would, so a malformed extraction raises the same errors.
    const items = pyIter(extracted);
    const texts = items
      .filter((item) => pyTruthy(pyGet(item, "text")))
      .map((item) => pyGet(item, "text", ""));
    const vectors = await this.#embedTexts(texts);

    const existingHashes = new Set(
      existing.map((hit) => get(hit.payload, "hash")).filter(pyTruthy),
    );
    const seen = new Set<string>();
    const records: PendingRecord[] = [];
    for (const item of items) {
      const text = pyGet(item, "text");
      if (!pyTruthy(text)) continue;
      if (Array.isArray(text) || isPlainObject(text)) {
        throw pyError("TypeError", `unhashable type: '${pyTypeName(text)}'`);
      }
      if (typeof text !== "string") continue;
      const vector = vectors.get(text);
      if (!vector) continue;
      const hash = md5Hex(text);
      if (existingHashes.has(hash) || seen.has(hash)) continue;
      seen.add(hash);
      const id = this.#newId();
      const createdAt = pyIsoformatUtc(this.#clock());
      const payload: Record<string, unknown> = {
        ...metadata,
        data: text,
        text_lemmatized: text,
        hash,
        created_at: createdAt,
        updated_at: createdAt,
      };
      const attributedTo = pyGet(item, "attributed_to");
      if (pyTruthy(attributedTo)) payload.attributed_to = attributedTo;
      records.push({ id, text, vector, payload });
    }
    if (!records.length) {
      this.#history.saveMessages(messages, sessionScope);
      return [];
    }

    try {
      await this.#store.insert(records);
    } catch {
      for (const record of records) {
        try {
          await this.#store.insert([record]);
        } catch (error) {
          logger.error(`Failed to insert memory ${record.id}: ${errorText(error)}`);
        }
      }
    }
    // History rows go in for every record, inserted or not, as mem0 writes them.
    const entries: HistoryEntry[] = records.map((record) => ({
      memoryId: record.id,
      oldMemory: null,
      newMemory: record.text,
      event: "ADD",
      createdAt: record.payload.created_at,
      isDeleted: 0,
    }));
    try {
      this.#history.batchAddHistory(entries);
    } catch {
      for (const entry of entries) {
        try {
          this.#history.addHistory(entry);
        } catch (error) {
          logger.error(`Failed to add history for ${entry.memoryId}: ${errorText(error)}`);
        }
      }
    }
    this.#history.saveMessages(messages, sessionScope);
    return records.map((record) => ({ id: record.id, memory: record.text, event: "ADD" }));
  }

  /** One batch request, falling back to one request per text; texts that fail are dropped. */
  async #embedTexts(texts: readonly unknown[]): Promise<Map<string, readonly number[]>> {
    const vectors = new Map<string, readonly number[]>();
    try {
      const batch = await this.#embedder.embedBatch(texts);
      for (const [i, text] of texts.entries()) vectors.set(text as string, batch[i] as number[]);
    } catch {
      for (const text of texts) {
        try {
          const vector = await this.#embedder.embed(text);
          vectors.set(text as string, vector);
        } catch (error) {
          logger.warning(`Failed to embed memory text: ${errorText(error)}`);
        }
      }
    }
    return vectors;
  }

  #isExpired(payload: Readonly<Record<string, unknown>>): boolean {
    if (!pyTruthy(payload)) return false;
    const expiration = get(payload, "expiration_date");
    if (!pyTruthy(expiration)) return false;
    let date: [number, number, number];
    try {
      date = parseIsoDate(pyStr(expiration));
    } catch {
      return false;
    }
    return compareDates(date, utcDateParts(this.#clock())) < 0;
  }

  /**
   * mem0 `search`: over-fetch `max(4·topK, 60)` neighbours, gate on the raw cosine score, keep
   * `topK`, then drop hits without `data`. That order means a dataless hit costs a slot.
   */
  async search(
    query: string,
    options: { readonly filters: MemoryScope; readonly topK?: number; readonly threshold?: number },
  ): Promise<MemoryItem[]> {
    const topK = options.topK ?? 20;
    const threshold = options.threshold ?? 0.1;
    validateSearchParams(threshold, topK);
    if (typeof query !== "string") {
      throw pyError("ValueError", "Invalid query: must be a non-empty string.");
    }
    const trimmed = pyStrip(query);
    if (!trimmed) throw pyError("ValueError", "Invalid query: cannot be empty or whitespace-only.");
    const filters = requireScope(scopeFilters(options.filters));
    const vector = await this.#embedder.embed(trimmed);
    const hits = await this.#store.search(vector, Math.max(topK * 4, 60), filters);
    const scored: { point: StoredPoint; score: number }[] = [];
    for (const hit of hits) {
      if (this.#isExpired(hit.payload)) continue;
      const score = hit.score || 0;
      if (score < threshold) continue;
      scored.push({ point: hit, score: Math.min(score, 1) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored
      .slice(0, topK)
      .filter(({ point }) => pyTruthy(get(point.payload, "data")))
      .map(({ point, score }) => project(point, score));
  }

  /** mem0 `get_all`: one id-ordered scroll of `max(4·topK, 60)` points, unexpired, up to `topK`. */
  async getAll(options: {
    readonly filters: MemoryScope;
    readonly topK?: number;
  }): Promise<MemoryItem[]> {
    const topK = options.topK ?? 20;
    validateSearchParams(null, topK);
    const filters = requireScope(scopeFilters(options.filters));
    const points = await this.#store.list(filters, Math.max(topK * 4, 60));
    const items: MemoryItem[] = [];
    for (const point of points) {
      if (this.#isExpired(point.payload)) continue;
      items.push(project(point));
      if (items.length >= topK) break;
    }
    return items;
  }

  /** mem0 `delete_all`: scroll and delete until the scope is empty. Returns how many went. */
  async deleteAll(scope: MemoryScope): Promise<number> {
    const filters = scopeFilters(scope);
    if (!Object.keys(filters).length) {
      throw pyError(
        "ValueError",
        "At least one filter is required to delete all memories. If you want to delete all memories, use the `reset()` method.",
      );
    }
    let deleted = 0;
    const seen = new Set<string>();
    for (;;) {
      const points = await this.#store.list(filters, DELETE_ALL_BATCH_SIZE);
      if (!points.length) break;
      const batch = JSON.stringify(sortedPy(points.map((point) => point.id)));
      if (seen.has(batch)) {
        logger.warning("Stopping delete_all after a repeated memory batch");
        break;
      }
      seen.add(batch);
      for (const point of points) await this.#deleteMemory(point.id);
      deleted += points.length;
    }
    return deleted;
  }

  async #deleteMemory(id: string): Promise<void> {
    const existing = await this.#store.get(id);
    if (!existing) {
      throw pyError(
        "ValueError",
        `Memory with id ${id} not found. Please provide a valid 'memory_id'`,
      );
    }
    const payload = existing.payload;
    const oldMemory = get(payload, "data", "");
    const createdAt = normalizeIsoTimestampToUtc(get(payload, "created_at"));
    const updatedAt = pyIsoformatUtc(this.#clock());
    await this.#store.delete(id);
    this.#history.addHistory({
      memoryId: id,
      oldMemory,
      newMemory: null,
      event: "DELETE",
      createdAt,
      updatedAt,
      actorId: get(payload, "actor_id"),
      role: get(payload, "role"),
      isDeleted: 1,
    });
  }
}

/** Builds the engine's clients, runs mem0's collection setup and opens the history DB. */
export async function openMemoryEngine(
  config: MemoryConfig,
  options: { readonly qdrantClient?: QdrantApi; readonly http?: OpenAIClientOptions } = {},
): Promise<MemoryEngine> {
  const { embedder: embedding, llm: chat } = config;
  const embedder = new OpenAICompatibleEmbedder(
    embedding,
    // The configured model, as retrieval records it: OpenRouter answers with the id unprefixed.
    jsonPoster(embedding, options.http, (units, _model, reportedUsd) =>
      reportUsage({
        role: "embeddings",
        provider: billingProvider(embedding.provider, embedding.baseUrl),
        model: embedding.model,
        units,
        costUsd: reportedUsd,
      }),
    ),
  );
  const store = new QdrantVectorStore(config.qdrant, options.qdrantClient);
  await store.ensureCollection();
  const llmClient = jsonPoster(
    { provider: chat.provider, baseUrl: chat.baseUrl, apiKey: requireLlmKey(chat) },
    options.http,
    usageHook("memory", chat.provider),
  );
  const llm = new OpenAICompatibleChat(chat.model, llmClient);
  const history = new HistoryStore(config.historyDbPath);
  return new MemoryEngine({ store, embedder, llm, history });
}

/** The process's one engine: only a successful open is kept, and concurrent callers share one. */
export class SharedEngine {
  #engine: MemoryEngine | null = null;
  #opening: Promise<MemoryEngine> | null = null;
  readonly #open: (config: MemoryConfig) => Promise<MemoryEngine>;

  constructor(open: (config: MemoryConfig) => Promise<MemoryEngine> = openMemoryEngine) {
    this.#open = open;
  }

  /** `fresh` is true when this call (or the one it joined) just ran the collection setup. */
  async get(config: MemoryConfig): Promise<{ engine: MemoryEngine; fresh: boolean }> {
    if (this.#engine) return { engine: this.#engine, fresh: false };
    this.#opening ??= this.#open(config)
      .then((engine) => {
        this.#engine = engine;
        return engine;
      })
      .finally(() => {
        this.#opening = null;
      });
    return { engine: await this.#opening, fresh: true };
  }
}

/**
 * Newest first by `created_at` as an instant: cloud-imported memories carry -07:00 offsets, local
 * writes +00:00, so sorting the raw strings would misorder them. Stable for equal instants; a
 * missing or unparseable stamp, or naive and aware stamps mixed, raises as Python's sort does.
 */
export function sortNewestFirst(items: readonly MemoryItem[]): MemoryItem[] {
  const keyed = items.map((item) => ({ item, at: parseIsoDatetime(item.created_at) }));
  if (keyed.some((k) => k.at.aware) && keyed.some((k) => !k.at.aware)) {
    throw pyError("TypeError", "can't compare offset-naive and offset-aware datetimes");
  }
  keyed.sort((a, b) => (a.at.micros < b.at.micros ? 1 : a.at.micros > b.at.micros ? -1 : 0));
  return keyed.map((k) => k.item);
}
