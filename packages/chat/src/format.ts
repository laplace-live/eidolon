// A chat's log: a header, then events numbered from 1. Keep this module import-free: browsers
// import it to keep chats of their own.

export const CHAT_FORMAT = 1;

/** The most personas a chat holds. */
export const MAX_PARTICIPANTS = 6;
/** Persona-to-persona hops after each viewer line until a `settings` event sets them; 0 is none. */
export const DEFAULT_CHAIN_LIMIT = 3;
export const MAX_CHAIN_LIMIT = 6;
/** The longest voice message the viewer can send. */
export const MAX_VOICE_MS = 120_000;

/** A persona id. */
export type ParticipantId = string;

export type Speaker =
  | { readonly kind: "user" }
  | { readonly kind: "persona"; readonly id: ParticipantId };

/** A log's first line, never rewritten. */
export interface ChatHeader {
  readonly format: typeof CHAT_FORMAT;
  /** A UUIDv7, so ids sort by time. */
  readonly id: string;
  /** ms since the epoch. */
  readonly createdAt: number;
  /** At creation; later changes are `participants` events. */
  readonly participants: readonly ParticipantId[];
}

/** A file in the chat's files/ (local) or a Blob row (browser). */
export type Attachment =
  | { readonly kind: "image"; readonly name: string; readonly mime: string }
  | {
      readonly kind: "audio";
      readonly name: string;
      readonly mime: string;
      /** Absent when nothing measured it; a player reads it from the file. */
      readonly durationMs?: number;
    };

/** How personas answer: `auto` lets the director choose voice where a line suits it. */
export const REPLY_MODES = ["auto", "text", "voice"] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];

export function isReplyMode(value: unknown): value is ReplyMode {
  return REPLY_MODES.some((mode) => mode === value);
}

export type CutOff = "length" | "refusal";

interface EventBase {
  /** 1, 2, 3…: contiguous. */
  readonly seq: number;
  /** ms since the epoch. */
  readonly at: number;
  /** The production endpoint's HMAC over `canonicalForSig`; never written locally, ignored on read. */
  readonly sig?: string;
}

export type ChatEvent =
  | (EventBase & {
      readonly type: "message";
      readonly id: string;
      readonly speaker: Speaker;
      /** For a voice message or a call's turn, the transcript. */
      readonly text: string;
      /** Absent means text. */
      readonly modality?: "text" | "voice" | "call";
      readonly attachments?: readonly Attachment[];
      readonly interrupted?: boolean;
      /** Her provider stopped her short: at its token limit, or refusing. */
      readonly cutOff?: CutOff;
    })
  | (EventBase & {
      /** Recall she was given, at `position` in her view; hidden in the UI. */
      readonly type: "context";
      readonly persona: ParticipantId;
      readonly turn: string;
      readonly position: number;
      readonly role: "system" | "user" | "developer";
      readonly content: string;
    })
  | (EventBase & {
      /** Her earlier context blocks, by seq, that a provider took out of her view. */
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
      readonly error: string;
      /** `voice-failed`: her reply, stored just before, was meant as a voice message but stayed text. */
      readonly code?: "voice-failed";
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
      /** The decision model's raw scores, for calibration. */
      readonly scores?: Readonly<Record<string, number>>;
    })
  | (EventBase & {
      /** Per-chat overrides. */
      readonly type: "settings";
      readonly replyMode?: ReplyMode;
      readonly chainLimit?: number;
    })
  | (EventBase & {
      readonly type: "call-started";
      readonly call: string;
      readonly persona: ParticipantId;
    })
  | (EventBase & { readonly type: "call-ended"; readonly call: string; readonly reason: string });

export type ChatEventOf<K extends ChatEvent["type"]> = Extract<ChatEvent, { readonly type: K }>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before its store's caller numbers and times it. */
export type ChatEventDraft = DistributiveOmit<ChatEvent, "seq" | "at">;

