// /api/local/chats: chats with the personas, in text and voice messages, kept in the data home. A
// reply streams as NDJSON while it runs, and GET live picks it up again from its start, or streams
// a call's lines as they are stored.
import { existsSync } from "node:fs";
import {
  attachmentKind,
  attachmentMime,
  ChatStoreError,
  isChatId,
  isReplyMode,
  MAX_CHAIN_LIMIT,
  MAX_PARTICIPANTS,
  type ReplyMode,
} from "@eidolon/chat";
import { isPlainObject, logger, withPersona } from "@eidolon/config";
import { hasKey, missingKey, ProviderConfigError, trySelect } from "@eidolon/providers";
import { HearingFailed, hearingRefusal } from "../chats/hearing.ts";
import { ChatInCall, ChatRunner, type ChatRunnerOptions } from "../chats/runner.ts";
import { personaRefusal } from "../personas.ts";
import {
  imageResponse,
  localError,
  localFailure,
  localJson,
  ndjsonResponse,
  readBytes,
  readJson,
} from "../responses.ts";
import type { LocalApp, LocalRouteSpec } from "../router.ts";

const MAX_TEXT = 4000;
const MAX_TITLE = 80;
/** 4000 characters, each escaped as JSON at worst. */
const BODY_LIMIT = 64 * 1024;
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const MAX_VOICE_MS = 2 * 60 * 1000;
// Attachments are named by their content's hash: a name never changes what it serves.
const IMMUTABLE = "private, max-age=31536000, immutable";
/** Control characters other than a tab or a line break. */
const CONTROL_IN_TEXT = /(?![\t\n\r])\p{Cc}/u;
const CONTROL = /\p{Cc}/u;

/** `body`'s one string field `name`, trimmed, when it is 1 to `max` characters; else null. */
function field(body: unknown, name: string, max: number, control: RegExp): string | null {
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== name)) return null;
  const value = body[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const length = [...trimmed].length;
  return length === 0 || length > max || control.test(trimmed) ? null : trimmed;
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
        const title = field(body.value, "title", MAX_TITLE, CONTROL);
        const chainLimit = chainLimitOf(body.value);
        const replyMode = replyModeIn(body.value);
        if (title === null && chainLimit === null && replyMode === null) {
          return localError(
            400,
            "bad-request",
            "Send a `title` of 1 to 80 characters on one line, a `chainLimit` from 0 to 6, or a `replyMode` of auto, text or voice",
          );
        }
        return inChat(async () => {
          if (title !== null) await runner().rename(id, title);
          else if (chainLimit !== null) await runner().changeSettings(id, { chainLimit });
          else await runner().changeSettings(id, { replyMode: replyMode as ReplyMode });
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
      route: "POST /api/local/chats/:id/messages",
      async handler(request, { params }) {
        const id = params.id as string;
        const refused = chatRefusal(id);
        if (refused !== null) return refused;
        const body = await readJson(request, BODY_LIMIT);
        if (!body.ok) return body.response;
        const text = field(body.value, "text", MAX_TEXT, CONTROL_IN_TEXT);
        if (text === null) return localError(400, "bad-request", "`text` is 1 to 4000 characters");
        return inChat(async () => {
          const blocked = speakersRefusal(await runner().participants(id));
          if (blocked !== null) return blocked;
          return ndjsonResponse((await runner().send(id, text)).stream());
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
        // Bun.serve answers a Range request on a Bun.file body itself, with a 206 or 416 and its
        // own Accept-Ranges; a second one would read `bytes, bytes`. Safari plays audio only from
        // a server that takes ranges.
        const ranges: Record<string, string> = request.headers.has("range")
          ? {}
          : { "accept-ranges": "bytes" };
        return imageResponse(Bun.file(path), mime, ranges);
      },
    },
  ];
}
