// The clients a mind calls, over fetch: OpenAI-compatible chat completions and Anthropic's Messages
// API, each one method in the vendor SDK's shape (`chat.completions.create`,
// `beta.messages.create`), with nothing of the SDKs in the request path.
import {
  abortableSleep,
  extractCostUsd,
  isPlainObject,
  retryDelaySeconds,
  shouldRetry,
} from "@eidolon/config";
import { ANTHROPIC_VERSION } from "../catalog.ts";
import type { Units } from "../pricing.ts";
import { httpError, ProviderHttpError } from "./errors.ts";
import { sseEvents } from "./sse.ts";

type Body = Record<string, unknown>;

export interface RequestOptions {
  readonly signal?: AbortSignal | null;
}

/** What a response used, the model that served it, its reported cost, and the model asked for. */
export type UsageHook = (
  units: Units,
  model: string,
  reportedUsd: number | null,
  requested: string,
) => void;

export interface ChatClientOptions {
  /** The provider's name, for errors. */
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Fields every request carries under the caller's, such as OpenRouter's `usage`. */
  readonly extraBody?: Readonly<Record<string, unknown>>;
  /** What each response used, once it is complete. */
  readonly onUsage?: UsageHook;
  /** The usage block carries what the request cost, as OpenRouter's does. */
  readonly reportsCost?: boolean;
  readonly fetch?: typeof fetch;
  /** For tests: the wait between retries. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The vendor SDKs' default. */
const MAX_RETRIES = 2;

/**
 * POSTs `init`, retrying as the OpenAI and Anthropic SDKs do: a connection error, or 408, 409, 429
 * or a 5xx (or what `x-should-retry` says), after a backoff or the server's `retry-after`. Only a
 * request that got no answer is retried, never one whose stream had begun.
 */
async function send(
  options: ChatClientOptions,
  url: string,
  init: RequestInit,
  controller: AbortController,
): Promise<Response> {
  const sleep = options.sleep ?? abortableSleep;
  for (let retriesTaken = 0; ; retriesTaken++) {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted || retriesTaken >= MAX_RETRIES) throw error;
      await sleep(retryDelaySeconds(retriesTaken, null) * 1000, controller.signal);
      continue;
    }
    if (response.ok) return response;
    if (retriesTaken < MAX_RETRIES && shouldRetry(response.status, response.headers)) {
      await response.body?.cancel().catch(() => undefined);
      await sleep(retryDelaySeconds(retriesTaken, response.headers) * 1000, controller.signal);
      continue;
    }
    throw await httpError(options.provider, response);
  }
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

/** An OpenAI `usage` block as disjoint units: `prompt_tokens` counts the cached ones too. */
export function openaiUnits(usage: Readonly<Record<string, unknown>>): Units {
  const details = isPlainObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const cached = count(details.cached_tokens);
  const written = count(details.cache_write_tokens);
  return {
    inputTokens: Math.max(0, count(usage.prompt_tokens) - cached - written),
    cachedTokens: cached,
    cacheWriteTokens: written,
    outputTokens: count(usage.completion_tokens),
  };
}

/** Anthropic's `usage`, whose `input_tokens` already leaves the cache out. */
export function anthropicUnits(usage: Readonly<Record<string, unknown>>): Units {
  return {
    inputTokens: count(usage.input_tokens),
    cachedTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
    outputTokens: count(usage.output_tokens),
  };
}

function linked(signal: AbortSignal | null | undefined): AbortController {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller;
}

function parseData(provider: string, data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    throw new ProviderHttpError(
      provider,
      200,
      `a stream event that isn't JSON: ${data.slice(0, 200)}`,
    );
  }
}

/** `chat.completions.create` for any OpenAI-compatible API. */
export class OpenAIChatClient {
  readonly chat: {
    readonly completions: {
      create(body: Body, options?: RequestOptions): Promise<unknown>;
    };
  };
  readonly #options: ChatClientOptions;

