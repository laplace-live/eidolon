import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { spawnProcess } from "@eidolon/config";
import { describe, expect, test, vi } from "vitest";
import { HistoryStore } from "../src/history.ts";
import fixtures from "./fixtures/text.json";
import { pinned, tempPath } from "./support.ts";

/** Every row of `sql` as an array of its values. */
function values(db: DatabaseSync, sql: string): unknown[][] {
  const statement = db.prepare(sql);
  statement.setReturnArrays(true);
  return statement.all() as unknown as unknown[][];
}

describe("HistoryStore", () => {
  test("a failed open closes the handle it opened", async () => {
    const path = tempPath("history.db");
    await writeFile(path, "not a database, just text that is long enough to be read as a header");
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    try {
      expect(() => new HistoryStore(path)).toThrow();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  test("a fresh file gets mem0's two tables", () => {
    const path = tempPath("history.db");
    new HistoryStore(path).close();
    const db = new DatabaseSync(path, { readOnly: true });
    const tables = values(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const historyColumns = db.prepare("PRAGMA table_info(history)").all() as { name: string }[];
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
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE history (id TEXT PRIMARY KEY, memory_id TEXT, prev_value TEXT, new_value TEXT, event TEXT, created_at DATETIME, updated_at DATETIME, is_deleted INTEGER)",
    );
    old.exec(
      "INSERT INTO history VALUES ('h1', 'm1', 'before', 'after', 'UPDATE', '2025-01-01T00:00:00+00:00', NULL, 0)",
    );
    old.close();
    new HistoryStore(path).close();
    const db = new DatabaseSync(path, { readOnly: true });
    const columns = (db.prepare("PRAGMA table_info(history)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    const rows = values(db, "SELECT * FROM history");
    const tables = values(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
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
    // The holder waits too, as Python's would: its COMMIT fails at once if it lands while one of the
    // store's retries holds the shared lock.
    const holder = spawnProcess([
      process.execPath,
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(${JSON.stringify(path)}, { timeout: 5000 });
       db.exec("BEGIN IMMEDIATE");
       db.exec("INSERT INTO messages (id, session_scope) VALUES ('held', 'x')");
       console.log("locked");
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
       db.exec("COMMIT");`,
    ]);
    const reader = (holder.stdout as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    const started = performance.now();
    store.saveMessages([{ role: "user", content: "after the lock" }], "s");
    expect(performance.now() - started).toBeGreaterThan(100);
    expect(await holder.exited).toBe(0);
    expect(store.getLastMessages("s").map((r) => r.content)).toEqual(["after the lock"]);
    store.close();
  });
});
