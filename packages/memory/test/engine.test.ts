// Parity with mem0: every case in fixtures/engine.json was produced by running mem0's own
// Memory.add/search/get_all/delete_all and Qdrant.create_col against the fakes in support.ts, with
// the clock and uuid4 pinned. Each replays here and must match call for call, row for row.
import { DatabaseSync } from "node:sqlite";
import { type Selection, select, setUsageSink, type UsageRecord } from "@eidolon/providers";
import { describe, expect, test } from "vitest";
import { MemoryEngine, openMemoryEngine, sortNewestFirst } from "../src/engine.ts";
import { ADDITIVE_EXTRACTION_PROMPT, AGENT_CONTEXT_SUFFIX } from "../src/extraction-prompt.ts";
import { HistoryStore } from "../src/history.ts";
import { EXTRACTION_MAX_TOKENS, Mem0Embedder, OpenAICompatibleChat } from "../src/openai.ts";
import { QdrantVectorStore } from "../src/qdrant.ts";
import type { MemoryItem } from "../src/types.ts";
import fixtures from "./fixtures/engine.json";
import {
  type ChatResponse,
  captureLogs,
  FakeEmbeddings,
  FakePoster,
  FakeQdrant,
  type Payload,
  pinned,
  tempPath,
  timeFixtures,
} from "./support.ts";

type Ids = { user_id?: string | null; agent_id?: string | null; run_id?: string | null };

function scope(ids: Ids) {
  return { userId: ids.user_id, agentId: ids.agent_id, runId: ids.run_id };
}

function build(options: {
  fake: FakeQdrant;
  poster: FakePoster;
  pins: ReturnType<typeof pinned>;
  embeddings?: FakeEmbeddings;
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
    embedder: new Mem0Embedder(options.embeddings ?? new FakeEmbeddings(), 4),
    llm: new OpenAICompatibleChat(options.model ?? "~google/gemini-flash-latest", options.poster),
    history,
    clock: options.pins.clock,
    newId: options.pins.newId,
  });
  return { engine, history, store, dbPath };
}

