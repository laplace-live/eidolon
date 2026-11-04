import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ContextTurn, ConversationContext } from "@eidolon/core";
import type { MemoryConfig } from "../src/config.ts";
import { MemoryEngine, SharedEngine } from "../src/engine.ts";
import { HistoryStore } from "../src/history.ts";
import { createMemoryProvider } from "../src/index.ts";
import { OpenAICompatibleChat, OpenAICompatibleEmbedder } from "../src/openai.ts";
import { Mem0MemoryProvider, openMemoryProvider } from "../src/provider.ts";
import { QdrantVectorStore } from "../src/qdrant.ts";
import type { MemoryItem } from "../src/types.ts";
import {
  captureLogs,
  clearMemoryEnv,
  FakePoster,
  FakeQdrant,
  pinned,
  resetEnv,
  setEnv,
  tempPath,
} from "./support.ts";

class FakeContext implements ConversationContext {
  readonly messages: unknown[];
  sets = 0;
  constructor(messages: unknown[]) {
    this.messages = messages;
  }
  getMessages(): unknown[] {
    return this.messages;
  }
  setMessages(messages: unknown[]): void {
    this.sets++;
    const copy = [...messages];
    this.messages.length = 0;
    this.messages.push(...copy);
  }
  setHiddenTools(): void {}
}

/** pipedog's LLMSpecificMessage is a class instance, never a plain object. */
class SpecificMessage {
  readonly llm = "openai";
  readonly role = "user";
  readonly content = "provider-specific";
}

function turnFor(context: ConversationContext, signal = new AbortController().signal) {
  const spawned: [string, Promise<void>][] = [];
  const turn: ContextTurn = {
    context,
    metadata: {},
    signal,
    spawn: (name, job) => {
      spawned.push([name, job()]);
    },
  };
  return { turn, spawned };
}

interface StubCalls {
  search: [string, unknown][];
  add: [unknown[], unknown][];
  getAll: unknown[];
}

function stubEngine(
  overrides: Partial<
    Record<"search" | "add" | "getAll", (...args: never[]) => Promise<unknown>>
  > = {},
) {
  const calls: StubCalls = { search: [], add: [], getAll: [] };
  const engine = {
    search: async (query: string, options: unknown) => {
      calls.search.push([query, options]);
      return overrides.search ? overrides.search() : [];
    },
    add: async (messages: unknown[], options: unknown) => {
      calls.add.push([messages, options]);
      return overrides.add ? overrides.add() : [];
    },
    getAll: async (options: unknown) => {
      calls.getAll.push(options);
      return overrides.getAll ? overrides.getAll() : [];
    },
  };
  return { engine: engine as unknown as MemoryEngine, calls };
}

const SCOPE = { userId: "12345678", agentId: null, runId: null };
const SEARCH = { searchLimit: 10, searchThreshold: 0.3 };
const memory = (text: string) => ({ memory: text }) as MemoryItem;

