// What a chat's log shows: the lines said and the turns that failed. Recall, tool events, the
// greeting prompt and the bookkeeping events stay hidden.
import type {
  Attachment,
  ChatEvent,
  ChatEventOf,
  CutOff,
  ParticipantId,
  Speaker,
} from "@eidolon/chat";
import { parseMarkup } from "@/lib/markup";
import { type ReplyReason, reasonOf } from "./group";

export type AudioAttachment = Extract<Attachment, { readonly kind: "audio" }>;

type PersonaItem = {
  readonly kind: "persona";
  readonly seq: number;
  readonly persona: ParticipantId;
  /** A voice message's transcript. */
  readonly text: string;
  readonly images: readonly Attachment[];
  /** Her voice message's audio; null for a text message. */
  readonly voice: AudioAttachment | null;
  /** She meant to answer with her voice, but it couldn't be made, so her words stayed text. */
  readonly sentAsText: boolean;
  readonly interrupted: boolean;
  readonly cutOff: CutOff | null;
  /** The decision that last chose her; null for a greeting. */
  readonly reason: ReplyReason | null;
};

export type ChatItem =
  | {
      readonly kind: "user";
      readonly seq: number;
      /** A voice message's transcript: empty when nothing in it could be heard. */
      readonly text: string;
      readonly voice: AudioAttachment | null;
    }
  | PersonaItem
  | {
      readonly kind: "failed";
      readonly seq: number;
      readonly persona: ParticipantId;
      readonly error: string;
    };

/** A voice message's audio; null for any other message. */
function voiceOf(event: ChatEventOf<"message">): AudioAttachment | null {
  if (event.modality !== "voice") return null;
  return event.attachments?.find((file): file is AudioAttachment => file.kind === "audio") ?? null;
}

export function chatItems(events: readonly ChatEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const speakers = new Map<number, Speaker>();
  const chosen = new Map<ParticipantId, ReplyReason>();
  for (const event of events) {
    if (event.type === "decision") {
      const reason = reasonOf(event, speakers);
      for (const reply of event.replies) chosen.set(reply.persona, reason);
    } else if (event.type === "message") {
      speakers.set(event.seq, event.speaker);
      const images = (event.attachments ?? []).filter((file) => file.kind === "image");
      const voice = voiceOf(event);
      if (event.speaker.kind === "user") {
        if (event.text !== "" || voice !== null) {
          items.push({ kind: "user", seq: event.seq, text: event.text, voice });
        }
      } else if (
        event.text !== "" ||
        images.length > 0 ||
        voice !== null ||
        event.cutOff !== undefined
      ) {
        items.push({
          kind: "persona",
          seq: event.seq,
          persona: event.speaker.id,
          text: event.text,
          images,
          voice,
          sentAsText: false,
          interrupted: event.interrupted === true,
          cutOff: event.cutOff ?? null,
          reason: chosen.get(event.speaker.id) ?? null,
        });
      }
    } else if (event.type === "turn-failed") {
      if (event.code === "voice-failed") {
        // It comes right after the message it badges, which keeps her words.
        const said = items.at(-1);
        if (said?.kind === "persona" && said.persona === event.persona) {
          items[items.length - 1] = { ...said, sentAsText: true };
        }
      } else {
        items.push({ kind: "failed", seq: event.seq, persona: event.persona, error: event.error });
      }
    }
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
 * reply to it was cut off. A voice message goes again as its transcript; one with none, not at all.
 */
export function retryText(items: readonly ChatItem[]): string | null {
  const last = items.at(-1);
  if (last?.kind === "persona" && last.cutOff !== null) {
    const asked = items.at(-2);
    return asked?.kind === "user" && asked.text !== "" ? asked.text : null;
  }
  if (last?.kind !== "failed") return null;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === "user") return item.text === "" ? null : item.text;
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
