// A call inside a chat: a local POST /api/offer whose requestData names a chat and one of its
// personas. The session runs as her and opens on her view of the chat; the runner stores its lines.
import type { AllowedOffer, JsonObject } from "@eidolon/access";
import { ChatStoreError, isChatId, type ParticipantId } from "@eidolon/chat";
import { logger, pyRepr } from "@eidolon/config";
import type { CallBinding, SignallingResult, SignallingServer } from "@eidolon/runtime";
import { jsonResponse } from "../../responses.ts";
import { personaRefusal } from "../personas.ts";
import { localError } from "../responses.ts";
import { type ChatCall, ChatInCall, type ChatRunner, NotInChat } from "./runner.ts";

export interface ChatCallTarget {
  readonly chatId: string;
  readonly persona: ParticipantId;
}

/** The chat call `requestData` asks for; null without a `chatId`, else the 4xx for a bad one. */
export function chatCallTarget(requestData: JsonObject | null): ChatCallTarget | null | Response {
  const chatId = requestData?.chatId;
  if (chatId === undefined) return null;
  if (typeof chatId !== "string" || !isChatId(chatId)) {
    return localError(400, "bad-request", "`chatId` is not a chat id");
  }
  const persona = requestData?.persona;
  if (typeof persona !== "string") {
    return localError(400, "bad-request", "A call in a chat names the `persona` it calls");
  }
  return personaRefusal(persona) ?? { chatId, persona };
}

/** The 4xx for a call the runner refused to open, or null for an error it didn't expect. */
function refusal(error: unknown): Response | null {
  if (error instanceof ChatStoreError && error.code === "not-found") {
    return localError(404, "unknown-chat", "No chat has that id");
  }
  if (error instanceof ChatInCall) {
    return localError(409, "chat-in-call", "The chat is in a call; hang up first");
  }
  if (error instanceof NotInChat) {
    return localError(400, "bad-request", "That persona isn't in the chat");
  }
  return null;
}

/**
 * Opens the call in the chat, then answers the offer with a session bound to it. An offer that
 * gets no answer ends the call it opened. The call's own connection renegotiating starts nothing.
 */
export async function offerChatCall(
  chats: ChatRunner,
  signalling: Pick<SignallingServer, "offer">,
  admission: AllowedOffer,
  { chatId, persona }: ChatCallTarget,
): Promise<Response> {
  const pcId = admission.body?.pc_id;
  const active = chats.callIn(chatId);
  if (active !== null && typeof pcId === "string" && active.pcId === pcId) {
    const result = await signalling.offer(admission);
    return jsonResponse(result.status, result.body);
  }
  let call: ChatCall;
  try {
    call = await chats.startCall(chatId, persona);
  } catch (error) {
    const refused = refusal(error);
    if (refused === null) throw error;
    return refused;
  }
  logger.info(
    `[local] Offer from the local viewer to ${pyRepr(persona)} in chat ${chatId} (call ${call.id})`,
  );
  const binding: CallBinding = {
    persona,
    seedMessages: call.seed,
    onTranscript: (line) => call.line(line),
    onEnded: (reason) => {
      void call.end(reason);
    },
  };
  let result: SignallingResult;
  try {
    result = await signalling.offer(admission, binding);
  } catch (error) {
    await call.end("error");
    throw error;
  }
  const answered = (result.body as { pc_id?: unknown } | null)?.pc_id;
  if (result.status === 200 && typeof answered === "string") call.connected(answered);
  else await call.end("error");
  return jsonResponse(result.status, result.body);
}
