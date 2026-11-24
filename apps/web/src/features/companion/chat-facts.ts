// Her messages in the chat open in the main window, as they arrive and as her voice messages play:
// what the desktop companion's feed passes on to her.
import type { ChatEvent } from "@eidolon/chat";
import type { ChatContents } from "@/lib/api";
import type { ChatFact } from "./protocol";

const listeners = new Set<(fact: ChatFact) => void>();

/** Her messages in the chat open here, for the desktop companion's feed. */
export function tellCompanion(fact: ChatFact): void {
  for (const listener of [...listeners]) listener(fact);
}

export function onChatFact(listener: (fact: ChatFact) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The facts of an `events` line: each persona's message past the end of `held`, the chat's log as
 * the page held it before the line, a call's excepted (the call's signals carry those). None while
 * it held none: what the page reads is never told, only what arrives.
 */
export function saidFacts(
  chat: string,
  events: readonly ChatEvent[],
  held: Pick<ChatContents, "events"> | undefined,
): ChatFact[] {
  if (held === undefined) return [];
  const last = held.events.at(-1)?.seq ?? 0;
  return events.flatMap((event): ChatFact[] =>
    event.seq > last &&
    event.type === "message" &&
    event.speaker.kind === "persona" &&
    event.modality !== "call"
      ? [{ type: "said", persona: event.speaker.id, chat, seq: event.seq, text: event.text }]
      : [],
  );
}
