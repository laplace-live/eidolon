// Fakes shared by the tests. FakeStore, FakePoster and FakeEmbeddings behave like the fakes mem0
// ran against to record fixtures/*.json, so a fixture case replays here unchanged.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleSink, cpLen, type JsonPoster, type LogRecord, logger } from "@eidolon/config";
import { type EmbeddingModel, EmbeddingUsage } from "@eidolon/providers";
import type { NewPoint, ScopeFilters, StoredPoint, VectorStore } from "../src/zvec.ts";

export type Payload = Record<string, unknown>;

interface Filter {
  must: { key: string; match: { value: unknown } }[];
}

function filterFor(filters: ScopeFilters): Filter | null {
  const must = Object.entries(filters).map(([key, value]) => ({ key, match: { value } }));
  return must.length ? { must } : null;
}

function matches(filter: Filter | null, payload: Payload): boolean {
  return (filter?.must ?? []).every((c) => payload[c.key] === c.match.value);
}

export interface FakeStoreOptions {
  fail?: Record<string, unknown>;
}

/** An in-memory vector store: query by a fixed score table, list by id, recording canonical calls. */
export class FakeStore implements VectorStore {
  readonly calls: unknown[][] = [];
  readonly points = new Map<string, Payload>();
  scores: Record<string, number> = {};
  noopDelete = false;
  missing: string[] = [];
  readonly fail: Record<string, unknown>;

  constructor(options: FakeStoreOptions = {}) {
    this.fail = { ...(options.fail ?? {}) };
  }

  #maybeFail(name: string): void {
    const n = this.fail[name];
    if (typeof n === "number" && n > 0) {
      this.fail[name] = n - 1;
      throw new Error(`${name} failed`);
    }
  }

  async ensureCollection(): Promise<void> {
    this.calls.push(["ensureCollection"]);
  }

  async insert(points: readonly NewPoint[]): Promise<void> {
    const formatted = points.map((p) => ({
      id: p.id,
      vector: { "": [...p.vector] },
      payload: { ...p.payload },
    }));
    this.calls.push(["upsert", formatted]);
    const rejected = (this.fail.upsert_ids as string[] | undefined) ?? [];
    for (const p of points) {
      if (rejected.includes(p.id)) throw new Error(`upsert rejected ${p.id}`);
    }
    this.#maybeFail("upsert");
    for (const p of formatted) this.points.set(p.id, p.payload);
  }

  async search(
    vector: readonly number[],
    limit: number,
    filters: ScopeFilters,
  ): Promise<StoredPoint[]> {
    const filter = filterFor(filters);
    this.calls.push(["query", { query: [...vector], filter, limit }]);
    const hits = [...this.points]
      .filter(([, payload]) => matches(filter, payload))
      .map(([id, payload]) => ({ id, score: this.scores[id] ?? 0.5, payload }));
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  async list(filters: ScopeFilters, limit: number): Promise<StoredPoint[]> {
    const filter = filterFor(filters);
    this.calls.push(["scroll", { filter, limit }]);
    const ids = [...this.points.keys()].sort();
    return ids
      .filter((id) => matches(filter, this.points.get(id) as Payload))
      .slice(0, limit)
      .map((id) => ({ id, payload: this.points.get(id) as Payload }));
  }

  async get(id: string): Promise<StoredPoint | null> {
    this.calls.push(["retrieve", [id]]);
    if (!this.points.has(id) || this.missing.includes(id)) return null;
    return { id, payload: this.points.get(id) as Payload };
  }

  async delete(id: string): Promise<void> {
    this.calls.push(["delete", [id]]);
    if (!this.noopDelete) this.points.delete(id);
  }
}

export type ChatResponse = string | null | { raise: string };

/** The embedding model: each request follows the plan, and is recorded as what it asked for. */
export class FakeEmbeddings implements EmbeddingModel {
  readonly provider = "openrouter";
  readonly model: string;
  readonly calls: Record<string, unknown>[] = [];
  plan: string[] = [];

  constructor(model = "google/gemini-embedding-2-preview") {
    this.model = model;
  }

  async embed(texts: readonly string[], dimensions: number): Promise<[number[][], EmbeddingUsage]> {
    this.calls.push({ input: [...texts], model: this.model, dimensions });
    const plan = this.plan.shift() ?? "ok";
    if (plan === "fail") throw new Error("embedding request failed");
    const vectors = texts.map((text) => [cpLen(text), 1, 0, 0]);
    return [plan === "short" ? vectors.slice(0, -1) : vectors, new EmbeddingUsage()];
  }
}

/** An OpenAI-compatible chat endpoint, replying with queued contents. */
export class FakePoster implements JsonPoster {
  readonly chatCalls: Record<string, unknown>[] = [];
  responses: ChatResponse[] = [];

  async post(_path: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.chatCalls.push({ ...body });
    const reply = this.responses.shift();
    if (reply !== null && typeof reply === "object") throw new Error(reply.raise);
    return { choices: [{ message: { content: reply ?? null } }] };
  }
}

/** The clock and uuid4 the fixtures pin: base + n·step microseconds, UUID(int=n). */
export function pinned(base: number, step: number) {
  const state = { clockReads: 0, uuids: 0 };
  return {
    state,
    clock: () => base + state.clockReads++ * step,
    newId: () => uuidFromInt(++state.uuids),
    resetClock: () => {
      state.clockReads = 0;
    },
  };
}

export function uuidFromInt(n: number): string {
  const hex = n.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Records every log line, instead of printing it, until `stop()`. */
export function captureLogs() {
  const records: LogRecord[] = [];
  logger.setSink((record) => records.push(record));
  const stop = () => logger.setSink(consoleSink);
  return {
    records,
    stop,
    at(...levels: string[]): [string, string][] {
      return records.filter((r) => levels.includes(r.level)).map((r) => [r.level, r.message]);
    },
  };
}

// Parsed, not imported: Vite's JSON import rejects its lone surrogates ("\ud800"), valid JSON.
export const timeFixtures: typeof import("./fixtures/time.json") = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "time.json"), "utf8"),
);

export function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "eidolon-memory-")), name);
}

const original = new Map<string, string | undefined>();

function apply(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export function setEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (!original.has(name)) original.set(name, process.env[name]);
    apply(name, value);
  }
}

/** Puts back whatever the process had before the first `setEnv`. */
export function resetEnv(): void {
  for (const [name, value] of original) apply(name, value);
  original.clear();
}

export const MEMORY_ENV_KEYS = [
  "MEM0_ENABLED",
  "MEM0_DIR",
  "MEM0_QDRANT_HOST",
  "MEM0_QDRANT_PORT",
  "MEM0_QDRANT_COLLECTION",
  "MEM0_HISTORY_DB_PATH",
  "MEM0_LLM_MODEL",
  "MEM0_AGENT_ID",
  "MEM0_RUN_ID",
  "MEM0_SEARCH_LIMIT",
  "MEM0_SEARCH_THRESHOLD",
  "OPENROUTER_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_API_BASE",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "EMBED_API_KEY",
  "EMBED_BASE_URL",
  "EMBED_MODEL",
  "EMBED_DIM",
];

/** Unsets every variable memory reads, so the shell's environment can't leak into a test. */
export function clearMemoryEnv(): void {
  setEnv(Object.fromEntries(MEMORY_ENV_KEYS.map((k) => [k, undefined])));
}
