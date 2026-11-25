// The production chat endpoint, which exists only while EIDOLON_CHAT_SECRET is set. The browser
// keeps each chat and sends its newest events with every line; the server answers with what the
// turn adds, signed, and keeps no transcript. A persona's files wait in memory for it to fetch.
import {
  type AllowedOffer,
  admitChatTurn,
  type ChatAdmission,
  type ChatTurnInput,
  chatPersonas,
  chatQuotas,
  loginSyncTokenFrom,
  type UserContext,
} from "@eidolon/access";
import {
  type Attachment,
  attachmentKind,
  type ChatEvent,
  type ChatEventDraft,
  type ChatStreamLine,
  type LineFileRefusal,
  lineFileType,
  MAX_IMAGE_PIXELS,
  MAX_LINE_FILES,
  MAX_PARTICIPANTS,
  MAX_VOICE_MS,
  type ParticipantId,
  sendableImageType,
  sendableText,
  sentFilename,
  sentFiles,
  summarize,
} from "@eidolon/chat";
import { isJsonObject, logger, newId } from "@eidolon/config";
import {
  type ChatDeps,
  type ChatOutput,
  defaultEngineDeps,
  type EngineDeps,
  hearVoiceMessage,
  replyModeFor,
  runChat,
  runTurn,
  SHOWN_IMAGES,
  type ShownFile,
  type TurnRequest,
} from "@eidolon/engine";
import { ProviderConfigError } from "@eidolon/providers";
import { recordingDurationMs } from "@eidolon/providers/speech-batch";
import type { MethodRoutes, RouteServer } from "../app.ts";
import { type ImageRefusal, normalizeImage } from "../images.ts";
import { readBytes } from "../responses.ts";
import { type BoundOffer, bindChatCall } from "./call.ts";
import { chatError } from "./errors.ts";
import {
  attachmentOf,
  CHAT_FILES_PATH,
  type ChatFiles,
  chatFileResponse,
  chatFiles,
} from "./files.ts";
import { ChatSigner, chatSecretFromEnv } from "./sig.ts";
import { openChatWindow, type RequestChatStore } from "./window.ts";

const CHAT_TURN_PATH = "/api/chat/turn";
const CHAT_VOICE_PATH = "/api/chat/voice";

const MAX_TEXT = 4000;
/** A window is at most 384 KB of events; this leaves room for the rest of the body. */
const BODY_LIMIT = 1024 * 1024;
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
/** What a turn's files weigh at most in all, the line's own and earlier lines' sent again. */
const MAX_TURN_FILE_BYTES = 12 * 1024 * 1024;
/**
 * How far past MAX_VOICE_MS a clip may measure: a recorder stopped at the limit by a timer (the web
 * app's ticks every 200 ms) hands over a little more, and frames are counted whole.
 */
const VOICE_GRACE_MS = 1000;
/** Control characters other than a tab or a line break. */
const CONTROL_IN_TEXT = /(?![\t\n\r])\p{Cc}/u;
/** What the browser is told when a reply fails; the log has the rest. */
const REPLY_FAILED = "The reply failed";
const VOICE_FAILED = "Her voice message couldn't be made, so she answered in text";
const TOOL_FAILED = "The tool failed";

/**
 * An event as the browser may see it, and so as it is signed. A turn-failed holds the provider's
 * words, and a failed tool's result can too (take_selfie's holds the image provider's), which can
 * name the provider, its account or its balance: the engine has logged a turn's, this logs a tool's.
 */
function told(chatId: string, draft: ChatEventDraft): ChatEventDraft {
  if (draft.type === "turn-failed") {
    return { ...draft, error: draft.code === "voice-failed" ? VOICE_FAILED : REPLY_FAILED };
  }
  if (draft.type === "tool-result" && (draft.result.ok === false || "error" in draft.result)) {
    logger.warning(
      `[chat] Chat ${chatId}: ${draft.persona}'s tool call ${draft.callId} failed: ` +
        JSON.stringify(draft.result),
    );
    return { ...draft, result: { ok: false, error: TOOL_FAILED } };
  }
  return draft;
}

