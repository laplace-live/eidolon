import {
  type Attachment,
  CHAT_FORMAT,
  type ChatEvent,
  type ChatHeader,
  type ChatStreamLine,
  isReplyMode,
  MAX_PARTICIPANTS,
  MAX_TEXT_LENGTH,
  type Speaker,
  type ToolState,
  type WireEvent,
} from "./types.ts";

export type JsonObject = { readonly [key: string]: unknown };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return options.some((option) => option === value);
}

// Lowercase only: a case-insensitive filesystem would otherwise give one folder two ids.
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `id` can name a chat: a lowercase UUID. */
export function isChatId(id: string): boolean {
  return CHAT_ID.test(id);
}

const ATTACHMENT_NAME = /^[0-9a-f]{64}\.([a-z0-9]+)$/;

// No SVG or HTML: a stored Blob is shown from the host app's own origin.
const ATTACHMENT_MIME_TO_EXT: Readonly<Record<string, string>> = {
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

const ATTACHMENT_EXT_TO_MIME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ATTACHMENT_MIME_TO_EXT).map(([mime, ext]) => [ext, mime]),
);

function essence(mime: string): string {
  return (mime.split(";")[0] ?? "").trim().toLowerCase();
}

/** The type of the attachment named `name` (`<sha256>.<ext>`), or null when it isn't one. */
export function attachmentMimeOf(name: string): string | null {
  const ext = ATTACHMENT_NAME.exec(name)?.[1];
  if (ext === undefined || !Object.hasOwn(ATTACHMENT_EXT_TO_MIME, ext)) return null;
  return ATTACHMENT_EXT_TO_MIME[ext] ?? null;
}

/** The extension an attachment of type `mime` is stored under, or null for a type not taken. */
export function attachmentExtension(mime: string): string | null {
  const type = essence(mime);
  return Object.hasOwn(ATTACHMENT_MIME_TO_EXT, type)
    ? (ATTACHMENT_MIME_TO_EXT[type] ?? null)
    : null;
}

/** Whether an attachment of type `mime` is an image or audio; null for a type not taken. */
export function attachmentKind(mime: string): Attachment["kind"] | null {
  if (attachmentExtension(mime) === null) return null;
  return essence(mime).startsWith("audio/") ? "audio" : "image";
}

/** Whether `name` is shaped as an attachment's, so it is safe in a URL path. */
export function isAttachmentName(name: string): boolean {
  return ATTACHMENT_NAME.test(name);
}

function isAttachment(value: unknown): value is Attachment {
  if (!isJsonObject(value) || !isString(value.name) || !isString(value.mime)) return false;
  if (!isAttachmentName(value.name)) return false;
  if (value.kind === "image") return true;
  return (
    value.kind === "audio" && (value.durationMs === undefined || isFiniteNumber(value.durationMs))
  );
}

function isSpeaker(value: unknown): value is Speaker {
  if (!isJsonObject(value)) return false;
  return value.kind === "user" || (value.kind === "persona" && isString(value.id));
}

/** An event as the log keeps it: an object with a `seq` from 1, an `at` and a `type`. */
export function isWireEvent(value: unknown): value is WireEvent {
  if (!isJsonObject(value)) return false;
  const { seq, at, type, sig } = value;
  return (
    typeof seq === "number" &&
    Number.isSafeInteger(seq) &&
    seq >= 1 &&
    isFiniteNumber(at) &&
    isString(type) &&
    (sig === undefined || isString(sig))
  );
}

function isOwnedByPersona(event: JsonObject): boolean {
  return isString(event.persona) && isString(event.turn);
}

/** Whether `value` is an event of a type this client knows, with the fields it reads well formed. */
export function isChatEvent(value: unknown): value is ChatEvent {
  if (!isWireEvent(value)) return false;
  switch (value.type) {
    case "message":
      return (
        isString(value.id) &&
        isSpeaker(value.speaker) &&
        isString(value.text) &&
        (value.modality === undefined || isOneOf(value.modality, ["text", "voice", "call"])) &&
        (value.attachments === undefined ||
          (Array.isArray(value.attachments) && value.attachments.every(isAttachment))) &&
        (value.interrupted === undefined || typeof value.interrupted === "boolean") &&
        (value.cutOff === undefined || isOneOf(value.cutOff, ["length", "refusal"]))
      );
    case "context":
      return isOwnedByPersona(value) && isFiniteNumber(value.position) && isString(value.content);
    case "context-removed":
      return (
        isOwnedByPersona(value) && Array.isArray(value.seqs) && value.seqs.every(isFiniteNumber)
      );
    case "tool-call":
      return (
        isOwnedByPersona(value) &&
        isString(value.callId) &&
        isString(value.name) &&
        isJsonObject(value.arguments)
      );
    case "tool-result":
      return isOwnedByPersona(value) && isString(value.callId) && isJsonObject(value.result);
    case "kickoff":
      return isOwnedByPersona(value) && isString(value.content);
    case "participants":
      return (
        (value.added === undefined || isStringList(value.added)) &&
        (value.removed === undefined || isStringList(value.removed))
      );
    case "title":
      return isString(value.title);
    case "turn-failed":
      return (
        isOwnedByPersona(value) &&
        isString(value.error) &&
        (value.code === undefined || isString(value.code))
      );
    case "decision":
      return (
        isFiniteNumber(value.after) &&
        isOneOf(value.source, ["single", "mention", "model", "fallback"]) &&
        Array.isArray(value.replies) &&
        value.replies.every(
          (reply) =>
            isJsonObject(reply) &&
            isString(reply.persona) &&
            isOneOf(reply.mode, ["text", "voice"]),
        )
      );
    case "settings":
      return (
        (value.replyMode === undefined || isReplyMode(value.replyMode)) &&
        (value.chainLimit === undefined || isFiniteNumber(value.chainLimit))
      );
    case "call-started":
      return isString(value.call) && isString(value.persona);
    case "call-ended":
      return isString(value.call) && isString(value.reason);
  }
  return false;
}

