// A call inside a chat: a local POST /api/offer whose requestData names a chat and one of its
// personas. The session runs as her and opens on her view of the chat; the runner stores its lines.
// With `group`, every persona in the chat is on the call, she hosting.
import type { AllowedOffer, JsonObject } from "@eidolon/access";
import { isChatId } from "@eidolon/chat";
import { logger, pyRepr } from "@eidolon/config";
import type { SignallingResult, SignallingServer } from "@eidolon/runtime";
import { jsonResponse } from "../../responses.ts";
import type { ChatCallRequestData } from "../api.ts";
import { personaRefusal } from "../personas.ts";
import { localError } from "../responses.ts";
import { chatErrorResponse } from "../routes/chats.ts";
import { type ChatCall, type ChatRunner, type GroupChatCall, NotInChat } from "./runner.ts";

/** The chat call `requestData` asks for; null without a `chatId`, else the 4xx for a bad one. */
export function chatCallTarget(
  requestData: JsonObject | null,
): ChatCallRequestData | null | Response {
  const chatId = requestData?.chatId;
  if (chatId === undefined) return null;
  if (typeof chatId !== "string" || !isChatId(chatId)) {
    return localError(400, "bad-request", "`chatId` is not a chat id");
  }
  const persona = requestData?.persona;
  if (typeof persona !== "string") {
    return localError(400, "bad-request", "A call in a chat names the `persona` it calls");
  }
  const group = requestData?.group;
  if (group !== undefined && typeof group !== "boolean") {
    return localError(400, "bad-request", "`group` is true or false");
  }
  return personaRefusal(persona) ?? { chatId, persona, ...(group ? { group } : {}) };
}

/** The 4xx for a call the runner refused to open, or null for an error it didn't expect. */
function refusal(error: unknown): Response | null {
  if (error instanceof NotInChat) {
    return localError(400, "bad-request", "That persona isn't in the chat");
  }
  return chatErrorResponse(error);
}

/**
 * Opens the call in the chat, then answers the offer with a session bound to it. An offer that
 * gets no answer ends the call it opened. The call's own connection renegotiating starts nothing.
 */
export async function offerChatCall(
  chats: ChatRunner,
  signalling: Pick<SignallingServer, "offer">,
  admission: AllowedOffer,
  { chatId, persona, group }: ChatCallRequestData,
): Promise<Response> {
  const pcId = admission.body?.pc_id;
  const active = chats.callIn(chatId);
  if (active !== null && typeof pcId === "string" && active.pcId === pcId) {
    const result = await signalling.offer(admission);
    return jsonResponse(result.status, result.body);
  }
  let call: ChatCall | GroupChatCall;
  try {
    if (group) {
      const refused = await chats.groupCallRefusal(chatId);
      if (refused !== null) return localError(refused.status, refused.code, refused.message);
      call = await chats.startGroupCall(chatId, persona);
    } else {
      call = await chats.startCall(chatId, persona);
    }
  } catch (error) {
    const refused = refusal(error);
    if (refused === null) throw error;
    return refused;
  }
  const whom = group
    ? `everyone in chat ${chatId}, ${pyRepr(persona)} hosting`
    : `${pyRepr(persona)} in chat ${chatId}`;
  logger.info(`[local] Offer from the local viewer to ${whom} (call ${call.id})`);
  let result: SignallingResult;
  try {
    result = await signalling.offer(admission, call);
  } catch (error) {
    await call.onEnded("error");
    throw error;
  }
  const answered = (result.body as { pc_id?: unknown } | null)?.pc_id;
  if (result.status === 200 && typeof answered === "string") call.connected(answered);
  else await call.onEnded("error");
  return jsonResponse(result.status, result.body);
}
