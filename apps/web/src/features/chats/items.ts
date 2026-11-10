// What a chat's log shows: the lines said and the turns that failed. Recall, tool events, the
// greeting prompt and the bookkeeping events stay hidden.
import type { Attachment, ChatEvent, CutOff, ParticipantId, Speaker } from "@eidolon/chat";
import { parseMarkup } from "@/lib/markup";
import { type ReplyReason, reasonOf } from "./group";

export type ChatItem =
  | { readonly kind: "user"; readonly seq: number; readonly text: string }
  | {
      readonly kind: "persona";
      readonly seq: number;
      readonly persona: ParticipantId;
      readonly text: string;
      readonly images: readonly Attachment[];
      readonly interrupted: boolean;
      readonly cutOff: CutOff | null;
      /** The decision her turn answered; null for a greeting, or a late photo of unknown turn. */
      readonly reason: ReplyReason | null;
    }
  | {
      readonly kind: "failed";
      readonly seq: number;
      readonly persona: ParticipantId;
      readonly error: string;
    };

export function chatItems(events: readonly ChatEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const speakers = new Map<number, Speaker>();
  const chosen = new Map<ParticipantId, ReplyReason>();
  // The decision each turn began under, by turn.
  const turns = new Map<string, ReplyReason | null>();
  let previous: ChatEvent | undefined;
  for (const event of events) {
    if ("turn" in event && !turns.has(event.turn)) {
      turns.set(event.turn, chosen.get(event.persona) ?? null);
    }
    if (event.type === "decision") {
      const reason = reasonOf(event, speakers);
      for (const reply of event.replies) chosen.set(reply.persona, reason);
    } else if (event.type === "message") {
      speakers.set(event.seq, event.speaker);
      const images = (event.attachments ?? []).filter((file) => file.kind === "image");
      if (event.speaker.kind === "user") {
        if (event.text !== "") items.push({ kind: "user", seq: event.seq, text: event.text });
      } else if (event.text !== "" || images.length > 0 || event.cutOff !== undefined) {
        // Photos that land after her interrupted turn follow its result, when it brought one, and
        // a decision since may have chosen her again: they take her turn's decision, or none.
        const late = event.text === "" && !event.interrupted && event.cutOff === undefined;
        const turn =
          late && previous?.type === "tool-result" && previous.persona === event.speaker.id
            ? previous.turn
            : null;
        items.push({
          kind: "persona",
          seq: event.seq,
          persona: event.speaker.id,
          text: event.text,
          images,
          interrupted: event.interrupted === true,
          cutOff: event.cutOff ?? null,
          reason:
            turn !== null
              ? (turns.get(turn) ?? null)
              : late
                ? null
                : (chosen.get(event.speaker.id) ?? null),
        });
      }
    } else if (event.type === "turn-failed") {
      items.push({ kind: "failed", seq: event.seq, persona: event.persona, error: event.error });
    }
    previous = event;
  }
  return items;
}

/** Whoever said the item at `index`: null for the viewer, else her id, for her lines and failures. */
function speakerAt(items: readonly ChatItem[], index: number): ParticipantId | null | undefined {
  const item = items[index];
  return item === undefined ? undefined : item.kind === "user" ? null : item.persona;
}

/** The item at `index` begins a run of one speaker's items, where a group chat names her. */
export function startsRun(items: readonly ChatItem[], index: number): boolean {
  return index === 0 || speakerAt(items, index - 1) !== speakerAt(items, index);
}

/** More than one persona has a line here, as in a group, or one that was a group. */
export function manyVoices(items: readonly ChatItem[]): boolean {
  let voice: ParticipantId | undefined;
  for (const item of items) {
    if (item.kind === "user") continue;
    if (voice !== undefined && item.persona !== voice) return true;
    voice = item.persona;
  }
  return false;
}

/**
 * What Retry sends again: the viewer's last line, if anything followed it only to fail, or her
 * reply to it was cut off.
 */
export function retryText(items: readonly ChatItem[]): string | null {
  const last = items.at(-1);
  if (last?.kind === "persona" && last.cutOff !== null) {
    const asked = items.at(-2);
    return asked?.kind === "user" ? asked.text : null;
  }
  if (last?.kind !== "failed") return null;
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