export interface ChatEndpointOptions {
  readonly signer: ChatSigner;
  /** Default: admitChatTurn on the process's chat quotas. */
  readonly admit?: (input: ChatTurnInput) => Promise<ChatAdmission>;
  /** Default: chatPersonas, read on every request. */
  readonly personas?: () => readonly ParticipantId[];
  /** Default: the real engine. */
  readonly engine?: (saveAttachment: EngineDeps["saveAttachment"]) => ChatDeps;
  readonly files?: ChatFiles;
}

export interface ChatEndpoint {
  /** For createBotApp's route table, which wraps each handler in its CORS and logging. */
  routes(clientIp: (request: Request, server: RouteServer) => string): Record<string, MethodRoutes>;
  /** bindChatCall with the endpoint's signer, files and personas. */
  bindCall(admission: AllowedOffer): Promise<BoundOffer | Response | null>;
}

/** `value` trimmed, when it is `min` to MAX_TEXT characters of text; else null. */
function lineOf(value: unknown, min: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const length = [...trimmed].length;
  return length < min || length > MAX_TEXT || CONTROL_IN_TEXT.test(trimmed) ? null : trimmed;
}

/** The voice message's `durationMs`, a whole number of ms from 1; else null. */
function durationOf(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,15}$/.test(value)) return null;
  const ms = Number(value);
  return ms > 0 ? ms : null;
}

/** A turn's request as read: its fields, before any is checked, and the files it carries. */
interface TurnBody {
  readonly chat: unknown;
  readonly text: unknown;
  /** The Login Sync token it carries, as `loginSyncTokenFrom` reads it. */
  readonly token: string | null;
  readonly files: readonly FormPart[];
  readonly seen: readonly FormPart[];
}

interface FormPart {
  readonly name: string;
  /** A file part's filename, as the browser escaped it: `"` and line breaks percent-encoded. */
  readonly filename: string | null;
  /** The part's Content-Type, or null without one. */
  readonly type: string | null;
  readonly bytes: Buffer;
}

const CRLF = 0x0d0a;
const DASH_DASH = 0x2d2d;

/**
 * A multipart/form-data body's parts in order, or null when it isn't one. A part is typed by its
 * own Content-Type, never by its filename: a browser names a recorded Blob "blob".
 */
function formParts(body: Buffer, contentType: string): FormPart[] | null {
  const param = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = param?.[1] ?? param?.[2];
  if (boundary === undefined) return null;
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const first = body.indexOf(delimiter.subarray(2));
  if (first === -1) return null;
  const parts: FormPart[] = [];
  let cursor = first + delimiter.length - 2;
  for (;;) {
    if (cursor + 2 > body.length) return null;
    if (body.readUInt16BE(cursor) === DASH_DASH) return parts;
    if (body.readUInt16BE(cursor) !== CRLF) return null;
    const blank = body.indexOf("\r\n\r\n", cursor);
    if (blank === -1) return null;
    const end = body.indexOf(delimiter, blank + 4);
    if (end === -1) return null;
    let name: string | null = null;
    let filename: string | null = null;
    let type: string | null = null;
    for (const line of body
      .subarray(cursor + 2, blank)
      .toString("utf8")
      .split("\r\n")) {
      const colon = line.indexOf(":");
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key === "content-disposition") {
        name = /(?:^|;)\s*name="([^"]*)"/i.exec(value)?.[1] ?? null;
        filename = /(?:^|;)\s*filename="([^"]*)"/i.exec(value)?.[1] ?? null;
      } else if (key === "content-type") {
        type = value;
      }
    }
    if (name !== null) parts.push({ name, filename, type, bytes: body.subarray(blank + 4, end) });
    cursor = end + delimiter.length;
  }
}

/** The first part named `name`. */
function partOf(parts: readonly FormPart[], name: string): FormPart | undefined {
  return parts.find((part) => part.name === name);
}

