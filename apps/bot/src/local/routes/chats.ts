// /api/local/chats: text chats with the personas, kept in the data home. A reply streams as NDJSON
// while it runs, and GET live picks it up again from its start.
import { existsSync } from "node:fs";
import { attachmentMime, ChatStoreError, isChatId } from "@eidolon/chat";
import { isPlainObject, withPersona } from "@eidolon/config";
import { hasKey, missingKey, trySelect } from "@eidolon/providers";
import { ChatRunner, type ChatRunnerOptions } from "../chats/runner.ts";
import { personaRefusal } from "../personas.ts";
import { imageResponse, localError, localJson, ndjsonResponse, readJson } from "../responses.ts";
import type { LocalApp, LocalRouteSpec } from "../router.ts";

const MAX_TEXT = 4000;
const MAX_TITLE = 80;
/** 4000 characters, each escaped as JSON at worst. */
const BODY_LIMIT = 64 * 1024;
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

/** The persona a create names: exactly one, for now. */
function participantsOf(body: unknown): string[] | null {
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "participants")) return null;
  const { participants } = body;
  if (!Array.isArray(participants) || participants.length !== 1) return null;
  return participants.every((id) => typeof id === "string") ? (participants as string[]) : null;
}

/** The 409 when persona `id`'s mind takes a key and has none; the caller validates `id`. */
function missingMindKey(id: string): Response | null {
  const selection = withPersona(id, () => trySelect("mind"));
  if (selection === null || hasKey(selection)) return null;
  return localError(
    409,
    "missing-key",
    `Her mind role has no key. ${missingKey(selection).message}`,
  );
}

function chatRefusal(id: string): Response | null {
  return isChatId(id) ? null : localError(400, "bad-request", "That is not a chat id");
}

/** `answer()`, with a chat the store doesn't have as a 404. */
async function inChat(answer: () => Promise<Response>): Promise<Response> {
  try {
    return await answer();
  } catch (error) {
    if (error instanceof ChatStoreError && error.code === "not-found") {
      return localError(404, "unknown-chat", "No chat has that id");
    }
    throw error;
  }
}

export function chatsRoutes(app: LocalApp, options: ChatRunnerOptions = {}): LocalRouteSpec[] {
  // Made by the first request: building the route table touches no disk.
  let made: ChatRunner | null = null;
  const runner = (): ChatRunner => {
    made ??= new ChatRunner(options);
    return made;
  };
  app.onStop(async () => {
    await made?.shutdown();
  });

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
          return localError(400, "bad-request", "`participants` names exactly one persona");
        }
        const [persona] = participants as [string];
        const refused = personaRefusal(persona) ?? missingMindKey(persona);
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
        if (title === null) {
          return localError(400, "bad-request", "`title` is 1 to 80 characters on one line");
        }
        return inChat(async () => {
          await runner().rename(id, title);
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
          const persona = await runner().replier(id);
          const blocked = personaRefusal(persona) ?? missingMindKey(persona);
          if (blocked !== null) return blocked;
          return ndjsonResponse((await runner().send(id, text, persona)).stream());
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
      route: "GET /api/local/chats/:id/files/:name",
      image: true,
      cache: IMMUTABLE,
      handler(_request, { params }) {
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
        return imageResponse(Bun.file(path), mime);
      },
    },
  ];
}
