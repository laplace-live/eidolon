// mem0's SQLiteManager: the `history` audit table and the `messages` window the extraction prompt
// quotes as "Last k Messages". The SQL is mem0's verbatim. Rows written in one call share a
// timestamp, so SQLite's tie order decides which 10 messages survive eviction: the earliest
// inserted, measured identical on Python's sqlite3 and bun:sqlite.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { errorText, logger } from "@eidolon/config";
import type { StoredMessage } from "./prompts.ts";
import { type Clock, pyIsoformatUtc, wallClockMicros } from "./time.ts";

const CREATE_HISTORY = `
                    CREATE TABLE IF NOT EXISTS history (
                        id           TEXT PRIMARY KEY,
                        memory_id    TEXT,
                        old_memory   TEXT,
                        new_memory   TEXT,
                        event        TEXT,
                        created_at   DATETIME,
                        updated_at   DATETIME,
                        is_deleted   INTEGER,
                        actor_id     TEXT,
                        role         TEXT
                    )
                `;

const HISTORY_COLUMNS = [
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
];

const CREATE_MESSAGES = `
                    CREATE TABLE IF NOT EXISTS messages (
                        id TEXT PRIMARY KEY,
                        session_scope TEXT,
                        role TEXT,
                        content TEXT,
                        name TEXT,
                        created_at DATETIME
                    )
                `;

const INSERT_HISTORY = `
                    INSERT INTO history (
                        id, memory_id, old_memory, new_memory, event,
                        created_at, updated_at, is_deleted, actor_id, role
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `;

const INSERT_MESSAGE = `
                        INSERT INTO messages (id, session_scope, role, content, name, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `;

const EVICT_MESSAGES = `
                    DELETE FROM messages WHERE session_scope = ? AND id NOT IN (
                        SELECT id FROM (
                            SELECT id FROM messages WHERE session_scope = ? ORDER BY created_at DESC LIMIT 10
                        )
                    )
                `;

const LAST_MESSAGES = `
                SELECT role, content, name, created_at FROM (
                    SELECT role, content, name, created_at
                    FROM messages
                    WHERE session_scope = ?
                    ORDER BY created_at DESC
                    LIMIT ?
                ) ORDER BY created_at ASC
            `;

export interface HistoryEntry {
  readonly memoryId: string;
  readonly oldMemory: unknown;
  readonly newMemory: unknown;
  readonly event: "ADD" | "DELETE";
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
  readonly isDeleted?: 0 | 1;
  readonly actorId?: unknown;
  readonly role?: unknown;
}

export interface MessageRow {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly name?: unknown;
}

function bind(value: unknown): SQLQueryBindings {
  return (value === undefined ? null : value) as SQLQueryBindings;
}

export class HistoryStore {
  readonly #db: Database;
  readonly #newId: () => string;
  readonly #clock: Clock;

  /** Opens (creating) the file; like sqlite3, it raises rather than create missing parents. */
  constructor(path: string, options: { newId?: () => string; clock?: Clock } = {}) {
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#clock = options.clock ?? wallClockMicros;
    this.#db = new Database(path);
    // Python's sqlite3 waits 5 s on a locked database by default; bun:sqlite does not wait.
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#transaction("History table migration failed", () => this.#migrate());
    this.#transaction("Failed to create history table", () => this.#db.run(CREATE_HISTORY));
    this.#transaction("Failed to create messages table", () => this.#db.run(CREATE_MESSAGES));
  }

  /** mem0's `_migrate_history_table`: rebuild a `history` table whose columns predate its schema. */
  #migrate(): void {
    const exists = this.#db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='history'")
      .get();
    if (!exists) return;
    const columns = new Set(
      (this.#db.query("PRAGMA table_info(history)").all() as { name: string }[]).map((c) => c.name),
    );
    if (columns.size === HISTORY_COLUMNS.length && HISTORY_COLUMNS.every((c) => columns.has(c))) {
      return;
    }
    this.#db.run("DROP TABLE IF EXISTS history_old");
    this.#db.run("ALTER TABLE history RENAME TO history_old");
    this.#db.run(CREATE_HISTORY.replace(" IF NOT EXISTS", ""));
    const shared = HISTORY_COLUMNS.filter((c) => columns.has(c)).join(", ");
    if (shared) this.#db.run(`INSERT INTO history (${shared}) SELECT ${shared} FROM history_old`);
    this.#db.run("DROP TABLE history_old");
  }

  #transaction(failure: string, body: () => void): void {
    this.#db.run("BEGIN");
    try {
      body();
      this.#db.run("COMMIT");
    } catch (error) {
      this.#db.run("ROLLBACK");
      logger.error(`${failure}: ${errorText(error)}`);
      throw error;
    }
  }

  #historyRow(entry: HistoryEntry): SQLQueryBindings[] {
    return [
      this.#newId(),
      entry.memoryId,
      bind(entry.oldMemory),
      bind(entry.newMemory),
      entry.event,
      bind(entry.createdAt),
      bind(entry.updatedAt),
      entry.isDeleted ?? 0,
      bind(entry.actorId),
      bind(entry.role),
    ];
  }

  addHistory(entry: HistoryEntry): void {
    this.#transaction("Failed to add history record", () => {
      this.#db.query(INSERT_HISTORY).run(...this.#historyRow(entry));
    });
  }

  batchAddHistory(entries: readonly HistoryEntry[]): void {
    this.#transaction("Failed to batch add history records", () => {
      const rows = entries.map((entry) => this.#historyRow(entry));
      const insert = this.#db.query(INSERT_HISTORY);
      for (const row of rows) insert.run(...row);
    });
  }

  saveMessages(messages: readonly MessageRow[], sessionScope: string): void {
    if (messages.length === 0) return;
    this.#transaction("Failed to save messages", () => {
      const now = pyIsoformatUtc(this.#clock());
      const insert = this.#db.query(INSERT_MESSAGE);
      for (const message of messages) {
        insert.run(
          this.#newId(),
          sessionScope,
          bind(message.role),
          bind(message.content),
          bind(message.name),
          now,
        );
      }
      this.#db.query(EVICT_MESSAGES).run(sessionScope, sessionScope);
    });
  }

  getLastMessages(sessionScope: string, limit = 10): StoredMessage[] {
    return this.#db.query(LAST_MESSAGES).all(sessionScope, limit) as StoredMessage[];
  }

  close(): void {
    this.#db.close();
  }
}