describe("onContext", () => {
  test("searches with the latest user string, skipping provider-specific and non-string messages", async () => {
    const { engine, calls } = stubEngine();
    const provider = new Mem0MemoryProvider(engine, SCOPE, SEARCH);
    const context = new FakeContext([
      { role: "user", content: "早上好" },
      { role: "assistant", content: "嗨" },
      { role: "user", content: [{ type: "text", text: "list content" }] },
      new SpecificMessage(),
      { role: "developer", content: "x" },
    ]);
    await provider.onContext(turnFor(context).turn);
    expect(calls.search).toEqual([["早上好", { filters: SCOPE, topK: 10, threshold: 0.3 }]]);
  });

  test("an empty latest message searches and stores nothing; whitespace still counts", async () => {
    const { engine, calls } = stubEngine();
    const provider = new Mem0MemoryProvider(engine, SCOPE, SEARCH);
    const empty = turnFor(new FakeContext([{ role: "user", content: "" }]));
    await provider.onContext(empty.turn);
    expect(calls.search).toEqual([]);
    expect(empty.spawned).toEqual([]);
    const blank = turnFor(new FakeContext([{ role: "user", content: "   " }]));
    await provider.onContext(blank.turn);
    expect(calls.search.map(([q]) => q)).toEqual(["   "]);
    expect(blank.spawned.map(([name]) => name)).toEqual(["mem0_store"]);
  });

  test("injects Pipecat's developer block at position 1, newest block first", async () => {
    let next = [memory("a"), memory("b"), { id: "no-text" } as MemoryItem];
    const { engine } = stubEngine({ search: async () => next });
    const provider = new Mem0MemoryProvider(engine, SCOPE, SEARCH);
    const context = new FakeContext([{ role: "user", content: "first" }]);
    await provider.onContext(turnFor(context).turn);
    expect(context.messages).toEqual([
      { role: "user", content: "first" },
      {
        role: "developer",
        content: "Based on previous conversations, I recall: \n\n1. a\n\n2. b\n\n3. \n\n",
      },
    ]);
    context.messages.push({ role: "user", content: "second" });
    next = [memory("c")];
    await provider.onContext(turnFor(context).turn);
    expect(context.messages.map((m) => (m as { content: string }).content)).toEqual([
      "first",
      "Based on previous conversations, I recall: \n\n1. c\n\n",
      "Based on previous conversations, I recall: \n\n1. a\n\n2. b\n\n3. \n\n",
      "second",
    ]);
    expect(context.sets).toBe(2);
  });

  test("a provider-specific first message still counts toward the position", async () => {
    const { engine } = stubEngine({ search: async () => [memory("m")] });
    const provider = new Mem0MemoryProvider(engine, SCOPE, SEARCH);
    const specific = new SpecificMessage();
    const context = new FakeContext([specific, { role: "user", content: "q" }]);
    await provider.onContext(turnFor(context).turn);
    expect(context.messages[0]).toBe(specific);
    expect(context.messages[1]).toEqual({
      role: "developer",
      content: expect.stringContaining("1. m"),
    });
  });

  test("the same query twice searches once but stores both times", async () => {
    const { engine, calls } = stubEngine();
    const provider = new Mem0MemoryProvider(engine, SCOPE, SEARCH);
    const context = new FakeContext([{ role: "user", content: "same" }]);
    const a = turnFor(context);
    await provider.onContext(a.turn);
    const b = turnFor(context);
    await provider.onContext(b.turn);
    expect(calls.search).toHaveLength(1);
    expect([...a.spawned, ...b.spawned].map(([name]) => name)).toEqual([
      "mem0_store",
      "mem0_store",
    ]);
  });

  test("a failed search is logged and the turn goes on without memories", async () => {
    const { engine } = stubEngine({
      search: async () => {
        throw new Error("Invalid query: cannot be empty or whitespace-only.");
      },
    });
    const provider = new Mem0MemoryProvider(engine, SCOPE, SEARCH);
    const context = new FakeContext([{ role: "user", content: "q" }]);
    const logs = captureLogs();
    await provider.onContext(turnFor(context).turn);
    logs.stop();
    expect(context.messages).toHaveLength(1);
    expect(logs.at("ERROR")).toEqual([
      [
        "ERROR",
        "Error retrieving memories from Mem0: Invalid query: cannot be empty or whitespace-only.",
      ],
    ]);
  });

  test("an interrupted search rejects with the signal's reason and leaves the context alone", async () => {
    let release: (value: MemoryItem[]) => void = () => {};
    const { engine } = stubEngine({ search: () => new Promise((resolve) => (release = resolve)) });
    const provider = new Mem0MemoryProvider(engine, SCOPE, SEARCH);
    const context = new FakeContext([{ role: "user", content: "q" }]);
    const controller = new AbortController();
    const { turn, spawned } = turnFor(context, controller.signal);
    const pending = provider.onContext(turn);
    const reason = new Error("interrupted");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    release([memory("late")]);
    await Bun.sleep(0);
    expect(context.messages).toHaveLength(1);
    expect(spawned).toEqual([]);
  });

  test("an already-aborted turn does nothing, so the next turn still searches that query", async () => {
    const { engine, calls } = stubEngine();
    const provider = new Mem0MemoryProvider(engine, SCOPE, SEARCH);
    const context = new FakeContext([{ role: "user", content: "q" }]);
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await expect(provider.onContext(turnFor(context, controller.signal).turn)).rejects.toThrow(
      "gone",
    );
    await provider.onContext(turnFor(context).turn);
    expect(calls.search).toHaveLength(1);
  });

  test("errorMessage is Pipecat's push_error text", () => {
    const provider = new Mem0MemoryProvider(stubEngine().engine, SCOPE, SEARCH);
    expect(provider.errorMessage(new Error("boom"))).toBe("Error processing with Mem0: boom");
  });
});

