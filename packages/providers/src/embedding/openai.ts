// OpenAI's `/embeddings` request, which OpenRouter, Gemini's OpenAI-compatible API and any
// compatible server take too: its retries, and what each request used.
import { setTimeout as sleep } from "node:timers/promises";
import {
  cpSlice,
  extractCostUsd,
  isJsonObject,
  logger,
  pyFixed,
  pyRepr,
  pySplitWs,
  pyStr,
  pyStrip,
  pyTruthy,
  raceAbort,
  retryDelaySeconds,
  shouldRetry,
} from "@eidolon/config";
import { providersFor } from "../catalog.ts";
import { costOf, priceOf } from "../pricing.ts";
import type { EmbeddingModel, EmbeddingRetries } from "./index.ts";

// Retries for the "200 OK with no `data` field" case: OpenRouter wraps
// upstream errors inside a 200 body (`{"error": {...}}`) rather than
// returning a real status, so a transport retry policy never sees
// them. Two budgets, because the failure modes need opposite backoff. Data
// failures (transient blips, malformed responses) clear in seconds under
// short exponential backoff. Quota failures (429 / RESOURCE_EXHAUSTED) need
// the ~60s Vertex AI quota window to reset, and often several of them since
// the OpenRouter pool is shared — exponential backoff alone exhausts in ~30s
// and kills the run on the first quota incident.
const MAX_EMBED_DATA_RETRIES = 5;
const EMBED_RETRY_BASE_DELAY = 1.0;
const MAX_EMBED_QUOTA_RETRIES = 10;
const EMBED_QUOTA_BACKOFF = 60.0;

// The OpenAI SDK's transport policy with 5 retries: connection errors, timeouts, 408, 409, 429 and
// 5xx are retried, the timeout is 600 s, and Retry-After is honoured up to 120 s.
const EMBED_HTTP_MAX_RETRIES = 5;
const EMBED_HTTP_TIMEOUT_SEC = 600;

/** Every budget above: what a request gets unless its caller asks for less. */
const EMBED_RETRIES: EmbeddingRetries = {
  http: EMBED_HTTP_MAX_RETRIES,
  empty: MAX_EMBED_DATA_RETRIES,
  quota: MAX_EMBED_QUOTA_RETRIES,
};

const QUOTA_SUGGESTIONS =
  "\n  Sustained quota error — options:" +
  "\n    - Wait and re-run (cached batches will be skipped)" +
  "\n    - Switch to a less rate-limited model: " +
  "set EMBED_MODEL=openai/text-embedding-3-large (also 3072-dim)" +
  "\n    - Submit a quota increase with the upstream provider";

export type EmbeddingCostSource = "openrouter" | "estimate" | "unknown" | "mixed";

/**
 * Token and cost accumulator. "openrouter" came from the response, "estimate" is tokens × the
 * catalog's price (BYOK withholds the cost), and "unknown" means 0 for lack of tokens or a price.
 */
export class EmbeddingUsage {
  promptTokens: number;
  totalTokens: number;
  costUsd: number;
  costSource: EmbeddingCostSource;

  constructor(
    init: Partial<
      Pick<EmbeddingUsage, "promptTokens" | "totalTokens" | "costUsd" | "costSource">
    > = {},
  ) {
    this.promptTokens = init.promptTokens ?? 0;
    this.totalTokens = init.totalTokens ?? 0;
    this.costUsd = init.costUsd ?? 0;
    this.costSource = init.costSource ?? "unknown";
  }

  /** "unknown" takes the other side's source; two different known sources become "mixed". */
  add(other: EmbeddingUsage): void {
    this.promptTokens += other.promptTokens;
    this.totalTokens += other.totalTokens;
    this.costUsd += other.costUsd;
    if (this.costSource === "unknown") this.costSource = other.costSource;
    else if (
      other.costSource !== "unknown" &&
      other.costSource !== this.costSource &&
      this.costSource !== "mixed"
    ) {
      this.costSource = "mixed";
    }
  }
}

