// A call inside a chat on the native engine, through the CallBinding pipedog's sessions take: its
// log opens on the chat as her view had it, and each line said on it, each photo she sends and its
// end reach the binding's hooks as pipedog's session reports them (docs/voice-engine.md). A group
// call, which only the native engine runs, opens on the chat itself and reports its events.
import {
  CHAT_WINDOW_MESSAGES,
  type ChatEvent,
  type ChatEventDraft,
  type ChatHeader,
  type ParticipantId,
  type Speaker,
  viewOf,
} from "@eidolon/chat";
import { errorText, isPlainObject, logger } from "@eidolon/config";
import type { ContextProvider } from "@eidolon/core";
import { groupMemory, type TurnRequest } from "@eidolon/engine";
import { MEM0_LABEL, MEM0_STORE_KEY } from "@eidolon/memory";
import {
  type CallDeps,
  type CallLog,
  type CallTransport,
  type CloseReason,
  rtviMessage,
} from "@eidolon/voice";
import type { CallBinding, CallClient, CallEnd, TranscriptLine } from "../session/session.ts";

/**
 * A call with every persona in a chat at once, the director choosing who answers each line. Only
 * the native engine runs one.
 */
export interface GroupCallBinding {
  readonly group: true;
  /** The host, whose hearing role hears the viewer, and whose scope the call runs in. */
  readonly persona: string;
  /** The chat as stored as the call opens, which each persona's view opens on. */
  readonly chat: { readonly header: ChatHeader; readonly events: readonly ChatEvent[] };
  /**
   * Each event of the chat's the call stores, as the call's log numbered it: every line said on
   * it, the viewer's (`modality` `call`, or `text` when typed) or a persona's, and each `decision`,
   * whose `after` is the seq of the line it answers in that numbering.
   */
  readonly onEvents: (events: readonly ChatEvent[], client: CallClient) => void;
  /** Each server message the call sends its browser; a selfie's names her `persona`. */
  readonly onServerMessage?: (data: Readonly<Record<string, unknown>>, client: CallClient) => void;
  /** Called once, after the call's last event. */
  readonly onEnded: (end: CallEnd) => void;
}

export type AnyCallBinding = CallBinding | GroupCallBinding;

export function isGroupCall(
  binding: { readonly persona: string } | undefined,
): binding is GroupCallBinding {
  return binding !== undefined && "group" in binding && binding.group === true;
}

/**
 * The seed as log events whose view is the seed: the viewer's lines and hers as messages, and a
 * system or developer message as her context block where it stands.
 */
function seedEvents(seed: readonly unknown[], persona: ParticipantId): ChatEventDraft[] {
  const drafts: ChatEventDraft[] = [];
  for (const message of seed) {
    if (!isPlainObject(message)) continue;
    const { role } = message;
    const text = message.content;
    if (typeof text !== "string") continue;
    if (role === "user" || role === "assistant") {
      const speaker: Speaker =
        role === "user" ? { kind: "user" } : { kind: "persona", id: persona };
      drafts.push({ type: "message", id: Bun.randomUUIDv7(), speaker, text });
    } else if (role === "system" || role === "developer") {
      const position = drafts.length;
      drafts.push({ type: "context", persona, turn: "seed", position, role, content: text });
    }
  }
  return drafts;
}

/** The finished line `event` is, the viewer's or hers; null for anything else. */
function lineOf(event: ChatEvent, persona: ParticipantId): TranscriptLine | null {
  if (event.type !== "message" || event.text.trim() === "") return null;
  const { speaker } = event;
  if (speaker.kind === "persona" && speaker.id !== persona) return null;
  const role = speaker.kind === "user" ? "user" : "assistant";
  return { role, text: event.text, interrupted: event.interrupted === true };
}

/** A hook's throw is logged: thrown into the Floor, it would end the call. */
function report(what: string, hook: () => void): void {
  try {
    hook();
  } catch (error) {
    logger.error(`Could not report ${what}: ${errorText(error)}`, error);
  }
}

/** What Mem0 stores of `said`, the events of the call, for `persona`. */
type CallMemory = (
  header: ChatHeader,
  said: readonly ChatEvent[],
  persona: ParticipantId,
) => readonly unknown[];

/** Her view of what was said on a call of hers alone, so no other persona's name is looked up. */
const herView: CallMemory = (header, said, persona) =>
  viewOf(header, said, persona, { windowMessages: CHAT_WINDOW_MESSAGES, nameOf: (id) => id });

/**
 * On a group call, the viewer's lines and hers, never another persona's, which would become
 * memories of the viewer: what the engine hands Mem0 in a group chat, of the call's lines alone.
 */
const ownLines: CallMemory = (_header, said, persona) => groupMemory(said, persona);

/** Her Mem0, storing `memory` of what was said on the call: the chat's own turns stored the rest. */
function storingCallOnly(
  provider: ContextProvider,
  chat: TurnRequest["chat"],
  persona: ParticipantId,
  seeded: number,
  memory: CallMemory,
): ContextProvider {
  return {
    onContext: (turn) => {
      const said = chat.events.filter((event) => event.seq > seeded);
      turn.metadata[MEM0_STORE_KEY] = memory(chat.header, said, persona);
      return provider.onContext(turn);
    },
    errorMessage: (error) => provider.errorMessage(error),
  };
}

