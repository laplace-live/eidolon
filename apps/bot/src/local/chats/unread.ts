// Per-chat read watermarks stored beside chat folders in <root>/read.json (mode 0600), so
// opening a chat marks her items read without writing to chat.jsonl or bumping updatedAt.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceJsonFile } from "@eidolon/assistant";
import { type ChatEvent, type ChatSummary, isChatId } from "@eidolon/chat";
import { errorText, isPlainObject } from "@eidolon/config";

const FILE = "read.json";

interface UnreadCache {
  readonly throughSeq: number;
  readonly seqs: readonly number[];
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

function isNonCallUserMessage(event: ChatEvent): boolean {
  return event.type === "message" && event.speaker.kind === "user" && event.modality !== "call";
}

/** Whether `event` adds an item of hers that counts toward a chat's unread badge. */
export function isUnreadEvent(event: ChatEvent): boolean {
  if (event.type === "message") {
    return (
      event.speaker.kind === "persona" &&
      event.modality !== "call" &&
      (event.text !== "" ||
        (event.attachments !== undefined && event.attachments.length > 0) ||
        event.cutOff !== undefined)
    );
  }
  if (event.type === "tool-call") return event.said !== undefined && event.said !== "";
  // voice-failed follows her text message immediately, so counting it would count that reply twice.
  if (event.type === "turn-failed") return event.code !== "voice-failed";
  return false;
}

/**
 * Tracks each chat's highest read seq in `<root>/read.json` and caches unread event seqs in memory
 * so `GET /api/local/chats` avoids re-reading logs when nothing new landed.
 */
export class ChatReadStore {
  readonly #root: string;
  readonly #path: string;
  readonly #log: (message: string) => void;
  #readSeq: Map<string, number> | null = null;
  #loading: Promise<Map<string, number>> | null = null;
  readonly #unreads = new Map<string, UnreadCache>();
  #queue: Promise<void> = Promise.resolve();

  constructor(root: string, log: (message: string) => void) {
    this.#root = root;
    this.#path = join(root, FILE);
    this.#log = log;
  }

