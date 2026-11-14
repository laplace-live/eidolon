// The call this page holds, shown as it is said. The chat stores each of its lines only once it is
// finished, her reply once all of it has played, so while the call is on, its own transcript (what
// the call page shows) stands in for its stored lines, until the call's end is stored after them.
import type { ChatEvent, ParticipantId } from "@eidolon/chat";
import type { WaitState } from "@laplace.live/eidolon-sdk";
import type { BotEntry, SelfieEntry, Transcript, UserEntry } from "@/features/call/transcript";
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
 * The seq of `call`'s call-started; null until it is stored, and once the call is over. A server
 * killed mid-call stores no call-ended, so a call started after it, or a line the viewer sent
 * outside one, ends it too.
 */
export function ongoingCall(events: readonly ChatEvent[], call: string): number | null {
  const index = events.findIndex((event) => event.type === "call-started" && event.call === call);
  const started = events[index];
  if (started?.type !== "call-started") return null;
  const over = events
    .slice(index + 1)
    .some(
      (event) =>
        (event.type === "call-ended" && event.call === call) ||
        event.type === "call-started" ||
        (event.type === "message" && event.speaker.kind === "user" && event.modality !== "call"),
    );
  return over ? null : started.seq;
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
