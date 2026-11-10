// RAG over past stream transcripts. Each enhanced turn refreshes the recent-broadcasts block, then
// routes the latest user line: a date- or period-scoped recall, a hint to call recall_streams, or
// a topical search the retrieval gate may skip. The archive also owns the recall_streams tool,
// whose per-turn budget shares this turn key.
import {
  cpLen,
  errorText,
  logger,
  personaTimeZone,
  pyRepr,
  pyStr,
  pyStrip,
  pyTruthy,
  raceAbort,
} from "@eidolon/config";
import type {
  ContextProvider,
  ContextTurn,
  ConversationContext,
  LlmTool,
  ToolCall,
} from "@eidolon/core";
import {
  addDays,
  type Broadcast,
  buildQueryText,
  clip,
  decodeTopics,
  formatBroadcasts,
  hasStreamTimeReference,
  type IsoDate,
  isStreamElaboration,
  isStreamFollowup,
  isStreamOverview,
  isStreamQuery,
  type Occurrence,
  openStreamArchiveRetriever,
  type Retriever,
  type SearchRow,
  StreamCatalog,
  type StreamScope,
  streamArchiveSearchParams,
  streamScope,
  type Timeline,
} from "@eidolon/retrieval";
import { pyRstrip } from "./compat.ts";
import { decisionOf, type GateDecision, unlessSkipped } from "./gate.ts";
import {
  latestUserText,
  recentUserTexts,
  sameTurn,
  setBlock,
  type TurnKey,
  turnKeyOf,
} from "./messages.ts";
import {
  OVERVIEW_FRAME_KEY,
  overviewText,
  type RecallCatalog,
  type RecallResult,
  recallResult,
  StreamRecall,
} from "./recall.ts";
import {
  parseRecallRequest,
  RECALL_STREAMS_SCHEMA,
  RECALL_TOOL_NAME,
  type RecallRequest,
  type RecallToolResult,
  TOOL_BUDGET_SPENT,
  TOOL_FAILED,
} from "./recall_tool.ts";

export const RECENT_PREFIX = "最近已归档的直播概览：\n";
export const RECALL_PREFIX = "本次直播回忆查询：\n";
export const RECALL_HINT =
  `当前问题需要直播回忆。概览不足时调用 ${RECALL_TOOL_NAME} 确定场次并查找记录；` +
  "不要把不同时期的直播混在一起，也不要还没查询就说记不清。";
export const CHUNK_SCOPE_LABEL = "刚才查到的直播片段";
const TIMELINE_SCOPE_LABEL = "刚才查到的场次";
export const RENDER_HEADER =
  "以下是已归档直播的记录，用来 ground 回复，不要照念，也不要主动念日期。";

const TOOL_BUDGET = 2;

export interface StreamArchiveParams {
  readonly topK: number;
  readonly candidates: number;
  readonly minQueryChars: number;
  readonly maxUserTurns: number;
  /**
   * SQL pre-filter on `stream_date` when the query names a day, applied before vector + FTS
   * scoring. Stops "26年3月24" from surfacing 2023-12-24 chunks; one stream day still yields
   * ~10-20 chunks, so the reranker isn't starved.
   */
  readonly datePrefilter: boolean;
  readonly systemPrompt: string;
  /**
   * The system instruction lives on the LLM service rather than in the context, so on the first
   * turn the context is just `[user]` and any position >= 1 clamps to "append at end".
   */
  readonly position: number;
}

export function streamArchiveParams(): StreamArchiveParams {
  return {
    ...streamArchiveSearchParams(),
    minQueryChars: 4,
    maxUserTurns: 3,
    datePrefilter: true,
    systemPrompt:
      "你过去直播里相关的片段（用来 ground 你的回复，不要照念，也不要把日期念出来）：\n\n",
    position: 2,
  };
}

/**
 * Renders retrieved chunks as one system block: a v2 chunk's details and extras, else a v1
 * summary, else the raw transcript. Per-viewer SC lines are what let the persona recall who said
 * what.
 */
