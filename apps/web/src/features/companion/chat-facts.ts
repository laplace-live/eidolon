// Her messages in the chat open in the main window, as they arrive and as her voice messages play:
// what the desktop companion's feed passes on. Kept for the page's life, as the bubble playing is.
import type { ChatEvent } from "@eidolon/chat";
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

/** The facts of an `events` line: each persona's message, a call's excepted (the call's signals carry those). */
export function saidFacts(chat: string, events: readonly ChatEvent[]): ChatFact[] {
  return events.flatMap((event): ChatFact[] =>
    event.type === "message" && event.speaker.kind === "persona" && event.modality !== "call"
      ? [{ type: "said", persona: event.speaker.id, chat, seq: event.seq, text: event.text }]
      : [],
  );
}
