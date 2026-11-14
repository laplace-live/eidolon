// Eidolon's stateless /api/chat/* log and stream types: the browser stores every chat, and the
// server signs what it adds.

/** The log format this client reads and writes. */
export const CHAT_FORMAT = 1;

/** The most personas a chat holds. */
export const MAX_PARTICIPANTS = 6;

/** Persona-to-persona hops after each viewer line until a `settings` event sets them; 0 is none. */
export const DEFAULT_CHAIN_LIMIT = 3;

export const MAX_CHAIN_LIMIT = 6;

/** The most hops the stateless /api/chat/* endpoint honors per viewer line. */
export const PUBLIC_CHAIN_LIMIT = 3;

/** The most events a turn's window carries, newest kept, besides the older state events. */
export const CHAT_WINDOW_EVENTS = 120;

/** The most those newest events weigh, summed over each event's JSON in UTF-8 bytes. */
export const CHAT_WINDOW_BYTES = 256 * 1024;

/** The most message events the server reads from a window when rebuilding a persona's view. */
export const CHAT_WINDOW_MESSAGES = 60;

/** The longest line the viewer can send, in code points once trimmed. */
export const MAX_TEXT_LENGTH = 4000;

/** The longest voice message the viewer can send. */
export const MAX_VOICE_MS = 120_000;

/** The largest voice message the viewer can send. */
export const MAX_VOICE_BYTES = 10 * 1024 * 1024;

/** How personas answer: `auto` lets the director choose voice where a line suits it. */
export const REPLY_MODES = ["auto", "text", "voice"] as const;

export type ReplyMode = (typeof REPLY_MODES)[number];

export function isReplyMode(value: unknown): value is ReplyMode {
  return REPLY_MODES.some((mode) => mode === value);
}

/** A persona id. */
export type ParticipantId = string;

export type Speaker =
  | { readonly kind: "user" }
  | { readonly kind: "persona"; readonly id: ParticipantId };

/** A log's first line, never rewritten. */
export interface ChatHeader {
  readonly format: typeof CHAT_FORMAT;
  /** A lowercase UUIDv7, so ids sort by time. */
  readonly id: string;
  /** ms since the epoch. */
  readonly createdAt: number;
  /** At creation; later changes are `participants` events. */
  readonly participants: readonly ParticipantId[];
}

/** A file named by its content's hash, `<sha256>.<ext>`, kept beside the events. */
export type Attachment =
  | { readonly kind: "image"; readonly name: string; readonly mime: string }
  | {
      readonly kind: "audio";
      readonly name: string;
      readonly mime: string;
      /** Absent when nothing measured it. */
      readonly durationMs?: number;
    };

export type CutOff = "length" | "refusal";

export type ToolState = "running" | "done" | "failed";

type EventBase = {
  /** 1, 2, 3…, numbered by whoever wrote the event. */
  readonly seq: number;
  /** ms since the epoch. */
  readonly at: number;
  /** The server's HMAC on everything it adds except the viewer's own events. */
  readonly sig?: string;
};

export type ChatMessageEvent = EventBase & {
  readonly type: "message";
  readonly id: string;
  readonly speaker: Speaker;
  /** A voice message's or a call line's transcript; empty on a message of photos alone. */
  readonly text: string;
  /** Absent means text. */
  readonly modality?: "text" | "voice" | "call";
  /** A voice message's audio first, then any photos. */
  readonly attachments?: readonly Attachment[];
  readonly interrupted?: boolean;
  readonly cutOff?: CutOff;
};

export type ChatEvent =
  | ChatMessageEvent
  | (EventBase & {
      /** Recall she was given; the server never sends it, and it is never sent back. */
      readonly type: "context";
      readonly persona: ParticipantId;
      readonly turn: string;
      readonly position: number;
      readonly role: "system" | "user" | "developer";
      readonly content: string;
    })
  | (EventBase & {
      readonly type: "context-removed";
      readonly persona: ParticipantId;
      readonly turn: string;
      readonly seqs: readonly number[];
    })
  | (EventBase & {
      readonly type: "tool-call";
      readonly persona: ParticipantId;
      readonly turn: string;
      readonly callId: string;
      readonly name: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    })
  | (EventBase & {
      readonly type: "tool-result";
      readonly persona: ParticipantId;
      readonly turn: string;
      readonly callId: string;
      readonly result: Readonly<Record<string, unknown>>;
      readonly stage?: "started" | "final" | "cancelled";
    })
  | (EventBase & {
      /** The hidden greeting prompt. */
      readonly type: "kickoff";
      readonly persona: ParticipantId;
      readonly turn: string;
      readonly content: string;
    })
  | (EventBase & {
      readonly type: "participants";
      readonly added?: readonly ParticipantId[];
      readonly removed?: readonly ParticipantId[];
    })
  | (EventBase & { readonly type: "title"; readonly title: string })
  | (EventBase & {
      readonly type: "turn-failed";
      readonly persona: ParticipantId;
      readonly turn: string;
      /** A fixed English sentence; show your own words. */
      readonly error: string;
      /** `voice-failed`: her reply, stored just before, was meant as a voice message but stayed text. */
      readonly code?: string;
    })
  | (EventBase & {
      /** Who answers the line at seq `after`, and how. */
      readonly type: "decision";
      readonly after: number;
      readonly replies: readonly {
        readonly persona: ParticipantId;
        readonly mode: "text" | "voice";
      }[];
      readonly source: "single" | "mention" | "model" | "fallback";
      readonly scores?: Readonly<Record<string, number>>;
    })
  | (EventBase & {
      readonly type: "settings";
      readonly replyMode?: ReplyMode;
      /** 0 to 6; the stateless server reads at most 3. */
      readonly chainLimit?: number;
    })
  | (EventBase & {
      readonly type: "call-started";
      readonly call: string;
      readonly persona: ParticipantId;
      readonly group?: true;
    })
  | (EventBase & {
      readonly type: "call-ended";
      readonly call: string;
      /** `hangup` or `error` from this browser; other writers may add their own. */
      readonly reason: string;
    });

