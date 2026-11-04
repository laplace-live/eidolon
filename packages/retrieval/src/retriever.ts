// One LanceDB table searched the way the bot searches it: embed, date pre-filter, hybrid search,
// and one retry against the stale handle a concurrent re-ingest leaves behind.
import { logger, pyFixed, pyRepr } from "@eidolon/config";
import type { Table } from "@lancedb/lancedb";
import { type EmbedOptions, embedTexts } from "./embeddings.ts";
import { type HybridSearchOptions, hybridSearch, type SearchRow, scoreOf } from "./hybrid.ts";
import { errorText } from "./py.ts";
import { extractDateFilter } from "./query.ts";
import {
  openTable,
  PERSONA_FACTS,
  resolveDbPath,
  STREAM_ARCHIVE,
  type TablePreset,
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
   * Python `retriever.table is not None`: true iff open(), or a stale-handle reopen inside
   * search(), holds a table. Never re-checks the filesystem; a table built later is seen by the
   * next open() (per session for context, at restart for MCP), as in Python.
   */
  readonly hasTable: boolean;
  /** Resolves [] on every failure except an abort, which rejects with `signal.reason`. Hits omit `vector`. */
  search(query: string, options: SearchOptions): Promise<SearchRow[]>;
  rowCount(): Promise<number>;
}

export interface LanceRetrieverOptions {
  dbPath: string;
  tableName: string;
  dateColumn: string;
  label: string;
  summarize?: ((hits: readonly SearchRow[]) => string) | null;
  ingestHint?: string;
  embedModel?: string | null;
  /** Test seams; default openTable, embedTexts and hybridSearch. */
  open?: (dbPath: string, tableName: string) => Promise<Table | null>;
  embed?: (texts: string[], options: EmbedOptions) => Promise<number[][]>;
  search?: (table: Table, options: HybridSearchOptions) => Promise<SearchRow[]>;
}

export class LanceRetriever implements Retriever {
  readonly #options: LanceRetrieverOptions;
  #table: Table | null;

  protected constructor(options: LanceRetrieverOptions, table: Table | null) {
    this.#options = options;
    this.#table = table;
  }

  /** Errors opening an existing table propagate; a missing one logs and yields a no-op retriever. */
  static async open(options: LanceRetrieverOptions): Promise<LanceRetriever> {
    const table = await (options.open ?? openTable)(options.dbPath, options.tableName);
    if (table === null) {
      const hint = options.ingestHint ? ` Run \`${options.ingestHint}\` to build it.` : "";
      logger.warning(
        `${options.label}: no LanceDB table at ${options.dbPath}/${options.tableName}.lance — ` +
          `retrieval will be a no-op.${hint}`,
      );
    }
    return new LanceRetriever(options, table);
  }

  /** The live handle, or null when the table has never been built. */
  get table(): Table | null {
    return this.#table;
  }

  get hasTable(): boolean {
    return this.#table !== null;
  }

  async rowCount(): Promise<number> {
    return this.#table === null ? 0 : this.#table.countRows();
  }

  async search(query: string, options: SearchOptions): Promise<SearchRow[]> {
    const { label, dateColumn, embedModel = null } = this.#options;
    const { signal } = options;
    if (this.#table === null) {
      logger.warning(`${label} search skipped: no table loaded`);
      return [];
    }
    let vectors: number[][];
    try {
      const embed = this.#options.embed ?? embedTexts;
      vectors = await embed([query], { model: embedModel, ...(signal ? { signal } : {}) });
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
        // lance exposes no typed errors, so a data file stranded by a re-ingest arrives as a bare
        // error carrying "Not found".
        if (attempt === 1 && errorText(error).includes("Not found")) {
          logger.warning(
            `${label} hit stale table (likely re-ingested while bot was running); ` +
              "re-opening and retrying once.",
          );
          try {
            await this.#reopen();
          } catch (reopenError) {
            logger.error(
              `${label} search failed for query=${pyRepr(query)}: ${errorText(reopenError)}`,
            );
            return [];
          }
          continue;
        }
        logger.error(`${label} search failed for query=${pyRepr(query)}: ${errorText(error)}`);
        return [];
      }
    }
    return [];
  }

  /** Once the table is gone, the retriever stays disabled for the life of the process. */
  async #reopen(): Promise<void> {
    const { label, dbPath, tableName } = this.#options;
    let table: Table | null;
    try {
      table = await (this.#options.open ?? openTable)(dbPath, tableName);
    } catch (error) {
      logger.error(`${label} re-open failed: ${errorText(error)}`);
      this.#table = null;
      return;
    }
    if (table === null) {
      logger.warning(`${label} re-open: no table at ${dbPath}/${tableName}.lance`);
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
  /** Overrides EMBED_MODEL; must match what ingest used. */
  embedModel?: string | null;
}

function openPreset(
  preset: TablePreset,
  dbPath: string,
  options: RetrieverOpenOptions,
): Promise<LanceRetriever> {
  return LanceRetriever.open({
    dbPath,
    tableName: options.tableName ?? preset.table,
    dateColumn: preset.dateColumn,
    label: preset.label,
    summarize: preset.summarize,
    ingestHint: preset.ingestHint,
    embedModel: options.embedModel ?? null,
  });
}

/** The persona-facts retriever as the bot uses it. `dbPath` defaults to resolveDbPath(). */
export function openPersonaFactsRetriever(
  dbPath: string = resolveDbPath(),
  options: RetrieverOpenOptions = {},
): Promise<LanceRetriever> {
  return openPreset(PERSONA_FACTS, dbPath, options);
}

/** The stream-archive retriever as the bot uses it. `dbPath` defaults to resolveDbPath(). */
export function openStreamArchiveRetriever(
  dbPath: string = resolveDbPath(),
  options: RetrieverOpenOptions = {},
): Promise<LanceRetriever> {
  return openPreset(STREAM_ARCHIVE, dbPath, options);
}
