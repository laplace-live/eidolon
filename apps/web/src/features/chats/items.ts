// What a chat's log shows: the lines said, the turns that failed, and where each call began and
// ended. Recall, tool events, the greeting prompt and the bookkeeping events stay hidden.
import type {
  Attachment,
  ChatEvent,
  ChatEventOf,
  CutOff,
  ParticipantId,
  Speaker,
} from "@eidolon/chat";
import { parseMarkup, trimTrailingPartialCue } from "@laplace.live/eidolon-sdk";
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
  /** The decision her turn answered; null for a greeting, or a late photo of unknown turn. */
  readonly reason: ReplyReason | null;
  /** Said on a call, as its transcript. */
  readonly call: boolean;
};

/** Where a call began or ended, as a quiet line across the log. */
export type CallItem = {
  readonly kind: "call";
  readonly seq: number;
  readonly edge: "started" | "ended";
  /** Whom the call was with; null when its start isn't in the log. On a group call, the host. */
  readonly persona: ParticipantId | null;
  /** Every persona in the chat was on it. */
  readonly group?: true;
  /** How long it lasted; null until it has ended, or when its other edge isn't in the log. */
  readonly durationMs: number | null;
};

export type ChatItem =
  | {
      readonly kind: "user";
      readonly seq: number;
      /** A voice message's transcript: empty when nothing in it could be heard. */
      readonly text: string;
      readonly voice: AudioAttachment | null;
      /** Said on a call, as its transcript. */
      readonly call: boolean;
    }
  | PersonaItem
  | {
      readonly kind: "failed";
      readonly seq: number;
      readonly persona: ParticipantId;
      readonly error: string;
    }
  | CallItem;

/** A voice message's audio; null for any other message. */
function voiceOf(event: ChatEventOf<"message">): AudioAttachment | null {
  if (event.modality !== "voice") return null;
  return event.attachments?.find((file): file is AudioAttachment => file.kind === "audio") ?? null;
}

interface CallEdges {
  started?: ChatEventOf<"call-started">;
  ended?: ChatEventOf<"call-ended">;
}

/** Each call's start and end in the log, by call. */
function callEdges(events: readonly ChatEvent[]): Map<string, CallEdges> {
  const calls = new Map<string, CallEdges>();
  for (const event of events) {
    if (event.type !== "call-started" && event.type !== "call-ended") continue;
    const edges = calls.get(event.call) ?? {};
    if (event.type === "call-started") edges.started = event;
    else edges.ended = event;
    calls.set(event.call, edges);
  }
  return calls;
}

export function chatItems(events: readonly ChatEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const speakers = new Map<number, Speaker>();
  const chosen = new Map<ParticipantId, ReplyReason>();
  // The decision each turn began under, by turn.
  const turns = new Map<string, ReplyReason | null>();
  const calls = callEdges(events);
  // On a group call, the director chooses each line's speaker, but her follow-ups follow no decision.
  let groupCall = false;
  let previous: ChatEvent | undefined;
  for (const event of events) {
    if ("turn" in event && !turns.has(event.turn)) {
      turns.set(event.turn, chosen.get(event.persona) ?? null);
    }
    if (event.type === "decision") {
      const reason = reasonOf(event, speakers);
      for (const reply of event.replies) chosen.set(reply.persona, reason);
    } else if (event.type === "call-started" || event.type === "call-ended") {
      const { started, ended } = calls.get(event.call) ?? {};
      groupCall = event.type === "call-started" && event.group === true;
      if (groupCall) chosen.clear();
      items.push({
        kind: "call",
        seq: event.seq,
        edge: event.type === "call-started" ? "started" : "ended",
        persona: started?.persona ?? null,
        ...(started?.group ? { group: true as const } : {}),
        durationMs:
          started === undefined || ended === undefined ? null : Math.max(0, ended.at - started.at),
      });
    } else if (event.type === "message") {
      speakers.set(event.seq, event.speaker);
      const images = (event.attachments ?? []).filter((file) => file.kind === "image");
      const voice = voiceOf(event);
      const call = event.modality === "call";
      if (event.speaker.kind === "user") {
        if (event.text !== "" || voice !== null) {
          items.push({ kind: "user", seq: event.seq, text: event.text, voice, call });
        }
      } else if (
        event.text !== "" ||
        images.length > 0 ||
        voice !== null ||
        event.cutOff !== undefined
      ) {
        // Photos that land after her interrupted turn follow its result, when it brought one, and
        // a decision since may have chosen her again: they take her turn's decision, or none.
        const late = event.text === "" && !event.interrupted && event.cutOff === undefined;
        const turn =
          late && previous?.type === "tool-result" && previous.persona === event.speaker.id
            ? previous.turn
            : null;
        // A group call's line takes the decision that chose her, once.
        const chose = groupCall && call && !late ? (chosen.get(event.speaker.id) ?? null) : null;
        if (chose !== null) chosen.delete(event.speaker.id);
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
          // No decision chooses who speaks on a call with her alone.
          reason:
            turn !== null
              ? (turns.get(turn) ?? null)
              : late || call
                ? chose
                : (chosen.get(event.speaker.id) ?? null),
          call,
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
    previous = event;
  }
  return items;
}

/**
 * Whoever said `item`: null for the viewer, else her id, for her lines and failures. A call's edge
 * has no speaker, so whoever speaks after it starts a run.
 */
export function saidBy(item: ChatItem | undefined): ParticipantId | null | undefined {
  if (item === undefined || item.kind === "call") return undefined;
  return item.kind === "user" ? null : item.persona;
}

/** The item at `index` begins a run of one speaker's items, where a group chat names her. */
export function startsRun(items: readonly ChatItem[], index: number): boolean {
  return index === 0 || saidBy(items[index - 1]) !== saidBy(items[index]);
}

/** More than one persona has a line here, as in a group, or one that was a group. */
export function manyVoices(items: readonly ChatItem[]): boolean {
  let voice: ParticipantId | undefined;
  for (const item of items) {
    if (item.kind === "user" || item.kind === "call") continue;
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
    if (item.kind === "persona" || item.kind === "call") return null;
  }
  return null;
}

/** A line as one row of plain text: her cues as their emoji, directions and tags dropped. */
export function previewText(text: string): string {
  return parseMarkup(trimTrailingPartialCue(text))
    .map((token) => (token.kind === "text" ? token.text : token.kind === "cue" ? token.emoji : " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