/** What the chat list shows: derived from the log, so it can be rebuilt. */
export interface ChatSummary {
  readonly id: string;
  /** The last `title` event's. */
  readonly title: string | null;
  readonly participants: readonly ParticipantId[];
  readonly createdAt: number;
  /** The last event's `at`, else `createdAt`. */
  readonly updatedAt: number;
  /** The text of the last message that has any. */
  readonly lastText: string | null;
  /** 0 before the first event. */
  readonly lastSeq: number;
}

/** The one interface every chat store implements; `runChatStoreContract` holds them to it. */
export interface ChatStore {
  /** Newest activity first. */
  list(): Promise<ChatSummary[]>;
  /** Rejects with `exists` when the id is taken. */
  create(header: ChatHeader): Promise<void>;
  /** Rejects with `not-found` for an unknown chat. */
  read(
    id: string,
    options?: { readonly afterSeq?: number },
  ): Promise<{ header: ChatHeader; events: ChatEvent[] }>;
  /** Rejects with `seq-gap`, writing nothing, unless the batch continues the log; durable on resolve. */
  append(id: string, events: readonly ChatEvent[]): Promise<void>;
  /** Rejects with `not-found` for an unknown chat. */
  remove(id: string): Promise<void>;
}

export type ChatStoreErrorCode = "not-found" | "exists" | "seq-gap" | "invalid";

export class ChatStoreError extends Error {
  readonly code: ChatStoreErrorCode;

  constructor(code: ChatStoreErrorCode, message: string) {
    super(message);
    this.name = "ChatStoreError";
    this.code = code;
  }
}

/**
 * One NDJSON line of a turn's stream, as POST messages and GET live answer. Deltas and tool states
 * are never stored; an `events` line carries events already stored.
 */
export type ChatStreamLine =
  | { readonly type: "started"; readonly turn: string; readonly persona: ParticipantId }
  | { readonly type: "delta"; readonly turn: string; readonly text: string }
  | {
      readonly type: "tool";
      readonly turn: string;
      readonly name: string;
      readonly state: "running" | "done" | "failed";
    }
  | { readonly type: "events"; readonly events: ChatEvent[] }
  | { readonly type: "ended"; readonly turn: string }
  | { readonly type: "error"; readonly code: string; readonly message: string };

/** Numbers `drafts` on from `lastSeq` and times them all `at`. */
export function stampEvents(
  drafts: readonly ChatEventDraft[],
  lastSeq: number,
  at: number,
): ChatEvent[] {
  return drafts.map((draft, i) => ({ ...draft, seq: lastSeq + 1 + i, at }) as ChatEvent);
}

// Lowercase only: a case-insensitive filesystem would otherwise give one folder two ids.
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isChatId(id: string): boolean {
  return CHAT_ID.test(id);
}

// No SVG: an attachment is served from the app's own origin, where one could run script. The audio
// is what browsers record (webm, or mp4 on Safari, or ogg) and what TTS providers send (mp3).
const ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "audio/mpeg": "mp3",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
};

const ATTACHMENT_NAME = /^[0-9a-f]{64}\.([a-z0-9]+)$/;

/** `mime` without its parameters: MediaRecorder's `audio/webm;codecs=opus` is `audio/webm`. */
function essence(mime: string): string {
  return (mime.split(";")[0] as string).trim().toLowerCase();
}

/** The extension an attachment of type `mime` is stored under, or null for a type not taken. */
export function attachmentExtension(mime: string): string | null {
  const type = essence(mime);
  return Object.hasOwn(ATTACHMENT_TYPES, type) ? (ATTACHMENT_TYPES[type] as string) : null;
}

/** Whether an attachment of type `mime` is an image or audio; null for a type not taken. */
export function attachmentKind(mime: string): Attachment["kind"] | null {
  if (attachmentExtension(mime) === null) return null;
  return essence(mime).startsWith("audio/") ? "audio" : "image";
}

/** The type of the attachment named `name` (`<sha256>.<ext>`), or null when it isn't one. */
export function attachmentMime(name: string): string | null {
  const ext = ATTACHMENT_NAME.exec(name)?.[1];
  if (ext === undefined) return null;
  for (const [mime, known] of Object.entries(ATTACHMENT_TYPES)) if (known === ext) return mime;
  return null;
}
