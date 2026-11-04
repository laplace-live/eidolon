// The embedding client for any OpenAI-compatible `/embeddings` endpoint. Query-time vectors must
// come from the same model and dimension as the offline ingest's, or they aren't comparable.
import {
  cpSlice,
  DEFAULT_EMBED_BASE_URL,
  DEFAULT_EMBED_MODEL,
  embedDim,
  envOptional,
  envStr,
  extractCostUsd,
  logger,
  openrouterHeaders,
  pyFixed,
  pyRepr,
  pySplitWs,
  pyStr,
  pyStrip,
  pyTruthy,
} from "@eidolon/config";

// Fallback per-model embedding prices, USD per 1M tokens.
//
// OpenRouter doesn't surface `cost_details` on `/v1/embeddings`. On a BYOK
// key the response is literally `{prompt_tokens, total_tokens, cost: 0}` —
// real money is spent upstream (Google AI Studio etc.) and reported as zero,
// so without a client-side estimate a 26k-chunk ingest logs `$0.000000` per
// batch. Prices come from each provider's public pricing page; best-effort,
// update them when they move.
export const EMBED_PRICING_USD_PER_1M: Readonly<Record<string, number>> = Object.freeze({
  "google/gemini-embedding-2-preview": 0.15,
  "~google/gemini-embedding-2-preview": 0.15,
  "openai/text-embedding-3-small": 0.02,
  "openai/text-embedding-3-large": 0.13,
});

// Retries for the "200 OK with no `data` field" case: OpenRouter wraps
// upstream errors inside a 200 body (`{"error": {...}}`) rather than
// returning a real status, so a transport retry policy never sees
// them. Two budgets, because the failure modes need opposite backoff. Data
// failures (transient blips, malformed responses) clear in seconds under
// short exponential backoff. Quota failures (429 / RESOURCE_EXHAUSTED) need
// the ~60s Vertex AI quota window to reset, and often several of them since
// the OpenRouter pool is shared — exponential backoff alone exhausts in ~30s
// and kills the run on the first quota incident.
export const MAX_EMBED_DATA_RETRIES = 5;
export const EMBED_RETRY_BASE_DELAY = 1.0;
export const MAX_EMBED_QUOTA_RETRIES = 10;
export const EMBED_QUOTA_BACKOFF = 60.0;

// The OpenAI SDK's transport policy, which the Python client ran under: 5 retries on connection
// errors, timeouts, 408, 409, 429 and 5xx, a 600 s timeout, and Retry-After honoured up to 120 s.
export const EMBED_HTTP_MAX_RETRIES = 5;
export const EMBED_HTTP_TIMEOUT_SEC = 600;
const INITIAL_RETRY_DELAY = 0.5;
const MAX_RETRY_DELAY = 8.0;
const MAX_RETRY_AFTER = 120;

const QUOTA_SUGGESTIONS =
  "\n  Sustained quota error — options:" +
  "\n    - Wait and re-run (cached batches will be skipped)" +
  "\n    - Switch to a less rate-limited model: " +
  "set EMBED_MODEL=openai/text-embedding-3-large (also 3072-dim)" +
  "\n    - Submit a quota increase with the upstream provider";

export type CostSource = "openrouter" | "estimate" | "unknown" | "mixed";

/**
 * Token and cost accumulator. "openrouter" came from the response, "estimate" is tokens ×
 * EMBED_PRICING_USD_PER_1M (BYOK withholds the cost), and "unknown" means 0 for lack of tokens or
 * a price entry.
 */
