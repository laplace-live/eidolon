// A mind on Anthropic's Messages API, sending what a call's AnthropicLLMService sends (prompt
// caching, refusal fallbacks, each model's lowest thinking) and streaming back her text and whole
// tool calls.
// Ports parts of pipedog's Anthropic LLM service and adapter
// (BSD-2-Clause; Copyright (c) 2024–2026 Daily, Copyright (c) 2026 pipedog contributors).
import { createHash } from "node:crypto";
import { isPlainObject, logger, pyJsonLoads } from "@eidolon/config";
import type { ToolSchema } from "@eidolon/core";
import type { AnthropicClient } from "@eidolon/providers";
import { canonical } from "../canonical.ts";
import type { Mind, MindChunk, MindRequest } from "../types.ts";
import { assembleCalls, type PendingCall, parsedArguments } from "./calls.ts";

export interface AnthropicMindOptions {
  readonly client: AnthropicClient;
  readonly model: string;
  /** Fields over the request's own: the catalog's call-time ones, and `fallbacks`. */
  readonly extra: Readonly<Record<string, unknown>>;
  /** The most a reply may run to, thinking included; her chat's 4,096 when unset. */
  readonly maxTokens?: number;
}

type Block = Record<string, unknown>;

interface Turn {
  role: string;
  content: string | Block[];
}

/**
 * A reply that made calls, kept for the rounds after it. On the models with preserved thinking, a
 * thinking block is bound to what came before it, `system`, `tools` and every earlier message, and
 * to the blocks before it in its own turn; sent back after any of them changed, it can fail the
 * request with a 400
 * (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking/prefix-checks).
 */
