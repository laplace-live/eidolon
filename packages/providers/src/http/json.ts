// One JSON chat completion for the callers outside a call: Mem0's fact extraction and the refine
// stage. They write OpenAI's chat-completions body; this sends it to whichever provider fills the
// role, translated for Anthropic, and reports what each response used.
import {
  extractCostUsd,
  isPlainObject,
  type JsonPoster,
  OpenAIClient,
  type OpenAIClientOptions,
} from "@eidolon/config";
import { ANTHROPIC_VERSION } from "../catalog.ts";
import { type CompletionsDialect, chatDialect, OPENROUTER_FIELDS } from "../chat/index.ts";
import { hasKey, missingKey, type Selection } from "../resolve.ts";
import { anthropicUnits, openaiUnits, type UsageHook } from "./chat.ts";

type Body = Readonly<Record<string, unknown>>;

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
  readonly #dialect: CompletionsDialect;
  readonly #onUsage: UsageHook | undefined;

  constructor(
    target: PostTarget,
    dialect: CompletionsDialect,
    options: OpenAIClientOptions,
    onUsage?: UsageHook,
  ) {
    this.#dialect = dialect;
    this.#client = new OpenAIClient(
      { baseUrl: target.baseUrl, apiKey: target.apiKey ?? "" },
      options,
    );
    this.#onUsage = onUsage;
  }

  async post(path: string, body: Body): Promise<unknown> {
    const dialect = this.#dialect;
    let payload = body;
    if (!dialect.openRouterFields) {
      const copy: Record<string, unknown> = { ...body };
      for (const key of OPENROUTER_FIELDS) delete copy[key];
      payload =
        path === "chat/completions" && dialect.chatBody !== undefined
          ? dialect.chatBody(copy)
          : copy;
    }
    const response = await this.#client.post(path, payload);
    if (isPlainObject(response) && isPlainObject(response.usage)) {
      const model =
        typeof response.model === "string" && response.model ? response.model : String(body.model);
      const reported = dialect.reportsCost ? extractCostUsd(response.usage) : null;
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
  const dialect = chatDialect(target.provider);
  return dialect.wire === "anthropic"
    ? new AnthropicPoster(target, options, onUsage)
    : new CompatiblePoster(target, dialect, options, onUsage);
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
  const dialect = chatDialect(selection.provider.id);
  const own = dialect.wire === "openai" ? dialect.headers?.() : undefined;
  const headers = own === undefined ? options.headers : { ...own, ...options.headers };
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