/** A part's text, or undefined without the part. */
function fieldOf(parts: readonly FormPart[], name: string): string | undefined {
  return partOf(parts, name)?.bytes.toString("utf8");
}

/** The 413 when a turn's file `parts` weigh more than MAX_TURN_FILE_BYTES in all; else null. */
function overweight(parts: readonly FormPart[]): Response | null {
  const weight = parts.reduce((sum, part) => sum + part.bytes.byteLength, 0);
  return weight > MAX_TURN_FILE_BYTES
    ? chatError(413, "payload-too-large", "A turn's files are at most 12 MB in all")
    : null;
}

/** A file part's filename as the viewer's computer called it, its escapes undone. */
function filenameOf(part: FormPart): string | null {
  const raw = part.filename?.replace(/%(22|0A|0D)/gi, (code) => decodeURIComponent(code));
  return sentFilename(raw);
}

/** A file a line carries, named by the bytes the browser sent and keeps. */
interface LineFile {
  readonly attachment: Attachment;
  readonly bytes: Uint8Array;
}

/**
 * An image a browser sends, made ready for her mind, which only an admitted turn does: a decode
 * is the work a request can't make cheap. One past MAX_IMAGE_PIXELS, which `prepareChatFile` fits
 * it to, is refused, so a decode stays small.
 */
function imageFor(bytes: Uint8Array): ReturnType<typeof normalizeImage> {
  return normalizeImage(bytes, MAX_IMAGE_PIXELS);
}

/** A file part of the line's, as `lineFileType` takes it, or why it can't go. */
function lineFile(part: FormPart): LineFile | { readonly refused: LineFileRefusal } {
  const kept = lineFileType(part.type ?? "", part.bytes);
  if ("refused" in kept) return kept;
  const attachment = attachmentOf(part.bytes, kept.mime);
  const filename = attachment.kind === "file" ? filenameOf(part) : null;
  return {
    attachment:
      attachment.kind === "file" && filename !== null ? { ...attachment, filename } : attachment,
    bytes: part.bytes,
  };
}

/** The answer refusing a line's file for `reason`. */
function fileRefusal(reason: LineFileRefusal | ImageRefusal): Response {
  if (reason === "empty") return chatError(400, "bad-request", "A file is empty");
  if (reason === "too-large") {
    return chatError(
      413,
      "payload-too-large",
      "An image is at most 3.5 MB and 2048 × 2048 pixels, and a text file at most 1 MB",
    );
  }
  return chatError(
    415,
    "unsupported-media-type",
    "Send a PNG, JPEG or WebP image, or a text file in UTF-8",
  );
}

const encoder = new TextEncoder();

/**
 * NDJSON of what `run` sends, until it settles. A reader that goes away aborts `run`'s signal: no
 * one is left to keep what the reply would add.
 */