export class EmbeddingUsage {
  promptTokens: number;
  totalTokens: number;
  costUsd: number;
  costSource: CostSource;

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

export interface EmbeddingClientOptions {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  sleep?: (seconds: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
  timeoutSec?: number;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FLOAT =
  /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const SPECIAL_FLOAT = /^([+-]?)(inf|infinity|nan)$/i;

/** Python `float(text)`, or null where it raises ValueError. */
function pyFloat(text: string): number | null {
  const t = pyStrip(text);
  if (FLOAT.test(t)) return Number(t.replaceAll("_", ""));
  const special = SPECIAL_FLOAT.exec(t);
  if (!special) return null;
  if ((special[2] as string).toLowerCase() === "nan") return Number.NaN;
  return special[1] === "-" ? -Infinity : Infinity;
}

/** Seconds a response asks us to wait: retry-after-ms, then retry-after (seconds or a date). */
function retryAfter(headers: Headers): number | null {
  for (const [name, divisor] of [
    ["retry-after-ms", 1000],
    ["retry-after", 1],
  ] as const) {
    const value = headers.get(name);
    if (value === null) continue;
    const delay = pyFloat(value);
    if (delay === null) continue;
    if (
      delay === Infinity &&
      !["inf", "+inf", "infinity", "+infinity"].includes(value.trim().toLowerCase())
    ) {
      // A numeric overflow is an excessive server delay, which refuses the retry.
      return MAX_RETRY_AFTER + 1;
    }
    return delay / divisor;
  }
  const value = headers.get("retry-after");
  if (value === null) return null;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : (date - Date.now()) / 1000;
}

function shouldRetry(response: Response): boolean {
  const wait = retryAfter(response.headers);
  if (wait !== null && Number.isFinite(wait) && wait > MAX_RETRY_AFTER) return false;
  const header = response.headers.get("x-should-retry");
  if (header === "true") return true;
  if (header === "false") return false;
  const { status } = response;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** The SDK's APIStatusError text: `Error code: 401 - {'error': ...}`. */
async function statusError(response: Response): Promise<Error> {
  const text = pyStrip(await response.text());
  try {
    return new Error(`Error code: ${response.status} - ${pyRepr(JSON.parse(text))}`);
  } catch {
    return new Error(text || `Error code: ${response.status}`);
  }
}

function abortableSleep(
  sleep: (seconds: number) => Promise<void>,
  seconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return sleep(seconds);
  signal.throwIfAborted();
  return new Promise((resolveSleep, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(seconds).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolveSleep();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function toInt(value: unknown): number {
  return Math.trunc(Number(value));
}

export class EmbeddingClient {
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch | null;
  readonly #sleep: (seconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #maxRetries: number;
  readonly #timeoutSec: number;

  constructor(options: EmbeddingClientOptions) {
    this.baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#headers = { ...(options.headers ?? {}) };
    this.#fetch = options.fetch ?? null;
    this.#sleep = options.sleep ?? ((seconds) => Bun.sleep(seconds * 1000));
    this.#random = options.random ?? Math.random;
    this.#maxRetries = options.maxRetries ?? EMBED_HTTP_MAX_RETRIES;
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
      usage: { include: true },
    };
    let body: JsonObject | null = null;
    let lastError = "unknown";
    let dataFailures = 0;
    let quotaFailures = 0;
    for (;;) {
      const candidate = await this.#post(payload, signal);
      if (isObject(candidate) && pyTruthy(candidate.data)) {
        body = candidate;
        break;
      }
      const error = isObject(candidate) ? candidate.error : undefined;
      if (isObject(error) && pyTruthy(error.message)) lastError = pyStr(error.message);
      else if (isObject(error)) lastError = pyRepr(error);
      else lastError = "provider returned no embedding data";

      let delay: number;
      let label: string;
      if (isQuotaError(lastError)) {
        quotaFailures += 1;
        if (quotaFailures > MAX_EMBED_QUOTA_RETRIES) break;
        // Jitter spreads concurrent clients out so they don't all retry
        // the instant the quota window resets.
        delay = EMBED_QUOTA_BACKOFF + 10 * this.#random();
        label = `quota retry ${quotaFailures}/${MAX_EMBED_QUOTA_RETRIES}`;
      } else {
        dataFailures += 1;
        if (dataFailures > MAX_EMBED_DATA_RETRIES) break;
        delay = EMBED_RETRY_BASE_DELAY * 2 ** (dataFailures - 1) + this.#random();
        label = `retry ${dataFailures}/${MAX_EMBED_DATA_RETRIES}`;
      }
      const compact = cpSlice(pySplitWs(lastError).join(" "), 0, 240);
      logger.warning(
        `Embedding ${label} got no data (${compact}). Retrying in ${pyFixed(delay, 1)}s...`,
      );
      await abortableSleep(this.#sleep, delay, signal);
    }
    if (body === null) {
      throw new Error(
        `Embedding provider returned no data after ${dataFailures + quotaFailures} attempts ` +
          `(${dataFailures} data, ${quotaFailures} quota). ` +
          `Last error: ${lastError}${quotaFailures > 0 ? QUOTA_SUGGESTIONS : ""}`,
      );
    }
    const data = body.data;
    if (!Array.isArray(data)) throw new TypeError("embedding data is not a list");
    const vectors = data.map((d: unknown) => (d as { embedding: number[] }).embedding);

    const usage = isObject(body.usage) && pyTruthy(body.usage) ? body.usage : {};
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
    const price = Object.hasOwn(EMBED_PRICING_USD_PER_1M, model)
      ? EMBED_PRICING_USD_PER_1M[model]
      : undefined;
    if (price !== undefined && totalTokens > 0) {
      const costUsd = (totalTokens * price) / 1_000_000;
      return [
        vectors,
        new EmbeddingUsage({ promptTokens, totalTokens, costUsd, costSource: "estimate" }),
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
      const remaining = this.#maxRetries - retriesTaken;
      const timeout = AbortSignal.timeout(this.#timeoutSec * 1000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await (this.#fetch ?? fetch)(url, { ...init, signal: combined });
        if (response.ok) return await response.json();
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof SyntaxError) throw error;
        if (remaining > 0) {
          await abortableSleep(this.#sleep, this.#retryDelay(retriesTaken, null), signal);
          continue;
        }
        throw new Error(timeout.aborted ? "Request timed out." : "Connection error.");
      }
      if (remaining > 0 && shouldRetry(response)) {
        await response.body?.cancel();
        await abortableSleep(this.#sleep, this.#retryDelay(retriesTaken, response.headers), signal);
        continue;
      }
      throw await statusError(response);
    }
  }

  #retryDelay(retriesTaken: number, headers: Headers | null): number {
    const wait = headers ? retryAfter(headers) : null;
    if (wait !== null && Number.isFinite(wait) && wait > 0 && wait <= MAX_RETRY_AFTER) return wait;
    const backoff = Math.min(
      INITIAL_RETRY_DELAY * 2 ** Math.min(retriesTaken, 1000),
      MAX_RETRY_DELAY,
    );
    return Math.max(0, backoff * (1 - 0.25 * this.#random()));
  }
}

let defaultClient: EmbeddingClient | null = null;

/**
 * The process's client, built from env on first use. Without a key it throws, and caches nothing,
 * so the check repeats per call.
 */
export function defaultEmbeddingClient(): EmbeddingClient {
  if (defaultClient !== null) return defaultClient;
  const apiKey = envOptional("EMBED_API_KEY") ?? envOptional("OPENROUTER_API_KEY");
  if (apiKey === undefined) {
    throw new Error(
      "Embeddings need an API key. Set OPENROUTER_API_KEY (reused " +
        "from the LLM config) or EMBED_API_KEY for a different provider.",
    );
  }
  defaultClient = new EmbeddingClient({
    baseUrl: envStr("EMBED_BASE_URL", DEFAULT_EMBED_BASE_URL),
    apiKey,
    headers: openrouterHeaders(),
  });
  return defaultClient;
}

/** Forgets the default client, so the next call reads the env again. */
export function resetEmbeddingClient(): void {
  defaultClient = null;
}

export interface EmbedOptions {
  model?: string | null;
  dimensions?: number | null;
  signal?: AbortSignal;
}

/** Empty input makes no request. `model` defaults to EMBED_MODEL, `dimensions` to EMBED_DIM. */
export async function embedTextsWithUsage(
  texts: readonly string[],
  options: EmbedOptions = {},
): Promise<[number[][], EmbeddingUsage]> {
  if (texts.length === 0) return [[], new EmbeddingUsage()];
  const model = options.model || envStr("EMBED_MODEL", DEFAULT_EMBED_MODEL);
  const dimensions = options.dimensions || embedDim();
  return defaultEmbeddingClient().embedWithUsage(texts, {
    model,
    dimensions,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export async function embedTexts(
  texts: readonly string[],
  options: EmbedOptions = {},
): Promise<number[][]> {
  return (await embedTextsWithUsage(texts, options))[0];
}
