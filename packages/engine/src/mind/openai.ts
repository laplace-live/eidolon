// A mind on an OpenAI-compatible chat completions API, sending what pipedog's service for the same
// provider sent, and streaming back her text and whole tool calls.
// Ports parts of pipedog's OpenAI, OpenRouter and DeepSeek LLM services and OpenAI adapter
// (BSD-2-Clause; Copyright (c) 2024–2026 Daily, Copyright (c) 2026 pipedog contributors).
import { isPlainObject } from "@eidolon/config";
import type { ToolSchema } from "@eidolon/core";
import type { OpenAIChatClient } from "@eidolon/providers";
import type { Mind, MindChunk, MindRequest } from "../types.ts";
import { assembleCalls, type PendingCall } from "./calls.ts";

/**
 * How a provider's chat API differs from OpenAI's own: only OpenAI's takes a `developer` message,
 * Gemini's takes one system message, and DeepSeek's wants its thinking off and a
 * `reasoning_content` on every assistant message.
 */
export type OpenAIDialect = "openai" | "compatible" | "gemini" | "deepseek";

export interface OpenAIMindOptions {
  readonly client: OpenAIChatClient;
  readonly model: string;
  /** The catalog's call-time fields, over the request's own. */
  readonly live: Readonly<Record<string, unknown>>;
  readonly dialect: OpenAIDialect;
  /** Whether the provider takes the request's `stop`. */
  readonly takesStop: boolean;
}

type Message = Record<string, unknown>;

function messagesFor(request: MindRequest, dialect: OpenAIDialect): Message[] {
  const messages: Message[] = request.system ? [{ role: "system", content: request.system }] : [];
  for (const message of request.messages) {
    if (!isPlainObject(message)) continue;
    let out: Message = message;
    if (dialect !== "openai" && out.role === "developer") out = { ...out, role: "user" };
    if (dialect === "deepseek" && out.role === "assistant" && !("reasoning_content" in out)) {
      out = { ...out, reasoning_content: "" };
    }
    messages.push(out);
  }
  if (dialect !== "gemini") return messages;
  let seen = false;
  return messages.map((message) => {
    if (message.role !== "system") return message;
    if (!seen) {
      seen = true;
      return message;
    }
    return { ...message, role: "user" };
  });
}

function toolFor(schema: ToolSchema): Message {
  return {
    type: "function",
    function: {
      name: schema.name,
      description: schema.description,
      parameters: {
        type: "object",
        properties: { ...schema.properties },
        required: [...schema.required],
      },
    },
  };
}

function bodyFor(request: MindRequest, options: OpenAIMindOptions): Message {
  const body: Message = {
    model: options.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: messagesFor(request, options.dialect),
  };
  if (request.tools.length > 0) body.tools = request.tools.map(toolFor);
  if (options.takesStop && request.stop?.length) body.stop = [...request.stop];
  Object.assign(body, options.live);
  // pipedog sends DeepSeek's `thinking` in `extra_body`, which lands over every other field.
  if (options.dialect === "deepseek") body.thinking = { type: "disabled" };
  return body;
}

export class OpenAIMind implements Mind {
  readonly #options: OpenAIMindOptions;

  constructor(options: OpenAIMindOptions) {
    this.#options = options;
  }

  async *stream(request: MindRequest): AsyncGenerator<MindChunk> {
    const { signal } = request;
    signal.throwIfAborted();
    const pending = new Map<number, PendingCall>();
    let finishReason: string | null = null;
    try {
      const chunks = (await this.#options.client.chat.completions.create(
        bodyFor(request, this.#options),
        { signal },
      )) as AsyncIterable<unknown>;
      for await (const chunk of chunks) {
        const choice =
          isPlainObject(chunk) && Array.isArray(chunk.choices) ? chunk.choices[0] : null;
        if (!isPlainObject(choice)) continue;
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!isPlainObject(delta)) continue;
        if (Array.isArray(delta.tool_calls)) {
          for (const fragment of delta.tool_calls) {
            if (!isPlainObject(fragment)) continue;
            const index = typeof fragment.index === "number" ? fragment.index : 0;
            const call = pending.get(index) ?? { id: "", name: "", arguments: "" };
            pending.set(index, call);
            const fn = isPlainObject(fragment.function) ? fragment.function : {};
            if (typeof fragment.id === "string" && fragment.id) call.id = fragment.id;
            if (typeof fn.name === "string") call.name += fn.name;
            if (typeof fn.arguments === "string") call.arguments += fn.arguments;
          }
        }
        if (typeof delta.content === "string" && delta.content) {
          yield { type: "text", text: delta.content };
        }
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    }
    signal.throwIfAborted();
    const calls = assembleCalls(pending);
    if (calls.length > 0) yield { type: "tool-calls", calls };
    yield { type: "done", finishReason };
  }
}
