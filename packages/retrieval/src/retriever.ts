// One Zvec table searched the way the bot searches it: embed, date pre-filter, hybrid search,
// automatic reload when `CURRENT` points to a newer build, and one retry against a stale handle.
import { existsSync } from "node:fs";
import { errorText, logger, pyFixed, pyRepr } from "@eidolon/config";
import { type EmbedOptions, embedTexts } from "./embeddings.ts";
import { type HybridSearchOptions, hybridSearch, type SearchRow, scoreOf } from "./hybrid.ts";
import { extractDateFilter } from "./query.ts";
import {
  ingestHint,
  openTable,
  PERSONA_FACTS,
  readCurrentBuildId,
  resolveDbPath,
  STREAM_ARCHIVE,
  type TablePreset,
  type ZvecTable,
} from "./tables.ts";

export interface SearchOptions {
  readonly candidates: number;
  readonly topK: number;
  /** Default true: an explicit `where` wins, else the query's named day filters the date column. */
  readonly datePrefilter?: boolean;
  readonly where?: string | null;
  readonly signal?: AbortSignal;
}

export interface Retriever {
  /**
   * True iff open(), or a reopen inside search(), holds a table. Never re-checks a missing table;
   * a table built later is seen by the next open() (per session for context, at restart for MCP).
   */
  readonly hasTable: boolean;
  /** Resolves [] on every failure except an abort, which rejects with `signal.reason`. Hits omit `vector`. */
  search(query: string, options: SearchOptions): Promise<SearchRow[]>;
  rowCount(): Promise<number>;
}

export interface ZvecRetrieverOptions {
  dbPath: string;
  tableName: string;
  dateColumn: string;
  label: string;
  summarize?: ((hits: readonly SearchRow[]) => string) | null;
  ingestHint?: string;
  /** Test seams; default openTable, embedTexts and hybridSearch. */
  open?: (dbPath: string, tableName: string) => Promise<ZvecTable | null>;
  embed?: (texts: string[], options: EmbedOptions) => Promise<number[][]>;
  search?: (table: ZvecTable, options: HybridSearchOptions) => Promise<SearchRow[]>;
}

function isStaleError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ZVEC_NOT_FOUND" || code === "ZVEC_FAILED_PRECONDITION" || code === "ENOENT") {
    return true;
  }
  const text = errorText(error);
  return text.includes("Not found") || text.includes("ENOENT") || text.includes("already closed");
}

export class ZvecRetriever implements Retriever {
  readonly #options: ZvecRetrieverOptions;
  #table: ZvecTable | null;

  protected constructor(options: ZvecRetrieverOptions, table: ZvecTable | null) {
    this.#options = options;
    this.#table = table;
  }

  /** Errors opening an existing table propagate; a missing one logs and yields a no-op retriever. */
  static async open(options: ZvecRetrieverOptions): Promise<ZvecRetriever> {
    const table = await (options.open ?? openTable)(options.dbPath, options.tableName);
    if (table === null) {
      const hint = options.ingestHint ? ` Run \`${options.ingestHint}\` to build it.` : "";
      logger.warning(
        `${options.label}: no Zvec table at ${options.dbPath}/${options.tableName}.zvec — ` +
          `retrieval will be a no-op.${hint}`,
      );
    }
    return new ZvecRetriever(options, table);
  }

  /** The live handle, or null when the table has never been built. */
  get table(): ZvecTable | null {
    return this.#table;
  }

  get hasTable(): boolean {
    return this.#table !== null;
  }

  async rowCount(): Promise<number> {
    if (
      this.#table !== null &&
      this.#options.open === undefined &&
      (this.#table.isClosed ||
        readCurrentBuildId(this.#options.dbPath, this.#options.tableName) !== this.#table.buildId)
    ) {
      await this.#reopen({
        keepCurrentIfOpen: !this.#table.isClosed && existsSync(this.#table.buildPath),
      });
    }
    return this.#table === null ? 0 : this.#table.countRows();
  }

