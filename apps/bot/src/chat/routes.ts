// The production chat endpoint, which exists only while EIDOLON_CHAT_SECRET is set. The browser
// keeps each chat and sends its newest events with every line; the server answers with what the
// turn adds, signed, and keeps no transcript. A persona's files wait in memory for it to fetch.
import {
  admitChatTurn,
  type ChatAdmission,
  type ChatTurnInput,
  chatPersonas,
  chatQuotas,
  loginSyncTokenFrom,
  type UserContext,
} from "@eidolon/access";
import {
  attachmentKind,
  type ChatEvent,
  type ChatEventDraft,
  type ChatStreamLine,
  MAX_PARTICIPANTS,
  type ParticipantId,
  summarize,
} from "@eidolon/chat";
import { isJsonObject, logger } from "@eidolon/config";
import {
  type ChatDeps,
  type ChatOutput,
  defaultEngineDeps,
  type EngineDeps,
  hearVoiceMessage,
  replyModeFor,
  runChat,
  runTurn,
} from "@eidolon/engine";
import { ProviderConfigError } from "@eidolon/providers";
import type { MethodRoutes, RouteServer } from "../app.ts";
import { jsonResponse } from "../responses.ts";
import {
  attachmentOf,
  CHAT_FILES_PATH,
  type ChatFiles,
  chatFileResponse,
  chatFiles,
} from "./files.ts";
import { ChatSigner, chatSecretFromEnv } from "./sig.ts";
import { openChatWindow, type RequestChatStore } from "./window.ts";

export const CHAT_TURN_PATH = "/api/chat/turn";
export const CHAT_VOICE_PATH = "/api/chat/voice";

const MAX_TEXT = 4000;
/** A window is at most 256 KB of events; this leaves room for the rest of the body. */
const BODY_LIMIT = 1024 * 1024;
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const MAX_VOICE_MS = 2 * 60 * 1000;
/** Control characters other than a tab or a line break. */
const CONTROL_IN_TEXT = /(?![\t\n\r])\p{Cc}/u;
/** What the browser is told when a reply fails; the log has the rest. */
const REPLY_FAILED = "The reply failed";
const VOICE_FAILED = "Her voice message couldn't be made, so she answered in text";

/**
 * A turn-failed as the browser may see it. The engine records the provider's words, which can name
 * the provider, its account or its balance; the engine has logged them.
 */
function told(draft: ChatEventDraft): ChatEventDraft {
  if (draft.type !== "turn-failed") return draft;
  return { ...draft, error: draft.code === "voice-failed" ? VOICE_FAILED : REPLY_FAILED };
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
  /** What signs the events it answers with, keyed by EIDOLON_CHAT_SECRET. */
  readonly signer: ChatSigner;
  /** For createBotApp's route table, which wraps each handler in its CORS and logging. */
  routes(clientIp: (request: Request, server: RouteServer) => string): Record<string, MethodRoutes>;
}

function chatError(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } }, { "cache-control": "no-store" });
}

/** The body's bytes, or null once it passes `limit` bytes, counted while it streams. */
async function readBody(request: Request, limit: number): Promise<Buffer | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (request.body === null) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** `value` trimmed, when it is 1 to MAX_TEXT characters of text; else null. */
function lineOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const length = [...trimmed].length;
  return length === 0 || length > MAX_TEXT || CONTROL_IN_TEXT.test(trimmed) ? null : trimmed;
}

/** The voice message's `durationMs`, a whole number of ms from 1; else null. */
function durationOf(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,15}$/.test(value)) return null;
  const ms = Number(value);
  return ms > 0 ? ms : null;
}

interface FormPart {
  /** The part's Content-Type, or null without one. */
  readonly type: string | null;
  readonly bytes: Buffer;
}

const CRLF = 0x0d0a;
const DASH_DASH = 0x2d2d;

/**
 * A multipart/form-data body's parts by name, the first of each name kept, or null when it isn't
 * one. Not Bun's formData(), which types a file part by its filename instead of its Content-Type
 * (https://github.com/oven-sh/bun/issues/45707), and a browser names a recorded Blob "blob".
 */