/**
 * True if `message` looks like a rate-limit or quota error. String-matched because the status
 * code is always 200; conservative, since a hit commits the caller to a fixed 60 s wait.
 */
export function isQuotaError(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    message.includes("429") ||
    lower.includes("resource_exhausted") ||
    lower.includes("quota exceeded") ||
    lower.includes("rate limit") ||
    lower.includes("rate-limit")
  );
}

/**
 * What `tokens` of `model` cost at the catalog's price, under whichever provider lists the id; null
 * where none does.
 */
function estimateUsd(model: string, tokens: number): number | null {
  for (const provider of providersFor("embedding")) {
    const price = priceOf(provider.id, "embedding", model);
    if (price !== undefined) return costOf(price, { inputTokens: tokens });
  }
  return null;
}

export interface EmbeddingClientOptions {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  /** Sends OpenRouter's `usage` request field, which other APIs refuse as unknown. */
  openrouter?: boolean;
  fetch?: typeof fetch;
  sleep?: (seconds: number) => Promise<void>;
  random?: () => number;
  /** Each budget left out is EMBED_RETRIES'. */
  retries?: Partial<EmbeddingRetries>;
  timeoutSec?: number;
}

/** The SDK's APIStatusError text: `Error code: 401 - {'error': ...}`. */
function statusError(status: number, body: string): Error {
  const text = pyStrip(body);
  try {
    return new Error(`Error code: ${status} - ${pyRepr(JSON.parse(text))}`);
  } catch {
    return new Error(text || `Error code: ${status}`);
  }
}

function toInt(value: unknown): number {
  return Math.trunc(Number(value));
}

export class EmbeddingClient {
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #headers: Record<string, string>;
  readonly #openrouter: boolean;
  readonly #fetch: typeof fetch | null;
  readonly #sleep: (seconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #retries: EmbeddingRetries;
  readonly #timeoutSec: number;

  constructor(options: EmbeddingClientOptions) {
    this.baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#headers = { ...(options.headers ?? {}) };
    this.#openrouter = options.openrouter ?? true;
    this.#fetch = options.fetch ?? null;
    this.#sleep = options.sleep ?? ((seconds) => sleep(seconds * 1000));
    this.#random = options.random ?? Math.random;
    this.#retries = { ...EMBED_RETRIES, ...options.retries };
    this.#timeoutSec = options.timeoutSec ?? EMBED_HTTP_TIMEOUT_SEC;
  }

