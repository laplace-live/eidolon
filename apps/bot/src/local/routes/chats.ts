// /api/local/chats: chats with the personas, in text and voice messages, kept in the data home. A
// reply streams as NDJSON while it runs, and GET live picks it up again from its start, or streams
// a call's lines as they are stored.
import { existsSync } from "node:fs";
import {
  type Attachment,
  attachmentKind,
  attachmentMime,
  type ChatDisplay,
  ChatStoreError,
  isChatDisplay,
  isChatId,
  isPermissionLevel,
  isReplyMode,
  lineFilesOf,
  MAX_CHAIN_LIMIT,
  MAX_PARTICIPANTS,
  MAX_TEXT_FILE_BYTES,
  MAX_VOICE_MS,
  type PermissionLevel,
  type ReplyMode,
  sendableText,
  sentFilename,
} from "@eidolon/chat";
import { isPlainObject, logger, withPersona } from "@eidolon/config";
import { hasKey, missingKey, ProviderConfigError, trySelect } from "@eidolon/providers";
import {
  type ImageRefusal,
  MAX_SENT_IMAGE_BYTES,
  MAX_SENT_IMAGE_PIXELS,
  type NormalizedImage,
  normalizeImage,
} from "../../images.ts";
import { readBytes } from "../../responses.ts";
import { HearingFailed, hearingRefusal } from "../chats/hearing.ts";
import { ChatInCall, ChatRunner, type ChatRunnerOptions } from "../chats/runner.ts";
import { personaRefusal } from "../personas.ts";
import { fileResponse } from "../ranges.ts";
import {
  imageHeaders,
  localError,
  localFailure,
  localJson,
  ndjsonResponse,
  readJson,
} from "../responses.ts";
import type { LocalApp, LocalRouteSpec } from "../router.ts";

const MAX_TEXT = 4000;
const MAX_TITLE = 80;
/** 4000 characters, each escaped as JSON at worst, and the names of the line's files. */
const BODY_LIMIT = 64 * 1024;
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
// Attachments are named by their content's hash: a name never changes what it serves.
const IMMUTABLE = "private, max-age=31536000, immutable";
/** Control characters other than a tab or a line break. */
const CONTROL_IN_TEXT = /(?![\t\n\r])\p{Cc}/u;
const CONTROL = /\p{Cc}/u;

/** PATCH's `title`, trimmed, 1 to MAX_TITLE characters on one line; else null. */
function titleIn(body: unknown): string | null {
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "title")) return null;
  const { title } = body;
  if (typeof title !== "string") return null;
  const trimmed = title.trim();
  const length = [...trimmed].length;
  return length === 0 || length > MAX_TITLE || CONTROL.test(trimmed) ? null : trimmed;
}

/** `value` as a list of strings, each once, of `min` to MAX_PARTICIPANTS; else null. */
function idsOf(value: unknown, min: number): string[] | null {
  if (!Array.isArray(value) || value.length < min || value.length > MAX_PARTICIPANTS) return null;
  if (!value.every((id) => typeof id === "string")) return null;
  return new Set(value).size === value.length ? (value as string[]) : null;
}

/** The personas a create names: 1 to MAX_PARTICIPANTS, each once. */
function participantsOf(body: unknown): string[] | null {
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "participants")) return null;
  return idsOf(body.participants, 1);
}

/** A participants change: `add`, `remove` or both, naming at least one persona, none in both. */
function changeOf(body: unknown): { add: string[]; remove: string[] } | null {
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "add" && key !== "remove")) {
    return null;
  }
  const add = body.add === undefined ? [] : idsOf(body.add, 0);
  const remove = body.remove === undefined ? [] : idsOf(body.remove, 0);
  if (add === null || remove === null || add.length + remove.length === 0) return null;
  return add.some((id) => remove.includes(id)) ? null : { add, remove };
}

/** PATCH's `chainLimit`, a whole number of hops from 0 to MAX_CHAIN_LIMIT; else null. */
function chainLimitOf(body: unknown): number | null {
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "chainLimit")) return null;
  const { chainLimit } = body;
  if (typeof chainLimit !== "number" || !Number.isInteger(chainLimit)) return null;
  return chainLimit >= 0 && chainLimit <= MAX_CHAIN_LIMIT ? chainLimit : null;
}

/** PATCH's `replyMode`: auto, text or voice; else null. */
function replyModeIn(body: unknown): ReplyMode | null {
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "replyMode")) return null;
  return isReplyMode(body.replyMode) ? body.replyMode : null;
}

/** PATCH's `display`: focus, normal or verbose; else null. */
function displayIn(body: unknown): ChatDisplay | null {
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "display")) return null;
  return isChatDisplay(body.display) ? body.display : null;
}

