// A mind on an OpenAI-compatible chat completions API, sending what pipedog's service for the same
// provider sent, and streaming back her text and whole tool calls.
// Ports parts of pipedog's OpenAI, OpenRouter and DeepSeek LLM services and OpenAI adapter
// (BSD-2-Clause; Copyright (c) 2024–2026 Daily, Copyright (c) 2026 pipedog contributors).
import { errorText, isPlainObject, logger } from "@eidolon/config";
import type { ToolSchema } from "@eidolon/core";
import type { OpenAIChatClient } from "@eidolon/providers";
import { refusedImages, showsImages, withoutImages } from "../seen.ts";
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
  /** The API's base URL: with `model`, what remembers a model there that can't see images. */
  readonly server: string;
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
  // OpenAI refuses a tool_choice sent without tools.
  if (request.tools.length > 0) {
    body.tools = request.tools.map(toolFor);
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  }
  if (options.takesStop && request.stop?.length) body.stop = [...request.stop];
  Object.assign(body, options.live);
  // pipedog sends DeepSeek's `thinking` in `extra_body`, which lands over every other field.
  if (options.dialect === "deepseek") body.thinking = { type: "disabled" };
  return body;
}

// Gemini, through OpenRouter at least, sometimes ends a turn with nothing in it and a native finish
// reason of MALFORMED_RESPONSE or MALFORMED_FUNCTION_CALL, mostly where it meant to call a tool;
// asked again, it answers. 3 to 7 of 8 replays of one logged request came back so (2026-11-17).
// https://github.com/anomalyco/opencode/pull/56232
const MALFORMED = new Set(["MALFORMED_RESPONSE", "MALFORMED_FUNCTION_CALL"]);
const MALFORMED_RETRIES = 2;

/** The models, as `<server> <model>`, that refused a request for its images: shown none since. */
const BLIND = new Set<string>();

export class OpenAIMind implements Mind {
  readonly #options: OpenAIMindOptions;

  constructor(options: OpenAIMindOptions) {
    this.#options = options;
  }

  get #blind(): string {
    return `${this.#options.server} ${this.#options.model}`;
  }

  /** The request's stream: with its images, or a note in place of each. */
  #create(request: MindRequest, images: boolean): Promise<AsyncIterable<unknown>> {
    const messages = images ? request.messages : withoutImages(request.messages);
    return this.#options.client.chat.completions.create(
      bodyFor({ ...request, messages }, this.#options),
      { signal: request.signal },
    ) as Promise<AsyncIterable<unknown>>;
  }

  /**
   * Whether `error` refused the images an attempt showed: then the model is shown none from now on,
   * that request's next attempt included, until the process restarts.
   */
  #refusedImages(error: unknown): boolean {
    if (!refusedImages(error)) return false;
    if (!BLIND.has(this.#blind)) {
      BLIND.add(this.#blind);
      logger.warning(
        `${this.#options.model} can't take images (${errorText(error)}); she is told of them instead`,
      );
    }
    return true;
  }

  async *stream(request: MindRequest): AsyncGenerator<MindChunk> {
    const { signal } = request;
    signal.throwIfAborted();
    for (let attempt = 0; ; attempt++) {
      const pending = new Map<number, PendingCall>();
      let finishReason: string | null = null;
      let native: string | null = null;
      let said = false;
      // Decided per attempt: another request can learn the model is blind while this one runs.
      const images = showsImages(request.messages) && !BLIND.has(this.#blind);
      try {
        const chunks = await this.#create(request, images);
        for await (const chunk of chunks) {
          const choice =
            isPlainObject(chunk) && Array.isArray(chunk.choices) ? chunk.choices[0] : null;
          if (!isPlainObject(choice)) continue;
          if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
          if (typeof choice.native_finish_reason === "string") native = choice.native_finish_reason;
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
            said = true;
            yield { type: "text", text: delta.content };
          }
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        // A refusal can come as the request's answer or, once its stream is open, as its first event.
        if (images && !said && pending.size === 0 && this.#refusedImages(error)) continue;
        throw error;
      }
      signal.throwIfAborted();
      if (
        !said &&
        pending.size === 0 &&
        native !== null &&
        MALFORMED.has(native) &&
        attempt < MALFORMED_RETRIES
      ) {
        logger.warning(
          `${this.#options.model} sent back a malformed reply (${native}); asking again`,
        );
        continue;
      }
      const calls = assembleCalls(pending);
      if (calls.length > 0) yield { type: "tool-calls", calls };
      yield { type: "done", finishReason };
      return;
    }
  }
}