  /** Vectors in response order, plus the provider-reported usage of this one call. */
  async embedWithUsage(
    texts: readonly string[],
    options: { model: string; dimensions: number; signal?: AbortSignal },
  ): Promise<[number[][], EmbeddingUsage]> {
    if (texts.length === 0) return [[], new EmbeddingUsage()];
    const { model, dimensions, signal } = options;
    // encoding_format "float" is always sent: providers that mishandle base64 round-trip an empty
    // response.
    const payload = {
      input: texts,
      model,
      dimensions,
      encoding_format: "float",
      ...(this.#openrouter ? { usage: { include: true } } : {}),
    };
    let body: Record<string, unknown> | null = null;
    let lastError = "unknown";
    let dataFailures = 0;
    let quotaFailures = 0;
    for (;;) {
      const candidate = await this.#post(payload, signal);
      if (isJsonObject(candidate) && pyTruthy(candidate.data)) {
        body = candidate;
        break;
      }
      const error = isJsonObject(candidate) ? candidate.error : undefined;
      if (isJsonObject(error) && pyTruthy(error.message)) lastError = pyStr(error.message);
      else if (isJsonObject(error)) lastError = pyRepr(error);
      else lastError = "provider returned no embedding data";

      let delay: number;
      let label: string;
      if (isQuotaError(lastError)) {
        quotaFailures += 1;
        if (quotaFailures > this.#retries.quota) break;
        // Jitter spreads concurrent clients out so they don't all retry
        // the instant the quota window resets.
        delay = EMBED_QUOTA_BACKOFF + 10 * this.#random();
        label = `quota retry ${quotaFailures}/${this.#retries.quota}`;
      } else {
        dataFailures += 1;
        if (dataFailures > this.#retries.empty) break;
        delay = EMBED_RETRY_BASE_DELAY * 2 ** (dataFailures - 1) + this.#random();
        label = `retry ${dataFailures}/${this.#retries.empty}`;
      }
      const compact = cpSlice(pySplitWs(lastError).join(" "), 0, 240);
      logger.warning(
        `Embedding ${label} got no data (${compact}). Retrying in ${pyFixed(delay, 1)}s...`,
      );
      await this.#abortableSleep(delay, signal);
    }
    if (body === null) {
      throw new Error(
        `Embedding provider returned no data after ${dataFailures + quotaFailures} attempts ` +
          `(${dataFailures} data, ${quotaFailures} quota). ` +
          `Last error: ${lastError}${quotaFailures > 0 && this.#retries.quota > 0 ? QUOTA_SUGGESTIONS : ""}`,
      );
    }
    const data = body.data;
    if (!Array.isArray(data)) throw new TypeError("embedding data is not a list");
    const vectors = data.map((d: unknown) => (d as { embedding: number[] }).embedding);

    const usage = isJsonObject(body.usage) && pyTruthy(body.usage) ? body.usage : {};
    const promptTokens = toInt(usage.prompt_tokens || 0);
    const totalTokens = toInt(
      ("total_tokens" in usage ? usage.total_tokens : promptTokens) || promptTokens,
    );
    const cost = extractCostUsd(usage);
    if (cost !== null && cost > 0) {
      return [
        vectors,
        new EmbeddingUsage({ promptTokens, totalTokens, costUsd: cost, costSource: "openrouter" }),
      ];
    }
    const estimate = totalTokens > 0 ? estimateUsd(model, totalTokens) : null;
    if (estimate !== null) {
      return [
        vectors,
        new EmbeddingUsage({
          promptTokens,
          totalTokens,
          costUsd: estimate,
          costSource: "estimate",
        }),
      ];
    }
    return [vectors, new EmbeddingUsage({ promptTokens, totalTokens })];
  }

  async #post(payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const url = `${this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`}embeddings`;
    const init = {
      method: "POST",
      headers: {
        ...this.#headers,
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    };
    for (let retriesTaken = 0; ; retriesTaken++) {
      const remaining = this.#retries.http - retriesTaken;
      const timeout = AbortSignal.timeout(this.#timeoutSec * 1000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      let text: string;
      try {
        response = await (this.#fetch ?? fetch)(url, { ...init, signal: combined });
        // httpx reads a non-streamed body inside send(), so openai-python retries a reset mid-body.
        text = await response.text();
        if (response.ok) return JSON.parse(text);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof SyntaxError) throw error;
        if (remaining > 0) {
          await this.#abortableSleep(retryDelaySeconds(retriesTaken, null, this.#random), signal);
          continue;
        }
        throw new Error(timeout.aborted ? "Request timed out." : "Connection error.");
      }
      if (remaining > 0 && shouldRetry(response.status, response.headers)) {
        await this.#abortableSleep(
          retryDelaySeconds(retriesTaken, response.headers, this.#random),
          signal,
        );
        continue;
      }
      throw statusError(response.status, text);
    }
  }

  #abortableSleep(seconds: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return raceAbort(this.#sleep(seconds), signal);
  }
}

export interface OpenAIEmbeddingsOptions extends EmbeddingClientOptions {
  /** As the usage ledger names it. */
  provider: string;
  model: string;
}

/** One model on an OpenAI-compatible embeddings API. */
export function openAIEmbeddings(options: OpenAIEmbeddingsOptions): EmbeddingModel {
  const client = new EmbeddingClient(options);
  const { provider, model } = options;
  return {
    provider,
    model,
    embed: (texts, dimensions, signal) =>
      client.embedWithUsage(texts, { model, dimensions, ...(signal ? { signal } : {}) }),
  };
}
