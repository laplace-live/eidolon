// What a call bound to a chat takes of her tasks there. Its seed holds no tool events, so her
// start_task calls reach its log as drafts; the status block and her nudges the chat stored are
// stale by the call, and stay out of its views.
import type { ChatEvent, ChatEventDraft, ParticipantId, ViewMessage } from "@eidolon/chat";
import { TASKS_BLOCK_PREFIX } from "./status.ts";
import { START_TASK, TASK_NUDGE_LEAD, taskEndedNudge } from "./tool.ts";

/** Whether a developer block is the status block or one of her task nudges. */
const isTaskContext = (content: string): boolean =>
  content.startsWith(TASKS_BLOCK_PREFIX) || content.startsWith(TASK_NUDGE_LEAD);

/** `seed` without the status block and her task nudges: developer messages that start as they do. */
export function withoutTaskContext(seed: readonly ViewMessage[]): ViewMessage[] {
  return seed.filter(
    (message) => !(message.role === "developer" && isTaskContext(message.content)),
  );
}

/**
 * What takes each persona's stored status block and task nudges out of her view of `events`: a
 * `context-removed` under `turn` for each persona with any. A group call opens on the chat's own
 * events, and refreshes no block.
 */
export function staleTaskContext(events: readonly ChatEvent[], turn: string): ChatEventDraft[] {
  const stored = new Map<ParticipantId, Set<number>>();
  for (const event of events) {
    if (event.type === "context" && event.role === "developer" && isTaskContext(event.content)) {
      stored.set(event.persona, (stored.get(event.persona) ?? new Set()).add(event.seq));
    } else if (event.type === "context-removed") {
      for (const seq of event.seqs) stored.get(event.persona)?.delete(seq);
    }
  }
  return [...stored].flatMap(([persona, seqs]) =>
    seqs.size === 0 ? [] : [{ type: "context-removed", persona, turn, seqs: [...seqs] }],
  );
}

function draftOf(event: ChatEvent): ChatEventDraft {
  const { seq: _, at: __, sig: ___, ...draft } = event;
  return draft as ChatEventDraft;
}

/** Takes `event` into `starts`: her start_task calls by id, each with its started result once stored. */
function note(starts: Map<string, ChatEvent[]>, event: ChatEvent, persona: ParticipantId): void {
  if (event.type === "tool-call" && event.persona === persona) {
    // A provider may use a call id again: a result goes to the newest call with it.
    if (event.name === START_TASK) starts.set(event.callId, [event]);
    else starts.delete(event.callId);
  } else if (
    event.type === "tool-result" &&
    event.persona === persona &&
    event.stage === "started"
  ) {
    starts.get(event.callId)?.push(event);
  }
}

/**
 * Her start_task call `callId` and its started result, once stored, as drafts for a call's log that
 * lacks them; none when the chat holds no such call of hers.
 */
export function herStart(
  events: readonly ChatEvent[],
  persona: ParticipantId,
  callId: string,
): ChatEventDraft[] {
  const starts = new Map<string, ChatEvent[]>();
  for (const event of events) note(starts, event, persona);
  return (starts.get(callId) ?? []).map(draftOf);
}

/** A task's end she hasn't told, as a call takes it. */
export interface UntoldEnd {
  /** Her start_task call's id, which her nudge names. */
  readonly callId: string;
  /** Her tool-call, its started result once stored, then the final: for a call's log. */
  readonly drafts: readonly ChatEventDraft[];
}

/**
 * The ends of persona `persona`'s tasks she hasn't told, oldest first: each final of a start_task
 * call of hers that isn't cancelled, until a call's call-ended names it among those she told there,
 * or a line of hers with words comes after it, not on a call. A line that answers her report turn's
 * nudge on one of them, the latest task nudge of hers since her last line, tells only that one: her
 * turn records its providers' blocks after the nudge.
 */
export function untoldEnds(events: readonly ChatEvent[], persona: ParticipantId): UntoldEnd[] {
  const starts = new Map<string, ChatEvent[]>();
  let untold: UntoldEnd[] = [];
  let nudge: string | null = null;
  for (const event of events) {
    note(starts, event, persona);
    if (event.type === "call-ended") {
      const told = event.told ?? [];
      untold = untold.filter(({ callId }) => !told.includes(callId));
    } else if (
      event.type === "context" &&
      event.persona === persona &&
      event.content.startsWith(TASK_NUDGE_LEAD)
    ) {
      nudge = event.content;
    } else if (
      event.type === "message" &&
      event.speaker.kind === "persona" &&
      event.speaker.id === persona &&
      event.text.trim() !== ""
    ) {
      if (event.modality !== "call") {
        const answered = untold.find(({ callId }) => taskEndedNudge(callId) === nudge);
        untold = answered === undefined ? [] : untold.filter((end) => end !== answered);
      }
      nudge = null;
    } else if (
      event.type === "tool-result" &&
      event.persona === persona &&
      event.stage === "final" &&
      event.result.status !== "cancelled"
    ) {
      const start = starts.get(event.callId);
      if (start !== undefined) {
        untold.push({ callId: event.callId, drafts: [...start, event].map(draftOf) });
      }
    }
  }
  return untold;
}
