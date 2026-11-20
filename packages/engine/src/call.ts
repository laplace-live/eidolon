// A call inside a chat, as the local app and production both keep it: what the call opens on, and
// the `call` messages its lines and her photos become.
import type { ChatEventDraft, ParticipantId, ViewMessage } from "@eidolon/chat";
import { newId } from "@eidolon/config";
import { fetchStoredSelfie, saveSelfies } from "./attachments.ts";
import { filesNote } from "./seen.ts";
import { turnView } from "./turn.ts";
import type { EngineDeps, TurnRequest } from "./types.ts";

/**
 * Her view of the chat as her next turn would read it, less her tool calls and their results: what
 * a call bound to it opens on. The call may offer no tools, and Anthropic refuses a request that
 * holds a tool_use block then. What she said before her calls joins her next line into one when no
 * other line comes between, and stands as a line of hers before the next one otherwise. A line the
 * viewer sent files with reads their note after its words, since a call's log holds text alone.
 */
export function callSeed(
  chat: TurnRequest["chat"],
  persona: ParticipantId,
  viewerName: string,
): ViewMessage[] {
  const seed: ViewMessage[] = [];
  let said = "";
  for (const viewed of turnView(chat, persona, viewerName).messages) {
    const message: ViewMessage =
      "attachments" in viewed
        ? { role: "user", content: viewed.content + filesNote(viewed.attachments) }
        : viewed;
    if (message.role === "tool") continue;
    if ("tool_calls" in message) {
      said += message.content ?? "";
    } else if (message.role === "assistant") {
      seed.push({ role: "assistant", content: said + message.content });
      said = "";
    } else {
      if (message.role === "user" && said !== "") {
        seed.push({ role: "assistant", content: said });
        said = "";
      }
      seed.push(message);
    }
  }
  if (said !== "") seed.push({ role: "assistant", content: said });
  return seed;
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
    id: newId(),
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
    id: newId(),
    speaker: { kind: "persona", id: persona },
    text: "",
    attachments,
    modality: "call",
  };
}
