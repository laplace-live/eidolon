// A mind on Anthropic's Messages API, sending what a call's AnthropicLLMService sends (prompt
// caching, refusal fallbacks, each model's lowest thinking) and streaming back her text and whole
// tool calls.
// Ports parts of pipedog's Anthropic LLM service and adapter
// (BSD-2-Clause; Copyright (c) 2024–2026 Daily, Copyright (c) 2026 pipedog contributors).
import { isPlainObject, logger, pyJsonLoads } from "@eidolon/config";
import type { ToolSchema } from "@eidolon/core";
import type { AnthropicClient } from "@eidolon/providers";
import type { Mind, MindChunk, MindRequest } from "../types.ts";
import { assembleCalls, type PendingCall } from "./calls.ts";

export interface AnthropicMindOptions {
  readonly client: AnthropicClient;
  readonly model: string;
  /** Fields over the request's own: the catalog's call-time ones, and `fallbacks`. */
  readonly extra: Readonly<Record<string, unknown>>;
}

type Block = Record<string, unknown>;

interface Turn {
  role: string;
  content: string | Block[];
}

const MAX_TOKENS = 4096;

const BETAS = ["interleaved-thinking-2025-05-14"];

/**
 * Each model's lowest thinking setting, as pipedog sends it unless the request sets `thinking` or
 * an effort: the models that can't stop thinking get the lowest effort instead.
 */
const THINKING_DEFAULTS: Readonly<Record<string, Readonly<Record<string, Block>>>> = {
  "claude-fable-5-1": { output_config: { effort: "low" } },
  "claude-fable-5": { output_config: { effort: "low" } },
  "claude-opus-5-5": { output_config: { effort: "low" } },
  "claude-opus-5": { thinking: { type: "disabled" } },
  "claude-sonnet-5-5": { thinking: { type: "between_tools" } },
  "claude-sonnet-5": { thinking: { type: "disabled" } },
  "claude-haiku-5-5": { thinking: { type: "disabled" } },
  "claude-opus-4-8": { thinking: { type: "disabled" } },
  "claude-opus-4-7": { thinking: { type: "disabled" } },
  "claude-opus-4-6": { thinking: { type: "disabled" } },
  "claude-sonnet-4-6": { thinking: { type: "disabled" } },
  "claude-opus-4-5": { thinking: { type: "disabled" } },
  "claude-sonnet-4-5": { thinking: { type: "disabled" } },
  "claude-haiku-4-5": { thinking: { type: "disabled" } },
};

/** The models that take a request ending on an assistant message; Anthropic dropped it at 4.6. */
const PREFILL_MODELS = [
  "claude-2",
  "claude-instant",
  "claude-3",
  "claude-opus-4-0",
  "claude-opus-4-1",
  "claude-sonnet-4-0",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
];

/** The name a model id refers to: Bedrock's and Vertex's wrappers and a dated snapshot removed. */
function modelName(model: string): string {
  let name = model.toLowerCase();
  name = name.slice(name.lastIndexOf(".") + 1);
  const at = name.indexOf("@");
  if (at !== -1) name = name.slice(0, at);
  return name.replace(/-v\d+:\d+$/, "").replace(/-\d{8}$/, "");
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((part) => isPlainObject(part) && part.type === "text")
    .map((part) => String(part.text ?? ""))
    .join(" ");
}

function turnOf(message: Record<string, unknown>): Turn {
  const role = String(message.role);
  if (role === "tool") {
    return {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content },
      ],
    };
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return {
      role: "assistant",
      content: message.tool_calls.filter(isPlainObject).map((call) => {
        const fn = isPlainObject(call.function) ? call.function : {};
        const input = pyJsonLoads(String(fn.arguments));
        return { type: "tool_use", id: call.id, name: fn.name, input };
      }),
    };
  }
  const { content } = message;
  if (Array.isArray(content)) {
    return {
      role,
      content: content.map((part) =>
        isPlainObject(part) && part.type === "text" && part.text === ""
          ? { ...part, text: "(empty)" }
          : part,
      ),
    };
  }
  return { role, content: content === "" ? "(empty)" : String(content ?? "") };
}

