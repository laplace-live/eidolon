// What a chat shows beyond its stored log: the reply streaming in, the tool she is running, and the
// viewer's line until it is stored. The log itself lives in the query cache, which `mergeEvents`
// extends as `events` lines arrive.
//
// A send interrupts the reply running, and that reply's last lines come on its own stream, which
// can arrive after the new reply started. Message events carry no turn, so a stored line is matched
// to what waits for it by seq: whatever answers a turn or a send is stored after it began.
import type { ChatEvent, ChatStreamLine, ParticipantId } from "@eidolon/chat";
import type { ChatContents } from "@/lib/chats";

export interface LiveTurn {
  readonly id: string;
  readonly persona: ParticipantId;
  /** The last seq stored when it started. */
  readonly after: number;
  /** Her deltas so far, never stored: her message replaces them. */
  readonly text: string;
  /** The tool running now. */
  readonly tool: string | null;
}

export interface PendingLine {
  /** Which send it came from, so another stream's end leaves it be. */
  readonly key: number;
  /** The last seq stored when it was sent. */
  readonly after: number;
  readonly text: string;
  readonly failed: boolean;
}

export interface LiveError {
  readonly code: string;
  readonly message: string;
}

export interface LiveState {
  readonly turn: LiveTurn | null;
  /** The viewer's line, sent and not yet stored. */
  readonly pending: PendingLine | null;
  readonly error: LiveError | null;
  /** The highest seq any stream has carried. */
  readonly seen: number;
}

export const IDLE: LiveState = { turn: null, pending: null, error: null, seen: 0 };

export type LiveAction =
  | ChatStreamLine
  | {
      readonly type: "sending";
      readonly key: number;
      readonly after: number;
      readonly text: string;
    }
  | { readonly type: "send-failed"; readonly key: number; readonly error: LiveError }
  /** A stream is gone: send `key`'s line is stored or never will be, and nothing finishes `turn`. */
  | { readonly type: "settled"; readonly key: number | null; readonly turn: string | null };

/** Her message or failure for `turn` is among `events`, so its streamed text is done. */
function finishes(turn: LiveTurn, events: readonly ChatEvent[]): boolean {
  return events.some(
    (event) =>
      (event.type === "message" &&
        event.seq > turn.after &&
        event.speaker.kind === "persona" &&
        event.speaker.id === turn.persona) ||
      (event.type === "turn-failed" && event.turn === turn.id),
  );
}

function stores(pending: PendingLine, events: readonly ChatEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === "message" && event.seq > pending.after && event.speaker.kind === "user",
  );
}

export function reduceLive(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case "started":
      return {
        ...state,
        turn: { id: action.turn, persona: action.persona, after: state.seen, text: "", tool: null },
        error: null,
      };
    case "delta":
      return state.turn?.id === action.turn
        ? { ...state, turn: { ...state.turn, text: state.turn.text + action.text } }
        : state;
    case "tool":
      return state.turn?.id === action.turn
        ? {
            ...state,
            turn: { ...state.turn, tool: action.state === "running" ? action.name : null },
          }
        : state;
    case "events":
      return {
        ...state,
        pending:
          state.pending !== null && stores(state.pending, action.events) ? null : state.pending,
        turn: state.turn !== null && finishes(state.turn, action.events) ? null : state.turn,
        seen: Math.max(state.seen, ...action.events.map((event) => event.seq)),
      };
    case "ended":
      return state.turn?.id === action.turn ? { ...state, turn: null } : state;
    case "error":
      return {
        ...state,
        turn: null,
        pending: state.pending && { ...state.pending, failed: true },
        error: { code: action.code, message: action.message },
      };
    case "sending":
      return {
        ...state,
        pending: { key: action.key, after: action.after, text: action.text, failed: false },
        error: null,
      };
    case "send-failed":
      return {
        ...state,
        pending:
          state.pending?.key === action.key ? { ...state.pending, failed: true } : state.pending,
        error: action.error,
      };
    case "settled":
      return {
        ...state,
        pending: state.pending?.key === action.key && !state.pending.failed ? null : state.pending,
        turn: action.turn !== null && state.turn?.id === action.turn ? null : state.turn,
      };
  }
}

/** How often a chat is read again while a tool her interrupted turn left running is out. */
export const LATE_POLL_MS = 2000;

/**
 * The chat query's refetch interval. What a tool her interrupted turn left running brings, a selfie
 * still rendering, is stored after every stream of that turn has closed, so the chat is read again
 * until the server lists no such tool.
 */
export function latePoll(log: ChatContents | undefined): number | false {
  return log !== undefined && log.lateTools.length > 0 ? LATE_POLL_MS : false;
}

/**
 * `log` with the events that continue it. A gap (an event missed, or two streams' lines arriving
 * out of order) keeps what came before it and asks for a refetch.
 */
export function mergeEvents(
  log: ChatContents,
  events: readonly ChatEvent[],
): { readonly log: ChatContents; readonly gap: boolean } {
  let next = (log.events.at(-1)?.seq ?? 0) + 1;
  const added: ChatEvent[] = [];
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.seq < next) continue;
    if (event.seq > next) return { log: extended(log, added), gap: true };
    added.push(event);
    next++;
  }
  return { log: extended(log, added), gap: false };
}

function extended(log: ChatContents, added: readonly ChatEvent[]): ChatContents {
  return added.length === 0 ? log : { ...log, events: [...log.events, ...added] };
}
