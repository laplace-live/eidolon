// The admin's optional agent scope, which the local app keys on the persona: production passes
// none and keeps scoping by viewer alone.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMemoryAdmin } from "../src/admin.ts";
import { MemoryEngine, SharedEngine } from "../src/engine.ts";
import { HistoryStore } from "../src/history.ts";
import { OpenAICompatibleChat, OpenAICompatibleEmbedder } from "../src/openai.ts";
import { QdrantVectorStore } from "../src/qdrant.ts";
import {
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

const STAMP = "2026-11-05T00:00:00+00:00";

function point(memory: string, scope: Record<string, string>): Record<string, unknown> {
  return { data: memory, hash: memory, created_at: STAMP, updated_at: STAMP, ...scope };
}

function seeded(): FakeQdrant {
  const fake = new FakeQdrant();
  fake.points.set("p1", point("alpha fact", { user_id: "local", agent_id: "alpha" }));
  fake.points.set("p2", point("beta fact", { user_id: "local", agent_id: "beta" }));
  fake.points.set("p3", point("someone else", { user_id: "12345678" }));
  return fake;
}

function adminOver(fake: FakeQdrant) {
  const pins = pinned(1793678706123456, 1);
  const poster = new FakePoster();
  const engine = new MemoryEngine({
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
  return createMemoryAdmin(new SharedEngine(async () => engine));
}

async function memories(admin: ReturnType<typeof adminOver>, userId: string, agentId?: string) {
  const outcome = await admin.list(userId, agentId);
  if (!outcome.ok) throw outcome.error;
  return outcome.value.map((m) => m.memory);
}

describe("an agent-scoped admin", () => {
  test("lists only that agent's memories of the viewer", async () => {
    const admin = adminOver(seeded());
    expect(await memories(admin, "local", "alpha")).toEqual(["alpha fact"]);
    expect(await memories(admin, "local", "beta")).toEqual(["beta fact"]);
  });

  test("forgets one agent's memories and leaves the other agent's and other viewers'", async () => {
    const fake = seeded();
    const admin = adminOver(fake);
    expect(await admin.forget("local", "alpha")).toEqual({ ok: true, value: undefined });
    expect([...fake.points.keys()]).toEqual(["p2", "p3"]);
    expect(await memories(admin, "local", "beta")).toEqual(["beta fact"]);
  });

  test("without an agent, the viewer's whole scope as before", async () => {
    const fake = seeded();
    const admin = adminOver(fake);
    expect(await memories(admin, "local")).toEqual(["alpha fact", "beta fact"]);
    await admin.forget("local");
    expect([...fake.points.keys()]).toEqual(["p3"]);
  });
});