export type ChatEventOf<K extends ChatEvent["type"]> = Extract<ChatEvent, { readonly type: K }>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before its store's caller numbers and times it. */
export type ChatEventDraft = DistributiveOmit<ChatEvent, "seq" | "at">;

/**
 * An event as the log keeps it, of a type this client may not know yet. Stored and sent back
 * exactly as received: a signed event changed in any way fails its signature.
 */
export type WireEvent = {
  readonly seq: number;
  readonly at: number;
  readonly type: string;
  readonly sig?: string;
  readonly [field: string]: unknown;
};

/** Why the browser ended a call. */
export type CallEndReason = "hangup" | "error";

/** The events the browser writes itself, never signed: numbered on from the log's newest seq. */
export type OwnEventDraft =
  | { readonly type: "title"; readonly title: string }
  | {
      readonly type: "participants";
      readonly added?: readonly ParticipantId[];
      readonly removed?: readonly ParticipantId[];
    }
  | { readonly type: "settings"; readonly replyMode?: ReplyMode; readonly chainLimit?: number }
  | { readonly type: "call-started"; readonly call: string; readonly persona: ParticipantId }
  | { readonly type: "call-ended"; readonly call: string; readonly reason: CallEndReason };

/** What the chat list shows, derived from the log. */
export interface ChatSummary {
  readonly id: string;
  /** The last `title` event's. */
  readonly title: string | null;
  /** Who is in the chat now. */
  readonly participants: readonly ParticipantId[];
  readonly createdAt: number;
  /** The last event's `at`, else `createdAt`. */
  readonly updatedAt: number;
  /** The text of the last message that has any, delivery cues included. */
  readonly lastText: string | null;
  /** 0 before the first event. */
  readonly lastSeq: number;
  /** The newest `call-started` with no `call-ended` after it, or null. */
  readonly openCall: string | null;
}

/** What a turn, a voice message or a call's offer sends: the header, older state events, and newest events. */
export interface ChatWindow {
  readonly header: ChatHeader;
  readonly events: readonly WireEvent[];
}

/** One NDJSON line of a turn's answer. Only `events` lines are stored. */
export type ChatStreamLine =
  | { readonly type: "started"; readonly turn: string; readonly persona: ParticipantId }
  | { readonly type: "delta"; readonly turn: string; readonly text: string }
  | {
      readonly type: "tool";
      readonly turn: string;
      readonly name: string;
      readonly state: ToolState;
    }
  | { readonly type: "events"; readonly events: readonly WireEvent[] }
  | { readonly type: "ended"; readonly turn: string }
  | { readonly type: "error"; readonly code: string; readonly message: string };

export type ChatStoreErrorCode = "not-found" | "exists" | "seq-gap" | "invalid";

export class ChatStoreError extends Error {
  readonly code: ChatStoreErrorCode;

  constructor(code: ChatStoreErrorCode, message: string) {
    super(message);
    this.name = "ChatStoreError";
    this.code = code;
  }
}

/** A chat record as the browser's store keeps it, bound to the server that signs its events. */
export interface BrowserChatRecord extends ChatSummary {
  readonly header: ChatHeader;
  readonly baseUrl: string;
}

/** Persistence contract for a browser chat store (such as Dexie over IndexedDB). */
export interface BrowserChatStore<TRecord extends BrowserChatRecord = BrowserChatRecord> {
  list(): Promise<TRecord[]>;
  get(id: string): Promise<TRecord | null>;
  create(header: ChatHeader, baseUrl: string): Promise<TRecord>;
  read(
    id: string,
    options?: { readonly afterSeq?: number },
  ): Promise<{ header: ChatHeader; events: WireEvent[] }>;
  append(
    id: string,
    events: readonly WireEvent[],
    options?: { readonly allowGap?: boolean },
  ): Promise<TRecord>;
  appendOwn(id: string, drafts: readonly OwnEventDraft[], at?: number): Promise<WireEvent[]>;
  window(id: string): Promise<ChatWindow>;
  remove(id: string): Promise<void>;
  putFile(chatId: string, name: string, blob: Blob): Promise<boolean>;
  getFile(chatId: string, name: string): Promise<Blob | null>;
  missingFiles(chatId: string): Promise<string[]>;
}
