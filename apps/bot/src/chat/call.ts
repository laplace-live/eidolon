// A production call inside a chat the browser keeps: POST /api/offer with the chat's signed window
// in requestData.chat. The session runs as the persona called and opens on her view of the window;
// each line said on it goes back to the browser numbered and signed, for the browser to store.
import {
  type AllowedOffer,
  chatPersonas,
  type JsonObject,
  type UserContext,
} from "@eidolon/access";
import {
  CHAT_WINDOW_MESSAGES,
  type ChatEvent,
  type ChatEventDraft,
  type ChatHeader,
  summarize,
  type ViewMessage,
  viewOf,
} from "@eidolon/chat";
import { errorText, isJsonObject, logger, pyRepr, readPersonaIdentity } from "@eidolon/config";
import { UNHEARD } from "@eidolon/engine";
import type { CallBinding } from "@eidolon/runtime";
import { jsonResponse } from "../responses.ts";
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
 * turn leaves them out.
 */
export async function bindChatCall(
  admission: AllowedOffer,
  signer: ChatSigner,
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
  const { header, events } = await store.read(store.header.id);
  if (!summarize(header, events).participants.includes(persona)) {
    return refusal(400, "bad-request", "That persona isn't in the chat");
  }
  const seedMessages = callSeed(header, events, persona, admission.user);
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
      onTranscript: chatLines(store, persona),
      onEnded: (end) =>
        logger.info(`[chat] Call to ${pyRepr(persona)} in chat ${header.id}: ${end}`),
    },
  };
}

/** Her view of the window, as her next text turn would read it, less tool calls and their results. */
function callSeed(
  header: ChatHeader,
  events: readonly ChatEvent[],
  persona: string,
  viewer: UserContext,
): ViewMessage[] {
  const heard = events.map((event) =>
    event.type === "message" &&
    event.speaker.kind === "user" &&
    event.modality === "voice" &&
    event.text === ""
      ? { ...event, text: UNHEARD }
      : event,
  );
  const view = viewOf(header, heard, persona, {
    windowMessages: CHAT_WINDOW_MESSAGES,
    nameOf: (id) => readPersonaIdentity(id).name,
    viewerName: viewer.uname ?? "",
  });
  return view.filter((message) => message.role !== "tool" && !("tool_calls" in message));
}

/**
 * Each finished line as a `call` message, numbered on from the window and signed unless it is the
 * viewer's, sent to the browser in the order said. One said after the browser hung up never reaches
 * it, and one whose sending fails is logged.
 */
function chatLines(store: RequestChatStore, persona: string): CallBinding["onTranscript"] {
  let sending: Promise<void> = Promise.resolve();
  return (line, client) => {
    const draft: ChatEventDraft = {
      type: "message",
      id: Bun.randomUUIDv7(),
      speaker: line.role === "user" ? { kind: "user" } : { kind: "persona", id: persona },
      text: line.text,
      modality: "call",
      ...(line.interrupted ? { interrupted: true } : {}),
    };
    sending = sending.then(async () => {
      try {
        const [event] = await store.add([draft]);
        await client?.sendServerMessage({ type: CHAT_LINE_MESSAGE, event });
      } catch (error) {
        logger.warning(
          `[chat] Chat ${store.header.id}: a call line didn't reach the browser: ${errorText(error)}`,
        );
      }
    });
  };
}
