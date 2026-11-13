import { isChatEvent } from "./parse.ts";
import type {
  Attachment,
  ChatStreamLine,
  CutOff,
  ParticipantId,
  Speaker,
  ToolState,
  WireEvent,
} from "./types.ts";

/** A turn still streaming: her words so far, and her tools' states. */
export interface LiveTurn {
  readonly turn: string;
  readonly persona: ParticipantId;
  readonly text: string;
  readonly tools: readonly { readonly name: string; readonly state: ToolState }[];
  /** Her message or failure is stored, and shows in its place. */
  readonly settled: boolean;
  /** Highest stored `seq` before this turn started; older persona messages cannot settle it. */
  readonly afterSeq?: number;
}

export interface ChatViewState {
  /** The chat's events, by seq. */
  readonly events: readonly WireEvent[];
  readonly live: readonly LiveTurn[];
  /** An `error` line that ended the stream. */
  readonly error: { readonly code: string; readonly message: string } | null;
}

export type ChatViewAction =
  | { readonly type: "loaded"; readonly events: readonly WireEvent[] }
  | { readonly type: "line"; readonly line: ChatStreamLine }
  | { readonly type: "closed" }
  | { readonly type: "reset" };

export const EMPTY_CHAT_VIEW: ChatViewState = { events: [], live: [], error: null };

