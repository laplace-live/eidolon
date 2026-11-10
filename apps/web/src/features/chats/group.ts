// A group chat as the page reads it from the log: who answers next, and the director's scores
// behind a reply.
import type { ChatEvent, ChatEventOf, ParticipantId, Speaker } from "@eidolon/chat";

type Decision = ChatEventOf<"decision">;

/** Why she answered: the decision that chose her, and who wrote the line it answered. */
export interface ReplyReason {
  readonly source: Decision["source"];
  readonly scores: Readonly<Record<string, number>>;
  /** Null when the log holds no message at the decision's `after`. */
  readonly to: Speaker | null;
}

export function reasonOf(decision: Decision, speakers: ReadonlyMap<number, Speaker>): ReplyReason {
  return {
    source: decision.source,
    scores: decision.scores ?? {},
    to: speakers.get(decision.after) ?? null,
  };
}

/**
 * Who answers next: the first persona the latest decision since the viewer's last line chose and who
 * hasn't answered since; null when none is waiting, or the viewer's line waits for its decision.
 */
export function nextUp(events: readonly ChatEvent[]): ParticipantId | null {
  const done = new Set<ParticipantId>();
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index] as ChatEvent;
    if (event.type === "decision") {
      const waiting = event.replies.find((reply) => !done.has(reply.persona));
      if (waiting !== undefined) return waiting.persona;
    }
    if (event.type === "message") {
      if (event.speaker.kind === "user") return null;
      done.add(event.speaker.id);
    } else if (event.type === "turn-failed") {
      done.add(event.persona);
    }
  }
  return null;
}

export interface ScoreRow {
  readonly persona: ParticipantId;
  /** Whether the line was addressed to her, 0 to 1. */
  readonly addressed: number | null;
  /** Whether it touched what she cares about, 0 to 1. */
  readonly interested: number | null;
}

const PER_PERSONA = /^(addressed|interested)_(.+)$/;

/** The director's scores by persona, in the order it asked, and whether the line invited a reply. */
export function scoreTable(scores: Readonly<Record<string, number>>): {
  readonly rows: readonly ScoreRow[];
  readonly invites: number | null;
} {
  const rows = new Map<ParticipantId, { addressed: number | null; interested: number | null }>();
  for (const [key, score] of Object.entries(scores)) {
    const match = PER_PERSONA.exec(key);
    if (match === null) continue;
    const [, question, persona] = match as unknown as [string, "addressed" | "interested", string];
    const row = rows.get(persona) ?? { addressed: null, interested: null };
    row[question] = score;
    rows.set(persona, row);
  }
  return {
    rows: [...rows].map(([persona, row]) => ({ persona, ...row })),
    invites: scores.invites_reply ?? null,
  };
}
