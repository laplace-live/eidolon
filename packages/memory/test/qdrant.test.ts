import { describe, expect, mock, test } from "bun:test";
import { QdrantVectorStore } from "../src/qdrant.ts";
import { FakeQdrant } from "./support.ts";

const SETTINGS = { host: "qdrant", port: 6333, collection: "eidolon_memories", vectorSize: 3072 };

function store(fake: FakeQdrant) {
  return new QdrantVectorStore(SETTINGS, fake.api);
}

function raw(fake: FakeQdrant, name: string): unknown[] {
  return fake.raw.filter(([n]) => n === name).map(([, args]) => args);
}

describe("QdrantVectorStore sets what the JS client defaults differently", () => {
  test("a missing collection is created with on-disk cosine vectors and an idf bm25 slot", async () => {
    const fake = new FakeQdrant({ collections: [] });
    await store(fake).ensureCollection();
    expect(raw(fake, "createCollection")).toEqual([
      {
        vectors: { size: 3072, distance: "Cosine", on_disk: true },
        sparse_vectors: { bm25: { modifier: "idf" } },
      },
    ]);
  });

  test("a collection another engine created between the check and the create is used", async () => {
    const fake = new FakeQdrant({ collections: [] });
    const created = fake.createCollection.bind(fake);
    fake.createCollection = async (name, args) => {
      await created(name, args);
      fake.collections.push(name);
      throw new Error("Conflict: Collection eidolon_memories already exists!");
    };
    await store(fake).ensureCollection();
    expect(raw(fake, "createPayloadIndex")).toHaveLength(4);
  });

  test("a create that fails with no collection behind it still fails", async () => {
    const fake = new FakeQdrant({ collections: [] });
    fake.createCollection = async () => {
      throw new Error("Bad Request");
    };
    await expect(store(fake).ensureCollection()).rejects.toThrow("Bad Request");
  });

  test("payload indexes wait, and their failures are swallowed", async () => {
    const fake = new FakeQdrant({ fail: { create_payload_index: 4 } });
    await store(fake).ensureCollection();
    expect(raw(fake, "createPayloadIndex")).toEqual(
      ["user_id", "agent_id", "run_id", "actor_id"].map((field_name) => ({
        field_name,
        field_schema: "keyword",
        wait: true,
      })),
    );
  });

  test("upserts wait and address the unnamed dense vector, as qdrant-client writes it", async () => {
    const fake = new FakeQdrant();
    await store(fake).insert([{ id: "u-1", vector: [0.5, 1], payload: { data: "x" } }]);
    expect(raw(fake, "upsert")).toEqual([
      { wait: true, points: [{ id: "u-1", vector: { "": [0.5, 1] }, payload: { data: "x" } }] },
    ]);
  });

  test("queries ask for payloads and filter on every scope id", async () => {
    const fake = new FakeQdrant();
    fake.points.set("p", { user_id: "1", agent_id: "a", data: "x" });
    fake.scores = { p: 0.75 };
    const hits = await store(fake).search([1, 0], 60, { user_id: "1", agent_id: "a" });
    expect(raw(fake, "query")).toEqual([
      {
        query: [1, 0],
        filter: {
          must: [
            { key: "user_id", match: { value: "1" } },
            { key: "agent_id", match: { value: "a" } },
          ],
        },
        limit: 60,
        with_payload: true,
        with_vector: false,
      },
    ]);
    expect(hits).toEqual([
      { id: "p", payload: { user_id: "1", agent_id: "a", data: "x" }, score: 0.75 },
    ]);
  });

  test("scroll and retrieve ask for payloads without vectors; a missing point is null", async () => {
    const fake = new FakeQdrant();
    fake.points.set("p", { user_id: "1" });
    const s = store(fake);
    expect(await s.list({ user_id: "1" }, 4000)).toEqual([{ id: "p", payload: { user_id: "1" } }]);
    expect(await s.get("p")).toEqual({ id: "p", payload: { user_id: "1" } });
    expect(await s.get("gone")).toBeNull();
    expect(raw(fake, "scroll")).toEqual([
      {
        filter: { must: [{ key: "user_id", match: { value: "1" } }] },
        limit: 4000,
        with_payload: true,
        with_vector: false,
      },
    ]);
    expect(raw(fake, "retrieve")).toEqual([
      { ids: ["p"], with_payload: true, with_vector: false },
      { ids: ["gone"], with_payload: true, with_vector: false },
    ]);
  });

  test("deletes wait, or the next delete_all scroll returns the batch it just deleted", async () => {
    const fake = new FakeQdrant();
    await store(fake).delete("p");
    expect(raw(fake, "delete")).toEqual([{ points: ["p"], wait: true }]);
  });

  test("the real client is built with qdrant-client's 5 s timeout and the version check", async () => {
    const constructed: unknown[] = [];
    mock.module("@qdrant/js-client-rest", () => ({
      QdrantClient: class {
        constructor(options: unknown) {
          constructed.push(options);
        }
      },
    }));
    new QdrantVectorStore(SETTINGS);
    expect(constructed).toEqual([
      { host: "qdrant", port: 6333, timeout: 5000, checkCompatibility: true },
    ]);
  });
});
