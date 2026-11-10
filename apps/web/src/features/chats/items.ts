// What a chat's log shows: the lines said and the turns that failed. Recall, tool events, the
// greeting prompt and the bookkeeping events stay hidden.
import type { Attachment, ChatEvent, ParticipantId } from "@eidolon/chat";
import { parseMarkup } from "@/lib/markup";

export type ChatItem =
  | { readonly kind: "user"; readonly seq: number; readonly text: string }
  | {
      readonly kind: "persona";
      readonly seq: number;
      readonly persona: ParticipantId;
      readonly text: string;
      readonly images: readonly Attachment[];
      readonly interrupted: boolean;
    }
  | {
      readonly kind: "failed";
      readonly seq: number;
      readonly persona: ParticipantId;
      readonly error: string;
    };

export function chatItems(events: readonly ChatEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const event of events) {
    if (event.type === "message") {
      const images = (event.attachments ?? []).filter((file) => file.kind === "image");
      if (event.speaker.kind === "user") {
        if (event.text !== "") items.push({ kind: "user", seq: event.seq, text: event.text });
      } else if (event.text !== "" || images.length > 0) {
        items.push({
          kind: "persona",
          seq: event.seq,
          persona: event.speaker.id,
          text: event.text,
          images,
          interrupted: event.interrupted === true,
        });
      }
    } else if (event.type === "turn-failed") {
      items.push({ kind: "failed", seq: event.seq, persona: event.persona, error: event.error });
    }
  }
  return items;
}

/** What Retry sends again: the viewer's last line, if anything followed it only to fail. */
export function retryText(items: readonly ChatItem[]): string | null {
  if (items.at(-1)?.kind !== "failed") return null;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === "user") return item.text;
    if (item.kind === "persona") return null;
  }
  return null;
}

const PARTIAL_MARKUP = /(?:\[[^[\]\n]*|<\/?[A-Za-z]*)$/;

/**
 * `text` without a cue or tag cut off at its end, as a reply still streaming, or one interrupted,
 * ends: `…真的</emp` shows as `…真的`.
 */
export function withoutPartialMarkup(text: string): string {
  return text.replace(PARTIAL_MARKUP, "");
}

/** A line as one row of plain text: her cues as their emoji, directions and tags dropped. */
export function previewText(text: string): string {
  return parseMarkup(withoutPartialMarkup(text))
    .map((token) => (token.kind === "text" ? token.text : token.kind === "cue" ? token.emoji : " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
