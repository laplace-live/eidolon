import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { HistoryStore } from "../src/history.ts";
import fixtures from "./fixtures/text.json";
import { pinned, tempPath } from "./support.ts";

describe("HistoryStore", () => {
  test("a fresh file gets mem0's two tables", () => {
    const path = tempPath("history.db");
    new HistoryStore(path).close();
    const db = new Database(path, { readonly: true });
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .values();
    const historyColumns = db.query("PRAGMA table_info(history)").all() as { name: string }[];
    db.close();
    expect(tables).toEqual([["history"], ["messages"]]);
    expect(historyColumns.map((c) => c.name)).toEqual([
      "id",
      "memory_id",
      "old_memory",
      "new_memory",
      "event",
      "created_at",
      "updated_at",
      "is_deleted",
      "actor_id",
      "role",
    ]);
  });

  test("eviction keeps the earliest-inserted rows on a timestamp tie, as Python's SQLite does", () => {
    const pins = pinned(1793678706123456, 1000001);
    const store = new HistoryStore(":memory:", { clock: pins.clock, newId: pins.newId });
    store.saveMessages(
      Array.from({ length: 15 }, (_, i) => ({
        role: "user",
        content: `m${String(i).padStart(2, "0")}`,
      })),
      "s",
    );
    expect(store.getLastMessages("s", 10).map((r) => r.content)).toEqual(fixtures.eviction.first);
    store.saveMessages(
      Array.from({ length: 3 }, (_, i) => ({
        role: "user",
        content: `n${String(i).padStart(2, "0")}`,
      })),
      "s",
    );
    const rows = store.getLastMessages("s", 10);
    expect(rows.map((r) => r.content)).toEqual(fixtures.eviction.second);
    expect(rows.map((r) => [r.content, r.created_at])).toEqual(fixtures.eviction.rows);
    store.close();
  });

  test("getLastMessages returns the newest rows oldest first, scoped", () => {
    const pins = pinned(1_000_000, 1_000_000);
    const store = new HistoryStore(":memory:", { clock: pins.clock, newId: pins.newId });
    store.saveMessages([{ role: "user", content: "a" }], "s");
    store.saveMessages([{ role: "assistant", content: "b", name: "nick" }], "s");
    store.saveMessages([{ role: "user", content: "other" }], "t");
    expect(store.getLastMessages("s", 1)).toEqual([
      { role: "assistant", content: "b", name: "nick", created_at: "1970-01-01T00:00:02+00:00" },
    ]);
    expect(store.getLastMessages("s").map((r) => r.content)).toEqual(["a", "b"]);
    store.close();
  });

  test("saving no messages writes nothing and reads no clock", () => {
    const pins = pinned(0, 1);
    const store = new HistoryStore(":memory:", { clock: pins.clock, newId: pins.newId });
    store.saveMessages([], "s");
    expect(pins.state).toEqual({ clockReads: 0, uuids: 0 });
    store.close();
  });

  test("an older history table is rebuilt to mem0's schema, keeping the shared columns", () => {
    const path = tempPath("history.db");
    const old = new Database(path);
    old.run(
      "CREATE TABLE history (id TEXT PRIMARY KEY, memory_id TEXT, prev_value TEXT, new_value TEXT, event TEXT, created_at DATETIME, updated_at DATETIME, is_deleted INTEGER)",
    );
    old.run(
      "INSERT INTO history VALUES ('h1', 'm1', 'before', 'after', 'UPDATE', '2025-01-01T00:00:00+00:00', NULL, 0)",
    );
    old.close();
    new HistoryStore(path).close();
    const db = new Database(path, { readonly: true });
    const columns = (db.query("PRAGMA table_info(history)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    const rows = db.query("SELECT * FROM history").values();
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .values();
    db.close();
    expect(columns).toEqual([
      "id",
      "memory_id",
      "old_memory",
      "new_memory",
      "event",
      "created_at",
      "updated_at",
      "is_deleted",
      "actor_id",
      "role",
    ]);
    expect(rows).toEqual([
      ["h1", "m1", null, null, "UPDATE", "2025-01-01T00:00:00+00:00", null, 0, null, null],
    ]);
    expect(tables).toEqual([["history"], ["messages"]]);
  });

  test("a missing parent directory raises, as sqlite3.connect does", () => {
    expect(() => new HistoryStore(tempPath("missing/dir/history.db"))).toThrow();
  });

  test("waits for another connection's write lock like Python's 5 s default", async () => {
    const path = tempPath("history.db");
    const store = new HistoryStore(path);
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { Database } = require("bun:sqlite");
         const db = new Database(${JSON.stringify(path)});
         db.run("BEGIN IMMEDIATE");
         db.run("INSERT INTO messages (id, session_scope) VALUES ('held', 'x')");
         console.log("locked");
         Bun.sleepSync(400);
         db.run("COMMIT");`,
      ],
      { stdout: "pipe" },
    );
    const reader = holder.stdout.getReader();
    await reader.read();
    const started = performance.now();
    store.saveMessages([{ role: "user", content: "after the lock" }], "s");
    expect(performance.now() - started).toBeGreaterThan(100);
    expect(await holder.exited).toBe(0);
    expect(store.getLastMessages("s").map((r) => r.content)).toEqual(["after the lock"]);
    store.close();
  });
});