/** Whether `value` is a chat's header: format 1, a chat id, and 1 to 6 distinct personas. */
export function isChatHeader(value: unknown): value is ChatHeader {
  if (!isJsonObject(value)) return false;
  const { format, id, createdAt, participants } = value;
  return (
    format === CHAT_FORMAT &&
    isString(id) &&
    isChatId(id) &&
    isFiniteNumber(createdAt) &&
    isStringList(participants) &&
    participants.length >= 1 &&
    participants.length <= MAX_PARTICIPANTS &&
    participants.every((persona) => persona !== "") &&
    new Set(participants).size === participants.length
  );
}

const TOOL_STATES: readonly ToolState[] = ["running", "done", "failed"];

/** One parsed NDJSON line as a stream line, or null for a line of a type this client doesn't know. */
export function parseStreamLine(raw: unknown): ChatStreamLine | null {
  if (!isJsonObject(raw)) return null;
  const { turn } = raw;
  switch (raw.type) {
    case "started":
      return isString(turn) && isString(raw.persona)
        ? { type: "started", turn, persona: raw.persona }
        : null;
    case "delta":
      return isString(turn) && isString(raw.text) ? { type: "delta", turn, text: raw.text } : null;
    case "tool":
      return isString(turn) && isString(raw.name) && isOneOf(raw.state, TOOL_STATES)
        ? { type: "tool", turn, name: raw.name, state: raw.state }
        : null;
    case "events": {
      const { events } = raw;
      return Array.isArray(events) && events.every(isWireEvent) ? { type: "events", events } : null;
    }
    case "ended":
      return isString(turn) ? { type: "ended", turn } : null;
    case "error":
      return isString(raw.code) && isString(raw.message)
        ? { type: "error", code: raw.code, message: raw.message }
        : null;
  }
  return null;
}

/** The RTVI server message a call inside a chat sends for each line said on it. */
export const CHAT_LINE_MESSAGE = "chat-line";

/** The event a call's `{ type: "chat-line", event }` server message carries, or null for any other. */
export function chatLineEventOf(data: unknown): WireEvent | null {
  if (!isJsonObject(data) || data.type !== CHAT_LINE_MESSAGE) return null;
  return isWireEvent(data.event) ? data.event : null;
}

/**
 * `text` trimmed, when the endpoint takes it as a line: 1 to 4000 code points, with no control
 * character except tabs and line breaks. Else null.
 */
export function chatTextOf(text: string): string | null {
  const trimmed = text.trim();
  let length = 0;
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (control && char !== "\t" && char !== "\n" && char !== "\r") return null;
    length++;
  }
  return length === 0 || length > MAX_TEXT_LENGTH ? null : trimmed;
}

const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;

/** The space two pieces of text need between them: none beside whitespace or CJK. */
export function separator(left: string, right: string): "" | " " {
  const before = left.at(-1);
  const after = right[0];
  if (before === undefined || after === undefined) return "";
  if (/\s/.test(before) || /\s/.test(after) || CJK.test(before) || CJK.test(after)) return "";
  return " ";
}

/** Pieces of speech joined as one trimmed string, with no spurious spaces between CJK segments. */
export function joinSegments(parts: readonly string[]): string {
  return parts.reduce((text, part) => text + separator(text, part) + part, "").trim();
}

/** MediaRecorder MIME types whose duration `/api/chat/voice` can measure, in preference order. */
export const VOICE_RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mpeg",
] as const;

/** The first supported recording MIME type that `/api/chat/voice` accepts, or null. */
export function recorderMimeType(isTypeSupported: (type: string) => boolean): string | null {
  return VOICE_RECORDER_MIME_TYPES.find((type) => isTypeSupported(type)) ?? null;
}