interface Thought {
  /** What came before the reply, hashed as `extend` hashes it. */
  readonly prefix: string;
  /** Its thinking and redacted thinking, in order. */
  readonly thinking: readonly Block[];
  /** Every block in order, or null when one can't be sent back as it came. */
  readonly blocks: readonly Block[] | null;
  /** Whether all its thinking came before its other blocks. */
  readonly leading: boolean;
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

const isThinking = (block: Block): boolean =>
  block.type === "thinking" || block.type === "redacted_thinking";

/** `prefix` with `value` after it, compared as the API compares them: parsed, in any key order. */
function extend(prefix: string, value: unknown): string {
  return createHash("sha256").update(prefix).update("\n").update(canonical(value)).digest("hex");
}

/** What a turn says, its text and its calls, or null when it holds anything else. */
function saying(blocks: readonly Block[]): string | null {
  let text = "";
  const calls: unknown[] = [];
  for (const block of blocks) {
    if (block.type === "text") text += String(block.text);
    else if (block.type === "tool_use") {
      calls.push({ id: block.id, name: block.name, input: block.input });
    } else return null;
  }
  return canonical({ text, calls });
}

/**
 * `content` with its reply's thinking put back: the reply as Claude sent it, when the turn says
 * what it said; the thinking and then the turn, when the thinking came first; or null.
 */
function rethought(content: readonly Block[], thought: Thought): Block[] | null {
  if (thought.blocks !== null) {
    const said = saying(thought.blocks.filter((block) => !isThinking(block)));
    if (said !== null && said === saying(content)) return [...thought.blocks];
  }
  return thought.leading ? [...thought.thinking, ...content] : null;
}

/**
 * What a reply can send back, from its blocks in order and its calls' streamed arguments by
 * index: null when it has no thinking, or a thinking block the stream cut off unsigned, which
 * leaves out all of them.
 */
function thoughtOf(
  prefix: string,
  blocks: ReadonlyMap<number, Block>,
  pending: ReadonlyMap<number, PendingCall>,
): Thought | null {
  const ordered = [...blocks].sort(([a], [b]) => a - b);
  const thinking = ordered.map(([, block]) => block).filter(isThinking);
  if (thinking.length === 0) return null;
  if (thinking.some((block) => block.type === "thinking" && !block.signature)) return null;
  // A cut call's input, an empty text block or a kind this mind doesn't parse can't go back as
  // it came.
  let whole = true;
  const sent = ordered.map(([index, block]): Block => {
    if (block.type === "tool_use") {
      const input = parsedArguments(pending.get(index)?.arguments ?? "");
      if (isPlainObject(input)) return { ...block, input };
      whole = false;
    } else if (block.type === "text" ? block.text === "" : !isThinking(block)) {
      whole = false;
    }
    return block;
  });
  const firstOther = sent.findIndex((block) => !isThinking(block));
  const lastThinking = sent.findLastIndex(isThinking);
  return {
    prefix,
    thinking,
    blocks: whole ? sent : null,
    leading: firstOther === -1 || lastThinking < firstOther,
  };
}

/**
 * OpenAI-shaped messages as Messages API turns, and the system prompt: a first system message is
 * the prompt when `system` is empty and is dropped otherwise, as pipedog's adapter does.
 * `thoughts` puts back a reply's thinking, keyed by its first call's id, while everything before
 * it is as it was; `prefix` hashes everything the request sends, for the reply it gets.
 */
function turnsFor(
  request: MindRequest,
  model: string,
  thoughts: ReadonlyMap<string, Thought>,
): { system: string | null; turns: Turn[]; prefix: string } {
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
  const system = request.system || extracted || null;
  let prefix = extend("", { system, tools: request.tools.map(toolFor) });
  for (const turn of turns) {
    if (turn.content === "") turn.content = "(empty)";
    else if (Array.isArray(turn.content) && turn.content.length === 0) {
      turn.content = [{ type: "text", text: "(empty)" }];
    }
    const thought = toolIds(turn)
      .map((id) => thoughts.get(id))
      .find((each) => each !== undefined);
    if (thought?.prefix === prefix) {
      turn.content = rethought(asBlocks(turn.content), thought) ?? turn.content;
    }
    prefix = extend(prefix, turn);
  }
  if (
    !PREFILL_MODELS.some((name) => model.startsWith(name)) &&
    turns.at(-1)?.role === "assistant"
  ) {
    const filler: Turn = { role: "user", content: [{ type: "text", text: "." }] };
    turns.push(filler);
    prefix = extend(prefix, filler);
  }
  return { system, turns, prefix };
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
  thoughts: ReadonlyMap<string, Thought>,
): { body: Block; prefix: string } {
  const { system, turns, prefix } = turnsFor(request, options.model, thoughts);
  const body: Block = {
    model: options.model,
    max_tokens: options.maxTokens ?? MAX_TOKENS,
    stream: true,
  };
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
  return { body, prefix };
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
 * Anthropic wants with the call when the model thinks between tools, for as long as everything
 * before it is unchanged.
 */
export class AnthropicMind implements Mind {
  readonly #options: AnthropicMindOptions;
  readonly #thoughts = new Map<string, Thought>();

  constructor(options: AnthropicMindOptions) {
    this.#options = options;
  }

  async *stream(request: MindRequest): AsyncGenerator<MindChunk> {
    const { signal } = request;
    signal.throwIfAborted();
    const pending = new Map<number, PendingCall>();
    const blocks = new Map<number, Block>();
    let stopReason: string | null = null;
    const { body, prefix } = bodyFor(request, this.#options, this.#thoughts);
    try {
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
            blocks.set(index, { type: "tool_use", id: String(block.id), name: String(block.name) });
          } else if (block.type === "thinking") {
            blocks.set(index, { type: "thinking", thinking: "", signature: "" });
          } else if (block.type === "redacted_thinking") {
            blocks.set(index, { type: "redacted_thinking", data: block.data });
          } else if (block.type === "text") {
            blocks.set(index, { type: "text", text: String(block.text ?? "") });
          } else {
            blocks.set(index, { type: String(block.type) });
          }
        } else if (event.type === "content_block_delta" && isPlainObject(event.delta)) {
          const { delta } = event;
          const block = blocks.get(index);
          if (typeof delta.text === "string") {
            if (delta.text) yield { type: "text", text: delta.text };
            if (block?.type === "text") block.text = `${block.text}${delta.text}`;
          } else if (typeof delta.partial_json === "string") {
            const call = pending.get(index);
            if (call !== undefined) call.arguments += delta.partial_json;
          } else if (typeof delta.thinking === "string" && block?.type === "thinking") {
            block.thinking = `${block.thinking}${delta.thinking}`;
          } else if (typeof delta.signature === "string" && block?.type === "thinking") {
            block.signature = delta.signature;
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
    // As pipedog does, tools run only when Claude stopped to call them; a reply the output limit
    // cut off reports its calls unparsed, for the caller to answer.
    const cut = stopReason === "max_tokens" || stopReason === "model_context_window_exceeded";
    if (stopReason === "tool_use" || cut) {
      const calls = assembleCalls(pending, cut);
      const first = calls[0];
      const thought = first === undefined ? null : thoughtOf(prefix, blocks, pending);
      if (first !== undefined && thought !== null) this.#thoughts.set(first.id, thought);
      if (calls.length > 0) yield { type: "tool-calls", calls };
    }
    yield { type: "done", finishReason: stopReason };
  }
}