function ndjson(
  upstream: AbortSignal,
  run: (send: (line: ChatStreamLine) => void, signal: AbortSignal) => Promise<void>,
): Response {
  const gone = new AbortController();
  const signal = AbortSignal.any([upstream, gone.signal]);
  let open = true;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (line: ChatStreamLine) => {
        if (open) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      };
      void run(send, signal)
        .catch((error: unknown) => logger.exception("[chat] A reply's stream failed", error))
        .finally(() => {
          if (!open) return;
          open = false;
          controller.close();
        });
    },
    cancel() {
      open = false;
      gone.abort();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

/**
 * Sends `first`, then each of `outputs` as `send` streams it, storing each event and decision in
 * `store` first, which numbers and signs them and drops context. A reply that throws ends as the
 * running persona's turn-failed, or `greeter`'s, else as an `error` line.
 */
async function relay(
  store: RequestChatStore,
  first: readonly ChatEvent[],
  outputs: AsyncIterable<ChatOutput>,
  greeter: ParticipantId | null,
  send: (line: ChatStreamLine) => void,
): Promise<void> {
  if (first.length > 0) send({ type: "events", events: [...first] });
  let running: { readonly turn: string; readonly persona: ParticipantId } | null = null;
  try {
    for await (const output of outputs) {
      if (output.type === "events" || output.type === "decision") {
        const events = await store.add(
          output.type === "events"
            ? output.events.map((event) => told(store.header.id, event))
            : [output],
        );
        if (events.length > 0) send({ type: "events", events });
        continue;
      }
      if (output.type === "started") running = { turn: output.turn, persona: output.persona };
      send(output);
      if (output.type === "ended") running = null;
    }
  } catch (error) {
    const persona = running?.persona ?? greeter;
    const who = persona === null ? "the reply" : `${persona}'s turn`;
    logger.exception(`[chat] Chat ${store.header.id}: ${who} failed`, error);
    if (persona === null) {
      send({ type: "error", code: "internal", message: REPLY_FAILED });
    } else {
      const turn = running?.turn ?? newId();
      const events = await store.add([{ type: "turn-failed", persona, turn, error: REPLY_FAILED }]);
      send({ type: "events", events });
    }
  } finally {
    if (running !== null) send({ type: "ended", turn: running.turn });
  }
}

export function createChatEndpoint(options: ChatEndpointOptions): ChatEndpoint {
  const { signer } = options;
  const admit = options.admit ?? ((input: ChatTurnInput) => admitChatTurn(input));
  const served = options.personas ?? chatPersonas;
  const files = options.files ?? chatFiles;
  const engine = (options.engine ?? ((saveAttachment) => defaultEngineDeps({ saveAttachment })))(
    async (bytes, mime) => files.save(bytes, mime),
  );

  /** The request's window, as read, and the personas in the chat now, all of them served here. */
  async function open(window: unknown): Promise<
    | {
        readonly store: RequestChatStore;
        readonly chat: TurnRequest["chat"];
        readonly participants: readonly ParticipantId[];
      }
    | { readonly refused: Response }
  > {
    const opened = await openChatWindow(window, signer);
    if (!opened.ok) return { refused: chatError(400, "bad-request", opened.message) };
    const { store } = opened;
    const chat = await store.read(store.header.id);
    const { participants } = summarize(chat.header, chat.events);
    if (participants.length === 0 || participants.length > MAX_PARTICIPANTS) {
      return { refused: chatError(400, "bad-request", "A chat holds 1 to 6 personas") };
    }
    const allowed = served();
    if (participants.some((id) => !allowed.includes(id))) {
      return {
        refused: chatError(403, "persona-not-served", "A persona in the chat isn't served here"),
      };
    }
    return { store, chat, participants };
  }

  /**
   * The engine for one viewer's turns. The browser picks a chat's id, so her parts, which keep what
   * they saw of a chat, are kept per viewer too: by mid when logged in, else by client IP.
   */
  function engineFor(viewer: UserContext, clientIp: string): ChatDeps {
    const who = viewer.isLoggedIn ? `mid:${viewer.mid}` : `ip:${clientIp}`;
    return {
      ...engine,
      parts: (persona, user, chat, options) =>
        engine.parts(persona, user, chat, { ...options, chatKey: `${who}/${chat.header.id}` }),
    };
  }

  /** The answer to the viewer's line at seq `after`, as runChat gives it. */
  function answer(
    store: RequestChatStore,
    viewer: UserContext,
    deps: ChatDeps,
    after: number,
    signal: AbortSignal,
  ): AsyncIterable<ChatOutput> {
    const id = store.header.id;
    return (async function* () {
      const chat = await store.read(id);
      yield* runChat({ chat, read: () => store.read(id), viewer, after, signal }, deps);
    })();
  }

  /** Her greeting in a new chat of one, in voice only when her reply mode is voice. */
  function greet(
    chat: TurnRequest["chat"],
    persona: ParticipantId,
    viewer: UserContext,
    deps: ChatDeps,
    signal: AbortSignal,
  ): AsyncIterable<ChatOutput> {
    return (async function* () {
      const mode = replyModeFor(chat, persona, deps.speech) === "voice" ? "voice" : "text";
      yield* runTurn({ chat, persona, viewer, kickoff: true, signal, mode }, deps);
    })();
  }

  /**
   * The files a request shows her, by name, each image made ready for her mind: those its line
   * carries, refused when one can't be, and those it sends again of the window's earlier lines
   * (`seen`), each kept only while a line of the viewer's there names it.
   */
  async function shownFiles(
    chat: TurnRequest["chat"],
    line: readonly LineFile[],
    seen: readonly FormPart[],
  ): Promise<Map<string, ShownFile> | Response> {
    const named = new Set(
      chat.events.flatMap((event) =>
        event.type === "message" ? sentFiles(event).map((file) => file.name) : [],
      ),
    );
    const shown = new Map<string, ShownFile>();
    const made = await Promise.all(
      line.map(({ attachment, bytes }) =>
        attachment.kind === "image" ? imageFor(bytes) : { bytes, mime: attachment.mime },
      ),
    );
    for (const [i, file] of made.entries()) {
      if ("refused" in file) return fileRefusal(file.refused);
      shown.set((line[i] as LineFile).attachment.name, file);
    }
    // Each once, and no more images than one request shows her: a copy past those is made for nothing.
    const again = new Map<string, { readonly bytes: Uint8Array; readonly image: boolean }>();
    // The line's own are newer, so shown first.
    let images = line.filter(({ attachment }) => attachment.kind === "image").length;
    for (const { bytes } of seen) {
      const type = sendableImageType(bytes);
      const mime = type ?? (sendableText(bytes) === null ? null : "text/plain");
      const name = mime === null ? null : attachmentOf(bytes, mime).name;
      if (name === null || !named.has(name) || shown.has(name) || again.has(name)) continue;
      const image = type !== null;
      if (image && images++ >= SHOWN_IMAGES) continue;
      again.set(name, { bytes, image });
    }
    await Promise.all(
      [...again].map(async ([name, { bytes, image }]) => {
        const ready = image ? await imageFor(bytes) : { bytes, mime: "text/plain" };
        if (!("refused" in ready)) shown.set(name, ready);
      }),
    );
    return shown;
  }

  /** `deps` reading the viewer's files from `shown` alone: production keeps none of them. */
  function withFiles(deps: ChatDeps, shown: ReadonlyMap<string, ShownFile>): ChatDeps {
    return { ...deps, readAttachment: async (name) => shown.get(name) ?? null };
  }

  /**
   * A turn's request, `{ chat, text?, loginSyncToken? }` as JSON, or as the fields of a multipart
   * form that also carries files: the line's own (`file`, each with its own Content-Type, a text
   * file's name as its filename) and earlier lines' sent again (`seen`).
   */
  async function turnBody(request: Request): Promise<TurnBody | Response> {
    const type = request.headers.get("content-type") ?? "";
    if (!/^multipart\/form-data\b/i.test(type)) {
      const bytes = await readBytes(request, BODY_LIMIT);
      if (bytes === null) return chatError(413, "payload-too-large", "The body is too large");
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return chatError(400, "bad-json", "The body is not valid JSON");
      }
      if (!isJsonObject(body)) {
        return chatError(400, "bad-request", "The body is { chat, text?, loginSyncToken? }");
      }
      return {
        chat: body.chat,
        text: body.text,
        token: loginSyncTokenFrom(body),
        files: [],
        seen: [],
      };
    }
    const bytes = await readBytes(request, BODY_LIMIT + MAX_TURN_FILE_BYTES);
    if (bytes === null) return chatError(413, "payload-too-large", "The body is too large");
    const parts = formParts(bytes, type);
    if (parts === null) return chatError(400, "bad-request", "The body is not multipart/form-data");
    let chat: unknown;
    try {
      chat = JSON.parse(fieldOf(parts, "chat") ?? "null");
    } catch {
      return chatError(400, "bad-json", "`chat` is not valid JSON");
    }
    const files = parts.filter((part) => part.name === "file");
    const seen = parts.filter((part) => part.name === "seen");
    const heavy = overweight([...files, ...seen]);
    if (heavy !== null) return heavy;
    return {
      chat,
      text: fieldOf(parts, "text"),
      token: loginSyncTokenFrom({ loginSyncToken: fieldOf(parts, "loginSyncToken") }),
      files,
      seen,
    };
  }

  /** The files the line carries, each named once, or the answer refusing them. */
  function lineFiles(parts: readonly FormPart[]): LineFile[] | Response {
    if (parts.length > MAX_LINE_FILES) {
      return chatError(400, "bad-request", `A line carries at most ${MAX_LINE_FILES} files`);
    }
    const files: LineFile[] = [];
    for (const part of parts) {
      const file = lineFile(part);
      if ("refused" in file) return fileRefusal(file.refused);
      if (!files.some(({ attachment }) => attachment.name === file.attachment.name)) {
        files.push(file);
      }
    }
    return files;
  }

  const turn = async (request: Request, clientIp: string): Promise<Response> => {
    const body = await turnBody(request);
    if (body instanceof Response) return body;
    const files = lineFiles(body.files);
    if (files instanceof Response) return files;
    const carries = files.length > 0;
    const text =
      body.text === undefined ? (carries ? "" : null) : lineOf(body.text, carries ? 0 : 1);
    if (body.text !== undefined && text === null) {
      return chatError(400, "bad-request", "`text` is 1 to 4000 characters");
    }
    const opened = await open(body.chat);
    if ("refused" in opened) return opened.refused;
    const { store, chat, participants } = opened;
    const [persona] = participants;
    if (text === null) {
      const said = chat.events.some((e) => e.type === "message");
      if (participants.length > 1 || said || persona === undefined) {
        return chatError(400, "bad-request", "Send `text`: only a new chat of one persona greets");
      }
    }
    const admission = await admit({ token: body.token, clientIp });
    if (!admission.allowed) return admission.response;
    const viewer = admission.user;
    const shown = await shownFiles(chat, files, body.seen);
    if (shown instanceof Response) return shown;
    const deps = withFiles(engineFor(viewer, clientIp), shown);
    if (text === null) {
      const greeter = persona as ParticipantId;
      return ndjson(request.signal, (send, signal) =>
        relay(store, [], greet(chat, greeter, viewer, deps, signal), greeter, send),
      );
    }
    const attachments = files.map((file) => file.attachment);
    const first = await store.add([
      {
        type: "message",
        id: newId(),
        speaker: { kind: "user" },
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    ]);
    const after = (first[0] as ChatEvent).seq;
    return ndjson(request.signal, (send, signal) =>
      relay(store, first, answer(store, viewer, deps, after, signal), null, send),
    );
  };

  const voice = async (request: Request, clientIp: string): Promise<Response> => {
    const type = request.headers.get("content-type") ?? "";
    if (!/^multipart\/form-data\b/i.test(type)) {
      return chatError(
        415,
        "unsupported-media-type",
        "Send multipart/form-data: chat, audio and durationMs",
      );
    }
    const bytes = await readBytes(request, MAX_VOICE_BYTES + BODY_LIMIT + MAX_TURN_FILE_BYTES);
    if (bytes === null) return chatError(413, "payload-too-large", "The body is too large");
    const form = formParts(bytes, type);
    if (form === null) {
      return chatError(400, "bad-request", "The body is not multipart/form-data");
    }
    const audio = partOf(form, "audio");
    const seen = form.filter((part) => part.name === "seen");
    const heavy = overweight(seen);
    if (heavy !== null) return heavy;
    if (audio === undefined) return chatError(400, "bad-request", "`audio` is the recording");
    const mime = audio.type ?? "";
    if (attachmentKind(mime) !== "audio") {
      return chatError(
        415,
        "unsupported-media-type",
        "Send a voice message as audio/webm, audio/ogg, audio/mp4 or audio/mpeg",
      );
    }
    if (audio.bytes.byteLength === 0) {
      return chatError(400, "bad-request", "The voice message is empty");
    }
    if (audio.bytes.byteLength > MAX_VOICE_BYTES) {
      return chatError(413, "payload-too-large", "A voice message is at most 10 MB");
    }
    const durationMs = durationOf(fieldOf(form, "durationMs"));
    if (durationMs === null) {
      return chatError(400, "bad-request", "`durationMs` is the clip's length in ms, from 1");
    }
    if (durationMs > MAX_VOICE_MS) {
      return chatError(413, "payload-too-large", "A voice message is at most 2 minutes");
    }
    // The claim is the browser's; hearing bills for what the clip holds.
    const measured = recordingDurationMs(audio.bytes, mime);
    if (measured === null) {
      return chatError(
        400,
        "bad-request",
        "The voice message isn't a whole recording of Opus in WebM or Ogg, AAC in MP4, or MP3",
      );
    }
    if (measured > MAX_VOICE_MS + VOICE_GRACE_MS) {
      return chatError(413, "payload-too-large", "A voice message is at most 2 minutes");
    }
    let window: unknown;
    try {
      window = JSON.parse(fieldOf(form, "chat") ?? "null");
    } catch {
      return chatError(400, "bad-json", "`chat` is not valid JSON");
    }
    const opened = await open(window);
    if ("refused" in opened) return opened.refused;
    const { store, chat } = opened;
    // Charged before the clip is heard, which bills.
    const admission = await admit({
      token: loginSyncTokenFrom({ loginSyncToken: fieldOf(form, "loginSyncToken") }),
      clientIp,
    });
    if (!admission.allowed) return admission.response;
    let message: Awaited<ReturnType<typeof hearVoiceMessage>>;
    try {
      message = await hearVoiceMessage(
        {
          chat,
          clip: { bytes: audio.bytes, mime, durationMs: measured },
          signal: request.signal,
        },
        // The browser keeps the clip it recorded; the server names it and lets it go.
        { ...engine, saveAttachment: async (clip, clipType) => attachmentOf(clip, clipType) },
      );
    } catch (error) {
      if (error instanceof ProviderConfigError) {
        logger.error(`[chat] Chat ${store.header.id}: no hearing role: ${error.message}`);
        return chatError(503, "unavailable", "Voice messages can't be heard here now");
      }
      logger.exception(`[chat] Chat ${store.header.id}: a voice message couldn't be heard`, error);
      return chatError(502, "upstream-failed", "The voice message couldn't be transcribed");
    }
    const first = await store.add([message]);
    const after = (first[0] as ChatEvent).seq;
    const shown = (await shownFiles(chat, [], seen)) as Map<string, ShownFile>;
    const deps = withFiles(engineFor(admission.user, clientIp), shown);
    return ndjson(request.signal, (send, signal) =>
      relay(store, first, answer(store, admission.user, deps, after, signal), null, send),
    );
  };

  return {
    routes: (clientIp) => ({
      [CHAT_TURN_PATH]: { POST: (request, server) => turn(request, clientIp(request, server)) },
      [CHAT_VOICE_PATH]: { POST: (request, server) => voice(request, clientIp(request, server)) },
      [`${CHAT_FILES_PATH}/:name`]: {
        GET: async (request) => chatFileResponse(request.params.name as string, files),
      },
    }),
    bindCall: (admission) => bindChatCall(admission, { signer, files, personas: served }),
  };
}

/** The endpoint, or null while EIDOLON_CHAT_SECRET is unset or too short: then no route exists. */
export async function chatEndpointFromEnv(): Promise<ChatEndpoint | null> {
  const secret = chatSecretFromEnv();
  if (secret === null) return null;
  const endpoint = createChatEndpoint({ signer: await ChatSigner.create(secret) });
  const { anonymous, loggedIn } = chatQuotas();
  logger.info(
    `[chat] Installed routes: POST ${CHAT_TURN_PATH}, POST ${CHAT_VOICE_PATH}, ` +
      `GET ${CHAT_FILES_PATH}/{name} (personas: ${chatPersonas().join(", ")}; turns an hour: ` +
      `${anonymous.maxPerWindow} per anonymous IP, ${loggedIn.maxPerWindow} per viewer)`,
  );
  return endpoint;
}
