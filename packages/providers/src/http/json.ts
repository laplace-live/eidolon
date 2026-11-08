// One JSON chat completion for the callers outside a call: Mem0's fact extraction and the refine
// stage. They write OpenAI's chat-completions body; this sends it to whichever provider fills the
// role, translated for Anthropic, and reports what each response used.
import {
  extractCostUsd,
  isPlainObject,
  type JsonPoster,
  OpenAIClient,
  type OpenAIClientOptions,
  openrouterHeaders,
} from "@eidolon/config";
import { ANTHROPIC_VERSION } from "../catalog.ts";
import { hasKey, missingKey, type Selection } from "../resolve.ts";
import { anthropicUnits, openaiUnits, type UsageHook } from "./chat.ts";

type Body = Readonly<Record<string, unknown>>;

// OpenRouter's own request fields, which OpenAI and others refuse as unknown arguments.
const OPENROUTER_ONLY = ["usage", "provider"] as const;

// OpenAI's reasoning models: the o series and GPT-5 on. They refuse a temperature or top_p.
const OPENAI_REASONING = /^(?:o\d|gpt-(?:[5-9]|\d{2,}))/;

/**
 * A body as OpenAI's own API takes it: `max_tokens` is `max_completion_tokens` there, which every
 * model accepts and its newer ones require; OpenRouter translates this itself.
 */
export function forOpenAI(body: Body): Record<string, unknown> {
  const { max_tokens: cap, ...rest } = body;
  const model = typeof body.model === "string" ? body.model.toLowerCase() : "";
  const out: Record<string, unknown> = { ...rest };
  if (OPENAI_REASONING.test(model)) {
    delete out.temperature;
    delete out.top_p;
  }
  if (cap !== undefined && out.max_completion_tokens === undefined) {
    out.max_completion_tokens = cap;
  }
  return out;
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isPlainObject(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}

/** An OpenAI chat-completions body as a Messages API request. */
export function toAnthropicRequest(body: Body): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system: string[] = [];
  const turns: { role: string; content: string }[] = [];
  for (const message of messages) {
    if (!isPlainObject(message)) continue;
    if (message.role === "system" || message.role === "developer") {
      system.push(text(message.content));
    } else if (message.role === "user" || message.role === "assistant") {
      turns.push({ role: message.role, content: text(message.content) });
    }
  }
  const request: Record<string, unknown> = {
    model: body.model,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 16000,
    messages: turns,
  };
  if (system.length > 0) request.system = system.join("\n\n");
  const format = isPlainObject(body.response_format) ? body.response_format : null;
  const schema =
    format?.type === "json_schema" && isPlainObject(format.json_schema)
      ? format.json_schema.schema
      : undefined;
  if (isPlainObject(schema)) request.output_config = { format: { type: "json_schema", schema } };
  return request;
}

/** A Messages API response in chat-completions shape: the text, the finish, the usage. */
export function fromAnthropicResponse(response: unknown): Record<string, unknown> {
  const body = isPlainObject(response) ? response : {};
  const content = Array.isArray(body.content) ? body.content : [];
  const textOut = content
    .map((block) => (isPlainObject(block) && block.type === "text" ? String(block.text ?? "") : ""))
    .join("");
  const usage = isPlainObject(body.usage) ? anthropicUnits(body.usage) : {};
  return {
    model: body.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: textOut },
        finish_reason: body.stop_reason === "max_tokens" ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens:
        (usage.inputTokens ?? 0) + (usage.cachedTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      completion_tokens: usage.outputTokens ?? 0,
    },
  };
}

/** Where a JSON request goes: a provider's API, at a base, with a key. */
export interface PostTarget {
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
}

class AnthropicPoster implements JsonPoster {
  readonly #client: OpenAIClient;
  readonly #onUsage: UsageHook | undefined;

  constructor(target: PostTarget, options: OpenAIClientOptions, onUsage?: UsageHook) {
    this.#client = new OpenAIClient(
      { baseUrl: target.baseUrl, apiKey: target.apiKey ?? "" },
      {
        ...options,
        authHeaders: { "x-api-key": target.apiKey ?? "", "anthropic-version": ANTHROPIC_VERSION },
      },
    );
    this.#onUsage = onUsage;
  }

  async post(path: string, body: Body): Promise<unknown> {
    if (path !== "chat/completions") throw new Error(`Anthropic has no ${path} here`);
    const response = await this.#client.post("messages", toAnthropicRequest(body));
    if (isPlainObject(response) && isPlainObject(response.usage)) {
      const model = typeof response.model === "string" ? response.model : String(body.model);
      this.#onUsage?.(anthropicUnits(response.usage), model, null, String(body.model));
    }
    return fromAnthropicResponse(response);
  }
}

class CompatiblePoster implements JsonPoster {
  readonly #client: OpenAIClient;
  readonly #openrouter: boolean;
  readonly #openai: boolean;
  readonly #onUsage: UsageHook | undefined;

  constructor(target: PostTarget, options: OpenAIClientOptions, onUsage?: UsageHook) {
    this.#openrouter = target.provider === "openrouter";
    this.#openai = target.provider === "openai";
    this.#client = new OpenAIClient(
      { baseUrl: target.baseUrl, apiKey: target.apiKey ?? "" },
      options,
    );
    this.#onUsage = onUsage;
  }

  async post(path: string, body: Body): Promise<unknown> {
    let payload = body;
    if (!this.#openrouter) {
      const copy: Record<string, unknown> = { ...body };
      for (const key of OPENROUTER_ONLY) delete copy[key];
      payload = this.#openai && path === "chat/completions" ? forOpenAI(copy) : copy;
    }
    const response = await this.#client.post(path, payload);
    if (isPlainObject(response) && isPlainObject(response.usage)) {
      const model =
        typeof response.model === "string" && response.model ? response.model : String(body.model);
      const reported = this.#openrouter ? extractCostUsd(response.usage) : null;
      this.#onUsage?.(openaiUnits(response.usage), model, reported, String(body.model));
    }
    return response;
  }
}

/**
 * A client that takes OpenAI's request bodies whatever the provider: Anthropic's chat goes through
 * the Messages API, and OpenRouter's own fields reach OpenRouter alone.
 */
export function jsonPoster(
  target: PostTarget,
  options: OpenAIClientOptions = {},
  onUsage?: UsageHook,
): JsonPoster {
  return target.provider === "anthropic"
    ? new AnthropicPoster(target, options, onUsage)
    : new CompatiblePoster(target, options, onUsage);
}

/**
 * `jsonPoster` for `selection`'s chat completions, with OpenRouter's attribution headers. Throws
 * when the key is missing, before any request.
 */
export function chatPoster(
  selection: Selection,
  options: OpenAIClientOptions = {},
  onUsage?: UsageHook,
): JsonPoster {
  if (!hasKey(selection)) throw missingKey(selection);
  const headers =
    selection.provider.id === "openrouter"
      ? { ...openrouterHeaders(), ...options.headers }
      : options.headers;
  return jsonPoster(
    {
      provider: selection.provider.id,
      baseUrl: selection.baseUrl as string,
      apiKey: selection.apiKey,
    },
    headers === undefined ? options : { ...options, headers },
    onUsage,
  );
}