/**
 * Her tool calls and their results as notes in the user's turns, for a request that offers no
 * tools: Anthropic refuses tool_use and tool_result blocks without tools. Written as her own lines,
 * they would teach her to write them.
 */
function callsAsNotes(messages: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const names = new Map<unknown, string>();
  return messages.map((message) => {
    if (message.role === "tool") {
      const name = names.get(message.tool_call_id) ?? "tool";
      return { role: "user", content: `（${name} 返回：${textOf(message.content)}）` };
    }
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) return message;
    const notes = message.tool_calls.filter(isPlainObject).map((call) => {
      const fn = isPlainObject(call.function) ? call.function : {};
      names.set(call.id, String(fn.name));
      return `（你调用了 ${fn.name} ${fn.arguments}）`;
    });
    return { role: "user", content: notes.join("\n") };
  });
}

function asBlocks(content: string | Block[]): Block[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function toolIds(turn: Turn): string[] {
  if (typeof turn.content === "string") return [];
  return turn.content.filter((block) => block.type === "tool_use").map((block) => String(block.id));
}

/**
 * OpenAI-shaped messages as Messages API turns, and the system prompt: a first system message is
 * the prompt when `system` is empty and is dropped otherwise, as pipedog's adapter does. `thinking`
 * puts back the signed thinking that came before a tool call, keyed by the call's id.
 */
function turnsFor(
  request: MindRequest,
  model: string,
  thinking: ReadonlyMap<string, readonly Block[]>,
): { system: string | null; turns: Turn[] } {
  const given = request.messages.filter(isPlainObject);
  const messages = request.tools.length > 0 ? given : callsAsNotes(given);
  let extracted: string | null = null;
  const first = messages[0];
  if (first?.role === "system") {
    if (messages.length === 1) messages[0] = { ...first, role: "user" };
    else {
      extracted = textOf(first.content);
      messages.shift();
    }
  }
  const turns = messages.map(turnOf);
  for (const turn of turns) {
    if (turn.role === "system" || turn.role === "developer") turn.role = "user";
  }
  for (let i = 0; i < turns.length - 1; ) {
    const current = turns[i] as Turn;
    const next = turns[i + 1] as Turn;
    if (current.role === next.role) {
      current.content = [...asBlocks(current.content), ...asBlocks(next.content)];
      turns.splice(i + 1, 1);
    } else {
      i++;
    }
  }
  for (const turn of turns) {
    if (turn.content === "") turn.content = "(empty)";
    else if (Array.isArray(turn.content) && turn.content.length === 0) {
      turn.content = [{ type: "text", text: "(empty)" }];
    }
    const thought = toolIds(turn)
      .map((id) => thinking.get(id))
      .find((blocks) => blocks !== undefined);
    if (thought !== undefined) turn.content = [...thought, ...asBlocks(turn.content)];
  }
  if (
    !PREFILL_MODELS.some((prefix) => model.startsWith(prefix)) &&
    turns.at(-1)?.role === "assistant"
  ) {
    turns.push({ role: "user", content: [{ type: "text", text: "." }] });
  }
  return { system: request.system || extracted || null, turns };
}

/** Cache breakpoints on the last two user turns: the newer writes the cache, the older reads it. */
function withCacheMarkers(turns: readonly Turn[]): Turn[] {
  const marked = structuredClone(turns) as Turn[];
  let left = 2;
  for (let i = marked.length - 1; i >= 0 && left > 0; i--) {
    const turn = marked[i] as Turn;
    if (turn.role !== "user") continue;
    turn.content = asBlocks(turn.content);
    const last = turn.content.at(-1);
    if (last !== undefined) last.cache_control = { type: "ephemeral" };
    left--;
  }
  return marked;
}

function toolFor(schema: ToolSchema): Block {
  return {
    name: schema.name,
    description: schema.description,
    input_schema: {
      type: "object",
      properties: { ...schema.properties },
      required: [...schema.required],
    },
  };
}

function bodyFor(
  request: MindRequest,
  options: AnthropicMindOptions,
  thinking: ReadonlyMap<string, readonly Block[]>,
): Block {
  const { system, turns } = turnsFor(request, options.model, thinking);
  const body: Block = { model: options.model, max_tokens: MAX_TOKENS, stream: true };
  if (system !== null) {
    body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }
  body.messages = withCacheMarkers(turns);
  body.tools = request.tools.map(toolFor);
  if (request.stop?.length) body.stop_sequences = [...request.stop];
  Object.assign(body, options.extra);
  const effort = isPlainObject(body.output_config) && "effort" in body.output_config;
  const name = modelName(options.model);
  if (!("thinking" in body) && !effort && Object.hasOwn(THINKING_DEFAULTS, name)) {
    for (const [field, value] of Object.entries(THINKING_DEFAULTS[name] as Block)) {
      body[field] = { ...(isPlainObject(body[field]) ? body[field] : {}), ...(value as Block) };
    }
  }
  body.betas = [...BETAS];
  return body;
}

/** Why Claude stopped, when it left her reply short: a refusal, or a token or context limit. */
function warnIfCut(delta: Record<string, unknown>): void {
  const reason = delta.stop_reason;
  if (reason === "end_turn" || reason === "tool_use" || reason === "stop_sequence") return;
  const details = isPlainObject(delta.stop_details) ? delta.stop_details : {};
  const detail = typeof details.category === "string" ? ` (${details.category})` : "";
  logger.warning(`Anthropic's response is incomplete: the model stopped for ${reason}${detail}`);
}

/**
 * Keep one per turn: a tool round sends back the thinking that came before the call, which
 * Anthropic wants with the call when the model thinks between tools.
 */
export class AnthropicMind implements Mind {
  readonly #options: AnthropicMindOptions;
  readonly #thinking = new Map<string, readonly Block[]>();

  constructor(options: AnthropicMindOptions) {
    this.#options = options;
  }

  async *stream(request: MindRequest): AsyncGenerator<MindChunk> {
    const { signal } = request;
    signal.throwIfAborted();
    const pending = new Map<number, PendingCall>();
    const thoughts = new Map<number, { thinking: string; signature: string }>();
    let stopReason: string | null = null;
    try {
      const body = bodyFor(request, this.#options, this.#thinking);
      const events = (await this.#options.client.beta.messages.create(body, {
        signal,
      })) as AsyncIterable<unknown>;
      for await (const event of events) {
        if (!isPlainObject(event)) continue;
        const index = typeof event.index === "number" ? event.index : -1;
        if (event.type === "content_block_start" && isPlainObject(event.content_block)) {
          const block = event.content_block;
          if (block.type === "tool_use") {
            pending.set(index, { id: String(block.id), name: String(block.name), arguments: "" });
          } else if (block.type === "thinking") {
            thoughts.set(index, { thinking: "", signature: "" });
          }
        } else if (event.type === "content_block_delta" && isPlainObject(event.delta)) {
          const { delta } = event;
          const thought = thoughts.get(index);
          if (typeof delta.text === "string") {
            if (delta.text) yield { type: "text", text: delta.text };
          } else if (typeof delta.partial_json === "string") {
            const call = pending.get(index);
            if (call !== undefined) call.arguments += delta.partial_json;
          } else if (typeof delta.thinking === "string" && thought !== undefined) {
            thought.thinking += delta.thinking;
          } else if (typeof delta.signature === "string" && thought !== undefined) {
            thought.signature = delta.signature;
          }
        } else if (event.type === "message_delta" && isPlainObject(event.delta)) {
          if (typeof event.delta.stop_reason === "string") {
            stopReason = event.delta.stop_reason;
            warnIfCut(event.delta);
          }
        }
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    }
    signal.throwIfAborted();
    // As pipedog does, tools run only when Claude stopped to call them.
    if (stopReason === "tool_use") {
      const calls = assembleCalls(pending);
      const signed = [...thoughts]
        .sort(([a], [b]) => a - b)
        .filter(([, thought]) => thought.signature)
        .map(([, { thinking, signature }]) => ({ type: "thinking", thinking, signature }));
      const first = calls[0];
      if (first !== undefined && signed.length > 0) this.#thinking.set(first.id, signed);
      if (calls.length > 0) yield { type: "tool-calls", calls };
    }
    yield { type: "done", finishReason: stopReason };
  }
}