  constructor(options: ChatClientOptions) {
    this.#options = options;
    this.chat = { completions: { create: (body, request) => this.#create(body, request) } };
  }

  async #create(body: Body, request: RequestOptions = {}): Promise<unknown> {
    const options = this.#options;
    const controller = linked(request.signal);
    const payload = { ...options.extraBody, ...body };
    const response = await send(
      options,
      `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          ...options.headers,
          ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      controller,
    );
    const model = typeof payload.model === "string" ? payload.model : "";
    if (payload.stream !== true) {
      const json = (await response.json()) as unknown;
      if (isPlainObject(json) && isPlainObject(json.usage)) this.#usage(json.usage, json, model);
      return json;
    }
    if (response.body === null) throw new ProviderHttpError(options.provider, 200, "no body");
    const stream = response.body;
    return this.#chunks(stream, model, controller);
  }

  #usage(
    usage: Readonly<Record<string, unknown>>,
    chunk: Readonly<Record<string, unknown>>,
    model: string,
  ) {
    const reported = this.#options.reportsCost ? extractCostUsd(usage) : null;
    const served = typeof chunk.model === "string" && chunk.model ? chunk.model : model;
    this.#options.onUsage?.(openaiUnits(usage), served, reported, model);
  }

  async *#chunks(
    body: ReadableStream<Uint8Array>,
    model: string,
    controller: AbortController,
  ): AsyncGenerator<unknown> {
    // Some providers send a cumulative usage on every chunk: report the last one, once.
    let last: { usage: Record<string, unknown>; chunk: Record<string, unknown> } | null = null;
    try {
      for await (const event of sseEvents(body)) {
        if (event.data === "[DONE]") return;
        const chunk = parseData(this.#options.provider, event.data);
        if (isPlainObject(chunk) && chunk.error !== undefined && chunk.choices === undefined) {
          const error = chunk.error;
          const message =
            isPlainObject(error) && typeof error.message === "string"
              ? error.message
              : JSON.stringify(error);
          const status = isPlainObject(error) && typeof error.code === "number" ? error.code : 200;
          throw new ProviderHttpError(this.#options.provider, status, message);
        }
        if (isPlainObject(chunk) && isPlainObject(chunk.usage))
          last = { usage: chunk.usage, chunk };
        yield chunk;
      }
    } finally {
      controller.abort();
      if (last !== null) this.#usage(last.usage, last.chunk, model);
    }
  }
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Models whose refusals Anthropic retries on another model when a request asks for fallbacks. */
export const ANTHROPIC_FALLBACK_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-fable-5-1",
  "claude-opus-5",
]);

/** `beta.messages.create` for Anthropic's Messages API. */
export class AnthropicClient {
  readonly beta: {
    readonly messages: { create(body: Body, options?: RequestOptions): Promise<unknown> };
  };
  readonly #options: ChatClientOptions;

  constructor(options: ChatClientOptions) {
    this.#options = options;
    this.beta = { messages: { create: (body, request) => this.#create(body, request) } };
  }

  async #create(body: Body, request: RequestOptions = {}): Promise<unknown> {
    const options = this.#options;
    const { betas, ...rest } = { ...options.extraBody, ...body } as Body & { betas?: unknown };
    const beta = Array.isArray(betas) ? betas.filter((name) => typeof name === "string") : [];
    if (rest.fallbacks === "default" && !beta.includes(FALLBACK_BETA)) beta.push(FALLBACK_BETA);
    const controller = linked(request.signal);
    const response = await send(
      options,
      `${options.baseUrl.replace(/\/+$/, "")}/messages`,
      {
        method: "POST",
        headers: {
          ...options.headers,
          ...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
          "anthropic-version": ANTHROPIC_VERSION,
          ...(beta.length > 0 ? { "anthropic-beta": beta.join(",") } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(rest),
      },
      controller,
    );
    const model = typeof rest.model === "string" ? rest.model : "";
    if (rest.stream !== true) {
      const json = (await response.json()) as unknown;
      if (isPlainObject(json) && isPlainObject(json.usage)) {
        const served = typeof json.model === "string" && json.model ? json.model : model;
        options.onUsage?.(anthropicUnits(json.usage), served, null, model);
      }
      return json;
    }
    if (response.body === null) throw new ProviderHttpError(options.provider, 200, "no body");
    const stream = response.body;
    return this.#events(stream, model, controller);
  }

  async *#events(
    body: ReadableStream<Uint8Array>,
    model: string,
    controller: AbortController,
  ): AsyncGenerator<unknown> {
    let usage: Record<string, unknown> = {};
    let served = model;
    let seen = false;
    try {
      for await (const sse of sseEvents(body)) {
        const event = parseData(this.#options.provider, sse.data);
        if (!isPlainObject(event)) continue;
        if (event.type === "error") {
          const error = isPlainObject(event.error) ? event.error : {};
          const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
          throw new ProviderHttpError(this.#options.provider, 200, message);
        }
        if (event.type === "message_start" && isPlainObject(event.message)) {
          if (typeof event.message.model === "string") served = event.message.model;
          if (isPlainObject(event.message.usage)) usage = { ...event.message.usage };
          seen = true;
        } else if (event.type === "message_delta" && isPlainObject(event.usage)) {
          usage = { ...usage, ...event.usage };
        }
        yield event;
      }
    } finally {
      controller.abort();
      if (seen) this.#options.onUsage?.(anthropicUnits(usage), served, null, model);
    }
  }
}
