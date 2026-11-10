// A production call inside a chat the browser keeps: POST /api/offer with the chat's signed window
// in requestData.chat. The session runs as the persona called and opens on her view of the window;
// each line said on it, and each photo she sends, goes back to the browser numbered and signed, for
// the browser to store.
import type { AllowedOffer, JsonObject } from "@eidolon/access";
import { type ChatEventDraft, type ParticipantId, summarize } from "@eidolon/chat";
import { errorText, isJsonObject, logger, pyRepr } from "@eidolon/config";
import { callLine, callPhotos, callSeed } from "@eidolon/engine";
import type { CallBinding, CallClient } from "@eidolon/runtime";
import { chatError } from "./errors.ts";
import type { ChatFiles } from "./files.ts";
import type { ChatSigner } from "./sig.ts";
import { openChatWindow, type RequestChatStore } from "./window.ts";

/** The RTVI server message's `type` for a line of the call, `{ type, event }`. */
export const CHAT_LINE_MESSAGE = "chat-line";

export interface BoundOffer {
  /** The admission without the window: the session holds it for the whole call, and logs it. */
  readonly admission: AllowedOffer;
  readonly binding: CallBinding;
}

/** What a chat's call shares with the endpoint's routes. */
export interface ChatCallOptions {
  readonly signer: ChatSigner;
  /** Where her photos wait for the browser to fetch. */
  readonly files: ChatFiles;
  readonly personas: () => readonly ParticipantId[];
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
  { signer, files, personas }: ChatCallOptions,
): Promise<BoundOffer | Response | null> {
  const requestData = admission.requestData;
  if (requestData?.chat === undefined) return null;
  const persona = requestData.persona;
  if (typeof persona !== "string") {
    return chatError(400, "bad-request", "A call in a chat names the `persona` it calls");
  }
  if (!personas().includes(persona)) {
    return chatError(403, "persona-not-served", "That persona isn't served here");
  }
  const opened = await openChatWindow(requestData.chat, signer);
  if (!opened.ok) return chatError(400, "bad-request", opened.message);
  const { store } = opened;
  const chat = await store.read(store.header.id);
  const { header } = chat;
  if (!summarize(header, chat.events).participants.includes(persona)) {
    return chatError(400, "bad-request", "That persona isn't in the chat");
  }
  const seedMessages = callSeed(chat, persona, admission.user.uname ?? "");
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
    make: () => Promise<ChatEventDraft | null>,
  ) => {
    sending = sending.then(async () => {
      try {
        const draft = await make();
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
  const save = async (bytes: Uint8Array, mime: string) => files.save(bytes, mime);
  return {
    onTranscript: (line, client) => {
      const draft = callLine(line, persona);
      send("a call line", client, async () => draft);
    },
    onServerMessage: (data, client) => {
      send("a photo of the call", client, () => callPhotos(data, persona, save));
    },
  };
}
