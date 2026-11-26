// A chat's log: a header, then events numbered from 1. Keep this module import-free: browsers
// import it to keep chats of their own.

export const CHAT_FORMAT = 1;

/** The most personas a chat holds. */
export const MAX_PARTICIPANTS = 6;
/** Persona-to-persona hops after each viewer line until a `settings` event sets them; 0 is none. */
export const CHAIN_LIMITS = [0, 1, 5, 10, 100] as const;
export const DEFAULT_CHAIN_LIMIT = 5;
export const MAX_CHAIN_LIMIT = 100;
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
    }
  | {
      /** A text file the viewer sent, as UTF-8. */
      readonly kind: "file";
      readonly name: string;
      readonly mime: string;
      /** What the viewer's file was called, which the line shows and her view names it by. */
      readonly filename?: string;
    };

/** The most files the viewer sends with one line. */
export const MAX_LINE_FILES = 8;
/**
 * The largest image her mind is shown, which the server makes each one fit: Anthropic takes 5 MB of
 * one as base64, which grows it by a third.
 */
export const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
/** An image's pixels at most as her mind is shown it, and its long edge: Claude's models see 2576 px. */
export const MAX_IMAGE_PIXELS = 2048 * 2048;
export const MAX_IMAGE_EDGE = 2576;
/** The largest text file the viewer sends. */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;
/** The types a file the viewer sends is kept as. */
const LINE_FILE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
]);
const MAX_FILENAME = 120;

/** How personas answer: `auto` lets the director choose voice where a line suits it. */
export const REPLY_MODES = ["auto", "text", "voice"] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];

export function isReplyMode(value: unknown): value is ReplyMode {
  return REPLY_MODES.some((mode) => mode === value);
}

/** How much of her tasks a chat shows: focus hides their cards, verbose adds their steps. */
export const CHAT_DISPLAYS = ["focus", "normal", "verbose"] as const;
export type ChatDisplay = (typeof CHAT_DISPLAYS)[number];

export function isChatDisplay(value: unknown): value is ChatDisplay {
  return CHAT_DISPLAYS.some((display) => display === value);
}

/**
 * What her tasks may do in a chat without the owner's answer on their cards: `ask` asks about every
 * place, site, command and tool call outside what the owner allowed, `auto` has a review let the
 * routine ones through, and `full` asks about none.
 */
export const PERMISSION_LEVELS = ["ask", "auto", "full"] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return PERMISSION_LEVELS.some((level) => level === value);
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
      /** Her words before this call in a text turn, on a round's first call only. */
      readonly said?: string;
    })
  | (EventBase & {
      readonly type: "tool-result";
      readonly persona: ParticipantId;
      readonly turn: string;
      readonly callId: string;
      readonly result: Readonly<Record<string, unknown>>;
      /**
       * For a tool that runs on past her reply (a call's selfie): `started` as it begins, then
       * `final` or `cancelled` once it settles. Absent when she waited for the result.
       */
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
      /** Only the local app writes it. */
      readonly display?: ChatDisplay;
      /** Only the local app writes it, from the owner's picker, and only it reads it. */
      readonly permissions?: PermissionLevel;
    })
  | (EventBase & {
      readonly type: "call-started";
      readonly call: string;
      /** Whom the viewer called; on a group call, the host, whose hearing hears them. */
      readonly persona: ParticipantId;
      /** Every persona in the chat was on the call, the director choosing who answered. */
      readonly group?: true;
    })
  | (EventBase & {
      readonly type: "call-ended";
      readonly call: string;
      readonly reason: string;
      /** Her start_task calls whose ends she told on it, by id; only the local app writes it. */
      readonly told?: readonly string[];
    });

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
// is what browsers record (webm, or mp4 on Safari, or ogg) and what TTS providers send (mp3). A
// text file of the viewer's is kept as UTF-8, whatever it was called.
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
  "text/plain": "txt",
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