  /** Marks a newly created chat at seq 0 with no unread items yet. */
  created(id: string): Promise<void> {
    return this.#serial((readSeq) => {
      readSeq.set(id, 0);
      this.#unreads.set(id, { throughSeq: 0, seqs: [] });
      return true;
    });
  }

  /**
   * Seeds `prevLastSeq` for a chat created before `read.json` tracked it, so pre-existing history
   * stays read while the events about to be appended can become unread.
   */
  beforeAppend(id: string, prevLastSeq: number): Promise<void> {
    return this.#serial((readSeq) => {
      if (readSeq.has(id)) return false;
      readSeq.set(id, prevLastSeq);
      this.#unreads.set(id, { throughSeq: prevLastSeq, seqs: [] });
      return true;
    });
  }

  /** Advances read state for the viewer's own non-call lines and updates any cached unread seqs. */
  appended(id: string, events: readonly ChatEvent[]): Promise<void> {
    if (events.length === 0) return Promise.resolve();
    return this.#serial((readSeq) => {
      let dirty = false;
      let userSeq = 0;
      for (const event of events) {
        if (isNonCallUserMessage(event)) userSeq = Math.max(userSeq, event.seq);
      }
      const prevSeen = readSeq.get(id) ?? 0;
      const seen = Math.max(prevSeen, userSeq);
      if (seen > prevSeen) {
        readSeq.set(id, seen);
        dirty = true;
      }

      const cached = this.#unreads.get(id);
      if (cached !== undefined) {
        const firstSeq = (events[0] as ChatEvent).seq;
        const lastSeq = (events.at(-1) as ChatEvent).seq;
        if (cached.throughSeq === firstSeq - 1) {
          const kept = cached.seqs.filter((seq) => seq > seen);
          const added = events
            .filter((event) => event.seq > seen && isUnreadEvent(event))
            .map((event) => event.seq);
          this.#unreads.set(id, { throughSeq: lastSeq, seqs: [...kept, ...added] });
        } else {
          this.#unreads.delete(id);
        }
      }
      return dirty;
    });
  }

  /** Marks events up to `seq` (clamped to `lastSeq`) as read. */
  markRead(id: string, seq: number, lastSeq: number): Promise<void> {
    return this.#serial((readSeq) => {
      const target = Math.min(seq, lastSeq);
      const current = readSeq.get(id) ?? lastSeq;
      if (target <= current) return false;
      readSeq.set(id, target);
      const cached = this.#unreads.get(id);
      if (cached !== undefined) {
        this.#unreads.set(id, {
          throughSeq: cached.throughSeq,
          seqs: cached.seqs.filter((entry) => entry > target),
        });
      }
      return true;
    });
  }

  /** Drops any watermark held for deleted chat `id`. */
  remove(id: string): Promise<void> {
    return this.#serial((readSeq) => {
      this.#unreads.delete(id);
      return readSeq.delete(id);
    });
  }

  /** Counts unread persona items in `summary` after its watermark, reading the log only on miss. */
  async count(
    summary: ChatSummary,
    readAfter: (id: string, afterSeq: number) => Promise<readonly ChatEvent[]>,
  ): Promise<number> {
    await this.#queue;
    const readSeq = await this.#ensureLoaded();
    const seen = readSeq.get(summary.id) ?? summary.lastSeq;
    if (seen >= summary.lastSeq) return 0;

    const cached = this.#unreads.get(summary.id);
    if (cached !== undefined && cached.throughSeq === summary.lastSeq) {
      return cached.seqs.filter((seq) => seq > seen).length;
    }

    const events = await readAfter(summary.id, seen);
    const seqs = events
      .filter((event) => event.seq <= summary.lastSeq && isUnreadEvent(event))
      .map((event) => event.seq);
    const current = readSeq.get(summary.id) ?? summary.lastSeq;
    if (current === seen) {
      const latest = this.#unreads.get(summary.id);
      if (latest === undefined || latest.throughSeq < summary.lastSeq) {
        this.#unreads.set(summary.id, { throughSeq: summary.lastSeq, seqs });
      }
      return seqs.length;
    }
    return seqs.filter((seq) => seq > current).length;
  }

  /** Waits for any queued write to finish. */
  async flush(): Promise<void> {
    await this.#queue;
  }

  async #ensureLoaded(): Promise<Map<string, number>> {
    if (this.#readSeq !== null) return this.#readSeq;
    this.#loading ??= this.#load();
    return this.#loading;
  }

  async #load(): Promise<Map<string, number>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#path, "utf8"));
    } catch (error) {
      if (!isNotFound(error)) {
        this.#log(`Chat read watermarks ignored: ${errorText(error)}`);
      }
      this.#readSeq = new Map();
      return this.#readSeq;
    }
    const map = new Map<string, number>();
    if (isPlainObject(parsed)) {
      for (const [id, seq] of Object.entries(parsed)) {
        if (isChatId(id) && typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) {
          map.set(id, seq);
        }
      }
    } else {
      this.#log("Chat read watermarks ignored: read.json is not an object");
    }
    this.#readSeq = map;
    return map;
  }

  #serial(task: (readSeq: Map<string, number>) => Promise<boolean> | boolean): Promise<void> {
    const next = this.#queue.then(async () => {
      const readSeq = await this.#ensureLoaded();
      if (await task(readSeq)) await this.#write(readSeq);
    });
    this.#queue = next.catch(() => {});
    return next;
  }

  async #write(readSeq: ReadonlyMap<string, number>): Promise<void> {
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      await replaceJsonFile(this.#path, Object.fromEntries(readSeq));
    } catch (error) {
      this.#log(`Chat ${FILE} not written: ${errorText(error)}`);
    }
  }
}