describe("the background store", () => {
  test("drops content-less tool-call messages and whitespace, then adds with Pipecat's metadata", async () => {
    const { engine, calls } = stubEngine();
    const provider = new Mem0MemoryProvider(engine, SCOPE, SEARCH);
    const kept = [
      { role: "user", content: "我养了猫" },
      { role: "assistant", content: "好可爱" },
    ];
    const context = new FakeContext([
      kept[0],
      { role: "assistant", tool_calls: [{ id: "c1" }] },
      { role: "tool", content: "{}" },
      kept[1],
      { role: "user", content: " \n　" },
      { role: "user", content: "最后" },
    ]);
    const logs = captureLogs();
    const { turn, spawned } = turnFor(context);
    await provider.onContext(turn);
    await Promise.all(spawned.map(([, job]) => job));
    logs.stop();
    expect(calls.add).toEqual([
      [
        [kept[0], kept[1], { role: "user", content: "最后" }],
        { scope: SCOPE, metadata: { platform: "pipecat" } },
      ],
    ]);
    expect(logs.at("DEBUG")).toContainEqual([
      "DEBUG",
      "Mem0: dropped 2 non-string-content message(s) before storing 3 valid one(s)",
    ]);
    expect(logs.at("DEBUG")).toContainEqual(["DEBUG", "Storing 3 messages in Mem0"]);
  });

  test("a batch that filters down to nothing skips mem0", async () => {
    const { engine, calls } = stubEngine();
    const provider = new Mem0MemoryProvider(engine, SCOPE, SEARCH);
    const logs = captureLogs();
    const { turn, spawned } = turnFor(new FakeContext([{ role: "user", content: "  " }]));
    await provider.onContext(turn);
    await Promise.all(spawned.map(([, job]) => job));
    logs.stop();
    expect(calls.add).toEqual([]);
    expect(logs.at("DEBUG")).toContainEqual([
      "DEBUG",
      "Mem0: skipping store — all 1 messages had non-string or empty content (likely tool_calls)",
    ]);
  });

  test("a failed add is logged, never thrown", async () => {
    const { engine } = stubEngine({
      add: async () => {
        throw new Error("LLM extraction failed: Error code: 429 - {'error': 'x'}");
      },
    });
    const provider = new Mem0MemoryProvider(engine, SCOPE, SEARCH);
    const logs = captureLogs();
    const { turn, spawned } = turnFor(new FakeContext([{ role: "user", content: "q" }]));
    await provider.onContext(turn);
    await Promise.all(spawned.map(([, job]) => job));
    logs.stop();
    expect(logs.at("ERROR")).toEqual([
      [
        "ERROR",
        "Error storing messages in Mem0: LLM extraction failed: Error code: 429 - {'error': 'x'}",
      ],
    ]);
  });

  test("end to end: the stored point is mem0's Shape A", async () => {
    const pins = pinned(1793678706123456, 1000001);
    const fake = new FakeQdrant();
    const poster = new FakePoster();
    poster.responses = ['{"memory": [{"text": "用户养了一只猫", "attributed_to": "user"}]}'];
    const engine = new MemoryEngine({
      store: new QdrantVectorStore(
        { host: "h", port: 6333, collection: "c", vectorSize: 4 },
        fake.api,
      ),
      embedder: new OpenAICompatibleEmbedder({ model: "m", dims: 4 }, poster),
      llm: new OpenAICompatibleChat("~google/gemini-flash-latest", poster),
      history: new HistoryStore(tempPath("h.db"), { clock: pins.clock, newId: pins.newId }),
      clock: pins.clock,
      newId: pins.newId,
    });
    const provider = new Mem0MemoryProvider(engine, SCOPE, SEARCH);
    const { turn, spawned } = turnFor(new FakeContext([{ role: "user", content: "我养了一只猫" }]));
    await provider.onContext(turn);
    await Promise.all(spawned.map(([, job]) => job));
    expect(JSON.stringify([...fake.points])).toBe(
      JSON.stringify([
        [
          "00000000-0000-0000-0000-000000000001",
          {
            platform: "pipecat",
            user_id: "12345678",
            data: "用户养了一只猫",
            text_lemmatized: "用户养了一只猫",
            hash: "e82efde5e8604de465a93415dd8f41fa",
            created_at: "2026-11-03T04:05:07.123457+00:00",
            updated_at: "2026-11-03T04:05:07.123457+00:00",
            attributed_to: "user",
          },
        ],
      ]),
    );
  });
});

