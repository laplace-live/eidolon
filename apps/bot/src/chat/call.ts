// A production call inside a chat the browser keeps: POST /api/offer with the chat's signed window
// in requestData.chat. The session runs as the persona called and opens on her view of the window;
// each line said on it, and each photo she sends, goes back to the browser numbered and signed, for
// the browser to store.
import {
  type AllowedOffer,
  chatPersonas,
  type JsonObject,
  type UserContext,
} from "@eidolon/access";
import { type ChatEventDraft, summarize, type ViewMessage } from "@eidolon/chat";
import { errorText, isJsonObject, logger, pyRepr } from "@eidolon/config";
import { fetchStoredSelfie, saveSelfies, type TurnRequest, turnView } from "@eidolon/engine";
import type { CallBinding, CallClient } from "@eidolon/runtime";
import { jsonResponse } from "../responses.ts";
import { type ChatFiles, chatFiles } from "./files.ts";
import type { ChatSigner } from "./sig.ts";
import { openChatWindow, type RequestChatStore } from "./window.ts";

/** The RTVI server message's `type` for a line of the call, `{ type, event }`. */
export const CHAT_LINE_MESSAGE = "chat-line";

export interface BoundOffer {
  /** The admission without the window, which the session would otherwise log. */
  readonly admission: AllowedOffer;
  readonly binding: CallBinding;
}

/** The chat routes' error body, for an offer whose chat won't do. */
function refusal(status: 400 | 403, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } }, { "cache-control": "no-store" });
}

function withoutWindow(data: unknown): unknown {
  if (!isJsonObject(data) || !("chat" in data)) return data;
  const { chat: _, ...rest } = data;
  return rest;
}

/**
 * The call `admission` asks for in a chat: null when its requestData has no `chat`; a 400 when the
 * window isn't a chat's or `persona` isn't in it, a 403 when the endpoint doesn't serve her; else
 * the binding. Lines in the window that fail their signature are left out of her view, as a chat
 * turn leaves them out. Her photos wait in `files` for the browser to fetch.
 */
export async function bindChatCall(
  admission: AllowedOffer,
  signer: ChatSigner,
  files: ChatFiles = chatFiles,
): Promise<BoundOffer | Response | null> {
  const requestData = admission.requestData;
  if (requestData?.chat === undefined) return null;
  const persona = requestData.persona;
  if (typeof persona !== "string") {
    return refusal(400, "bad-request", "A call in a chat names the `persona` it calls");
  }
  if (!chatPersonas().includes(persona)) {
    return refusal(403, "persona-not-served", "That persona isn't served here");
  }
  const opened = await openChatWindow(requestData.chat, signer);
  if (!opened.ok) return refusal(400, "bad-request", opened.message);
  const { store } = opened;
  const chat = await store.read(store.header.id);
  const { header } = chat;
  if (!summarize(header, chat.events).participants.includes(persona)) {
    return refusal(400, "bad-request", "That persona isn't in the chat");
  }
  const seedMessages = callSeed(chat, persona, admission.user);
  logger.info(
    `[chat] Offer to ${pyRepr(persona)} in chat ${header.id}, ` +
      `opening on ${seedMessages.length} messages of her view`,
  );
  const body = admission.body && {
    ...admission.body,
    ...("requestData" in admission.body
      ? { requestData: withoutWindow(admission.body.requestData) }
      : {}),
    ...("request_data" in admission.body
      ? { request_data: withoutWindow(admission.body.request_data) }
      : {}),
  };
  return {
    admission: {
      ...admission,
      body,
      requestData: withoutWindow(requestData) as JsonObject,
    },
    binding: {
      persona,
      seedMessages,
      ...chatLines(store, persona, files),
      onEnded: (end) =>
        logger.info(`[chat] Call to ${pyRepr(persona)} in chat ${header.id}: ${end}`),
    },
  };
}

/** Her view of the window, as her next text turn would read it, less tool calls and their results. */
function callSeed(chat: TurnRequest["chat"], persona: string, viewer: UserContext): ViewMessage[] {
  return turnView(chat, persona, viewer.uname ?? "").messages.filter(
    (message) => message.role !== "tool" && !("tool_calls" in message),
  );
}

/**
 * Each finished line as a `call` message, numbered on from the window and signed unless it is the
 * viewer's, and each selfie she sends as her photos alone, `text: ""`, their files saved into
 * `files`: sent to the browser in the order said. One said after the browser hung up never reaches
 * it, and one whose sending fails is logged.
 */
function chatLines(
  store: RequestChatStore,
  persona: string,
  files: ChatFiles,
): Pick<CallBinding, "onTranscript" | "onServerMessage"> {
  let sending: Promise<void> = Promise.resolve();
  const send = (
    what: string,
    client: CallClient | undefined,
    drafts: () => Promise<ChatEventDraft | null>,
  ) => {
    sending = sending.then(async () => {
      try {
        const draft = await drafts();
        if (draft === null) return;
        const [event] = await store.add([draft]);
        await client?.sendServerMessage({ type: CHAT_LINE_MESSAGE, event });
      } catch (error) {
        logger.warning(
          `[chat] Chat ${store.header.id}: ${what} didn't reach the browser: ${errorText(error)}`,
        );
      }
    });
  };
  const photoDeps = {
    fetchImage: (url: string) => fetchStoredSelfie(url),
    saveAttachment: async (bytes: Uint8Array, mime: string) => files.save(bytes, mime),
  };
  return {
    onTranscript: (line, client) => {
      const draft: ChatEventDraft = {
        type: "message",
        id: Bun.randomUUIDv7(),
        speaker: line.role === "user" ? { kind: "user" } : { kind: "persona", id: persona },
        text: line.text,
        modality: "call",
        ...(line.interrupted ? { interrupted: true } : {}),
      };
      send("a call line", client, async () => draft);
    },
    onServerMessage: (data, client) => {
      if (data.type !== "selfie") return;
      send("a photo of the call", client, async () => {
        // Never aborted: the photo is rendered and billed.
        const attachments = await saveSelfies(data, new AbortController().signal, photoDeps);
        if (attachments.length === 0) return null;
        return {
          type: "message",
          id: Bun.randomUUIDv7(),
          speaker: { kind: "persona", id: persona },
          text: "",
          attachments,
          modality: "call",
        };
      });
    },
  };
}
