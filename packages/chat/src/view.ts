import {
  asyncToolCallId,
  cancelledEnvelope,
  finalEnvelope,
  startedEnvelope,
} from "./async_tool.ts";
import type { Attachment, ChatEvent, ChatEventOf, ChatHeader, ParticipantId } from "./format.ts";
import { summarize } from "./summary.ts";

/** The lines a persona's view keeps; older ones are Mem0's to recall. */
export const CHAT_WINDOW_MESSAGES = 60;

/** Her newest turns whose results stay whole; older results she waited for read as stubs. */
const WHOLE_TURNS = 2;

export interface ViewToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** An OpenAI-shaped message, as a turn's context holds them. */
export type ViewMessage =
  | { role: "user" | "assistant" | "system" | "developer"; content: string }
  | ViewUserMessage
  | { role: "assistant"; content?: string; tool_calls: [ViewToolCall] }
  | ViewToolMessage;

/**
 * A line of the viewer's that came with files. `content` is what they typed, for whatever reads
 * text alone; the files reach a mind only as the engine shows them to it, as her turn's request
 * is made.
 */
export type ViewUserMessage = {
  role: "user";
  content: string;
  attachments: readonly Attachment[];
};

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

/** The files the viewer sent with a line: a voice message's audio is its transcript instead. */
export function sentFiles(message: ChatEventOf<"message">): readonly Attachment[] {
  if (message.speaker.kind !== "user" || message.attachments === undefined) return [];
  return message.attachments.filter((file) => file.kind !== "audio");
}

/** Whether a message is a line: it has words, or files the viewer sent. */
function isLine(message: ChatEventOf<"message">): boolean {
  return message.text !== "" || sentFiles(message).length > 0;
}

/**
 * The seq her view starts at: the oldest line in the window, moved on to the first that isn't
 * hers, so the view opens on a user message the way a call's does.
 */
