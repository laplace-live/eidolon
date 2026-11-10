// A production chat request's window: the newest events the browser sent that fit, with the
// server's own verified and the viewer's own rebuilt, kept in memory for that request alone.
// Production keeps no transcript: the browser stores what the turn adds.
import {
  CHAT_FORMAT,
  type ChatEvent,
  type ChatEventDraft,
  type ChatHeader,
  type ChatStore,
  ChatStoreError,
  type ChatSummary,
  isChatId,
  isReplyMode,
  MAX_CHAIN_LIMIT,
  MAX_PARTICIPANTS,
  stampEvents,
  summarize,
} from "@eidolon/chat";
import { isJsonObject, logger } from "@eidolon/config";
import { type ChatSigner, fromViewer } from "./sig.ts";

/** The most events a request's window holds, newest kept. */
export const CHAT_WINDOW_EVENTS = 120;
/** The most a request's window holds, as each event's JSON in UTF-8, newest kept. */
export const CHAT_WINDOW_BYTES = 256 * 1024;
/** A browser's `settings` may ask for more hops; each costs mind turns, so the server caps them. */
export const PUBLIC_CHAIN_LIMIT = 3;

/** The newest of `events` that fit the window, oldest first. */
export function newestThatFit(events: readonly unknown[]): unknown[] {
  let bytes = 0;
  let start = events.length;
  while (start > 0 && events.length - start < CHAT_WINDOW_EVENTS) {
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(events[start - 1]) ?? "");
    } catch {
      // JSON.stringify overflows the stack on nesting JSON.parse accepted.
      break;
    }
    if (bytes + size > CHAT_WINDOW_BYTES) break;
    bytes += size;
    start--;
  }
  return events.slice(start);
}

function headerOf(raw: unknown): ChatHeader | null {
  if (!isJsonObject(raw)) return null;
  const { format, id, createdAt, participants } = raw;
  if (format !== CHAT_FORMAT || typeof id !== "string" || !isChatId(id)) return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (!isIdList(participants) || participants.length === 0) return null;
  if (participants.length > MAX_PARTICIPANTS) return null;
  return { format: CHAT_FORMAT, id, createdAt, participants };
}

function isIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((id) => typeof id === "string" && id !== "") &&
    new Set(value).size === value.length
  );
}

function seqOf(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : null;
}

/**
 * One of the viewer's own events, rebuilt from the fields the server reads, or null when it isn't
 * well formed. Attachments are left behind: no turn reads the viewer's, and the browser keeps them.
 */
function viewersEvent(raw: Record<string, unknown>, seq: number, at: number): ChatEvent | null {
  switch (raw.type) {
    case "message": {
      const { id, text, modality } = raw;
      if (typeof id !== "string" || typeof text !== "string") return null;
      if (
        modality !== undefined &&
        modality !== "text" &&
        modality !== "voice" &&
        modality !== "call"
      ) {
        return null;
      }
      return {
        seq,
        at,
        type: "message",
        id,
        speaker: { kind: "user" },
        text,
        ...(modality === undefined ? {} : { modality }),
      };
    }
    case "title":
      return typeof raw.title === "string" ? { seq, at, type: "title", title: raw.title } : null;
    case "participants": {
      const { added, removed } = raw;
      if (added !== undefined && !isIdList(added)) return null;
      if (removed !== undefined && !isIdList(removed)) return null;
      return {
        seq,
        at,
        type: "participants",
        ...(added === undefined ? {} : { added }),
        ...(removed === undefined ? {} : { removed }),
      };
    }
    case "settings": {
      const { replyMode, chainLimit } = raw;
      if (replyMode !== undefined && !isReplyMode(replyMode)) return null;
      if (
        chainLimit !== undefined &&
        !(
          Number.isInteger(chainLimit) &&
          (chainLimit as number) >= 0 &&
          (chainLimit as number) <= MAX_CHAIN_LIMIT
        )
      ) {
        return null;
      }
      return {
        seq,
        at,
        type: "settings",
        ...(replyMode === undefined ? {} : { replyMode }),
        ...(chainLimit === undefined
          ? {}
          : { chainLimit: Math.min(chainLimit as number, PUBLIC_CHAIN_LIMIT) }),
      };
    }
    case "call-started": {
      const { call, persona } = raw;
      if (typeof call !== "string" || typeof persona !== "string" || persona === "") return null;
      return { seq, at, type: "call-started", call, persona };
    }
    case "call-ended": {
      const { call, reason } = raw;
      if (typeof call !== "string" || typeof reason !== "string") return null;
      return { seq, at, type: "call-ended", call, reason };
    }
  }
  return null;
}

type Dropped = "unsigned" | "context" | "malformed" | "unordered";

async function verified(signer: ChatSigner, chatId: string, event: ChatEvent): Promise<boolean> {
  try {
    return await signer.verify(chatId, event);
  } catch {
    // canonicalForSig recurses, and overflows on nesting JSON.parse accepted.
    return false;
  }
}

export type OpenedChat =
  | { readonly ok: true; readonly store: RequestChatStore }
  | { readonly ok: false; readonly message: string };

/**
 * The request's chat, `{ header, events }` as the browser sent it, cut to the newest events that
 * fit. Each event the server signed is kept only while its `sig` verifies in this chat, and the
 * viewer's own only while well formed; context blocks never come back, and are dropped too. What is
 * dropped is counted in one log line, never answered: a tampered history just loses those lines.
 * Seqs carry on from the newest event sent, dropped or not, so the browser's log stays contiguous.
 */
