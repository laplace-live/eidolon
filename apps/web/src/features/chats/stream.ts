// What a chat shows beyond its stored log: the reply streaming in, the tool she is running, the
// viewer's line until it is stored, and whether a reply is still under way between its turns. The log itself lives in the query cache, which `mergeEvents`
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
  /** The viewer's lines, sent and not yet stored, in the order sent. */
  readonly pending: readonly PendingLine[];
  readonly error: LiveError | null;
  /** The highest seq any stream has carried. */
  readonly seen: number;
  /**
   * Streams carrying a reply: a send's from its start, live's from its first line. A group's reply
   * goes on between its turns while the director decides who answers next.
   */
  readonly following: number;
}

export const IDLE: LiveState = { turn: null, pending: [], error: null, seen: 0, following: 0 };

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
  | { readonly type: "settled"; readonly key: number | null; readonly turn: string | null }
  | { readonly type: "follow" }
  | { readonly type: "unfollow" };

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

/** `pending` without the lines `events` store, each the first sent before it with its text. */
function unstored(
  pending: readonly PendingLine[],
  events: readonly ChatEvent[],
): readonly PendingLine[] {
  let left = pending;
  for (const event of events) {
    if (event.type !== "message" || event.speaker.kind !== "user") continue;
    const stored = left.findIndex((line) => event.seq > line.after && line.text === event.text);
    if (stored >= 0) left = left.filter((_, i) => i !== stored);
  }
  return left;
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
        pending: unstored(state.pending, action.events),
        turn: state.turn !== null && finishes(state.turn, action.events) ? null : state.turn,
        seen: Math.max(state.seen, ...action.events.map((event) => event.seq)),
      };
    case "ended":
      return state.turn?.id === action.turn ? { ...state, turn: null } : state;
    case "error":
      return {
        ...state,
        turn: null,
        pending: state.pending.map((line) => ({ ...line, failed: true })),
        error: { code: action.code, message: action.message },
      };
    case "sending":
      return {
        ...state,
        pending: [
          ...state.pending.filter((line) => !line.failed),
          { key: action.key, after: action.after, text: action.text, failed: false },
        ],
        error: null,
      };
    case "send-failed":
      return {
        ...state,
        pending: state.pending.map((line) =>
          line.key === action.key ? { ...line, failed: true } : line,
        ),
        error: action.error,
      };
    case "settled":
      return {
        ...state,
        pending: state.pending.filter((line) => line.key !== action.key || line.failed),
        turn: action.turn !== null && state.turn?.id === action.turn ? null : state.turn,
      };
    case "follow":
      return { ...state, following: state.following + 1 };
    case "unfollow":
      return { ...state, following: Math.max(0, state.following - 1) };
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

/**
 * Which streams a send supersedes. A send counts once the server accepts it, at its stream's first
 * line: one refused before it starts (a 400, say) never ran, so the reply on screen carries on.
 */
export class Sends {
  #issued = 0;
  #accepted = 0;

  /** A new send's key. */
  issue(): number {
    this.#issued += 1;
    return this.#issued;
  }

  /** What a stream opening now is superseded after: its own key, or for live every send so far. */
  mark(key: number | null): number {
    return key ?? this.#issued;
  }

  accept(key: number): void {
    this.#accepted = Math.max(this.#accepted, key);
  }

  superseded(mark: number): boolean {
    return this.#accepted > mark;
  }
}

/**
 * Whether a stream's line reaches the reducer. A send supersedes every stream open before it, and
 * its own carries her reply from its start: a superseded one only stores what it brings, whether
 * it replays that same reply or still carries the one the send interrupted.
 */
export function reaches(line: ChatStreamLine, superseded: boolean): boolean {
  return !superseded || (line.type !== "started" && line.type !== "delta" && line.type !== "tool");
}
