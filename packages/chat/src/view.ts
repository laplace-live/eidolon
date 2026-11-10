import type { ChatEvent, ChatEventOf, ChatHeader, ParticipantId } from "./format.ts";
import { summarize } from "./summary.ts";

/** The lines a persona's view keeps; older ones are Mem0's to recall. */
export const CHAT_WINDOW_MESSAGES = 60;

export interface ViewToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** An OpenAI-shaped message, as the voice pipeline's context holds them. */
export type ViewMessage =
  | { role: "user" | "assistant" | "system" | "developer"; content: string }
  | { role: "assistant"; tool_calls: [ViewToolCall] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ViewOptions {
  /** How many lines (messages and her kickoffs) to keep, counted back from the newest. */
  readonly windowMessages: number;
  /** The name another persona's lines are prefixed with. */
  nameOf(id: ParticipantId): string;
  /** The viewer's lines are prefixed with it while the chat has two or more personas; 观众 unset. */
  readonly viewerName?: string;
}

type Line = ChatEventOf<"message"> | ChatEventOf<"kickoff">;

/**
 * The seq her view starts at: the oldest line in the window, moved on to the first that isn't
 * hers, so the view opens on a user message the way a call's does.
 */
function windowStart(events: readonly ChatEvent[], id: ParticipantId, size: number): number {
  const lines = events.filter(
    (event): event is Line =>
      (event.type === "message" && event.text !== "") ||
      (event.type === "kickoff" && event.persona === id),
  );
  if (lines.length <= size) return 0;
  if (size <= 0) return Number.POSITIVE_INFINITY;
  const first = lines.length - size;
  const opening = lines.slice(first).find((line) => !(line.type === "message" && isFrom(line, id)));
  return (opening ?? (lines[first] as Line)).seq;
}

function isFrom(message: ChatEventOf<"message">, id: ParticipantId): boolean {
  return message.speaker.kind === "persona" && message.speaker.id === id;
}

/**
 * A tool call as her view holds it: the `assistant.tool_calls` message, then its `tool` message,
 * with pipedog's content: "CANCELLED" for a call with no result, and "COMPLETED" for an empty
 * result, by Python's truthiness.
 */
export function toolCallMessages(
  call: Pick<ChatEventOf<"tool-call">, "callId" | "name" | "arguments">,
  result: Readonly<Record<string, unknown>> | null,
): [ViewMessage, ViewMessage] {
  let content: string;
  if (result === null) content = "CANCELLED";
  else content = Object.keys(result).length === 0 ? "COMPLETED" : JSON.stringify(result);
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id: call.callId,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        },
      ],
    },
    { role: "tool", tool_call_id: call.callId, content },
  ];
}

/**
 * Persona `id`'s LLM messages, without a system message: what a call with her would have built.
 * Her lines are `assistant` and the viewer's `user`, as `名字：text` while the chat has two or more
 * personas; a run of other personas' lines becomes one `user` message of `名字：text` lines. Her
 * kickoff is a `user` message, each tool call an `assistant.tool_calls` message followed by its
 * result, and each context block is spliced in at its recorded position in seq order, so blocks
 * accumulate as they do in a call, until a `context-removed` takes one out. What belongs to another
 * persona is left out.
 */
export function viewOf(
  header: ChatHeader,
  events: readonly ChatEvent[],
  id: ParticipantId,
  options: ViewOptions,
): ViewMessage[] {
  return viewWithBlocks(header, events, id, options).messages;
}

/** viewOf, with the seq of the `context` event each of her blocks in it came from. */
export function viewWithBlocks(
  header: ChatHeader,
  events: readonly ChatEvent[],
  id: ParticipantId,
  options: ViewOptions,
): { messages: ViewMessage[]; blocks: Map<ViewMessage, number> } {
  const start = windowStart(events, id, options.windowMessages);
  const viewer =
    summarize(header, events).participants.length > 1 ? `${options.viewerName || "观众"}：` : "";
  const results = new Map<string, ChatEventOf<"tool-result">>();
  for (const event of events) {
    if (event.type === "tool-result" && event.persona === id) results.set(event.callId, event);
  }
  const view: ViewMessage[] = [];
  const blocks = new Map<ViewMessage, number>();
  const bySeq = new Map<number, ViewMessage>();
  let others: { role: "user"; content: string } | null = null;
  for (const event of events) {
    if (event.seq < start) continue;
    switch (event.type) {
      case "message": {
        if (event.text === "") break;
        const { speaker } = event;
        if (speaker.kind === "user") {
          view.push({ role: "user", content: `${viewer}${event.text}` });
        } else if (speaker.id === id) {
          view.push({ role: "assistant", content: event.text });
        } else {
          const line = `${options.nameOf(speaker.id)}：${event.text}`;
          if (others !== null && view.at(-1) === others) {
            others.content += `\n${line}`;
          } else {
            others = { role: "user", content: line };
            view.push(others);
          }
        }
        break;
      }
      case "kickoff":
        if (event.persona === id) view.push({ role: "user", content: event.content });
        break;
      case "context":
        if (event.persona === id) {
          const at = Math.max(0, Math.min(event.position, view.length));
          const block: ViewMessage = { role: event.role, content: event.content };
          view.splice(at, 0, block);
          blocks.set(block, event.seq);
          bySeq.set(event.seq, block);
        }
        break;
      case "context-removed":
        if (event.persona === id) {
          for (const seq of event.seqs) {
            const block = bySeq.get(seq);
            const at = block === undefined ? -1 : view.indexOf(block);
            if (at === -1) continue;
            view.splice(at, 1);
            blocks.delete(block as ViewMessage);
          }
        }
        break;
      case "tool-call":
        if (event.persona === id) {
          view.push(...toolCallMessages(event, results.get(event.callId)?.result ?? null));
        }
        break;
    }
  }
  return { messages: view, blocks };
}
