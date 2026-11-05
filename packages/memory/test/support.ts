// Fakes shared by the tests. FakeQdrant and FakePoster behave exactly like the fakes the Python
// oracle drove mem0 with (fixtures/*.json), so a fixture case replays here unchanged.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleSink, cpLen, type JsonPoster, type LogRecord, logger } from "@eidolon/config";
import type { QdrantApi } from "../src/qdrant.ts";

export type Payload = Record<string, unknown>;

interface Filter {
  must?: { key: string; match: { value: unknown } }[];
}

function matches(filter: Filter | undefined, payload: Payload): boolean {
  return (filter?.must ?? []).every((c) => payload[c.key] === c.match.value);
}

export interface FakeQdrantOptions {
  collections?: string[];
  sparse?: Record<string, unknown> | null;
  fail?: Record<string, unknown>;
}

/** An in-memory Qdrant: query by a fixed score table, scroll by id, recording canonical calls. */
export class FakeQdrant {
  readonly calls: unknown[][] = [];
  readonly raw: [string, unknown][] = [];
  readonly points = new Map<string, Payload>();
  scores: Record<string, number> = {};
  noopDelete = false;
  missing: string[] = [];
  readonly collections: string[];
  readonly sparse: Record<string, unknown> | null;
  readonly fail: Record<string, unknown>;

  constructor(options: FakeQdrantOptions = {}) {
    this.collections = options.collections ?? ["eidolon_memories"];
    this.sparse = options.sparse === undefined ? { bm25: {} } : options.sparse;
    this.fail = { ...(options.fail ?? {}) };
  }

  get api(): QdrantApi {
    return this as unknown as QdrantApi;
  }

  #maybeFail(name: string): void {
    const n = this.fail[name];
    if (typeof n === "number" && n > 0) {
      this.fail[name] = n - 1;
      throw new Error(`${name} failed`);
    }
  }

  async getCollections() {
    this.calls.push(["getCollections"]);
    return { collections: this.collections.map((name) => ({ name })) };
  }

  async getCollection(name: string) {
    this.calls.push(["getCollection", name]);
    return { config: { params: { sparse_vectors: this.sparse } } };
  }

  async createCollection(_name: string, args: { vectors: unknown; sparse_vectors: unknown }) {
    this.raw.push(["createCollection", args]);
    this.calls.push([
      "createCollection",
      { vectors: args.vectors, sparse_vectors: args.sparse_vectors },
    ]);
    return true;
  }

  async createPayloadIndex(_name: string, args: { field_name: string; field_schema: string }) {
    this.raw.push(["createPayloadIndex", args]);
    this.calls.push(["createPayloadIndex", args.field_name, args.field_schema]);
    this.#maybeFail("create_payload_index");
    return { operation_id: 0, status: "completed" };
  }

  async upsert(
    _name: string,
    args: { points: { id: string; vector: unknown; payload: Payload }[] },
  ) {
    this.raw.push(["upsert", args]);
    this.calls.push(["upsert", args.points]);
    const rejected = (this.fail.upsert_ids as string[] | undefined) ?? [];
    for (const p of args.points) {
      if (rejected.includes(p.id)) throw new Error(`upsert rejected ${p.id}`);
    }
    this.#maybeFail("upsert");
    for (const p of args.points) this.points.set(p.id, p.payload);
    return { operation_id: 0, status: "completed" };
  }

  async query(_name: string, args: { query: number[]; filter?: Filter; limit: number }) {
    this.raw.push(["query", args]);
    this.calls.push([
      "query",
      { query: args.query, filter: args.filter ?? null, limit: args.limit },
    ]);
    const hits = [...this.points]
      .filter(([, payload]) => matches(args.filter, payload))
      .map(([id, payload]) => ({ id, version: 0, score: this.scores[id] ?? 0.5, payload }));
    hits.sort((a, b) => b.score - a.score);
    return { points: hits.slice(0, args.limit) };
  }

  async scroll(_name: string, args: { filter?: Filter; limit: number }) {
    this.raw.push(["scroll", args]);
    this.calls.push(["scroll", { filter: args.filter ?? null, limit: args.limit }]);
    const ids = [...this.points.keys()].sort();
    const points = ids
      .filter((id) => matches(args.filter, this.points.get(id) as Payload))
      .map((id) => ({ id, payload: this.points.get(id) as Payload }));
    return { points: points.slice(0, args.limit), next_page_offset: null };
  }

  async retrieve(_name: string, args: { ids: string[] }) {
    this.raw.push(["retrieve", args]);
    this.calls.push(["retrieve", args.ids]);
    return args.ids
      .filter((id) => this.points.has(id) && !this.missing.includes(id))
      .map((id) => ({ id, payload: this.points.get(id) as Payload }));
  }

  async delete(_name: string, args: { points: string[] }) {
    this.raw.push(["delete", args]);
    this.calls.push(["delete", args.points]);
    if (!this.noopDelete) for (const id of args.points) this.points.delete(id);
    return { operation_id: 0, status: "completed" };
  }
}

export type ChatResponse = string | null | { raise: string };

/** OpenAI-compatible endpoints: embeddings follow a plan, chat replies with queued contents. */
export class FakePoster implements JsonPoster {
  readonly embedCalls: Record<string, unknown>[] = [];
  readonly chatCalls: Record<string, unknown>[] = [];
  embedPlan: string[] = [];
  responses: ChatResponse[] = [];

  async post(path: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (path === "embeddings") {
      this.embedCalls.push({ ...body });
      const plan = this.embedPlan.shift() ?? "ok";
      if (plan === "fail") throw new Error("embedding request failed");
      let data = (body.input as string[]).map((text, index) => ({
        index,
        embedding: [cpLen(text), 1, 0, 0],
      }));
      if (plan === "short") data = data.slice(0, -1);
      if (plan === "reversed") data = data.reverse();
      return { data };
    }
    this.chatCalls.push({ ...body });
    const reply = this.responses.shift();
    if (reply !== null && typeof reply === "object") throw new Error(reply.raise);
    return { choices: [{ message: { content: reply ?? null } }] };
  }
}

/** The clock and uuid4 the oracle pinned: base + n·step microseconds, UUID(int=n). */
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
