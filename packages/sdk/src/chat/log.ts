import { isChatEvent } from "./parse.ts";
import {
  type Attachment,
  CHAT_FORMAT,
  CHAT_WINDOW_BYTES,
  CHAT_WINDOW_EVENTS,
  type ChatEvent,
  type ChatEventDraft,
  type ChatEventOf,
  type ChatHeader,
  type ChatSummary,
  type ChatWindow,
  DEFAULT_CHAIN_LIMIT,
  type ParticipantId,
  type ReplyMode,
  type WireEvent,
} from "./types.ts";
import { uuidv7 } from "./uuid.ts";

/** A new chat's header, with a fresh UUIDv7 id. */
export function newChatHeader(
  participants: readonly ParticipantId[],
  now: number = Date.now(),
): ChatHeader {
  return { format: CHAT_FORMAT, id: uuidv7(now), createdAt: now, participants: [...participants] };
}

/** Numbers `drafts` on from `lastSeq` and times them all `at`. */
export function stampEvents(
  drafts: readonly ChatEventDraft[],
  lastSeq: number,
  at: number,
): ChatEvent[] {
  return drafts.map((draft, i) => ({ ...draft, seq: lastSeq + 1 + i, at }) as ChatEvent);
}

/** `summary` with `events`, the ones after its `lastSeq`, applied; its other fields kept. */
export function advanceSummary<T extends ChatSummary>(summary: T, events: readonly WireEvent[]): T {
  let { title, participants, updatedAt, lastText, lastSeq, openCall } = summary;
  for (const event of events) {
    lastSeq = event.seq;
    updatedAt = Math.max(updatedAt, event.at);
    if (!isChatEvent(event)) continue;
    if (event.type === "message" && event.text !== "") lastText = event.text;
    else if (event.type === "title") title = event.title;
    else if (event.type === "participants") {
      const removed = new Set(event.removed ?? []);
      participants = [
        ...new Set([...participants.filter((id) => !removed.has(id)), ...(event.added ?? [])]),
      ];
    } else if (event.type === "call-started") openCall = event.call;
    else if (event.type === "call-ended") openCall = null;
  }
  return { ...summary, title, participants, updatedAt, lastText, lastSeq, openCall };
}

/** What the chat list shows for a log. */
export function summarize(header: ChatHeader, events: readonly WireEvent[]): ChatSummary {
  const empty: ChatSummary = {
    id: header.id,
    title: null,
    participants: header.participants,
    createdAt: header.createdAt,
    updatedAt: header.createdAt,
    lastText: null,
    lastSeq: 0,
    openCall: null,
  };
  return advanceSummary(empty, events);
}

function isSettingsEvent(event: WireEvent): event is ChatEventOf<"settings"> {
  return event.type === "settings" && isChatEvent(event);
}

/** The chat's chain limit: the last `settings` event's, else `DEFAULT_CHAIN_LIMIT`. */
export function chainLimitOf(events: readonly WireEvent[]): number {
  return (
    events.findLast(
      (event): event is ChatEventOf<"settings"> =>
        isSettingsEvent(event) && event.chainLimit !== undefined,
    )?.chainLimit ?? DEFAULT_CHAIN_LIMIT
  );
}

/** The chat's own reply mode: the last `settings` event's, else null. */
export function replyModeOf(events: readonly WireEvent[]): ReplyMode | null {
  return (
    events.findLast(
      (event): event is ChatEventOf<"settings"> =>
        isSettingsEvent(event) && event.replyMode !== undefined,
    )?.replyMode ?? null
  );
}

function isMessageEvent(event: WireEvent): event is ChatEventOf<"message"> {
  return event.type === "message" && isChatEvent(event);
}

/** Her messages' attachments in `events`, which the browser fetches before they expire. */
export function herAttachments(events: readonly WireEvent[]): Attachment[] {
  return events.flatMap((event) =>
    isMessageEvent(event) && event.speaker.kind === "persona" ? (event.attachments ?? []) : [],
  );
}

const encoder = new TextEncoder();

/** The size an event counts for in a window: its JSON in UTF-8. */
export function windowBytesOf(event: WireEvent): number {
  return encoder.encode(JSON.stringify(event)).length;
}

/** Never sent back: her recall stays on the server, and any that comes back is dropped. */
export const NEVER_SENT: ReadonlySet<string> = new Set(["context", "context-removed"]);

/** Who is in the chat, its title and its settings: the server reads every one, however old. */
export const STATE_EVENT_TYPES = ["participants", "title", "settings"] as const;

const STATE_EVENTS: ReadonlySet<string> = new Set(STATE_EVENT_TYPES);

/**
 * The window a turn sends, from the log oldest first: the newest 120 events that fit in 256 KB of
 * JSON, as the server cuts it, after every state event older than them. Events are sent as stored.
 */
export function buildWindow(header: ChatHeader, events: readonly WireEvent[]): ChatWindow {
  const newest: WireEvent[] = [];
  let bytes = 0;
  let cut = events.length;
  for (let i = events.length - 1; i >= 0 && newest.length < CHAT_WINDOW_EVENTS; i--) {
    const event = events[i];
    if (event === undefined || NEVER_SENT.has(event.type)) continue;
    const size = windowBytesOf(event);
    if (bytes + size > CHAT_WINDOW_BYTES) break;
    bytes += size;
    newest.push(event);
    cut = i;
  }
  const state = events.slice(0, cut).filter((event) => STATE_EVENTS.has(event.type));
  return { header, events: [...state, ...newest.reverse()] };
}
