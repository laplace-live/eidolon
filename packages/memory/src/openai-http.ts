// The OpenAI Python SDK's request policy, which mem0's embedder and extraction LLM run on: two
// retries on connection errors, timeouts, 408/409/429/5xx (or as `x-should-retry` says), backoff
// min(0.5·2^n, 8) s less up to 25% jitter, a server `retry-after` honoured up to two minutes, and a
// 10-minute timeout. Its error texts reach the logs, so they read as the SDK's do.
import { pyStr, pyStrip } from "@eidolon/config";
import { pyError } from "./errors.ts";
import { pyJsonLoads } from "./py-json.ts";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 600_000;
const INITIAL_RETRY_DELAY_S = 0.5;
const MAX_RETRY_DELAY_S = 8;
const MAX_RETRY_AFTER_S = 120;

export interface HttpOptions {
  readonly fetch?: typeof fetch;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The one call mem0's OpenAI clients make: POST a JSON body under the base URL. */
export interface JsonPoster {
  post(path: string, body: Readonly<Record<string, unknown>>): Promise<unknown>;
}

const FLOAT =
  /^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/;
const SPECIAL = /^([+-]?)(inf|infinity|nan)$/i;

/** Python `float(text)`, or null where it raises ValueError. */
function pyFloat(text: string): number | null {
  const t = pyStrip(text);
  if (FLOAT.test(t)) return Number(t.replaceAll("_", ""));
  const special = SPECIAL.exec(t);
  if (!special) return null;
  if (special[2]?.toLowerCase() === "nan") return Number.NaN;
  return special[1] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
}

/** The SDK's `_parse_retry_after_header`, in seconds. */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | null {
  for (const [name, divisor] of [
    ["retry-after-ms", 1000],
    ["retry-after", 1],
  ] as const) {
    const value = headers.get(name);
    if (value === null) continue;
    const delay = pyFloat(value);
    if (delay === null) continue;
    const literal = ["inf", "+inf", "infinity", "+infinity"].includes(pyStrip(value).toLowerCase());
    // An overflowing number is an excessive server delay, not an infinity literal.
    if (delay === Number.POSITIVE_INFINITY && !literal) return MAX_RETRY_AFTER_S + 1;
    return delay / divisor;
  }
  const date = headers.get("retry-after");
  if (date === null) return null;
  const at = Date.parse(date);
  return Number.isNaN(at) ? null : (at - now) / 1000;
}

/** The SDK's `_should_retry` for an error status. */
export function shouldRetry(status: number, headers: Headers): boolean {
  const retryAfter = parseRetryAfter(headers);
  if (retryAfter !== null && Number.isFinite(retryAfter) && retryAfter > MAX_RETRY_AFTER_S) {
    return false;
  }
  const header = headers.get("x-should-retry");
  if (header === "true") return true;
  if (header === "false") return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** The SDK's `_calculate_retry_timeout`, in milliseconds. */
export function retryDelayMs(
  retriesTaken: number,
  headers: Headers | null,
  random: () => number = Math.random,
): number {
  const retryAfter = headers ? parseRetryAfter(headers) : null;
  if (
    retryAfter !== null &&
    Number.isFinite(retryAfter) &&
    retryAfter > 0 &&
    retryAfter <= MAX_RETRY_AFTER_S
  ) {
    return retryAfter * 1000;
  }
  const backoff = Math.min(
    INITIAL_RETRY_DELAY_S * 2 ** Math.min(retriesTaken, 1000),
    MAX_RETRY_DELAY_S,
  );
  return Math.max(backoff * (1 - 0.25 * random()), 0) * 1000;
}

const STATUS_ERRORS: Record<number, string> = {
  400: "BadRequestError",
  401: "AuthenticationError",
  403: "PermissionDeniedError",
  404: "NotFoundError",
  409: "ConflictError",
  422: "UnprocessableEntityError",
  429: "RateLimitError",
};

/** The SDK's `_make_status_error_from_response` message: the parsed body's Python repr. */
function statusError(status: number, text: string): Error {
  const body = pyStrip(text);
  let message: string;
  try {
    message = `Error code: ${status} - ${pyStr(pyJsonLoads(body))}`;
  } catch {
    message = body || `Error code: ${status}`;
  }
  const name = STATUS_ERRORS[status] ?? (status >= 500 ? "InternalServerError" : "APIStatusError");
  return pyError(name, message);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenAIClient implements JsonPoster {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;
  readonly #random: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(
    settings: { readonly baseUrl: string; readonly apiKey: string },
    options: HttpOptions = {},
  ) {
    this.#baseUrl = settings.baseUrl.endsWith("/") ? settings.baseUrl : `${settings.baseUrl}/`;
    this.#apiKey = settings.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? wait;
  }

  async post(path: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    const url = this.#baseUrl + path;
    const payload = JSON.stringify(body);
    for (let retriesTaken = 0; ; retriesTaken++) {
      const remaining = this.#maxRetries - retriesTaken;
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: payload,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        if (remaining > 0) {
          await this.#sleep(retryDelayMs(retriesTaken, null, this.#random));
          continue;
        }
        throw timedOut
          ? pyError("APITimeoutError", "Request timed out.")
          : pyError("APIConnectionError", "Connection error.");
      }
      if (response.ok) return response.json();
      if (remaining > 0 && shouldRetry(response.status, response.headers)) {
        await response.body?.cancel();
        await this.#sleep(retryDelayMs(retriesTaken, response.headers, this.#random));
        continue;
      }
      throw statusError(response.status, await response.text());
    }
  }
}