function formParts(body: Buffer, contentType: string): Map<string, FormPart> | null {
  const param = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = param?.[1] ?? param?.[2];
  if (boundary === undefined) return null;
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const first = body.indexOf(delimiter.subarray(2));
  if (first === -1) return null;
  const parts = new Map<string, FormPart>();
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
      } else if (key === "content-type") {
        type = value;
      }
    }
    if (name !== null && !parts.has(name)) {
      parts.set(name, { type, bytes: body.subarray(blank + 4, end) });
    }
    cursor = end + delimiter.length;
  }
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
          output.type === "events" ? output.events.map(told) : [output],
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
      const turn = running?.turn ?? Bun.randomUUIDv7();
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

  /** The request's window, and the personas in the chat now, all of them served here. */
  async function open(
    chat: unknown,
  ): Promise<
    | { readonly store: RequestChatStore; readonly participants: readonly ParticipantId[] }
    | { readonly refused: Response }
  > {
    const opened = await openChatWindow(chat, signer);
    if (!opened.ok) return { refused: chatError(400, "bad-request", opened.message) };
    const { store } = opened;
    const { participants } = summarize(store.header, (await store.read(store.header.id)).events);
    if (participants.length === 0 || participants.length > MAX_PARTICIPANTS) {
      return { refused: chatError(400, "bad-request", "A chat holds 1 to 6 personas") };
    }
    const allowed = served();
    if (participants.some((id) => !allowed.includes(id))) {
      return {
        refused: chatError(403, "persona-not-served", "A persona in the chat isn't served here"),
      };
    }
    return { store, participants };
  }

  /** The answer to the viewer's line at seq `after`, as runChat gives it. */
  function answer(
    store: RequestChatStore,
    viewer: UserContext,
    after: number,
    signal: AbortSignal,
  ): AsyncIterable<ChatOutput> {
    const id = store.header.id;
    return (async function* () {
      const chat = await store.read(id);
      yield* runChat({ chat, read: () => store.read(id), viewer, after, signal }, engine);
    })();
  }

  /** Her greeting in a new chat of one, in voice only when her reply mode is voice. */
  function greet(
    store: RequestChatStore,
    persona: ParticipantId,
    viewer: UserContext,
    signal: AbortSignal,
  ): AsyncIterable<ChatOutput> {
    return (async function* () {
      const chat = await store.read(store.header.id);
      const mode = replyModeFor(chat, persona, engine.speech) === "voice" ? "voice" : "text";
      yield* runTurn({ chat, persona, viewer, kickoff: true, signal, mode }, engine);
    })();
  }

  const turn = async (request: Request, clientIp: string): Promise<Response> => {
    const bytes = await readBody(request, BODY_LIMIT);
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
    const text = body.text === undefined ? null : lineOf(body.text);
    if (body.text !== undefined && text === null) {
      return chatError(400, "bad-request", "`text` is 1 to 4000 characters");
    }
    const opened = await open(body.chat);
    if ("refused" in opened) return opened.refused;
    const { store, participants } = opened;
    const [persona] = participants;
    if (text === null) {
      const said = (await store.read(store.header.id)).events.some((e) => e.type === "message");
      if (participants.length > 1 || said || persona === undefined) {
        return chatError(400, "bad-request", "Send `text`: only a new chat of one persona greets");
      }
    }
    const admission = await admit({ token: loginSyncTokenFrom(body), clientIp });
    if (!admission.allowed) return admission.response;
    const viewer = admission.user;
    if (text === null) {
      const greeter = persona as ParticipantId;
      return ndjson(request.signal, (send, signal) =>
        relay(store, [], greet(store, greeter, viewer, signal), greeter, send),
      );
    }
    const first = await store.add([
      { type: "message", id: Bun.randomUUIDv7(), speaker: { kind: "user" }, text },
    ]);
    const after = (first[0] as ChatEvent).seq;
    return ndjson(request.signal, (send, signal) =>
      relay(store, first, answer(store, viewer, after, signal), null, send),
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
    const bytes = await readBody(request, MAX_VOICE_BYTES + BODY_LIMIT);
    if (bytes === null) return chatError(413, "payload-too-large", "The body is too large");
    const form = formParts(bytes, type);
    if (form === null) {
      return chatError(400, "bad-request", "The body is not multipart/form-data");
    }
    const field = (name: string) => form.get(name)?.bytes.toString("utf8");
    const audio = form.get("audio");
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
    const durationMs = durationOf(field("durationMs"));
    if (durationMs === null) {
      return chatError(400, "bad-request", "`durationMs` is the clip's length in ms, from 1");
    }
    if (durationMs > MAX_VOICE_MS) {
      return chatError(413, "payload-too-large", "A voice message is at most 2 minutes");
    }
    let chat: unknown;
    try {
      chat = JSON.parse(field("chat") ?? "null");
    } catch {
      return chatError(400, "bad-json", "`chat` is not valid JSON");
    }
    const opened = await open(chat);
    if ("refused" in opened) return opened.refused;
    const { store } = opened;
    // Charged before the clip is heard, which bills.
    const admission = await admit({
      token: loginSyncTokenFrom({ loginSyncToken: field("loginSyncToken") }),
      clientIp,
    });
    if (!admission.allowed) return admission.response;
    let message: Awaited<ReturnType<typeof hearVoiceMessage>>;
    try {
      message = await hearVoiceMessage(
        {
          chat: await store.read(store.header.id),
          clip: { bytes: audio.bytes, mime, durationMs },
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
    return ndjson(request.signal, (send, signal) =>
      relay(store, first, answer(store, admission.user, after, signal), null, send),
    );
  };

  return {
    signer,
    routes: (clientIp) => ({
      [CHAT_TURN_PATH]: { POST: (request, server) => turn(request, clientIp(request, server)) },
      [CHAT_VOICE_PATH]: { POST: (request, server) => voice(request, clientIp(request, server)) },
      [`${CHAT_FILES_PATH}/:name`]: {
        GET: async (request) => chatFileResponse(request.params.name as string, files),
      },
    }),
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
