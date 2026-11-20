// The usage ledger: one SQLite row per request that spent money, or per batch of a call's audio
// and speech, with the persona it served. The bot, the local app and every CLI job write to the
// same file, so it runs in WAL mode with a busy timeout.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { activePersona, dataHome, envOptional, errorText, logger } from "@eidolon/config";
import { setUsageSink, type UsageRecord } from "@eidolon/providers";
import type { UsageRow, UsageSummary } from "./summary.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    persona TEXT NOT NULL,
    source TEXT,
    session TEXT,
    role TEXT NOT NULL,
    category TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER,
    cached_tokens INTEGER,
    cache_write_tokens INTEGER,
    output_tokens INTEGER,
    characters INTEGER,
    bytes INTEGER,
    audio_seconds REAL,
    searches REAL,
    images INTEGER,
    cost_usd REAL,
    cost_source TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_at ON usage (at);
  CREATE INDEX IF NOT EXISTS usage_persona_at ON usage (persona, at);
`;

const INSERT = `
  INSERT INTO usage (
    at, persona, source, session, role, category, provider, model,
    input_tokens, cached_tokens, cache_write_tokens, output_tokens,
    characters, bytes, audio_seconds, searches, images, cost_usd, cost_source
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SUMMARY = `
  SELECT
    strftime('%Y-%m-%d', at / 1000, 'unixepoch', 'localtime') AS day,
    persona, provider, category, role, model,
    COUNT(*) AS records,
    COALESCE(SUM(cost_usd), 0) AS costUsd,
    COALESCE(SUM(CASE WHEN cost_source = 'estimated' THEN cost_usd END), 0) AS estimatedUsd,
    SUM(cost_source = 'unpriced') AS unpriced,
    COALESCE(SUM(input_tokens), 0) AS inputTokens,
    COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
    COALESCE(SUM(output_tokens), 0) AS outputTokens,
    COALESCE(SUM(characters), 0) AS characters,
    COALESCE(SUM(audio_seconds), 0) AS audioSeconds,
    COALESCE(SUM(searches), 0) AS searches,
    COALESCE(SUM(images), 0) AS images
  FROM usage
  WHERE at >= $from AND at < $to AND ($persona IS NULL OR persona = $persona)
  GROUP BY day, persona, provider, category, role, model
  ORDER BY day, persona, provider, category, role, model
`;

export interface SummaryQuery {
  /** ms since the epoch, inclusive; unbounded when absent. */
  readonly from?: number | null;
  /** ms since the epoch, exclusive. */
  readonly to?: number | null;
  readonly persona?: string | null;
}

const MAX_INSTANT = 8.64e15;

const distinct = (column: "persona" | "provider"): string =>
  `SELECT DISTINCT ${column} AS value FROM usage ORDER BY value`;

export class UsageLedger {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #insert: StatementSync;
  readonly #summary: StatementSync;
  readonly #personas: StatementSync;
  readonly #providers: StatementSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec("PRAGMA journal_mode = WAL");
    // Records are written on a call's event loop. In WAL mode NORMAL syncs at checkpoints rather
    // than at every commit: a power cut can lose the last few records, never the file.
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec(SCHEMA);
    this.#insert = this.#db.prepare(INSERT);
    this.#summary = this.#db.prepare(SUMMARY);
    this.#personas = this.#db.prepare(distinct("persona"));
    this.#providers = this.#db.prepare(distinct("provider"));
  }

  record(record: UsageRecord, persona: string): void {
    const { units } = record;
    this.#insert.run(
      record.at,
      persona,
      record.source,
      record.session,
      record.role,
      record.category,
      record.provider,
      record.model,
      units.inputTokens ?? null,
      units.cachedTokens ?? null,
      units.cacheWriteTokens ?? null,
      units.outputTokens ?? null,
      units.characters ?? null,
      units.bytes ?? null,
      units.audioSeconds ?? null,
      units.searches ?? null,
      units.images ?? null,
      record.costUsd,
      record.costSource,
    );
  }

  summarize(query: SummaryQuery = {}): Omit<UsageSummary, "path" | "recording"> {
    const from = query.from ?? null;
    const to = query.to ?? null;
    const persona = query.persona ?? null;
    const rows = this.#summary.all({
      $from: from ?? 0,
      $to: to ?? MAX_INSTANT,
      $persona: persona,
    }) as unknown as UsageRow[];
    const values = (statement: StatementSync): string[] =>
      statement.all().map((row) => row.value as string);
    return {
      from,
      to,
      persona,
      rows,
      personas: values(this.#personas),
      providers: values(this.#providers),
    };
  }

  close(): void {
    this.#db.close();
  }
}

/** `usage.db` (EIDOLON_USAGE_DB), else `<data home>/usage.db`. */
export function ledgerPath(): string {
  return envOptional("EIDOLON_USAGE_DB") ?? join(dataHome(), "usage.db");
}

let installed: UsageLedger | null = null;

/**
 * Opens the ledger and sends every usage report to it, each under the active persona. A ledger
 * that can't be opened, as on a read-only data home, logs once and records nothing.
 */
export function installUsageLedger(): UsageLedger | null {
  if (installed !== null) return installed;
  const path = ledgerPath();
  try {
    installed = new UsageLedger(path);
  } catch (error) {
    logger.warning(
      `Usage ledger off: ${path} can't be opened (${errorText(error)}); set EIDOLON_USAGE_DB to a writable path`,
    );
    return null;
  }
  const ledger = installed;
  setUsageSink((record) => ledger.record(record, activePersona().id));
  return ledger;
}

/** The installed ledger; null before installUsageLedger(), or when it couldn't open. */
export function usageLedger(): UsageLedger | null {
  return installed;
}

/** Stops recording and closes the ledger. For tests and shutdown. */
export function uninstallUsageLedger(): void {
  setUsageSink(null);
  installed?.close();
  installed = null;
}
