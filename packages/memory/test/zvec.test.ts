import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Selection, select } from "@eidolon/providers";
import { afterEach, describe, expect, test } from "vitest";
import { openMemoryEngine, SharedEngine } from "../src/engine.ts";
import { closeMemoryStores, ZvecVectorStore } from "../src/zvec.ts";
import { tempPath } from "./support.ts";

const createdDirs: string[] = [];

function storeDir(): string {
  const dir = tempPath("vectors");
  createdDirs.push(dirname(dir));
  return dir;
}

afterEach(() => {
  closeMemoryStores();
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ZvecVectorStore", () => {
  test("persists points across reopen, converts cosine distance to similarity, and orders lists by id", async () => {
    const dir = storeDir();
    const store = new ZvecVectorStore({ dir, vectorSize: 4 });
    await store.ensureCollection();
    await store.insert([
      {
        id: "m-2",
        vector: [0, 1, 0, 0],
        payload: { user_id: "u1", agent_id: "a1", data: "orthogonal", custom: { nested: true } },
      },
      {
        id: "m-1",
        vector: [1, 0, 0, 0],
        payload: { user_id: "u1", agent_id: "a1", data: "aligned", attributed_to: "user" },
      },
      {
        id: "m-3",
        vector: [-1, 0, 0, 0],
        payload: { user_id: "u1", agent_id: "a1", data: "opposite" },
      },
      {
        id: "m-other",
        vector: [1, 0, 0, 0],
        payload: { user_id: "u2", agent_id: "a1", data: "other viewer" },
      },
    ]);

    closeMemoryStores();
    const reopened = new ZvecVectorStore({ dir, vectorSize: 4 });
    const hits = await reopened.search([1, 0, 0, 0], 10, { user_id: "u1", agent_id: "a1" });
    expect(hits.map((h) => h.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(hits[0]?.score).toBeCloseTo(1, 5);
    expect(hits[1]?.score).toBeCloseTo(0, 5);
    expect(hits[2]?.score).toBeCloseTo(-1, 5);
    expect(hits[0]?.payload).toEqual({
      user_id: "u1",
      agent_id: "a1",
      data: "aligned",
      attributed_to: "user",
    });

    const listed = await reopened.list({ user_id: "u1" }, 10);
    expect(listed.map((p) => p.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(listed[1]?.payload).toEqual({
      user_id: "u1",
      agent_id: "a1",
      data: "orthogonal",
      custom: { nested: true },
    });

    expect(await reopened.get("m-1")).toEqual({
      id: "m-1",
      payload: { user_id: "u1", agent_id: "a1", data: "aligned", attributed_to: "user" },
    });
    expect(await reopened.get("missing")).toBeNull();
  });

  test("isolates scopes and escapes quotes and backslashes in filter values", async () => {
    const store = new ZvecVectorStore({ dir: storeDir(), vectorSize: 4 });
    const trickyUser = String.raw`viewer'1\test`;
    const injector = String.raw`viewer'1\test' OR user_id = 'victim`;
    await store.insert([
      { id: "p-tricky", vector: [1, 0, 0, 0], payload: { user_id: trickyUser, data: "mine" } },
      { id: "p-victim", vector: [1, 0, 0, 0], payload: { user_id: "victim", data: "secret" } },
    ]);

    expect((await store.list({ user_id: trickyUser }, 10)).map((p) => p.id)).toEqual(["p-tricky"]);
    expect(await store.list({ user_id: injector }, 10)).toEqual([]);
    expect((await store.search([1, 0, 0, 0], 10, { user_id: injector })).map((p) => p.id)).toEqual(
      [],
    );
  });

  test("deletes immediately so subsequent list and get see the point gone, and missing deletes are no-ops", async () => {
    const store = new ZvecVectorStore({ dir: storeDir(), vectorSize: 4 });
    await store.insert([
      { id: "a", vector: [1, 0, 0, 0], payload: { user_id: "u1", data: "a" } },
      { id: "b", vector: [0, 1, 0, 0], payload: { user_id: "u1", data: "b" } },
    ]);
    await store.delete("a");
    await store.delete("never-existed");
    expect(await store.get("a")).toBeNull();
    expect((await store.list({ user_id: "u1" }, 10)).map((p) => p.id)).toEqual(["b"]);
  });

  test("recreates the collection if its directory is removed, and isolates different vector dimensions", async () => {
    const dir = storeDir();
    const store4 = new ZvecVectorStore({ dir, vectorSize: 4 });
    await store4.insert([
      { id: "a", vector: [1, 0, 0, 0], payload: { user_id: "u1", data: "4d" } },
    ]);

    const store8 = new ZvecVectorStore({ dir, vectorSize: 8 });
    await store8.insert([
      { id: "b", vector: [1, 0, 0, 0, 0, 0, 0, 0], payload: { user_id: "u1", data: "8d" } },
    ]);
    expect((await store4.list({ user_id: "u1" }, 10)).map((p) => p.payload.data)).toEqual(["4d"]);
    expect((await store8.list({ user_id: "u1" }, 10)).map((p) => p.payload.data)).toEqual(["8d"]);

    closeMemoryStores();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "v1_4"), { recursive: true });
    await store4.ensureCollection();
    expect(await store4.list({ user_id: "u1" }, 10)).toEqual([]);
  });

  test("chunks inserts past Zvec's 1,024-doc batch limit", async () => {
    const store = new ZvecVectorStore({ dir: storeDir(), vectorSize: 4 });
    const points = Array.from({ length: 1_100 }, (_, i) => ({
      id: `p-${String(i).padStart(4, "0")}`,
      vector: [1, 0, 0, 0],
      payload: { user_id: "u-bulk", data: `item-${i}` },
    }));
    await store.insert(points);
    const listed = await store.list({ user_id: "u-bulk" }, 1_200);
    expect(listed.length).toBe(1_100);
    expect(listed[0]?.id).toBe("p-0000");
    expect(listed[1_099]?.id).toBe("p-1099");
  });

  test.skipIf(process.platform === "win32")(
    "creates missing parent directories with mode 0700 so viewer memories stay private",
    async () => {
      const base = storeDir();
      const nested = join(base, "home", "mem0", "vectors");
      const store = new ZvecVectorStore({ dir: nested, vectorSize: 4 });
      await store.ensureCollection();
      expect(statSync(join(base, "home")).mode & 0o777).toBe(0o700);
      expect(statSync(nested).mode & 0o777).toBe(0o700);
    },
  );

  test("multiple MemoryEngines on one directory share the open Zvec handle cleanly", async () => {
    const dir = storeDir();
    const historyDbPath = tempPath("shared-history.db");
    createdDirs.push(dirname(historyDbPath));
    const settings: Readonly<Record<string, string>> = {
      EMBED_PROVIDER: "openai-compatible",
      EMBED_MODEL: "embed-model",
      OPENAI_COMPATIBLE_API_KEY: "sk-embed",
      OPENAI_COMPATIBLE_BASE_URL: "https://embed.test/v1",
    };
    const selection = select("embeddings", (name) => settings[name]) as Selection;
    const fetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input?: string[]; model?: string };
      if (url.endsWith("/embeddings")) {
        return Response.json({
          data: (body.input ?? []).map((text, index) => ({
            index,
            embedding: text.includes("猫") ? [1, 0, 0, 0] : [0, 1, 0, 0],
          })),
        });
      }
      const fact = body.model === "alice/chat" ? "用户养猫" : "用户喝茶";
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ memory: [{ text: fact }] }) } }],
      });
    }) as unknown as typeof globalThis.fetch;

    const shared = new SharedEngine((cfg) => openMemoryEngine(cfg, { http: { fetch } }));
    const makeConfig = (model: string) => ({
      store: { dir, vectorSize: 4 },
      embedder: { selection, dims: 4 },
      llm: {
        provider: "openai-compatible",
        model,
        apiKey: "sk-llm",
        baseUrl: "https://llm.test/v1",
        keyMissing: null,
      },
      historyDbPath,
    });

    const [{ engine: alice }, { engine: bob }] = await Promise.all([
      shared.get(makeConfig("alice/chat")),
      shared.get(makeConfig("bob/chat")),
    ]);
    await alice.add([{ role: "user", content: "我养猫" }], {
      scope: { userId: "u1", agentId: "alice" },
      metadata: {},
    });
    await bob.add([{ role: "user", content: "我喝茶" }], {
      scope: { userId: "u1", agentId: "bob" },
      metadata: {},
    });

    expect(
      (await alice.getAll({ filters: { userId: "u1", agentId: "alice" } })).map((m) => m.memory),
    ).toEqual(["用户养猫"]);
    expect(
      (await bob.getAll({ filters: { userId: "u1", agentId: "bob" } })).map((m) => m.memory),
    ).toEqual(["用户喝茶"]);
    expect(await alice.deleteAll({ userId: "u1", agentId: "alice" })).toBe(1);
    expect(
      (await bob.getAll({ filters: { userId: "u1", agentId: "bob" } })).map((m) => m.memory),
    ).toEqual(["用户喝茶"]);
  });
});
