import { consoleSink, type LogRecord, logger } from "@eidolon/config";
import type { ContextTurn, ConversationContext, FrameMetadata } from "@eidolon/core";
import type {
  Broadcast,
  IsoDate,
  Retriever,
  SearchOptions,
  SearchRow,
  StreamScope,
} from "@eidolon/retrieval";
import type { ArchiveCatalog } from "../src/index.ts";

export const TODAY: IsoDate = "2026-09-09";

/** A plain StreamScope with Python's defaults, for fixtures. */
export function scope(init: Partial<StreamScope> = {}): StreamScope {
  return { startDate: null, endDate: null, latest: null, streamIds: [], label: "", ...init };
}

export function broadcast(day: string, bv = "BV1abc", parts = 1): Broadcast {
  const id = `${day}-${bv}`;
  const streamIds = Array.from({ length: parts }, (_, i) => `${id}_p${i + 1}`);
  return {
    id,
    streamDate: day,
    streamIds,
    overview: `${day} 聊了 ASMR、游戏和观众 SC。`,
    sourceChunkIds: streamIds.map((part) => `${part}::000`),
    scenes: [],
    sourcePaths: [],
    unrefinedCount: 0,
    overviewCompressed: false,
  };
}

/** Python's StreamCatalog over an in-memory list: sorted (stream_date, id) descending. */
export class MemoryCatalog implements ArchiveCatalog {
  readonly path = "/nonexistent/stream_catalog.json";
  readonly items: Broadcast[];
  present: boolean;

  constructor(broadcasts: readonly Broadcast[], present = true) {
    this.items = [...broadcasts].sort((a, b) =>
      a.streamDate === b.streamDate ? compare(b.id, a.id) : compare(b.streamDate, a.streamDate),
    );
    this.present = present;
  }

  async broadcasts(): Promise<Broadcast[]> {
    return [...this.items];
  }

  async select(
    options: {
      startDate?: IsoDate | null;
      endDate?: IsoDate | null;
      streamIds?: readonly string[] | null;
    } = {},
  ): Promise<Broadcast[]> {
    const start = options.startDate ?? null;
    const end = options.endDate ?? null;
    const ids = options.streamIds == null ? null : new Set(options.streamIds);
    return (await this.broadcasts()).filter(
      (item) =>
        (start === null || item.streamDate >= start) &&
        (end === null || (item.streamDate !== "" && item.streamDate < end)) &&
        (ids === null || ids.has(item.id) || item.streamIds.some((part) => ids.has(part))),
    );
  }

  async recent(n = 3): Promise<Broadcast[]> {
    return (await this.broadcasts()).slice(0, Math.max(0, n));
  }

  exists(): boolean {
    return this.present;
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const RECALL_HIT: SearchRow = {
  id: "hit-1",
  summary: "聊了 ASMR。",
  stream_date: "2026-09-08",
};

/** Records each search as `{query, ...options}` without the signal, as Python's kwargs. */
export class FakeRetriever implements Retriever {
  hasTable = true;
  readonly calls: Record<string, unknown>[] = [];
  hits: SearchRow[];
  search: (query: string, options: SearchOptions) => Promise<SearchRow[]>;

  constructor(hits: SearchRow[] = [RECALL_HIT]) {
    this.hits = hits;
    this.search = async (query, options) => {
      const { signal: _signal, ...rest } = options;
      this.calls.push({ query, ...rest });
      return this.hits;
    };
  }

  async rowCount(): Promise<number> {
    return this.hits.length;
  }
}

/** A ConversationContext over a plain list; `setMessages` refills in place, as pipedog does. */
export class FakeContext implements ConversationContext {
  readonly messages: unknown[];
  hidden: readonly string[] = [];
  readonly hiddenCalls: (readonly string[])[] = [];

  constructor(messages: unknown[] = []) {
    this.messages = messages;
  }

  getMessages(): unknown[] {
    return this.messages;
  }

  setMessages(messages: unknown[]): void {
    const copy = [...messages];
    this.messages.length = 0;
    this.messages.push(...copy);
  }

  setHiddenTools(names: readonly string[]): void {
    this.hidden = [...names];
    this.hiddenCalls.push([...names]);
  }

  add(message: Record<string, unknown>): void {
    this.messages.push(message);
  }

  /** The advertised tool names, given the full registered list. */
  advertised(all: readonly string[]): string[] {
    return all.filter((name) => !this.hidden.includes(name));
  }

  /** String content of each message, as Python's `str(message.get("content", ""))`. */
  contents(): string[] {
    return this.messages.map((message) =>
      String((message as Record<string, unknown>).content ?? ""),
    );
  }
}

export function turnOf(
  context: ConversationContext,
  metadata: FrameMetadata = {},
  signal: AbortSignal = new AbortController().signal,
): ContextTurn {
  return {
    context,
    metadata,
    signal,
    spawn: () => {
      throw new Error("context providers spawn nothing");
    },
  };
}

export async function ticks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Routes every log record into `records` until `restore()`. */
export function captureLogs(): { records: LogRecord[]; restore: () => void } {
  const records: LogRecord[] = [];
  logger.setSink((record) => records.push(record));
  return { records, restore: () => logger.setSink(consoleSink) };
}

const originals = new Map<string, string | undefined>();

export function setEnv(name: string, value: string | undefined): void {
  if (!originals.has(name)) originals.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export function resetEnv(): void {
  for (const [name, value] of originals) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originals.clear();
}