function windowStart(events: readonly ChatEvent[], id: ParticipantId, size: number): number {
  const lines = events.filter(
    (event): event is Line =>
      (event.type === "message" && isLine(event)) ||
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
 * The seq of the line of hers that ended the turn before her WHOLE_TURNS newest: a turn's calls all
 * come before its line, and a turn that said nothing has none. None while she has too few lines.
 */
function stubBefore(events: readonly ChatEvent[], id: ParticipantId): number {
  const lines = events.filter(
    (event) => event.type === "message" && event.text !== "" && isFrom(event, id),
  );
  return lines.at(-(WHOLE_TURNS + 1))?.seq ?? Number.NEGATIVE_INFINITY;
}

/** A result's content as an older turn's reads it: its stub, when that is shorter. */
function stubbed(name: string, content: string): string {
  const stub = `[${name} result elided, ${content.length} characters]`;
  return stub.length < content.length ? stub : content;
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
 * A `started` result as `toolCallMessages` takes it: "started", pipedog's placeholder, for its
 * async tools' `{}`, else what a background tool started, as it is. Only a `{}` start gets
 * pipedog's rule for the call's `final`, so a background tool's started result is never empty.
 */
export function startedResult(
  result: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | "started" {
  return Object.keys(result).length === 0 ? "started" : result;
}

/**
 * A tool call as her view holds it: the `assistant.tool_calls` message, with the words she wrote
 * before it as its content, then its `tool` message, with pipedog's content: "CANCELLED" for a
 * call with no result, and for `started`, an async call still running, the placeholder
 * `startedEnvelope`.
 */
export function toolCallMessages(
  call: Pick<ChatEventOf<"tool-call">, "callId" | "name" | "arguments">,
  result: Readonly<Record<string, unknown>> | null | "started",
  said?: string,
): [ViewMessage, ViewToolMessage] {
  let content: string;
  if (result === null) content = "CANCELLED";
  else if (result === "started") content = startedEnvelope(call.callId);
  else content = resultContent(result);
  return [
    {
      role: "assistant",
      ...(said ? { content: said } : {}),
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
 * personas; a run of other personas' lines becomes one `user` message of `名字：text` lines,
 * another persona's said joining her next line into one when no other line comes between. Her
 * kickoff is a `user` message, each tool call an `assistant.tool_calls` message, her said as its
 * content, followed by its result, and each context block is spliced in at its recorded position
 * in seq order, so blocks accumulate as they do in a call, until a `context-removed` takes one
 * out. A result she waited for, from a turn before her WHOLE_TURNS newest, reads as a stub naming
 * its tool and length when that is shorter; the log keeps it whole. A `final` of pipedog's async
 * calls, whose `started` result is `{}`, replaces its placeholder, or comes later as a developer
 * message once the conversation has moved on, as pipedog settles it. Every other `final` replaces
 * its call's result, comes with its call, without its said, when that call left the window, and is
 * left out when the log holds no call for it, so what a background tool brings back stays a tool's
 * output. A `cancelled` always comes as a developer message. What belongs to another persona is
 * left out.
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
  /** Her calls whose result she waited for: stored with no stage. */
  const waited = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool-result" || event.persona !== id) continue;
    if (event.stage === undefined) {
      results.set(event.callId, event.result);
      waited.add(event.callId);
    } else if (event.stage === "started") {
      results.set(event.callId, startedResult(event.result));
      waited.delete(event.callId);
    }
  }
  const stubs = stubBefore(events, id);
  /** Her calls' `tool` messages in the window, by call id. */
  const toolMessages = new Map<string, ViewToolMessage>();
  /** Her calls by id, those before the window too. */
  const calls = new Map<string, ChatEventOf<"tool-call">>();
  const view: ViewMessage[] = [];
  const blocks = new Map<ViewMessage, number>();
  const bySeq = new Map<number, ViewMessage>();
  let others: { role: "user"; content: string } | null = null;
  /** The persona whose said ends `others`, which her next line joins while nothing follows it. */
  let saying: ParticipantId | null = null;
  /** Another persona's line, or her said, joining or starting the run of others' lines. */
  const other = (persona: ParticipantId, text: string, said: boolean): void => {
    if (others !== null && view.at(-1) === others) {
      others.content += saying === persona ? text : `\n${options.nameOf(persona)}：${text}`;
    } else {
      others = { role: "user", content: `${options.nameOf(persona)}：${text}` };
      view.push(others);
    }
    saying = said ? persona : null;
  };
  for (const event of events) {
    if (event.type === "tool-call" && event.persona === id) calls.set(event.callId, event);
    if (event.seq < start) continue;
    switch (event.type) {
      case "message": {
        if (!isLine(event)) break;
        const { speaker } = event;
        if (speaker.kind === "user") {
          const content = `${viewer}${event.text}`;
          const attachments = sentFiles(event);
          view.push(
            attachments.length === 0
              ? { role: "user", content }
              : { role: "user", content, attachments },
          );
        } else if (speaker.id === id) {
          view.push({ role: "assistant", content: event.text });
        } else {
          other(speaker.id, event.text, false);
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
          const [call, tool] = toolCallMessages(event, result, event.said);
          if (waited.has(event.callId) && event.seq < stubs) {
            tool.content = stubbed(event.name, tool.content);
          }
          view.push(call, tool);
          toolMessages.set(event.callId, tool);
        } else if (event.said) {
          other(event.persona, event.said, true);
        }
        break;
      case "tool-result":
        if (event.persona === id && event.stage === "cancelled") {
          view.push({ role: "developer", content: cancelledEnvelope(event.callId) });
        } else if (event.persona === id && event.stage === "final") {
          const content = resultContent(event.result);
          const tool = toolMessages.get(event.callId);
          // pipedog's async call: its started result was `{}`.
          if (results.get(event.callId) === "started") {
            if (tool !== undefined && !movedOn(view, tool)) tool.content = content;
            else view.push({ role: "developer", content: finalEnvelope(event.callId, content) });
          } else if (tool !== undefined) {
            // What a background tool brings, such as a page a task quotes, stays a tool's output.
            tool.content = content;
          } else {
            const call = calls.get(event.callId);
            if (call !== undefined) view.push(...toolCallMessages(call, event.result));
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
