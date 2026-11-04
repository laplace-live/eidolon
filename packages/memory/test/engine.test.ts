// Parity with mem0: every case in fixtures/engine.json was produced by running mem0's own
// Memory.add/search/get_all/delete_all and Qdrant.create_col against the fakes in support.ts, with
// the clock and uuid4 pinned. Each replays here and must match call for call, row for row.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MemoryEngine, openMemoryEngine, sortNewestFirst } from "../src/engine.ts";
import { ADDITIVE_EXTRACTION_PROMPT, AGENT_CONTEXT_SUFFIX } from "../src/extraction-prompt.ts";
import { HistoryStore } from "../src/history.ts";
import { OpenAICompatibleChat, OpenAICompatibleEmbedder } from "../src/openai.ts";
import { QdrantVectorStore } from "../src/qdrant.ts";
import type { MemoryItem } from "../src/types.ts";
import fixtures from "./fixtures/engine.json";
import timeFixtures from "./fixtures/time.json";
import {
  type ChatResponse,
  captureLogs,
  FakePoster,
  FakeQdrant,
  type Payload,
  pinned,
  tempPath,
} from "./support.ts";

type Ids = { user_id?: string | null; agent_id?: string | null; run_id?: string | null };

function scope(ids: Ids) {
  return { userId: ids.user_id, agentId: ids.agent_id, runId: ids.run_id };
}

function build(options: {
  fake: FakeQdrant;
  poster: FakePoster;
  pins: ReturnType<typeof pinned>;
  model?: string;
  vectorSize?: number;
}) {
  const dbPath = tempPath("history.db");
  const store = new QdrantVectorStore(
    { host: "h", port: 6333, collection: "eidolon_memories", vectorSize: options.vectorSize ?? 4 },
    options.fake.api,
  );
  const history = new HistoryStore(dbPath, {
    clock: options.pins.clock,
    newId: options.pins.newId,
  });
  const engine = new MemoryEngine({
    store,
    embedder: new OpenAICompatibleEmbedder(
      { model: "google/gemini-embedding-2-preview", dims: 4 },
      options.poster,
    ),
    llm: new OpenAICompatibleChat(options.model ?? "~google/gemini-flash-latest", options.poster),
    history,
    clock: options.pins.clock,
    newId: options.pins.newId,
  });
  return { engine, history, store, dbPath };
}

function rows(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      history: db
        .query(
          "SELECT id, memory_id, old_memory, new_memory, event, created_at, updated_at, is_deleted, actor_id, role FROM history ORDER BY rowid",
        )
        .values(),
      messages: db
        .query(
          "SELECT id, session_scope, role, content, name, created_at FROM messages ORDER BY rowid",
        )
        .values(),
    };
  } finally {
    db.close();
  }
}

async function outcome(run: () => Promise<unknown>) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const e = error as Error;
    return { ok: false, error: [e.name, e.message] };
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

const PROBLEM_LEVELS = ["WARNING", "ERROR", "CRITICAL"];

describe("add replays mem0", () => {
  for (const c of fixtures.add) {
    test(c.name, async () => {
      const pins = pinned(c.input.base, c.input.step);
      const fake = new FakeQdrant({ fail: c.input.fail });
      for (const [id, payload] of Object.entries(c.input.existing)) fake.points.set(id, payload);
      fake.scores = c.input.scores as Record<string, number>;
      const poster = new FakePoster();
      poster.responses = [...(c.input.responses as ChatResponse[])];
      poster.embedPlan = [...c.input.embed_plan];
      const { engine, history, dbPath } = build({ fake, poster, pins, model: c.input.model });
      const prior = c.input.prior_messages as [Payload[], string] | null;
      if (prior) {
        history.saveMessages(prior[0], prior[1]);
        pins.resetClock();
      }
      const logs = captureLogs();
      const result = await outcome(() =>
        engine.add(c.input.messages as never, {
          scope: scope(c.input),
          metadata: { platform: "pipecat" },
        }),
      );
      logs.stop();

      expect(result as unknown).toEqual(
        c.ok ? { ok: true, value: c.value } : { ok: false, error: c.error },
      );
      expect(logs.at(...PROBLEM_LEVELS)).toEqual(c.logs as [string, string][]);
      // Stringified so payload key order is compared too: both bots write these points.
      expect(json(fake.calls)).toBe(json(c.qdrant));
      expect(json(poster.embedCalls)).toBe(json(c.embed));
      const chat = poster.chatCalls.map((call) => {
        const messages = (call.messages as { role: string; content: string }[]).map((m) => ({
          ...m,
        }));
        const system = messages[0] as { content: string };
        if (system.content === ADDITIVE_EXTRACTION_PROMPT) {
          system.content = "<ADDITIVE_EXTRACTION_PROMPT>";
        } else if (system.content === ADDITIVE_EXTRACTION_PROMPT + AGENT_CONTEXT_SUFFIX) {
          system.content = "<ADDITIVE_EXTRACTION_PROMPT+AGENT_CONTEXT_SUFFIX>";
        }
        return { ...call, messages };
      });
      expect(json(chat)).toBe(json(c.chat));
      expect(rows(dbPath)).toEqual(c.db as never);
      expect(pins.state.clockReads).toBe(c.clock_reads);
      expect(pins.state.uuids).toBe(c.uuids);
    });
  }
});

