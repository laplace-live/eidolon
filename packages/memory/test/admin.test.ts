import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMemoryAdmin } from "../src/admin.ts";
import { MemoryEngine, SharedEngine } from "../src/engine.ts";
import { HistoryStore } from "../src/history.ts";
import { memoryAdmin } from "../src/index.ts";
import { OpenAICompatibleChat, OpenAICompatibleEmbedder } from "../src/openai.ts";
import { QdrantVectorStore } from "../src/qdrant.ts";
import fixtures from "./fixtures/engine.json";
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

beforeEach(() => {
  clearMemoryEnv();
  setEnv({
    MEM0_QDRANT_HOST: "qdrant",
    OPENROUTER_API_KEY: "sk-or",
    MEM0_HISTORY_DB_PATH: tempPath("h.db"),
  });
});
afterEach(resetEnv);

function engineOver(fake: FakeQdrant): MemoryEngine {
  const pins = pinned(1793678706123456, 1);
  const poster = new FakePoster();
  return new MemoryEngine({
    store: new QdrantVectorStore(
      { host: "h", port: 6333, collection: "c", vectorSize: 4 },
      fake.api,
    ),
    embedder: new OpenAICompatibleEmbedder({ model: "m", dims: 4 }, poster),
    llm: new OpenAICompatibleChat("m", poster),
    history: new HistoryStore(tempPath("h.db"), { clock: pins.clock, newId: pins.newId }),
    clock: pins.clock,
    newId: pins.newId,
  });
}

function seeded(): FakeQdrant {
  const fake = new FakeQdrant();
  for (const [id, payload] of Object.entries(fixtures.search_points)) fake.points.set(id, payload);
  return fake;
}

describe("memoryAdmin", () => {
  test("is null when memory is not configured", () => {
    setEnv({ MEM0_QDRANT_HOST: " " });
    expect(memoryAdmin()).toBeNull();
    setEnv({ MEM0_QDRANT_HOST: "qdrant" });
    expect(memoryAdmin()).not.toBeNull();
  });

  test("list projects five keys in order, categories always null, in scroll order", async () => {
    const admin = createMemoryAdmin(new SharedEngine(async () => engineOver(seeded())));
    const outcome = await admin.list("12345678");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(JSON.stringify(outcome.value[1])).toBe(
      JSON.stringify({
        id: "00000000-0000-4000-8000-000000000002",
        memory: "B cloud",
        created_at: "2025-12-01T03:04:05-07:00",
        updated_at: "2025-12-01T03:04:05-07:00",
        categories: null,
      }),
    );
    expect(outcome.value.map((m) => m.memory)).toEqual([
      "A fact",
      "B cloud",
      "",
      "E low",
      "F future",
      "H bad expiry",
    ]);
    expect(outcome.value.every((m) => m.categories === null)).toBe(true);
  });

  test("an engine that won't open is unavailable, retried on the next call", async () => {
    let attempts = 0;
    const admin = createMemoryAdmin(
      new SharedEngine(async () => {
        attempts++;
        throw new Error("connect ECONNREFUSED");
      }),
    );
    const outcome = await admin.list("1");
    expect(outcome).toMatchObject({ ok: false, reason: "unavailable" });
    if (!outcome.ok) expect(String(outcome.error)).toContain("ECONNREFUSED");
    expect(await admin.forget("1")).toMatchObject({ ok: false, reason: "unavailable" });
    expect(attempts).toBe(2);
  });

  test("configuration errors are unavailable too", async () => {
    setEnv({ OPENROUTER_API_KEY: "" });
    const admin = createMemoryAdmin(new SharedEngine(async () => engineOver(seeded())));
    const outcome = await admin.list("1");
    expect(outcome).toMatchObject({ ok: false, reason: "unavailable" });
  });

  test("an operation that throws is failed, carrying mem0's error", async () => {
    const fake = seeded();
    fake.missing = ["00000000-0000-4000-8000-000000000003"];
    const admin = createMemoryAdmin(new SharedEngine(async () => engineOver(fake)));
    const outcome = await admin.forget("12345678");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("failed");
    expect([(outcome.error as Error).name, (outcome.error as Error).message]).toEqual([
      "ValueError",
      "Memory with id 00000000-0000-4000-8000-000000000003 not found. Please provide a valid 'memory_id'",
    ]);
    fake.scroll = async () => {
      throw new Error("timeout");
    };
    expect(await admin.list("12345678")).toMatchObject({ ok: false, reason: "failed" });
  });

  test("forget wipes the viewer and is idempotent", async () => {
    const fake = seeded();
    const admin = createMemoryAdmin(new SharedEngine(async () => engineOver(fake)));
    expect(await admin.forget("12345678")).toEqual({ ok: true, value: undefined });
    expect(await admin.forget("12345678")).toEqual({ ok: true, value: undefined });
    expect([...fake.points.keys()]).toEqual(["00000000-0000-4000-8000-000000000007"]);
    expect(await admin.list("12345678")).toEqual({ ok: true, value: [] });
  });

  test("never logs: apps/bot owns every [memory-admin] line", async () => {
    const logs = captureLogs();
    const broken = createMemoryAdmin(
      new SharedEngine(async () => {
        throw new Error("down");
      }),
    );
    await broken.list("1");
    await broken.forget("1");
    await createMemoryAdmin(new SharedEngine(async () => engineOver(seeded()))).list("12345678");
    logs.stop();
    expect(logs.records).toEqual([]);
  });
});
