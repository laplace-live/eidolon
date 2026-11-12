// The call this page holds, shown as it is said. The chat stores each of its lines only once it is
// finished, her reply once all of it has played, so while the call is on, its own transcript (what
// the call page shows) stands in for its stored lines, until the call's end is stored after them.
import type { ChatEvent, ChatEventOf, ParticipantId } from "@eidolon/chat";
import type { CallPhase } from "@/features/call/phase";
import type { BotEntry, SelfieEntry, Transcript, UserEntry } from "@/features/call/transcript";
import type { WaitState } from "@/features/call/watchdog";
import { type ChatItem, saidBy } from "./items";

export interface LiveCall {
  /** The seq of its call-started: the lines of it stored after this, the transcript shows. */
  readonly from: number;
  readonly transcript: Transcript;
  readonly wait: WaitState;
  /** Whom the viewer called, whose replies these are on a call with her alone; else the host. */
  readonly persona: ParticipantId;
  readonly group: boolean;
  /** Up and hearing the viewer. */
  readonly live: boolean;
}

/**
 * The seq of the call-started this page's call stored, the first after `placedAfter`, the log's
 * last seq as the page placed it; null until it is stored, and once its call-ended is.
 */
export function ongoingCall(events: readonly ChatEvent[], placedAfter: number): number | null {
  const started = events.find(
    (event): event is ChatEventOf<"call-started"> =>
      event.type === "call-started" && event.seq > placedAfter,
  );
  if (started === undefined) return null;
  const ended = events.some((event) => event.type === "call-ended" && event.call === started.call);
  return ended ? null : started.seq;
}

/**
 * Whether the page's call stored the start found after `placedAfter`. A call refused, or given up
 * before its offer, stored none, and the next start may be another tab's call; one live or
 * answered stored its own.
 */
export function cameUp(phase: CallPhase): boolean {
  return phase.name === "live" || ("answeredAt" in phase && phase.answeredAt !== null);
}

/** Whether `item` is a line of the call that started at `from`, which its transcript shows. */
export function standsIn(item: ChatItem, from: number): boolean {
  return item.seq > from && (item.kind === "user" || item.kind === "persona") && item.call;
}

export type CallRow =
  | { readonly kind: "viewer"; readonly entry: UserEntry }
  | {
      readonly kind: "her";
      readonly entry: BotEntry | SelfieEntry;
      readonly persona: ParticipantId;
      /** It begins a run of her rows, where a group names her. */
      readonly first: boolean;
    };

/**
 * The transcript as the log's rows, after `before`, the line shown above them. Each reply and photo
 * is the persona's the server named, else the host's.
 */
export function callRows(
  transcript: Transcript,
  host: ParticipantId,
  before: ChatItem | undefined,
): CallRow[] {
  const rows: CallRow[] = [];
  let last = saidBy(before);
  for (const entry of transcript.entries) {
    if (entry.kind === "user") {
      rows.push({ kind: "viewer", entry });
      last = null;
      continue;
    }
    const persona = (entry.kind === "bot" ? entry.speaker?.persona : entry.persona) ?? host;
    rows.push({ kind: "her", entry, persona, first: last !== persona });
    last = persona;
  }
  return rows;
}