function rows(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const values = (sql: string): unknown[][] => {
    const statement = db.prepare(sql);
    statement.setReturnArrays(true);
    return statement.all() as unknown as unknown[][];
  };
  try {
    return {
      history: values(
        "SELECT id, memory_id, old_memory, new_memory, event, created_at, updated_at, is_deleted, actor_id, role FROM history ORDER BY rowid",
      ),
      messages: values(
        "SELECT id, session_scope, role, content, name, created_at FROM messages ORDER BY rowid",
      ),
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

/** mem0's recorded request, with the one documented departure: this engine's larger token cap. */
function withPortTokenCap(request: unknown): unknown {
  const body = { ...(request as Record<string, unknown>) };
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    if (body[key] === 2000) body[key] = EXTRACTION_MAX_TOKENS;
  }
  return body;
}

/** What each of mem0's embedding requests asked the model for; the wire format is its own. */
function asked(requests: readonly { input: string[]; model: string; dimensions: number }[]) {
  return requests.map(({ input, model, dimensions }) => ({ input, model, dimensions }));
}

describe("add replays mem0", () => {
  // batch_reversed has the API list the batch's vectors out of order, which mem0 put back by their
  // index: an embedding model's vectors come in the order its response lists them.
  for (const c of fixtures.add.filter((a) => a.name !== "batch_reversed")) {
    test(c.name, async () => {
      const pins = pinned(c.input.base, c.input.step);
      const fake = new FakeQdrant({ fail: c.input.fail });
      for (const [id, payload] of Object.entries(c.input.existing)) fake.points.set(id, payload);
      fake.scores = c.input.scores as Record<string, number>;
      const poster = new FakePoster();
      poster.responses = [...(c.input.responses as ChatResponse[])];
      const embeddings = new FakeEmbeddings();
      embeddings.plan = [...c.input.embed_plan];
      const { engine, history, dbPath } = build({
        fake,
        poster,
        pins,
        embeddings,
        model: c.input.model,
      });
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
      // Stringified so payload key order is compared too: these points must match mem0's exactly.
      expect(json(fake.calls)).toBe(json(c.qdrant));
      expect(json(embeddings.calls)).toBe(json(asked(c.embed)));
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
      expect(json(chat)).toBe(json(c.chat.map(withPortTokenCap)));
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
  // trim_ids crashes mem0 in its telemetry (`None.encode()`), which this engine leaves out.
  for (const c of fixtures.search.filter((s) => s.name !== "trim_ids")) {
    test(c.name, async () => {
      const pins = pinned(1793678706123456, 1000001);
      const fake = seeded(fixtures.search_points, fixtures.search_scores);
      const embeddings = new FakeEmbeddings();
      const { engine } = build({ fake, poster: new FakePoster(), pins, embeddings });
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
      expect(json(embeddings.calls)).toBe(json(asked(c.embed)));
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
  const settings: Readonly<Record<string, string>> = {
    EMBED_PROVIDER: "openai-compatible",
    EMBED_MODEL: "embed-model",
    OPENAI_COMPATIBLE_API_KEY: "sk-embed",
    OPENAI_COMPATIBLE_BASE_URL: "https://embed.test/v1",
  };
  const embeddings = select("embeddings", (name) => settings[name]) as Selection;
  const config = (apiKey: string | null) => ({
    qdrant: { host: "h", port: 6333, collection: "c", vectorSize: 4 },
    embedder: { selection: embeddings, dims: 4 },
    llm: {
      provider: "openai-compatible",
      model: "x/extractor",
      apiKey,
      baseUrl: "https://llm.test/v1",
      keyMissing: apiKey === null ? "the memory key is missing" : null,
    },
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

  test("reports what extraction and embedding used, under the configured models", async () => {
    const records: UsageRecord[] = [];
    setUsageSink((record) => records.push(record));
    try {
      const fake = new FakeQdrant({ collections: [] });
      const usage = { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 };
      const fetch = (async (url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { input?: string[] };
        if (url.endsWith("/embeddings")) {
          return Response.json({
            model: "unprefixed-embed",
            data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0, 0, 0] })),
            usage: { prompt_tokens: 3, total_tokens: 3 },
          });
        }
        return Response.json({
          model: "x/extractor-2026",
          choices: [{ message: { content: '{"memory": []}' } }],
          usage,
        });
      }) as unknown as typeof globalThis.fetch;
      const engine = await openMemoryEngine(config("sk-llm"), {
        qdrantClient: fake.api,
        http: { fetch },
      });
      await engine.add([{ role: "user", content: "hi" }], { scope: { userId: "1" }, metadata: {} });
      expect(records.map((r) => [r.role, r.model, r.units.inputTokens])).toEqual([
        ["embeddings", "embed-model", 3],
        ["memory", "x/extractor-2026", 7],
      ]);
    } finally {
      setUsageSink(null);
    }
  });

  test("a missing LLM key fails after the collection setup, in mem0's construction order", async () => {
    const fake = new FakeQdrant();
    await expect(openMemoryEngine(config(null), { qdrantClient: fake.api })).rejects.toThrow(
      "the memory key is missing",
    );
    expect(fake.calls[0]).toEqual(["getCollections"]);
  });

  /** A search whose embedding requests get `replies` in turn; resolves to its error and requests. */
  async function failedSearch(replies: Response[]): Promise<[string, number]> {
    let requests = 0;
    const fetch = (async () => {
      requests++;
      return replies.shift() ?? Response.json({}, { status: 500 });
    }) as unknown as typeof globalThis.fetch;
    const engine = await openMemoryEngine(config("sk-llm"), {
      qdrantClient: new FakeQdrant().api,
      http: { fetch },
    });
    const error = await engine.search("q", { filters: { userId: "1" } }).catch((e: Error) => e);
    return [(error as Error).message, requests];
  }

  test("a 200 without vectors fails at once: a turn sits out no quota window", async () => {
    expect(await failedSearch([Response.json({ object: "list" })])).toEqual([
      "Embedding provider returned no data after 1 attempts (1 data, 0 quota). " +
        "Last error: provider returned no embedding data",
      1,
    ]);
    const [quota, requests] = await failedSearch([
      Response.json({ error: { message: "Rate limit exceeded: 429" } }),
    ]);
    expect(quota).toStartWith(
      "Embedding provider returned no data after 1 attempts (0 data, 1 quota). " +
        "Last error: Rate limit exceeded: 429",
    );
    expect(requests).toBe(1);
  });

  test("a failed request goes again twice, as the OpenAI SDK sent mem0's", async () => {
    const down = () =>
      Response.json(
        { error: { message: "down" } },
        { status: 503, headers: { "retry-after-ms": "1" } },
      );
    expect(await failedSearch([down(), down(), down()])).toEqual([
      "Error code: 503 - {'error': {'message': 'down'}}",
      3,
    ]);
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
