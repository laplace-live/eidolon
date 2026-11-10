import {
  asyncToolCallId,
  cancelledEnvelope,
  finalEnvelope,
  startedEnvelope,
} from "./async_tool.ts";
import type { ChatEvent, ChatEventOf, ChatHeader, ParticipantId } from "./format.ts";
import { summarize } from "./summary.ts";

/** The lines a persona's view keeps; older ones are Mem0's to recall. */
export const CHAT_WINDOW_MESSAGES = 60;

export interface ViewToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** An OpenAI-shaped message, as a turn's context holds them. */
export type ViewMessage =
  | { role: "user" | "assistant" | "system" | "developer"; content: string }
  | { role: "assistant"; tool_calls: [ViewToolCall] }
  | ViewToolMessage;

type ViewToolMessage = { role: "tool"; tool_call_id: string; content: string };

export interface ViewOptions {
  /** How many lines (messages and her kickoffs) to keep, counted back from the newest. */
  readonly windowMessages: number;
  /** The name another persona's lines are prefixed with. */
  nameOf(id: ParticipantId): string;
  /** The viewer's lines are prefixed with it while the chat has two or more personas; 观众 unset. */
  readonly viewerName?: string;
}

type Line = ChatEventOf<"message"> | ChatEventOf<"kickoff">;

/** The name the viewer's lines carry in a chat of two or more personas. */
export function viewerLabel(viewerName: string | undefined): string {
  return viewerName || "观众";
}

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
 * Python's `json.dumps(value, ensure_ascii=False)`, its `", "` and `": "` separators included, as
 * pipedog writes a call's arguments and result into the context.
 */
function pyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  const fields = Object.entries(value)
    .filter(([, field]) => field !== undefined)
    .map(([key, field]) => `${JSON.stringify(key)}: ${pyJson(field)}`);
  return `{${fields.join(", ")}}`;
}

/** pipedog's content for a tool's result: "COMPLETED" for an empty one, by Python's truthiness. */
function resultContent(result: Readonly<Record<string, unknown>>): string {
  return Object.keys(result).length === 0 ? "COMPLETED" : pyJson(result);
}

/**
 * A tool call as her view holds it: the `assistant.tool_calls` message, then its `tool` message,
 * with pipedog's content: "CANCELLED" for a call with no result, and for `started`, an async call
 * still running, the placeholder `startedEnvelope`.
 */
export function toolCallMessages(
  call: Pick<ChatEventOf<"tool-call">, "callId" | "name" | "arguments">,
  result: Readonly<Record<string, unknown>> | null | "started",
): [ViewMessage, ViewToolMessage] {
  let content: string;
  if (result === null) content = "CANCELLED";
  else if (result === "started") content = startedEnvelope(call.callId);
  else content = resultContent(result);
  return [
    {
      role: "assistant",
      tool_calls: [
        {
          id: call.callId,
          type: "function",
          function: { name: call.name, arguments: pyJson(call.arguments) },
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
 * accumulate as they do in a call, until a `context-removed` takes one out. An async call's result
 * replaces its placeholder, or comes later as a developer message once the conversation has moved
 * on, as pipedog settles it. What belongs to another persona is left out.
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
    summarize(header, events).participants.length > 1 ? `${viewerLabel(options.viewerName)}：` : "";
  const results = new Map<string, Readonly<Record<string, unknown>> | "started">();
  for (const event of events) {
    if (event.type !== "tool-result" || event.persona !== id) continue;
    if (event.stage === undefined) results.set(event.callId, event.result);
    else if (event.stage === "started") results.set(event.callId, "started");
  }
  const placeholders = new Map<string, ViewToolMessage>();
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
          const result = results.get(event.callId) ?? null;
          const [call, tool] = toolCallMessages(event, result);
          view.push(call, tool);
          if (result === "started") placeholders.set(event.callId, tool);
        }
        break;
      case "tool-result":
        if (event.persona === id && event.stage === "cancelled") {
          view.push({ role: "developer", content: cancelledEnvelope(event.callId) });
        } else if (event.persona === id && event.stage === "final") {
          const content = resultContent(event.result);
          const placeholder = placeholders.get(event.callId);
          if (placeholder !== undefined && !movedOn(view, placeholder)) {
            placeholder.content = content;
          } else {
            view.push({ role: "developer", content: finalEnvelope(event.callId, content) });
          }
        }
        break;
    }
  }
  return { messages: view, blocks };
}

/**
 * Whether the conversation went on past an async call's placeholder, so its result has to reach
 * her as a developer message: pipedog's `_isDeferred`, which overlooks tool and assistant messages
 * and other calls' async-tool messages.
 */
function movedOn(view: readonly ViewMessage[], placeholder: ViewToolMessage): boolean {
  return view.slice(view.indexOf(placeholder) + 1).some((message) => {
    if (message.role === "tool" || message.role === "assistant") return false;
    const callId = message.role === "developer" ? asyncToolCallId(message.content) : null;
    return callId === null || callId === placeholder.tool_call_id;
  });
}