/** Whether an attachment of type `mime` is an image, audio or a text file; null for a type not taken. */
export function attachmentKind(mime: string): Attachment["kind"] | null {
  if (attachmentExtension(mime) === null) return null;
  const type = essence(mime);
  if (type.startsWith("audio/")) return "audio";
  return type.startsWith("text/") ? "file" : "image";
}

/**
 * The type of image `bytes` hold, by their signature, when it is one the viewer may send with a
 * line: PNG, JPEG or WebP, which every mind that sees takes. Else null.
 */
export function sendableImageType(bytes: Uint8Array): string | null {
  const holds = (offset: number, ascii: string): boolean =>
    [...ascii].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
  if (bytes[0] === 0x89 && holds(1, "PNG\r\n\x1a\n")) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (holds(0, "RIFF") && holds(8, "WEBP")) return "image/webp";
  return null;
}

/** `bytes` as text when they are UTF-8 with no NUL, as a text file the viewer sends is; else null. */
export function sendableText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Why a file can't go with a line. */
export type LineFileRefusal = "empty" | "too-large" | "unsupported";

/**
 * The type a file the viewer sends with a line is kept as, by the type it was sent as and its
 * bytes: an image (`image/*`) that is a PNG, JPEG or WebP, or a text file (`text/*`) in UTF-8; or
 * why it can't go.
 */
export function lineFileType(
  sentAs: string,
  bytes: Uint8Array,
): { readonly mime: string } | { readonly refused: LineFileRefusal } {
  const type = essence(sentAs);
  const image = type.startsWith("image/");
  if (!image && !type.startsWith("text/")) return { refused: "unsupported" };
  if (bytes.byteLength === 0) return { refused: "empty" };
  if (bytes.byteLength > (image ? MAX_IMAGE_BYTES : MAX_TEXT_FILE_BYTES)) {
    return { refused: "too-large" };
  }
  if (!image)
    return sendableText(bytes) === null ? { refused: "unsupported" } : { mime: "text/plain" };
  const mime = sendableImageType(bytes);
  return mime === null ? { refused: "unsupported" } : { mime };
}

/** What a file the viewer sent was called, without its folders or control characters; null for none. */
export function sentFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const base = value.slice(Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\")) + 1).trim();
  const name = [...base.replace(/\p{Cc}/gu, "")].slice(0, MAX_FILENAME).join("");
  return name === "" ? null : name;
}

/**
 * The files a line of the viewer's carries, as an event of theirs that came from a browser names
 * them, rebuilt from their names; null when one isn't a file a line takes.
 */
export function lineFilesOf(value: unknown): Attachment[] | null {
  if (!Array.isArray(value) || value.length > MAX_LINE_FILES) return null;
  const files: Attachment[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const { name, filename } = raw as { name?: unknown; filename?: unknown };
    const file = typeof name === "string" ? attachmentNamed(name) : null;
    if (file === null || !LINE_FILE_TYPES.has(file.mime)) return null;
    if (files.some((each) => each.name === file.name)) return null;
    if (file.kind !== "file") files.push(file);
    else {
      const called = sentFilename(filename);
      files.push(called === null ? file : { ...file, filename: called });
    }
  }
  return files;
}

/** The type of the attachment named `name` (`<sha256>.<ext>`), or null when it isn't one. */
export function attachmentMime(name: string): string | null {
  const ext = ATTACHMENT_NAME.exec(name)?.[1];
  if (ext === undefined) return null;
  for (const [mime, known] of Object.entries(ATTACHMENT_TYPES)) if (known === ext) return mime;
  return null;
}

/** The attachment named `name` (`<sha256>.<ext>`), of its type's kind; null when it isn't one. */
export function attachmentNamed(name: string): Attachment | null {
  const mime = attachmentMime(name);
  return mime === null ? null : ({ kind: attachmentKind(mime), name, mime } as Attachment);
}