  async search(query: string, options: SearchOptions): Promise<SearchRow[]> {
    const { label, dateColumn, dbPath, tableName } = this.#options;
    const { signal } = options;
    signal?.throwIfAborted();
    if (this.#table === null) {
      logger.warning(`${label} search skipped: no table loaded`);
      return [];
    }
    if (this.#options.open === undefined) {
      const diskBuildId = readCurrentBuildId(dbPath, tableName);
      if (this.#table.isClosed || diskBuildId !== this.#table.buildId) {
        logger.warning(
          `${label} hit stale table (likely re-ingested while bot was running); ` +
            "re-opening and retrying once.",
        );
        // `rsync --delay-updates` renames `CURRENT` before moving `<newBuildId>/.~tmp~/*`: keep the
        // live previous build when the incoming build cannot open yet.
        const keepCurrentIfOpen = !this.#table.isClosed && existsSync(this.#table.buildPath);
        await this.#reopen({ keepCurrentIfOpen });
        if (this.#table === null) return [];
      }
    }

    let vectors: number[][];
    try {
      const embed = this.#options.embed ?? embedTexts;
      vectors = await embed([query], { model: null, ...(signal ? { signal } : {}) });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      logger.error(`${label} embed failed for query=${pyRepr(query)}: ${errorText(error)}`);
      return [];
    }
    const vector = vectors[0];
    if (vector === undefined) return [];

    let where = options.where ?? null;
    if (where === null && (options.datePrefilter ?? true)) {
      where = extractDateFilter(query, { column: dateColumn });
    }
    if (where) logger.info(`${label} date pre-filter: ${pyRepr(where)}`);

    const search = this.#options.search ?? hybridSearch;
    for (const attempt of [1, 2]) {
      const table = this.#table;
      if (table === null) return [];
      if (attempt === 1 && table.isClosed && this.#options.open === undefined) {
        logger.warning(
          `${label} hit stale table (likely re-ingested while bot was running); ` +
            "re-opening and retrying once.",
        );
        await this.#reopen();
        continue;
      }
      try {
        const results = await search(table, {
          vector,
          queryText: query,
          candidates: options.candidates,
          where,
          finalK: options.topK,
          rerank: true,
          ...(signal ? { signal } : {}),
        });
        this.#logOutcome(query, results);
        return results;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (attempt === 1 && isStaleError(error)) {
          logger.warning(
            `${label} hit stale table (likely re-ingested while bot was running); ` +
              "re-opening and retrying once.",
          );
          await this.#reopen();
          continue;
        }
        logger.error(`${label} search failed for query=${pyRepr(query)}: ${errorText(error)}`);
        return [];
      }
    }
    return [];
  }

  /** Once the table is gone, the retriever stays disabled for the life of the process. */
  async #reopen(options: { keepCurrentIfOpen?: boolean } = {}): Promise<void> {
    const { label, dbPath, tableName } = this.#options;
    let table: ZvecTable | null;
    try {
      table = await (this.#options.open ?? openTable)(dbPath, tableName);
    } catch (error) {
      if (options.keepCurrentIfOpen && this.#table !== null && !this.#table.isClosed) {
        logger.warning(`${label} re-open deferred while new build settles: ${errorText(error)}`);
        return;
      }
      logger.error(`${label} re-open failed: ${errorText(error)}`);
      this.#table = null;
      return;
    }
    if (table === null) {
      if (options.keepCurrentIfOpen && this.#table !== null && !this.#table.isClosed) {
        logger.warning(`${label} re-open deferred while new build settles`);
        return;
      }
      logger.warning(`${label} re-open: no table at ${dbPath}/${tableName}.zvec`);
      this.#table = null;
      return;
    }
    this.#table = table;
    logger.info(`${label} re-opened table (${await table.countRows()} rows)`);
  }

  #logOutcome(query: string, results: readonly SearchRow[]): void {
    const { label, summarize } = this.#options;
    const first = results[0];
    if (first === undefined) {
      logger.info(`${label} miss: query=${pyRepr(query)} returned 0 rows`);
      return;
    }
    const score = scoreOf(first) ?? Number.NaN;
    const extra = summarize ? `, ${summarize(results)}` : "";
    logger.info(
      `${label} hit: query=${pyRepr(query)} → ${results.length} rows ` +
        `(top_score=${pyFixed(score, 3)}${extra})`,
    );
  }
}

export interface RetrieverOpenOptions {
  /** Overrides the preset's table name. */
  tableName?: string;
}

function openPreset(
  preset: TablePreset,
  dbPath: string,
  options: RetrieverOpenOptions,
): Promise<ZvecRetriever> {
  return ZvecRetriever.open({
    dbPath,
    tableName: options.tableName ?? preset.table,
    dateColumn: preset.dateColumn,
    label: preset.label,
    summarize: preset.summarize,
    ingestHint: ingestHint(preset.ingestCommand),
  });
}

/** The persona-facts retriever as the bot uses it. `dbPath` defaults to resolveDbPath(). */
export function openPersonaFactsRetriever(
  dbPath: string = resolveDbPath(),
  options: RetrieverOpenOptions = {},
): Promise<ZvecRetriever> {
  return openPreset(PERSONA_FACTS, dbPath, options);
}

/** The stream-archive retriever as the bot uses it. `dbPath` defaults to resolveDbPath(). */
export function openStreamArchiveRetriever(
  dbPath: string = resolveDbPath(),
  options: RetrieverOpenOptions = {},
): Promise<ZvecRetriever> {
  return openPreset(STREAM_ARCHIVE, dbPath, options);
}