export interface BoundCall {
  readonly log: CallLog;
  readonly transport: CallTransport;
  readonly deps: CallDeps;
  /** The call is over: its browser gets nothing more. */
  close(): void;
}

/**
 * The call's `log`, `transport` and `deps` reporting to a binding's hooks: what the log takes after
 * seq `seeded` goes to `onStored`, each server message the call sends its browser reaches
 * `onServerMessage` once sent, and Mem0 stores `memory` of what is said on the call. Every hook gets
 * one CallClient, which reaches the browser until it hangs up or the call ends.
 */
function bound(
  call: { readonly log: CallLog; readonly transport: CallTransport; readonly deps: CallDeps },
  seeded: number,
  hooks: {
    readonly onStored: (events: readonly ChatEvent[], client: CallClient) => void;
    readonly onServerMessage?: (
      data: Readonly<Record<string, unknown>>,
      client: CallClient,
    ) => void;
  },
  memory: CallMemory,
): BoundCall {
  const { log, transport, deps } = call;
  const { onStored, onServerMessage } = hooks;
  let over = false;
  void transport.closed.then(() => {
    over = true;
  });
  const client: CallClient = {
    sendServerMessage: async (data) => {
      if (!over) transport.send(rtviMessage("server-message", data));
    },
  };
  const { engine } = deps;
  return {
    log: {
      snapshot: () => log.snapshot(),
      append(drafts) {
        const events = log.append(drafts);
        onStored(events, client);
        return events;
      },
      flush: () => log.flush(),
    },
    transport: {
      audioIn: transport.audioIn,
      messages: transport.messages,
      closed: transport.closed,
      attachSpeaker: (source) => transport.attachSpeaker(source),
      send(message) {
        transport.send(message);
        const { data } = message;
        if (message.type === "server-message" && isPlainObject(data) && onServerMessage) {
          report("a server message", () => onServerMessage(data, client));
        }
      },
      connect: () => transport.connect(),
      disconnect: () => transport.disconnect(),
    },
    deps: {
      ...deps,
      engine: {
        ...engine,
        parts: async (who, viewer, chat, options) => {
          const parts = await engine.parts(who, viewer, chat, options);
          const providers = parts.providers.map((entry) =>
            entry.label === MEM0_LABEL
              ? { ...entry, provider: storingCallOnly(entry.provider, chat, who, seeded, memory) }
              : entry,
          );
          return { ...parts, providers };
        },
      },
    },
    close: () => {
      over = true;
    },
  };
}

/**
 * The call's `log`, `transport` and `deps` bound to `binding`: the log opens on the seed and hands
 * each finished line it stores to `onTranscript`, each server message the call sends its browser
 * reaches `onServerMessage` once sent, and Mem0 stores only what is said on the call.
 */
export function bindCall(
  binding: CallBinding,
  log: CallLog,
  transport: CallTransport,
  deps: CallDeps,
): BoundCall {
  const { persona, onTranscript, onServerMessage } = binding;
  const seeded = log.append(seedEvents(binding.seedMessages, persona)).at(-1)?.seq ?? 0;
  const onStored = (events: readonly ChatEvent[], client: CallClient) => {
    for (const event of events) {
      const line = lineOf(event, persona);
      if (line !== null) report("a call line", () => onTranscript(line, client));
    }
  };
  const hooks = { onStored, ...(onServerMessage ? { onServerMessage } : {}) };
  return bound({ log, transport, deps }, seeded, hooks, herView);
}

/**
 * A group call's `log`, opened on the chat as stored, its `transport` and its `deps`, bound to
 * `binding`: each line said on the call and each decision go to `onEvents` as the log takes them,
 * each server message to `onServerMessage`, and each persona's Mem0 stores only the viewer's lines
 * on the call and hers.
 */
export function bindGroupCall(
  binding: GroupCallBinding,
  log: CallLog,
  transport: CallTransport,
  deps: CallDeps,
): BoundCall {
  const { onEvents, onServerMessage } = binding;
  const seeded = binding.chat.events.at(-1)?.seq ?? 0;
  const onStored = (events: readonly ChatEvent[], client: CallClient) => {
    const reported = events.filter(
      (event) =>
        event.type === "decision" || (event.type === "message" && event.text.trim() !== ""),
    );
    if (reported.length > 0) report("the call's events", () => onEvents(reported, client));
  };
  const hooks = { onStored, ...(onServerMessage ? { onServerMessage } : {}) };
  return bound({ log, transport, deps }, seeded, hooks, ownLines);
}

/** Tells the binding how its call ended: `error` when it couldn't start or failed. */
export function reportEnd(binding: AnyCallBinding, reason: CloseReason): void {
  report("the call's end", () => binding.onEnded(reason === "error" ? "error" : "hangup"));
}