export function formatChunks(chunks: readonly SearchRow[], prefix: string): string {
  const lines = [prefix];
  chunks.forEach((chunk, index) => {
    const date = "stream_date" in chunk ? pyStr(chunk.stream_date) : "unknown date";
    const heading = chunk.heading ?? "";
    const summary = textOr(chunk.summary);
    const details = textOr(chunk.details);
    const topics = decodeTopics(chunk);
    let header = `[${index + 1}] ${date}`;
    if (topics.length > 0) header += ` — ${topics.join(", ")}`;
    if (pyTruthy(heading)) header += ` — ${pyStr(heading)}`;
    lines.push(header);
    if (details) {
      lines.push(pyStrip(details));
      appendExtras(lines, extrasOf(chunk));
    } else if (summary) {
      lines.push(pyStrip(summary));
    } else {
      lines.push(pyStrip(pyStr(chunk.text ?? "")));
    }
    lines.push("");
  });
  return `${pyRstrip(lines.join("\n"))}\n`;
}

/** Python `value or ""` for a text column. */
function textOr(value: unknown): string {
  return pyTruthy(value) ? pyStr(value) : "";
}

function extrasOf(chunk: SearchRow): Record<string, unknown> {
  const raw = chunk.extras_json;
  if (typeof raw !== "string" || !raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function listOf(value: unknown): unknown[] {
  return pyTruthy(value) ? (value as unknown[]) : [];
}

function field(value: unknown, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function appendExtras(lines: string[], extras: Record<string, unknown>): void {
  const scEvents = listOf(extras.sc_events);
  if (scEvents.length > 0) {
    lines.push("SC回顾:");
    for (const sc of scEvents) {
      const viewer = pyTruthy(field(sc, "viewer")) ? pyStr(field(sc, "viewer")) : "?";
      const amount = field(sc, "amount_yuan");
      const content = pyStrip(textOr(field(sc, "content")));
      const response = pyStrip(textOr(field(sc, "response")));
      let head = `  • ${viewer}`;
      if (pyTruthy(amount)) head += `（¥${pyStr(amount)}）`;
      if (content) head += `: ${content}`;
      lines.push(head);
      if (response) lines.push(`    → 我的回复: ${response}`);
    }
  }

  const songs = listOf(extras.songs);
  if (songs.length > 0) {
    const titles: string[] = [];
    for (const song of songs) {
      if (typeof song === "string") {
        titles.push(`《${song}》`);
      } else if (typeof song === "object" && song !== null && !Array.isArray(song)) {
        const title = pyStrip(textOr(field(song, "title")));
        const note = pyStrip(textOr(field(song, "note")));
        titles.push(`《${title}》${note ? `（${note}）` : ""}`);
      }
    }
    if (titles.length > 0) lines.push(`歌曲: ${titles.join("; ")}`);
  }

  const events = listOf(extras.events);
  if (events.length > 0) lines.push(`事件: ${events.map((e) => pyStr(e)).join("; ")}`);

  const promises = listOf(extras.promises);
  if (promises.length > 0) lines.push(`承诺: ${promises.map((p) => pyStr(p)).join("; ")}`);

  const quotes = listOf(extras.key_quotes);
  if (quotes.length > 0) {
    lines.push("金句:");
    for (const quote of quotes) lines.push(`  · 「${pyStr(quote)}」`);
  }
}

// What a timeline follow-up is built from: pointers (那个游戏), pronouns, time and question words,
// the verbs these questions use, particles. Two or more other characters in a row may name a topic
// the catalog lacks, which must not borrow the earlier line's; a stray one (在, 碰) can't.
const FOLLOWUP_CHARS = new RegExp(
  "(?:那|这)(?:个|款|首|部)?(?:游戏|歌|曲子|节目|剧)|" +
    "[那这个款首部它她他你我咱还又再是的了吗呢吧啊呀嘛过没在要会能就都也跟和给对么啥什哪怎" +
    "时候次回最上一第早久几多少号天月年前后近来去曾经玩播唱打聊开看见提说" +
    String.raw`\s\p{P}]`,
  "gu",
);

function isBareFollowup(text: string | undefined): boolean {
  return text !== undefined && !/\S{2}/u.test(text.replace(FOLLOWUP_CHARS, " "));
}

// A broadcast with at least this many scenes naming a topic reads as one she spent on it; one or
// two usually just mention it.
const TIMELINE_MAIN_SCENES = 3;
const TIMELINE_SHOWN = 3;

/**
 * A timeline as the archive injects it, with the broadcasts it names in its order: the newest
 * few, the newest with many scenes, the first, and the first with many.
 */
function renderTimeline(timeline: Timeline): { text: string; shown: Broadcast[] } {
  const { occurrences } = timeline;
  const entry = (occurrence: Occurrence) =>
    `${occurrence.broadcast.streamDate}，${occurrence.scenes.length}段：` +
    occurrence.scenes
      .slice(0, 2)
      .map((scene) => clip(scene.heading, 30))
      .join("；");
  const recent = occurrences.slice(0, TIMELINE_SHOWN);
  const main = occurrences.filter((o) => o.scenes.length >= TIMELINE_MAIN_SCENES);
  const first = occurrences.at(-1) as Occurrence;
  const firstMain = main.at(-1);
  const lines = [
    `观众在问${timeline.terms.map((term) => `「${term}」`).join("和")}最近一次、第一次或一共几次的时间。` +
      "下面是已归档录播里提到它的直播，从新到旧；段数是那场里提到它的片段数，" +
      "多段通常是那天主要在做这件事，一两段多半只是聊到。归档不是完整的开播记录。",
    `共${occurrences.length}场提到，其中${main.length}场多段。`,
    ...recent.map((o) => `- ${entry(o)}`),
    main[0] ? `最近一场多段的是 ${entry(main[0])}` : "这些场次都只有一两段，可能都只是聊到。",
    `最早一场是 ${entry(first)}`,
  ];
  if (firstMain && firstMain !== first) lines.push(`最早一场多段的是 ${entry(firstMain)}`);
  lines.push(
    '被问到时间就直接说日期，像平时说话那样（比如"八月三十号"）；' +
      '不是今年的带上年份（比如"二〇二二年十月"），不要换算成"前年"。',
  );
  const named = [...recent, main[0], first, firstMain].filter((o) => o !== undefined);
  return { text: lines.join("\n"), shown: [...new Set(named.map((o) => o.broadcast))] };
}

/** One recall result as the archive injects it and recall_streams returns it. */
export function renderRecallResult(result: RecallResult, chunkPrefix: string): string {
  const lines = [RENDER_HEADER];
  if (result.scope !== null) lines.push(`查询范围：${result.scope.label || "指定场次"}`);
  if (result.broadcasts.length > 0) {
    lines.push(overviewText(result, result.overview ? 10000 : 3000));
  }
  if (result.chunks.length > 0) lines.push(formatChunks(result.chunks, chunkPrefix));
  if (result.note) lines.push(result.note);
  return lines.join("\n");
}

export interface ArchiveCatalog extends RecallCatalog {
  recent(n?: number): Promise<Broadcast[]>;
  /** Whether stream_catalog.json exists, which alone is enough to offer recall_streams. */
  exists(): boolean;
  timeline(query: string): Promise<Timeline | null>;
}

export interface StreamArchiveOptions {
  readonly retriever: Retriever;
  readonly catalog: ArchiveCatalog;
  /** Defaults to config's personaTimeZone(). */
  readonly timeZone?: string;
  readonly today?: () => IsoDate;
}

/** The stream-archive RAG provider, which also owns the recall_streams tool. */
export class StreamArchive implements ContextProvider {
  /** Rejects when the archive can't be opened; runtime logs `Stream archive disabled: ${e}`. */
  static async open(options: { dbPath: string; timeZone?: string }): Promise<StreamArchive> {
    const retriever = await openStreamArchiveRetriever(options.dbPath);
    const archive = new StreamArchive({
      retriever,
      catalog: new StreamCatalog(options.dbPath),
      timeZone: options.timeZone,
    });
    if (retriever.hasTable) {
      const { candidates, topK, datePrefilter } = archive.params;
      logger.info(
        `StreamArchiveService initialized with ${await retriever.rowCount()} chunks ` +
          `(candidates=${candidates}, top_k=${topK}, date_prefilter=${pyRepr(datePrefilter)})`,
      );
    }
    return archive;
  }

  readonly params: StreamArchiveParams;
  readonly recall: StreamRecall;
  /** Whether the last enhanced turn recalled from the archive, or a recall_streams call has since. */
  lastWasArchive = false;
  readonly #retriever: Retriever;
  readonly #catalog: ArchiveCatalog;
  #turnKey: TurnKey | null = null;
  #turnId: string | undefined;
  #toolCalls = 0;
  #tool: LlmTool | null = null;

  constructor(options: StreamArchiveOptions) {
    this.params = streamArchiveParams();
    this.#retriever = options.retriever;
    this.#catalog = options.catalog;
    this.recall = new StreamRecall({
      retriever: options.retriever,
      catalog: options.catalog,
      timeZone: options.timeZone ?? personaTimeZone(),
      candidates: this.params.candidates,
      topK: this.params.topK,
      today: options.today,
    });
  }

  async onContext(turn: ContextTurn): Promise<void> {
    const { context, metadata, signal } = turn;
    signal.throwIfAborted();
    const query = buildQueryText(context.getMessages(), {
      maxUserTurns: this.params.maxUserTurns,
    });
    // The turn is consumed even when its query is too short to search.
    if (!this.#beginTurn(context) || !query) return;
    if (cpLen(pyStrip(query)) < this.params.minQueryChars) return;
    metadata[OVERVIEW_FRAME_KEY] = await this.enhance(context, query, decisionOf(metadata), signal);
  }

  errorMessage(error: unknown): string {
    return `StreamArchiveService error: ${errorText(error)}`;
  }

  /**
   * recall_streams, or null when it can't be offered (no table and no catalog). A non-null
   * result must be registered last; from then on the archive flips it per turn through
   * `ConversationContext.setHiddenTools`.
   */
  async recallTool(): Promise<LlmTool | null> {
    if (!this.#retriever.hasTable && !this.#catalog.exists()) return null;
    this.#tool ??= {
      schema: RECALL_STREAMS_SCHEMA,
      cancelOnInterruption: true,
      timeoutSecs: null,
      run: (call) => this.#runTool(call),
    };
    return this.#tool;
  }

  /** Returns whether the turn was a recap, which makes the facts provider skip it. */
  async enhance(
    context: ConversationContext,
    query: string,
    decision: GateDecision | null = null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { position } = this.params;
    const recent = await raceAbort(this.#catalog.recent(3), signal);
    signal?.throwIfAborted();
    setBlock(
      context,
      RECENT_PREFIX,
      recent.length > 0 ? formatBroadcasts(recent, 3600) : "",
      position,
    );

    // Routing reads the latest line; the search keeps `query`, which folds in short turns.
    const latest = latestUserText(context.getMessages()) ?? query;
    const elaboration = isStreamElaboration(latest);
    const scope = !elaboration || this.lastWasArchive ? this.recall.resolve(latest) : null;
    this.lastWasArchive = false;
    const overview = isStreamOverview(latest);
    const followup = isStreamFollowup(latest);
    const archiveQuery = isStreamQuery(latest) || overview || (followup && !elaboration);

    if (scope !== null && (archiveQuery || followup)) {
      const result = await this.recall.lookup(query, { scope, overview, signal });
      signal?.throwIfAborted();
      // 上次 reads as "the newest broadcast" to the routing, but as "the last time" in 上次玩X.
      if (scope.latest !== null && (await this.#answerTimeline(context, decision, signal))) {
        return false;
      }
      this.lastWasArchive = true;
      setBlock(context, RECALL_PREFIX, this.renderResult(result), position);
      logger.info(
        `Archive recall: overview=${pyRepr(result.overview)}, ` +
          `broadcasts=${result.broadcasts.length}, chunks=${result.chunks.length}, ` +
          `scope=${pyRepr(scope.label)}`,
      );
      return result.overview;
    }

    if (archiveQuery && this.#tool !== null && (overview || hasStreamTimeReference(latest))) {
      this.lastWasArchive = true;
      setBlock(context, RECALL_PREFIX, RECALL_HINT, position);
      return overview;
    }

    const { candidates, topK, datePrefilter } = this.params;
    const chunks = await unlessSkipped(
      decision,
      (search) =>
        this.#retriever.search(query, { candidates, topK, datePrefilter, signal: search }),
      signal,
    );
    signal?.throwIfAborted();
    if (await this.#answerTimeline(context, decision, signal)) return false;
    if (chunks.length > 0 && archiveQuery) {
      this.lastWasArchive = true;
      const parts = streamScope({
        streamIds: [...new Set(chunks.map((chunk) => pyStr(chunk.stream_id)))],
        label: CHUNK_SCOPE_LABEL,
      });
      const broadcasts = await raceAbort(this.recall.select(parts), signal);
      signal?.throwIfAborted();
      this.recall.remember(recallResult({ scope: parts, overview: false, broadcasts }));
    }
    setBlock(
      context,
      RECALL_PREFIX,
      chunks.length > 0 ? formatChunks(chunks, this.params.systemPrompt) : "",
      position,
    );
    return false;
  }

  renderResult(result: RecallResult): string {
    return renderRecallResult(result, this.params.systemPrompt);
  }

  /**
   * Replaces the turn's recall with the catalog's timeline when the gate has already said the
   * viewer asks when, or how often; it is read after the search, so it never waits on the gate.
   */
  async #answerTimeline(
    context: ConversationContext,
    decision: GateDecision | null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!decision?.asksTimeline) return false;
    // Each line alone, so earlier topics never mix in. Only a bare follow-up like 那上次玩是什么时候
    // borrows the line before's topic; a line that names something the catalog lacks must not.
    const [latest, before] = recentUserTexts(context.getMessages(), 2);
    let timeline: Timeline | null = null;
    for (const text of [latest, isBareFollowup(latest) ? before : undefined]) {
      if (text === undefined) continue;
      timeline = await raceAbort(this.#catalog.timeline(text), signal);
      signal?.throwIfAborted();
      if (timeline !== null) break;
    }
    if (timeline === null) return false;
    const { text, shown } = renderTimeline(timeline);
    this.lastWasArchive = true;
    this.recall.remember(
      recallResult({
        scope: streamScope({ streamIds: shown.map((b) => b.id), label: TIMELINE_SCOPE_LABEL }),
        overview: false,
        broadcasts: shown,
      }),
    );
    setBlock(context, RECALL_PREFIX, text, this.params.position);
    logger.info(
      `Archive timeline: terms=${pyRepr(timeline.terms)}, ` +
        `broadcasts=${timeline.occurrences.length}, newest=${shown[0]?.streamDate}`,
    );
    return true;
  }

  #beginTurn(context: ConversationContext): boolean {
    const key = turnKeyOf(context.getMessages());
    if (sameTurn(this.#turnKey, key) && this.#turnId === context.turn) return false;
    this.#turnKey = key;
    this.#turnId = context.turn;
    this.#toolCalls = 0;
    if (this.#tool !== null) context.setHiddenTools([]);
    return true;
  }

  async #runTool(call: ToolCall): Promise<RecallToolResult> {
    const { context, signal } = call;
    signal.throwIfAborted();
    this.#beginTurn(context);
    if (this.#toolCalls >= TOOL_BUDGET) return { error: TOOL_BUDGET_SPENT };
    // Spent before validation, so invalid calls count too. The handler stays registered; only
    // the advertised list drops the tool until the next user turn.
    this.#toolCalls += 1;
    if (this.#toolCalls === TOOL_BUDGET) context.setHiddenTools([RECALL_TOOL_NAME]);
    try {
      const request = parseRecallRequest(call.arguments);
      const scope = await this.#toolScope(request, signal);
      signal.throwIfAborted();
      const result = await this.recall.lookup(request.query, {
        scope,
        overview: request.mode === "overview",
        signal,
      });
      signal.throwIfAborted();
      this.lastWasArchive = true;
      return {
        content: this.renderResult(result),
        broadcast_ids: result.broadcasts.map((broadcast) => broadcast.id),
        chunk_ids: result.chunks.map((chunk) => chunk.id ?? null),
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const reason = errorText(error);
      logger.warning(`Archive recall tool unavailable: ${reason}`);
      return { error: TOOL_FAILED, reason };
    }
  }

  async #toolScope(request: RecallRequest, signal: AbortSignal): Promise<StreamScope> {
    const period = request.period;
    switch (period) {
      case "latest":
      case "previous":
        return streamScope({ latest: period === "latest" ? 1 : 2, label: period });
      case "selected":
        if (this.recall.selectedScope === null) {
          throw new Error("还没有已选定的场次，请给出日期范围或使用 latest");
        }
        return this.recall.selectedScope;
      case "broadcasts": {
        if (request.broadcastIds.length === 0) throw new Error("broadcasts 需要已知场次 ID");
        const broadcasts = await raceAbort(this.recall.catalog.broadcasts(), signal);
        const known = new Set(broadcasts.map((broadcast) => broadcast.id));
        if (!request.broadcastIds.every((id) => known.has(id))) {
          throw new Error("场次 ID 不在归档中，请使用日期范围查找");
        }
        return streamScope({ streamIds: request.broadcastIds, label: "选定的归档直播" });
      }
      case "date_range": {
        const start = request.startDate;
        if (start === null) throw new Error("date_range 需要 start_date");
        const end = request.endDate ?? addDays(start, 1);
        if (end <= start) throw new Error("end_date 必须晚于 start_date，且不包含该日");
        return streamScope({
          startDate: start,
          endDate: end,
          label: `${start} 至 ${end}（不含结束日）`,
        });
      }
      case "all":
        return streamScope({ label: "全部已归档直播" });
      default: {
        const query =
          period === "past_days" ? `past ${request.days} days` : period.replaceAll("_", " ");
        const scope = this.recall.resolve(query);
        if (scope === null) throw new Error("无法确定查询时间段");
        return scope;
      }
    }
  }
}