/** PATCH's `permissions`: ask, auto or full; else null. */
function permissionsIn(body: unknown): PermissionLevel | null {
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "permissions")) return null;
  return isPermissionLevel(body.permissions) ? body.permissions : null;
}

/**
 * POST messages' line: `text`, 0 to MAX_TEXT characters once trimmed, and `attachments`, up to
 * MAX_LINE_FILES files sent to POST files first, each named once; at least one of the two. Else
 * null.
 */
function lineIn(body: unknown): { text: string; files: Attachment[] } | null {
  if (!isPlainObject(body)) return null;
  if (Object.keys(body).some((key) => key !== "text" && key !== "attachments")) return null;
  const { text = "", attachments = [] } = body;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if ([...trimmed].length > MAX_TEXT || CONTROL_IN_TEXT.test(trimmed)) return null;
  const exact =
    Array.isArray(attachments) &&
    attachments.every(
      (file) =>
        isPlainObject(file) &&
        Object.keys(file).every((key) => key === "name" || key === "filename") &&
        (file.filename === undefined || typeof file.filename === "string"),
    );
  const files = exact ? lineFilesOf(attachments) : null;
  if (files === null) return null;
  return trimmed === "" && files.length === 0 ? null : { text: trimmed, files };
}

/**
 * A file sent to POST files as the chat keeps it: a `text` one as UTF-8 text, as it is, and anything
 * else as an image, made ready for her mind; or why it can't be kept.
 */
async function keptFile(
  text: boolean,
  bytes: Uint8Array,
): Promise<NormalizedImage | { readonly refused: ImageRefusal }> {
  if (!text) return normalizeImage(bytes, MAX_SENT_IMAGE_PIXELS);
  return sendableText(bytes) === null ? { refused: "unsupported" } : { bytes, mime: "text/plain" };
}

/** POST voice's `durationMs`, a whole number of ms from 1; else null. */
function durationIn(url: URL): number | null {
  const value = url.searchParams.get("durationMs");
  if (value === null || !/^\d{1,15}$/.test(value)) return null;
  const ms = Number(value);
  return ms > 0 ? ms : null;
}

/** The answer to a voice message that couldn't be heard. */
function hearingFailure(id: string, { cause }: HearingFailed): Response {
  if (cause instanceof ProviderConfigError) {
    return localError(
      409,
      "missing-key",
      `The hearing role can't hear a voice message. ${cause.message}`,
    );
  }
  return localFailure(502, "upstream-failed", "The voice message couldn't be transcribed", (log) =>
    logger.exception(`Chat ${id}: a voice message couldn't be heard (error ${log})`, cause),
  );
}

/** The 409 when persona `id`'s mind takes a key and has none; the caller validates `id`. */
function missingMindKey(id: string, whose: string): Response | null {
  const selection = withPersona(id, () => trySelect("mind"));
  if (selection === null || hasKey(selection)) return null;
  return localError(
    409,
    "missing-key",
    `${whose} mind role has no key. ${missingKey(selection).message}`,
  );
}

/** Why personas `ids` can't reply: the first that doesn't exist, or whose mind has no key. */
function speakersRefusal(ids: readonly string[]): Response | null {
  for (const id of ids) {
    const refused = personaRefusal(id) ?? missingMindKey(id, ids.length > 1 ? `${id}'s` : "Her");
    if (refused !== null) return refused;
  }
  return null;
}

function chatRefusal(id: string): Response | null {
  return isChatId(id) ? null : localError(400, "bad-request", "That is not a chat id");
}

/** The 404 for a chat the store doesn't have, the 409 for one in a call, else null. */
export function chatErrorResponse(error: unknown): Response | null {
  if (error instanceof ChatStoreError && error.code === "not-found") {
    return localError(404, "unknown-chat", "No chat has that id");
  }
  if (error instanceof ChatInCall) {
    return localError(409, "chat-in-call", "The chat is in a call; hang up first");
  }
  return null;
}

/** `answer()`, with chatErrorResponse's answer for the errors it knows. */
async function inChat(answer: () => Promise<Response>): Promise<Response> {
  try {
    return await answer();
  } catch (error) {
    const refused = chatErrorResponse(error);
    if (refused === null) throw error;
    return refused;
  }
}

/**
 * The chats' one runner, shared by these routes and the offer route's calls, and shut down with the
 * server. Made by its first use: building the route table touches no disk.
 */