describe("newestFirst", () => {
  test("lists up to 1000 and sorts by instant", async () => {
    const { engine, calls } = stubEngine({
      getAll: async () => [
        { id: "cloud", memory: "c", created_at: "2025-12-01T03:04:05-07:00" },
        { id: "late", memory: "l", created_at: "2026-11-03T04:05:06.123456+00:00" },
        { id: "early", memory: "e", created_at: "2025-12-01T09:00:00+00:00" },
      ],
    });
    const provider = new Mem0MemoryProvider(engine, SCOPE, SEARCH);
    expect((await provider.newestFirst()).map((m) => m.id)).toEqual(["late", "cloud", "early"]);
    expect(calls.getAll).toEqual([{ filters: SCOPE, topK: 1000 }]);
  });

  test("rejects on a store error or a missing stamp, logging nothing", async () => {
    const failing = stubEngine({
      getAll: async () => {
        throw new Error("Qdrant down");
      },
    });
    const logs = captureLogs();
    await expect(
      new Mem0MemoryProvider(failing.engine, SCOPE, SEARCH).newestFirst(),
    ).rejects.toThrow("Qdrant down");
    const stampless = stubEngine({ getAll: async () => [{ id: "x", created_at: null }] });
    await expect(
      new Mem0MemoryProvider(stampless.engine, SCOPE, SEARCH).newestFirst(),
    ).rejects.toThrow("fromisoformat: argument must be str");
    logs.stop();
    expect(logs.records).toEqual([]);
  });
});

describe("openMemoryProvider", () => {
  beforeEach(() => {
    clearMemoryEnv();
    setEnv({
      MEM0_QDRANT_HOST: "qdrant",
      OPENROUTER_API_KEY: "sk-or",
      MEM0_HISTORY_DB_PATH: tempPath("h.db"),
    });
  });
  afterEach(resetEnv);

  function engines(open?: () => Promise<MemoryEngine>) {
    const opened: MemoryConfig[] = [];
    let ensured = 0;
    const engine = Object.assign(stubEngine().engine, {
      ensureCollection: async () => {
        ensured++;
      },
    });
    const shared = new SharedEngine(async (config) => {
      opened.push(config);
      return open ? open() : engine;
    });
    return { shared, opened, ensured: () => ensured };
  }

  test("logs Pipecat's init line with Python reprs", async () => {
    const e = engines();
    const logs = captureLogs();
    await openMemoryProvider({ userId: "12345678" }, e.shared);
    setEnv({ MEM0_AGENT_ID: "laplace", MEM0_RUN_ID: "" });
    await openMemoryProvider({ userId: "42" }, e.shared);
    logs.stop();
    expect(logs.at("INFO")).toEqual([
      ["INFO", "Initialized Mem0MemoryService with user_id='12345678', agent_id=None, run_id=None"],
      ["INFO", "Initialized Mem0MemoryService with user_id='42', agent_id='laplace', run_id=None"],
    ]);
  });

  test("opens the shared engine once, then reruns the collection setup per session", async () => {
    const e = engines();
    await openMemoryProvider({ userId: "1" }, e.shared);
    await openMemoryProvider({ userId: "2" }, e.shared);
    await openMemoryProvider({ userId: "3" }, e.shared);
    expect(e.opened).toHaveLength(1);
    expect(e.ensured()).toBe(2);
  });

  test("a failed open rejects and is retried by the next session", async () => {
    let attempts = 0;
    const e = engines(async () => {
      attempts++;
      throw new Error("connect ECONNREFUSED 127.0.0.1:6333");
    });
    await expect(openMemoryProvider({ userId: "1" }, e.shared)).rejects.toThrow("ECONNREFUSED");
    await expect(openMemoryProvider({ userId: "1" }, e.shared)).rejects.toThrow("ECONNREFUSED");
    expect(attempts).toBe(2);
  });

  test("configuration errors come first, in mem0_local's order", async () => {
    const e = engines();
    setEnv({ OPENROUTER_API_KEY: "", MEM0_SEARCH_LIMIT: "0" });
    await expect(openMemoryProvider({ userId: "1" }, e.shared)).rejects.toThrow(
      "Self-hosted Mem0 needs an embedding API key",
    );
    setEnv({ OPENROUTER_API_KEY: "sk-or" });
    await expect(openMemoryProvider({ userId: "1" }, e.shared)).rejects.toThrow(RangeError);
    expect(e.opened).toEqual([]);
  });

  test("createMemoryProvider rejects without a host and builds no client", async () => {
    setEnv({ MEM0_QDRANT_HOST: "" });
    await expect(createMemoryProvider({ userId: "1" })).rejects.toThrow(
      "MEM0_QDRANT_HOST is unset",
    );
  });
});