function seeded(points: Record<string, Payload>, scores: Record<string, number> = {}) {
  const fake = new FakeQdrant();
  for (const [id, payload] of Object.entries(points)) fake.points.set(id, payload);
  fake.scores = scores;
  return fake;
}

describe("search replays mem0", () => {
  // The Python case crashes in mem0's telemetry (`None.encode()`), which the port leaves out.
  for (const c of fixtures.search.filter((s) => s.name !== "trim_ids")) {
    test(c.name, async () => {
      const pins = pinned(1793678706123456, 1000001);
      const fake = seeded(fixtures.search_points, fixtures.search_scores);
      const poster = new FakePoster();
      const { engine } = build({ fake, poster, pins });
      const logs = captureLogs();
      const result = await outcome(() =>
        engine.search(c.input.query, {
          filters: scope(c.input.filters as Ids),
          topK: c.input.top_k,
          threshold: c.input.threshold,
        }),
      );
      logs.stop();
      expect(json(result)).toBe(
        json(c.ok ? { ok: true, value: c.value } : { ok: false, error: c.error }),
      );
      expect(logs.at(...PROBLEM_LEVELS)).toEqual(c.logs as [string, string][]);
      expect(json(fake.calls)).toBe(json(c.qdrant));
      expect(json(poster.embedCalls)).toBe(json(c.embed));
      expect(pins.state.clockReads).toBe(c.clock_reads);
    });
  }

  test("ids are trimmed before they filter", async () => {
    const fake = seeded(fixtures.search_points, fixtures.search_scores);
    const pins = pinned(1793678706123456, 1);
    const { engine } = build({ fake, poster: new FakePoster(), pins });
    const hits = await engine.search("q", {
      filters: { userId: " 12345678 " },
      topK: 10,
      threshold: 0.3,
    });
    expect(hits.map((h) => h.memory)).toEqual(["A fact", "B cloud", "F future", "H bad expiry"]);
    expect(json((fake.calls[0] as unknown[])[1])).toContain('"value":"12345678"');
  });
});

describe("get_all replays mem0", () => {
  for (const c of fixtures.get_all) {
    test(c.name, async () => {
      const pins = pinned(1793678706123456, 1000001);
      const fake = seeded(fixtures.search_points);
      const { engine } = build({ fake, poster: new FakePoster(), pins });
      const result = await outcome(() =>
        engine.getAll({ filters: scope(c.input.filters as Ids), topK: c.input.top_k }),
      );
      expect(json(result)).toBe(
        json(c.ok ? { ok: true, value: c.value } : { ok: false, error: c.error }),
      );
      expect(json(fake.calls)).toBe(json(c.qdrant));
      expect(pins.state.clockReads).toBe(c.clock_reads);
    });
  }
});

describe("delete_all replays mem0", () => {
  for (const c of fixtures.delete) {
    test(c.name, async () => {
      const pins = pinned(1793678706123456, 1000001);
      const fake = seeded(c.input.points as Record<string, Payload>);
      fake.noopDelete = c.input.noop;
      fake.missing = c.input.missing;
      const { engine, dbPath } = build({ fake, poster: new FakePoster(), pins });
      const logs = captureLogs();
      const result = await outcome(() => engine.deleteAll({ userId: c.input.user_id }));
      logs.stop();
      if (c.ok) expect(result.ok).toBe(true);
      else expect(result as unknown).toEqual({ ok: false, error: c.error });
      expect(logs.at(...PROBLEM_LEVELS)).toEqual(c.logs as [string, string][]);
      expect(json(fake.calls)).toBe(json(c.qdrant));
      expect(rows(dbPath)).toEqual(c.db as never);
      expect([...fake.points.keys()].sort()).toEqual(c.remaining);
      expect(pins.state.clockReads).toBe(c.clock_reads);
    });
  }

  test("returns how many it deleted, repeating until the scope is empty", async () => {
    const fake = seeded(fixtures.search_points);
    const { engine } = build({ fake, poster: new FakePoster(), pins: pinned(0, 1) });
    expect(await engine.deleteAll({ userId: "12345678" })).toBe(7);
    expect(await engine.deleteAll({ userId: "12345678" })).toBe(0);
  });
});

