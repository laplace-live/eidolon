import {
  type ChatEvent,
  type ChatHeader,
  type ChatSummary,
  DEFAULT_CHAIN_LIMIT,
  type ReplyMode,
} from "./format.ts";

/** `summary` with `events`, the ones after its `lastSeq`, applied. */
export function advanceSummary(summary: ChatSummary, events: readonly ChatEvent[]): ChatSummary {
  let { title, participants, updatedAt, lastText, lastSeq } = summary;
  for (const event of events) {
    lastSeq = event.seq;
    updatedAt = Math.max(updatedAt, event.at);
    // A message with photos alone has no text to preview.
    if (event.type === "message") lastText = event.text === "" ? lastText : event.text;
    else if (event.type === "title") title = event.title;
    else if (event.type === "participants") {
      const removed = new Set(event.removed ?? []);
      const kept = participants.filter((id) => !removed.has(id));
      participants = [...new Set([...kept, ...(event.added ?? [])])];
    }
  }
  return {
    id: summary.id,
    title,
    participants,
    createdAt: summary.createdAt,
    updatedAt,
    lastText,
    lastSeq,
  };
}

/** The chat's chain limit: the last `settings` event's, else DEFAULT_CHAIN_LIMIT. */
export function chainLimitOf(events: readonly ChatEvent[]): number {
  const set = events.findLast(
    (event) => event.type === "settings" && event.chainLimit !== undefined,
  );
  return set?.type === "settings" ? (set.chainLimit as number) : DEFAULT_CHAIN_LIMIT;
}

/** The chat's own reply mode, which overrides each persona's: the last `settings` event's, else null. */
export function replyModeOf(events: readonly ChatEvent[]): ReplyMode | null {
  const set = events.findLast(
    (event) => event.type === "settings" && event.replyMode !== undefined,
  );
  return set?.type === "settings" ? (set.replyMode as ReplyMode) : null;
}

export function summarize(header: ChatHeader, events: readonly ChatEvent[]): ChatSummary {
  const empty: ChatSummary = {
    id: header.id,
    title: null,
    participants: header.participants,
    createdAt: header.createdAt,
    updatedAt: header.createdAt,
    lastText: null,
    lastSeq: 0,
  };
  return advanceSummary(empty, events);
}