export async function openChatWindow(
  chat: unknown,
  signer: ChatSigner,
  now: () => number = Date.now,
): Promise<OpenedChat> {
  if (!isJsonObject(chat)) return { ok: false, message: "chat must be { header, events }" };
  const header = headerOf(chat.header);
  if (header === null) return { ok: false, message: "chat.header is not a chat's header" };
  if (!Array.isArray(chat.events)) return { ok: false, message: "chat.events must be a list" };
  const window = newestThatFit(chat.events);
  const kept: ChatEvent[] = [];
  const dropped = new Map<Dropped, number>();
  const drop = (why: Dropped) => dropped.set(why, (dropped.get(why) ?? 0) + 1);
  let lastSeq = 0;
  for (const raw of window) {
    const seq = isJsonObject(raw) ? seqOf(raw.seq) : null;
    if (seq !== null) lastSeq = Math.max(lastSeq, seq);
    if (!isJsonObject(raw) || seq === null || typeof raw.type !== "string") {
      drop("malformed");
      continue;
    }
    const at = raw.at;
    if (typeof at !== "number" || !Number.isFinite(at)) {
      drop("malformed");
      continue;
    }
    if (raw.type === "context" || raw.type === "context-removed") {
      drop("context");
      continue;
    }
    let event: ChatEvent;
    if (fromViewer(raw)) {
      const rebuilt = viewersEvent(raw, seq, at);
      if (rebuilt === null) {
        drop("malformed");
        continue;
      }
      event = rebuilt;
    } else if (await verified(signer, header.id, raw as unknown as ChatEvent)) {
      event = raw as unknown as ChatEvent;
    } else {
      drop("unsigned");
      continue;
    }
    if (seq <= (kept.at(-1)?.seq ?? 0)) {
      drop("unordered");
      continue;
    }
    kept.push(event);
  }
  const cut = chat.events.length - window.length;
  if (dropped.size > 0 || cut > 0) {
    const counts = [
      ...(cut > 0 ? [`${cut} past the window`] : []),
      ...[...dropped].map(([why, n]) => `${n} ${why}`),
    ];
    const level = dropped.has("unsigned") || dropped.has("malformed") ? "WARNING" : "INFO";
    logger.log(
      level,
      `[chat] Chat ${header.id}: kept ${kept.length} of the request's ${chat.events.length} ` +
        `events (dropped ${counts.join(", ")})`,
    );
  }
  return { ok: true, store: new RequestChatStore(header, kept, lastSeq, signer, now) };
}

/**
 * The ChatStore of one request: its chat alone, from the window, in memory. `add` is how a turn's
 * output gets in: numbered on from the window's newest seq, timed, and signed.
 */
export class RequestChatStore implements ChatStore {
  readonly header: ChatHeader;
  readonly #signer: ChatSigner;
  readonly #now: () => number;
  readonly #events: ChatEvent[];
  #lastSeq: number;
  #removed = false;
  #adding: Promise<unknown> = Promise.resolve();

  constructor(
    header: ChatHeader,
    events: readonly ChatEvent[],
    lastSeq: number,
    signer: ChatSigner,
    now: () => number = Date.now,
  ) {
    this.header = header;
    this.#events = [...events];
    this.#lastSeq = Math.max(lastSeq, events.at(-1)?.seq ?? 0);
    this.#signer = signer;
    this.#now = now;
  }

  /** The seq the next event follows: the newest the browser sent, kept or not, or added since. */
  get lastSeq(): number {
    return this.#lastSeq;
  }

  async list(): Promise<ChatSummary[]> {
    return this.#removed
      ? []
      : [{ ...summarize(this.header, this.#events), lastSeq: this.#lastSeq }];
  }

  async create(header: ChatHeader): Promise<void> {
    if (header.id === this.header.id && !this.#removed) {
      throw new ChatStoreError("exists", `chat ${header.id} exists`);
    }
    throw new ChatStoreError("invalid", "a request's store holds only the chat it was opened on");
  }

  async read(
    id: string,
    options: { readonly afterSeq?: number } = {},
  ): Promise<{ header: ChatHeader; events: ChatEvent[] }> {
    this.#check(id);
    const after = options.afterSeq ?? 0;
    return { header: this.header, events: this.#events.filter((event) => event.seq > after) };
  }

  async append(id: string, events: readonly ChatEvent[]): Promise<void> {
    this.#check(id);
    if (events.some((event, i) => event.seq !== this.#lastSeq + 1 + i)) {
      throw new ChatStoreError(
        "seq-gap",
        `chat ${id}: the batch doesn't follow seq ${this.#lastSeq}`,
      );
    }
    this.#events.push(...events);
    this.#lastSeq += events.length;
  }

  async remove(id: string): Promise<void> {
    this.#check(id);
    this.#removed = true;
    this.#events.length = 0;
  }

  /**
   * Numbers `drafts` on from `lastSeq`, times them now, signs all but the viewer's own, and keeps
   * them; resolves to the events to send the browser, in order. Context blocks are dropped first:
   * they never leave the server, so a later turn of the request doesn't see them either.
   */
  add(drafts: readonly ChatEventDraft[]): Promise<ChatEvent[]> {
    const added = this.#adding.then(async () => {
      const kept = drafts.filter(
        (draft) => draft.type !== "context" && draft.type !== "context-removed",
      );
      const stamped = stampEvents(kept, this.#lastSeq, this.#now());
      const signed = await Promise.all(
        stamped.map((event) =>
          fromViewer(event) ? event : this.#signer.sign(this.header.id, event),
        ),
      );
      await this.append(this.header.id, signed);
      return signed;
    });
    this.#adding = added.catch(() => {});
    return added;
  }

  #check(id: string): void {
    if (id !== this.header.id || this.#removed) {
      throw new ChatStoreError("not-found", `chat ${id} is not this request's`);
    }
  }
}