export function chatRunner(
  app: Pick<LocalApp, "onStop">,
  options: ChatRunnerOptions = {},
): () => ChatRunner {
  let made: ChatRunner | null = null;
  app.onStop(async () => {
    await made?.shutdown();
  });
  return () => {
    made ??= new ChatRunner(options);
    return made;
  };
}

export function chatsRoutes(runner: () => ChatRunner): LocalRouteSpec[] {
  return [
    {
      route: "GET /api/local/chats",
      handler: async () => localJson(200, await runner().list()),
    },
    {
      route: "POST /api/local/chats",
      async handler(request) {
        const body = await readJson(request, BODY_LIMIT);
        if (!body.ok) return body.response;
        const participants = participantsOf(body.value);
        if (participants === null) {
          return localError(400, "bad-request", "`participants` names 1 to 6 personas, each once");
        }
        const refused = speakersRefusal(participants);
        if (refused !== null) return refused;
        return localJson(201, { id: await runner().create(participants) });
      },
    },
    {
      route: "GET /api/local/chats/:id",
      handler(_request, { params, url }) {
        const id = params.id as string;
        const after = url.searchParams.get("afterSeq");
        if (after !== null && !/^\d{1,15}$/.test(after)) {
          return localError(400, "bad-request", "`afterSeq` is a seq, 0 or more");
        }
        return (
          chatRefusal(id) ??
          inChat(async () => localJson(200, await runner().read(id, Number(after ?? 0))))
        );
      },
    },
    {
      route: "PATCH /api/local/chats/:id",
      async handler(request, { params }) {
        const id = params.id as string;
        const refused = chatRefusal(id);
        if (refused !== null) return refused;
        const body = await readJson(request, BODY_LIMIT);
        if (!body.ok) return body.response;
        const title = titleIn(body.value);
        const chainLimit = chainLimitOf(body.value);
        const replyMode = replyModeIn(body.value);
        const display = displayIn(body.value);
        const permissions = permissionsIn(body.value);
        if (
          title === null &&
          chainLimit === null &&
          replyMode === null &&
          display === null &&
          permissions === null
        ) {
          return localError(
            400,
            "bad-request",
            "Send a `title` of 1 to 80 characters on one line, a `chainLimit` from 0 to 100, a `replyMode` of auto, text or voice, a `display` of focus, normal or verbose, or `permissions` of ask, auto or full",
          );
        }
        return inChat(async () => {
          if (title !== null) await runner().rename(id, title);
          else if (chainLimit !== null) await runner().changeSettings(id, { chainLimit });
          else if (replyMode !== null) await runner().changeSettings(id, { replyMode });
          else if (display !== null) await runner().changeSettings(id, { display });
          else if (permissions !== null) await runner().changeSettings(id, { permissions });
          return localJson(200, { ok: true });
        });
      },
    },
    {
      route: "DELETE /api/local/chats/:id",
      handler(_request, { params }) {
        const id = params.id as string;
        return (
          chatRefusal(id) ??
          inChat(async () => {
            await runner().remove(id);
            return localJson(200, { ok: true });
          })
        );
      },
    },
    {
      route: "POST /api/local/chats/:id/files",
      async handler(request, { params, url }) {
        const id = params.id as string;
        const refused = chatRefusal(id);
        if (refused !== null) return refused;
        const sentAs = request.headers.get("content-type") ?? "";
        const text = sentAs.toLowerCase().startsWith("text/");
        const bytes = await readBytes(request, text ? MAX_TEXT_FILE_BYTES : MAX_SENT_IMAGE_BYTES);
        if (bytes?.byteLength === 0) return localError(400, "bad-request", "The file is empty");
        const kept =
          bytes === null ? { refused: "too-large" as const } : await keptFile(text, bytes);
        if ("refused" in kept) {
          if (kept.refused === "too-large") {
            return localError(
              413,
              "payload-too-large",
              text ? "A text file is at most 1 MB" : "An image is at most 50 MB and 64 megapixels",
            );
          }
          return localError(
            415,
            "unsupported-media-type",
            "Send a PNG, JPEG, WebP or GIF image, or a text file in UTF-8",
          );
        }
        return inChat(async () => {
          const saved = await runner().store.saveFile(id, kept.bytes, kept.mime);
          const filename =
            saved.kind === "file" ? sentFilename(url.searchParams.get("filename")) : null;
          return localJson(201, filename === null ? saved : { ...saved, filename });
        });
      },
    },
    {
      route: "POST /api/local/chats/:id/messages",
      async handler(request, { params }) {
        const id = params.id as string;
        const refused = chatRefusal(id);
        if (refused !== null) return refused;
        const body = await readJson(request, BODY_LIMIT);
        if (!body.ok) return body.response;
        const line = lineIn(body.value);
        if (line === null) {
          return localError(
            400,
            "bad-request",
            "Send `text` of up to 4000 characters, `attachments` naming up to 8 files sent to `files`, or both",
          );
        }
        return inChat(async () => {
          const blocked = speakersRefusal(await runner().participants(id));
          if (blocked !== null) return blocked;
          const store = runner().store;
          if (line.files.some(({ name }) => !existsSync(store.filePath(id, name)))) {
            return localError(400, "bad-request", "Send each file to `files` before the line");
          }
          return ndjsonResponse((await runner().send(id, line.text, line.files)).stream());
        });
      },
    },
    {
      route: "POST /api/local/chats/:id/voice",
      async handler(request, { params, url }) {
        const id = params.id as string;
        const refused = chatRefusal(id);
        if (refused !== null) return refused;
        const mime = request.headers.get("content-type") ?? "";
        if (attachmentKind(mime) !== "audio") {
          return localError(
            415,
            "unsupported-media-type",
            "Send a voice message as audio/webm, audio/ogg, audio/mp4 or audio/mpeg",
          );
        }
        const durationMs = durationIn(url);
        if (durationMs === null) {
          return localError(400, "bad-request", "`durationMs` is the clip's length in ms, from 1");
        }
        if (durationMs > MAX_VOICE_MS) {
          return localError(413, "payload-too-large", "A voice message is at most 2 minutes");
        }
        return inChat(async () => {
          const participants = await runner().participants(id);
          const blocked = speakersRefusal(participants);
          if (blocked !== null) return blocked;
          const deaf = hearingRefusal(participants);
          if (deaf !== null) return localError(409, "missing-key", deaf);
          const bytes = await readBytes(request, MAX_VOICE_BYTES);
          if (bytes === null) {
            return localError(413, "payload-too-large", "A voice message is at most 10 MB");
          }
          if (bytes.byteLength === 0) {
            return localError(400, "bad-request", "The voice message is empty");
          }
          try {
            const live = await runner().sendVoice(id, { bytes, mime, durationMs });
            return ndjsonResponse(live.stream());
          } catch (error) {
            if (error instanceof HearingFailed) return hearingFailure(id, error);
            throw error;
          }
        });
      },
    },
    {
      route: "GET /api/local/chats/:id/live",
      handler(_request, { params }) {
        const id = params.id as string;
        return (
          chatRefusal(id) ??
          inChat(async () => {
            const live = runner().live(id);
            if (live !== null) return ndjsonResponse(live.stream());
            await runner().store.summary(id);
            return new Response(null, { status: 204 });
          })
        );
      },
    },
    {
      route: "POST /api/local/chats/:id/stop",
      handler(_request, { params }) {
        const id = params.id as string;
        return (
          chatRefusal(id) ??
          inChat(async () => {
            await runner().stop(id);
            return new Response(null, { status: 204 });
          })
        );
      },
    },
    {
      route: "POST /api/local/chats/:id/participants",
      async handler(request, { params }) {
        const id = params.id as string;
        const refused = chatRefusal(id);
        if (refused !== null) return refused;
        const body = await readJson(request, BODY_LIMIT);
        if (!body.ok) return body.response;
        const change = changeOf(body.value);
        if (change === null) {
          return localError(
            400,
            "bad-request",
            "Send `add` or `remove`, lists of personas, naming each once",
          );
        }
        // Only those added are looked up: one deleted since can still be removed.
        const blocked = speakersRefusal(change.add);
        if (blocked !== null) return blocked;
        return inChat(async () => {
          if (!(await runner().changeParticipants(id, change.add, change.remove))) {
            return localError(
              400,
              "bad-request",
              "Add personas not in the chat and remove ones in it, keeping 1 to 6",
            );
          }
          return localJson(200, { ok: true });
        });
      },
    },
    {
      route: "GET /api/local/chats/:id/files/:name",
      image: true,
      cache: IMMUTABLE,
      handler(request, { params }) {
        const id = params.id as string;
        const name = params.name as string;
        const refused = chatRefusal(id);
        if (refused !== null) return refused;
        const mime = attachmentMime(name);
        if (mime === null) {
          return localError(400, "invalid-file-name", "That is not an attachment's name");
        }
        const path = runner().store.filePath(id, name);
        if (!existsSync(path)) return localError(404, "not-found", "No such file");
        // Under nosniff, text with no charset reads as windows-1252; the viewer's is kept as UTF-8.
        const type = mime === "text/plain" ? "text/plain; charset=utf-8" : mime;
        return fileResponse(request, path, imageHeaders(type));
      },
    },
  ];
}
