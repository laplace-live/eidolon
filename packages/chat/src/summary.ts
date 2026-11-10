import type { ChatEvent, ChatHeader, ChatSummary } from "./format.ts";

/** `summary` with `events`, the ones after its `lastSeq`, applied. */
export function advanceSummary(summary: ChatSummary, events: readonly ChatEvent[]): ChatSummary {
  let { title, participants, updatedAt, lastText, lastSeq } = summary;
  for (const event of events) {
    lastSeq = event.seq;
    updatedAt = Math.max(updatedAt, event.at);
    if (event.type === "message") lastText = event.text;
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
