// Date-scoped broadcast overviews and the detailed archive search they bound. The selected scope
// is per session, so follow-ups like "那周呢？" resolve against what the last recall picked.
import { raceAbort, zonedClock } from "@eidolon/config";
import {
  addDays,
  type Broadcast,
  formatBroadcasts,
  type IsoDate,
  isStreamOverview,
  parseIsoDate,
  type Retriever,
  resolveStreamScope,
  type SearchRow,
  type StreamScope,
  streamScope,
} from "@eidolon/retrieval";

export const OVERVIEW_FRAME_KEY = "stream_archive_overview";

export const RECALL_NOTES = {
  sameDay: "当天有多场归档但没有开播时间，无法确定这些场次的先后；不要猜测哪场最后。",
  noScope: "还没有明确要回顾哪场直播或哪个时间段，请先确定范围。",
  noOverview: "这个范围没有已归档的直播概览；不能据此断定没有直播。",
  noLatest: "没有可确定最近场次的直播概览，不能把其他日期的片段当作最近直播。",
  noChunks: "没有找到能回答这个问题的直播片段；概览只能支持其中明确记录的内容。",
} as const;

export interface RecallResult {
  scope: StreamScope | null;
  overview: boolean;
  broadcasts: Broadcast[];
  chunks: SearchRow[];
  note: string;
}

export function recallResult(
  init: Pick<RecallResult, "scope" | "overview"> & Partial<RecallResult>,
): RecallResult {
  return {
    scope: init.scope,
    overview: init.overview,
    broadcasts: init.broadcasts ?? [],
    chunks: init.chunks ?? [],
    note: init.note ?? "",
  };
}

export function overviewText(result: RecallResult, maxChars = 10000): string {
  return formatBroadcasts(result.broadcasts, maxChars);
}

/** The LanceDB `where` that keeps a details search inside `scope`, or null for none. */
export function scopeFilter(scope: StreamScope, broadcasts: readonly Broadcast[]): string | null {
  const ids =
    broadcasts.length > 0 && (scope.latest !== null || scope.streamIds.length > 0)
      ? broadcasts.flatMap((broadcast) => broadcast.streamIds)
      : [...scope.streamIds];
  if (ids.length > 0) {
    return `stream_id IN (${ids.map((id) => `'${id.replaceAll("'", "''")}'`).join(", ")})`;
  }
  const conditions: string[] = [];
  if (scope.startDate) conditions.push(`stream_date >= '${scope.startDate}'`);
  if (scope.endDate) conditions.push(`stream_date < '${scope.endDate}'`);
  return conditions.join(" AND ") || null;
}

export type RecallRetriever = Pick<Retriever, "search">;

export interface RecallCatalog {
  broadcasts(): Promise<Broadcast[]>;
  select(options?: {
    startDate?: IsoDate | null;
    endDate?: IsoDate | null;
    streamIds?: readonly string[] | null;
  }): Promise<Broadcast[]>;
}

export interface StreamRecallOptions {
  readonly retriever: RecallRetriever;
  readonly catalog: RecallCatalog;
  readonly timeZone: string;
  readonly candidates?: number;
  readonly topK?: number;
  /** Read on every call; defaults to today's date in `timeZone`. */
  readonly today?: () => IsoDate;
}

export class StreamRecall {
  readonly retriever: RecallRetriever;
  readonly catalog: RecallCatalog;
  readonly candidates: number;
  readonly topK: number;
  selectedScope: StreamScope | null = null;
  readonly #today: () => IsoDate;

  constructor(options: StreamRecallOptions) {
    this.retriever = options.retriever;
    this.catalog = options.catalog;
    this.candidates = options.candidates ?? 15;
    this.topK = options.topK ?? 3;
    const timeZone = options.timeZone;
    this.#today = options.today ?? (() => zonedClock(timeZone).isoDate);
  }

  today(): IsoDate {
    return this.#today();
  }

  resolve(query: string): StreamScope | null {
    return resolveStreamScope(query, { today: this.#today(), previous: this.selectedScope });
  }

  async select(scope: StreamScope): Promise<Broadcast[]> {
    if (scope.latest !== null) {
      const today = this.#today();
      const eligible = (await this.catalog.broadcasts()).filter(
        (broadcast) => broadcast.streamDate <= today,
      );
      const [chosen] = eligible.slice(scope.latest - 1, scope.latest);
      if (chosen === undefined) return [];
      // "previous" (latest=2) lands on the newest date again when two broadcasts share it.
      return eligible.filter((broadcast) => broadcast.streamDate === chosen.streamDate);
    }
    return this.catalog.select({
      startDate: scope.startDate,
      endDate: scope.endDate,
      streamIds: scope.streamIds.length > 0 ? scope.streamIds : null,
    });
  }

  /** Makes `result` the scope follow-ups resolve against, widened to its broadcasts' dates. */
  remember(result: RecallResult): void {
    const scope = result.scope;
    if (scope === null) return;
    if (result.broadcasts.length === 0) {
      this.selectedScope = scope;
      return;
    }
    const dates = result.broadcasts
      .filter((broadcast) => broadcast.streamDate)
      .map((broadcast) => parseIsoDate(broadcast.streamDate))
      .sort();
    const first = dates[0];
    const last = dates.at(-1);
    this.selectedScope = streamScope({
      startDate: scope.startDate ?? first ?? null,
      endDate: scope.endDate ?? (last === undefined ? null : addDays(last, 1)),
      streamIds: result.broadcasts.map((broadcast) => broadcast.id),
      label: scope.label,
    });
  }

  /** Rejects with `signal.reason`, leaving the selected scope as it was, when aborted mid-way. */
  async lookup(
    query: string,
    options: {
      scope?: StreamScope | null;
      overview?: boolean | null;
      signal?: AbortSignal;
    } = {},
  ): Promise<RecallResult> {
    const scope = options.scope ?? null;
    const signal = options.signal;
    const overview = options.overview ?? isStreamOverview(query);
    const broadcasts = scope === null ? [] : await raceAbort(this.select(scope), signal);
    signal?.throwIfAborted();
    const result = recallResult({ scope, overview, broadcasts });
    if (scope !== null && scope.latest !== null && broadcasts.length > 1) {
      result.note = RECALL_NOTES.sameDay;
    }
    if (overview) {
      if (scope === null) result.note = RECALL_NOTES.noScope;
      else if (broadcasts.length === 0) result.note = RECALL_NOTES.noOverview;
      this.remember(result);
      return result;
    }

    const where = scope === null ? null : scopeFilter(scope, broadcasts);
    if (scope !== null && scope.latest !== null && broadcasts.length === 0) {
      result.note = RECALL_NOTES.noLatest;
      return result;
    }
    result.chunks = await raceAbort(
      this.retriever.search(query, {
        candidates: this.candidates,
        topK: this.topK,
        datePrefilter: scope === null,
        where,
        signal,
      }),
      signal,
    );
    signal?.throwIfAborted();
    if (result.chunks.length === 0) result.note += RECALL_NOTES.noChunks;
    this.remember(result);
    return result;
  }
}