describe("collection setup replays mem0", () => {
  for (const c of fixtures.create_col) {
    test(c.name, async () => {
      const fake = new FakeQdrant({
        collections: c.input.collections,
        sparse: c.input.sparse,
        fail: c.input.fail,
      });
      const { store } = build({
        fake,
        poster: new FakePoster(),
        pins: pinned(0, 1),
        vectorSize: 3072,
      });
      const logs = captureLogs();
      await store.ensureCollection();
      logs.stop();
      expect(json(fake.calls)).toBe(json(c.qdrant));
      expect(logs.at(...PROBLEM_LEVELS)).toEqual(c.logs as [string, string][]);
    });
  }

  test("an unreachable Qdrant rejects", async () => {
    const fake = new FakeQdrant();
    fake.getCollections = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const { store } = build({ fake, poster: new FakePoster(), pins: pinned(0, 1) });
    await expect(store.ensureCollection()).rejects.toThrow("connect ECONNREFUSED");
  });
});

describe("openMemoryEngine", () => {
  const config = (apiKey: string | null) => ({
    qdrant: { host: "h", port: 6333, collection: "c", vectorSize: 4 },
    embedder: {
      model: "embed-model",
      apiKey: "sk-embed",
      baseUrl: "https://embed.test/v1",
      dims: 4,
    },
    llm: { model: "x/extractor", apiKey, baseUrl: "https://llm.test/v1" },
    historyDbPath: tempPath("history.db"),
  });

  test("routes embeddings and extraction to their own endpoints and keys", async () => {
    const fake = new FakeQdrant({ collections: [] });
    const seen: [string, string | null][] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push([url, new Headers(init.headers).get("authorization")]);
      const body = JSON.parse(init.body as string) as { input?: string[] };
      if (url.endsWith("/embeddings")) {
        return Response.json({
          data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0, 0] })),
        });
      }
      return Response.json({ choices: [{ message: { content: '{"memory": [{"text": "x"}]}' } }] });
    }) as unknown as typeof globalThis.fetch;
    const engine = await openMemoryEngine(config("sk-llm"), {
      qdrantClient: fake.api,
      http: { fetch },
    });
    expect(fake.calls.slice(0, 2)).toEqual([
      ["getCollections"],
      [
        "createCollection",
        {
          vectors: { size: 4, distance: "Cosine", on_disk: true },
          sparse_vectors: { bm25: { modifier: "idf" } },
        },
      ],
    ]);
    const added = await engine.add([{ role: "user", content: "hi" }], {
      scope: { userId: "1" },
      metadata: { platform: "pipecat" },
    });
    expect(added.map((r) => r.memory)).toEqual(["x"]);
    expect(seen).toEqual([
      ["https://embed.test/v1/embeddings", "Bearer sk-embed"],
      ["https://llm.test/v1/chat/completions", "Bearer sk-llm"],
      ["https://embed.test/v1/embeddings", "Bearer sk-embed"],
    ]);
  });

  test("a missing LLM key fails after the collection setup, in mem0's construction order", async () => {
    const fake = new FakeQdrant();
    await expect(openMemoryEngine(config(null), { qdrantClient: fake.api })).rejects.toThrow(
      "The api_key client option must be set",
    );
    expect(fake.calls[0]).toEqual(["getCollections"]);
  });
});

describe("sortNewestFirst follows laplace's get_memories sort", () => {
  for (const [created, expected] of timeFixtures.greeting_sort as [unknown[], unknown[]][]) {
    test(JSON.stringify(created), () => {
      const items = created.map((c, i) => ({ id: String(i), memory: `m${i}`, created_at: c }));
      let result: unknown[];
      try {
        result = [true, sortNewestFirst(items as MemoryItem[]).map((m) => m.id)];
      } catch (error) {
        result = [false, (error as Error).name, (error as Error).message];
      }
      expect(result).toEqual(expected);
    });
  }

  test("equal instants keep their scroll order", () => {
    const items = [
      { id: "a", created_at: "2026-01-01T08:00:00+08:00" },
      { id: "b", created_at: "2026-01-01T00:00:00+00:00" },
      { id: "c", created_at: "2025-12-31T17:00:00-07:00" },
    ];
    expect(sortNewestFirst(items as MemoryItem[]).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});