function mergeEvents(
  current: readonly WireEvent[],
  incoming: readonly WireEvent[],
): readonly WireEvent[] {
  if (incoming.length === 0) return current;
  const lastSeq = current.at(-1)?.seq ?? 0;
  if (incoming.every((event, i) => event.seq > (i === 0 ? lastSeq : (incoming[i - 1]?.seq ?? 0)))) {
    return [...current, ...incoming];
  }
  const bySeq = new Map<number, WireEvent>();
  for (const event of current) bySeq.set(event.seq, event);
  let added = false;
  for (const event of incoming) {
    if (!bySeq.has(event.seq)) {
      bySeq.set(event.seq, event);
      added = true;
    }
  }
  if (!added) return current;
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function settles(live: LiveTurn, events: readonly WireEvent[]): boolean {
  const afterSeq = live.afterSeq ?? 0;
  return events.some(
    (event) =>
      isChatEvent(event) &&
      ((event.type === "message" &&
        event.seq > afterSeq &&
        event.speaker.kind === "persona" &&
        event.speaker.id === live.persona) ||
        (event.type === "turn-failed" && event.turn === live.turn)),
  );
}

function settleLiveTurns(
  live: readonly LiveTurn[],
  incoming: readonly WireEvent[],
): readonly LiveTurn[] {
  if (!live.some((turn) => !turn.settled && settles(turn, incoming))) return live;
  return live.map((turn) =>
    turn.settled || !settles(turn, incoming) ? turn : { ...turn, settled: true },
  );
}

function updateLive(
  state: ChatViewState,
  turn: string,
  update: (live: LiveTurn) => LiveTurn,
): ChatViewState {
  const index = state.live.findIndex((live) => live.turn === turn);
  if (index === -1) return state;
  const current = state.live[index]!;
  const next = update(current);
  if (next === current) return state;
  const live = [...state.live];
  live[index] = next;
  return { ...state, live };
}

function applyLine(state: ChatViewState, line: ChatStreamLine): ChatViewState {
  switch (line.type) {
    case "started":
      if (state.live.some((live) => live.turn === line.turn)) return state;
      return {
        ...state,
        error: null,
        live: [
          ...state.live,
          {
            turn: line.turn,
            persona: line.persona,
            text: "",
            tools: [],
            settled: false,
            afterSeq: state.events.at(-1)?.seq ?? 0,
          },
        ],
      };
    case "delta":
      return updateLive(state, line.turn, (live) =>
        live.settled || line.text === "" ? live : { ...live, text: live.text + line.text },
      );
    case "tool":
      return updateLive(state, line.turn, (live) => ({
        ...live,
        tools: live.tools.some((tool) => tool.name === line.name)
          ? live.tools.map((tool) =>
              tool.name === line.name ? { name: line.name, state: line.state } : tool,
            )
          : [...live.tools, { name: line.name, state: line.state }],
      }));
    case "events": {
      const events = mergeEvents(state.events, line.events);
      const live = settleLiveTurns(state.live, line.events);
      return events === state.events && live === state.live ? state : { ...state, events, live };
    }
    case "ended":
      return state.live.some((live) => live.turn === line.turn)
        ? { ...state, live: state.live.filter((live) => live.turn !== line.turn) }
        : state;
    case "error":
      return { ...state, error: { code: line.code, message: line.message } };
  }
}

/** Reducer for one chat's stored events and its still-streaming turns. */
export function chatViewReducer(state: ChatViewState, action: ChatViewAction): ChatViewState {
  switch (action.type) {
    case "loaded": {
      const events = mergeEvents(state.events, action.events);
      const live = settleLiveTurns(state.live, action.events);
      return events === state.events && live === state.live ? state : { ...state, events, live };
    }
    case "line":
      return applyLine(state, action.line);
    case "closed":
      return state.live.length === 0 ? state : { ...state, live: [] };
    case "reset":
      return EMPTY_CHAT_VIEW;
  }
}

type ImageAttachment = Extract<Attachment, { readonly kind: "image" }>;
type AudioAttachment = Extract<Attachment, { readonly kind: "audio" }>;

/** One row of a chat as a UI shows it. */
export type ChatItem =
  | {
      readonly kind: "message";
      readonly key: string;
      readonly seq: number;
      readonly at: number;
      readonly speaker: Speaker;
      readonly text: string;
      readonly modality: "text" | "voice" | "call";
      readonly audio: AudioAttachment | null;
      readonly images: readonly ImageAttachment[];
      readonly interrupted: boolean;
      readonly cutOff: CutOff | null;
      /** Meant as a voice message, but her voice failed: show a quiet "sent as text". */
      readonly sentAsText: boolean;
    }
  | {
      readonly kind: "failed";
      readonly key: string;
      readonly seq: number;
      readonly at: number;
      readonly persona: ParticipantId;
    }
  | {
      readonly kind: "call";
      readonly key: string;
      readonly seq: number;
      readonly at: number;
      readonly edge: "started" | "ended";
      readonly call: string;
      /** Null on an end whose start isn't loaded. */
      readonly persona: ParticipantId | null;
      /** `hangup` or `error` on an end; null on a start. */
      readonly reason: string | null;
      /** On an end whose start is loaded. */
      readonly durationMs: number | null;
    }
  | {
      readonly kind: "live";
      readonly key: string;
      readonly turn: string;
      readonly persona: ParticipantId;
      readonly text: string;
      readonly tools: LiveTurn["tools"];
    };

type MessageItem = Extract<ChatItem, { readonly kind: "message" }>;

/**
 * The rows a chat's stored events show, in log order: messages, failures and call marks, a call's
 * start only until it ends. Hidden events and empty messages are omitted.
 */
export function eventItems(events: readonly WireEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const calls = new Map<string, { readonly persona: ParticipantId; readonly at: number }>();
  const ended = new Set<string>();
  for (const event of events) {
    if (!isChatEvent(event)) continue;
    const key = `seq-${event.seq}`;
    const { seq, at } = event;
    switch (event.type) {
      case "message": {
        const attachments = event.attachments ?? [];
        const modality = event.modality ?? "text";
        const audio =
          modality === "voice"
            ? (attachments.find((a): a is AudioAttachment => a.kind === "audio") ?? null)
            : null;
        const images = attachments.filter(
          (attachment): attachment is ImageAttachment => attachment.kind === "image",
        );
        if (
          event.text === "" &&
          audio === null &&
          images.length === 0 &&
          (event.speaker.kind === "user" || event.cutOff === undefined)
        ) {
          break;
        }
        const item: MessageItem = {
          kind: "message",
          key,
          seq,
          at,
          speaker: event.speaker,
          text: event.text,
          modality,
          audio,
          images,
          interrupted: event.interrupted ?? false,
          cutOff: event.cutOff ?? null,
          sentAsText: false,
        };
        items.push(item);
        break;
      }
      case "turn-failed": {
        if (event.code !== "voice-failed") {
          items.push({ kind: "failed", key, seq, at, persona: event.persona });
          break;
        }
        const index = items.findLastIndex(
          (item) =>
            item.kind === "message" &&
            item.speaker.kind === "persona" &&
            item.speaker.id === event.persona,
        );
        const reply = items[index];
        if (reply?.kind === "message") items[index] = { ...reply, sentAsText: true };
        break;
      }
      case "call-started":
        calls.set(event.call, { persona: event.persona, at });
        items.push({
          kind: "call",
          key,
          seq,
          at,
          edge: "started",
          call: event.call,
          persona: event.persona,
          reason: null,
          durationMs: null,
        });
        break;
      case "call-ended": {
        const started = calls.get(event.call);
        ended.add(event.call);
        items.push({
          kind: "call",
          key,
          seq,
          at,
          edge: "ended",
          call: event.call,
          persona: started?.persona ?? null,
          reason: event.reason,
          durationMs: started === undefined ? null : Math.max(0, at - started.at),
        });
        break;
      }
    }
  }
  if (ended.size === 0) return items;
  return items.filter(
    (item) => item.kind !== "call" || item.edge === "ended" || !ended.has(item.call),
  );
}

/** The turns still streaming, as the rows after the stored ones. */
export function liveItems(live: readonly LiveTurn[]): ChatItem[] {
  return live
    .filter((turn) => !turn.settled)
    .map((turn) => ({
      kind: "live",
      key: `live-${turn.turn}`,
      turn: turn.turn,
      persona: turn.persona,
      text: turn.text,
      tools: turn.tools,
    }));
}
