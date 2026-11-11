// A call inside a chat, as the local app and production both keep it: what the call opens on, and
// the `call` messages its lines and her photos become.
import type { ChatEventDraft, ParticipantId, ViewMessage } from "@eidolon/chat";
import { fetchStoredSelfie, saveSelfies } from "./attachments.ts";
import { turnView } from "./turn.ts";
import type { EngineDeps, TurnRequest } from "./types.ts";

/**
 * Her view of the chat as her next turn would read it, less her tool calls and their results: what
 * a call bound to it opens on. The call may offer no tools, and Anthropic refuses a request that
 * holds a tool_use block then.
 */
export function callSeed(
  chat: TurnRequest["chat"],
  persona: ParticipantId,
  viewerName: string,
): ViewMessage[] {
  return turnView(chat, persona, viewerName).messages.filter(
    (message) => message.role !== "tool" && !("tool_calls" in message),
  );
}

/** A finished line of her call, the viewer's or hers, as a `call` message. */
export function callLine(
  line: {
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly interrupted: boolean;
  },
  persona: ParticipantId,
): ChatEventDraft {
  return {
    type: "message",
    id: Bun.randomUUIDv7(),
    speaker: line.role === "user" ? { kind: "user" } : { kind: "persona", id: persona },
    text: line.text,
    modality: "call",
    ...(line.interrupted ? { interrupted: true } : {}),
  };
}

/**
 * The photos a `selfie` server message of her call names, copied from the selfie store through
 * `save`, as her `call` message with no words; null for any other message. Never aborted: the
 * photo is rendered and billed.
 */
export async function callPhotos(
  data: Readonly<Record<string, unknown>>,
  persona: ParticipantId,
  save: EngineDeps["saveAttachment"],
): Promise<ChatEventDraft | null> {
  const attachments = await saveSelfies(data, new AbortController().signal, {
    fetchImage: (url) => fetchStoredSelfie(url),
    saveAttachment: save,
  });
  if (attachments.length === 0) return null;
  return {
    type: "message",
    id: Bun.randomUUIDv7(),
    speaker: { kind: "persona", id: persona },
    text: "",
    attachments,
    modality: "call",
  };
}
