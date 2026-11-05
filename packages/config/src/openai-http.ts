// The OpenAI Python SDK's request policy, which mem0's clients and laplace-refine run on: retries
// on connection errors, timeouts, 408/409/429/5xx (or as `x-should-retry` says), backoff
// min(0.5·2^n, 8) s less up to 25% jitter, a server `retry-after` honoured up to two minutes, and a
// 10-minute timeout. Its error texts reach the logs, so they read as the SDK's do.
import { abortableSleep, raceAbort } from "./abort.ts";
import { retryDelaySeconds, shouldRetry } from "./openai-retry.ts";
import { pyError, pyStr, pyStrip } from "./py.ts";
import { pyJsonLoads } from "./py-json.ts";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 600_000;

export interface OpenAIClientOptions {
  readonly fetch?: typeof fetch;
  /** The SDK's `max_retries`. */
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  readonly random?: () => number;
  /** Given `signal`, which aborts the wait. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The SDK's `default_headers`: sent with every request, over its own. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Aborts the request in flight and any retry wait; the call then rejects with its reason. */
  readonly signal?: AbortSignal;
}

/** The one call these clients make: POST a JSON body under the base URL. */
export interface JsonPoster {
  post(path: string, body: Readonly<Record<string, unknown>>): Promise<unknown>;
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

export class OpenAIClient implements JsonPoster {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;
  readonly #random: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #signal: AbortSignal | undefined;

  constructor(
    settings: { readonly baseUrl: string; readonly apiKey: string },
    options: OpenAIClientOptions = {},
  ) {
    this.#baseUrl = settings.baseUrl.endsWith("/") ? settings.baseUrl : `${settings.baseUrl}/`;
    this.#apiKey = settings.apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? abortableSleep;
    this.#headers = options.headers ?? {};
    this.#signal = options.signal;
  }

  async post(path: string, body: Readonly<Record<string, unknown>>): Promise<unknown> {
    const url = this.#baseUrl + path;
    const payload = JSON.stringify(body);
    const cancel = this.#signal;
    for (let retriesTaken = 0; ; retriesTaken++) {
      cancel?.throwIfAborted();
      const remaining = this.#maxRetries - retriesTaken;
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      let response: Response;
      let text: string;
      try {
        response = await this.#fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            ...this.#headers,
          },
          body: payload,
          signal: cancel ? AbortSignal.any([cancel, timeout]) : timeout,
        });
        // httpx reads a non-streamed body inside send(), so openai-python retries a reset mid-body.
        text = await response.text();
      } catch (error) {
        if (cancel?.aborted) throw cancel.reason;
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        if (remaining > 0) {
          await this.#wait(retryDelaySeconds(retriesTaken, null, this.#random));
          continue;
        }
        throw timedOut
          ? pyError("APITimeoutError", "Request timed out.")
          : pyError("APIConnectionError", "Connection error.");
      }
      if (response.ok) return JSON.parse(text);
      if (remaining > 0 && shouldRetry(response.status, response.headers)) {
        await this.#wait(retryDelaySeconds(retriesTaken, response.headers, this.#random));
        continue;
      }
      throw statusError(response.status, text);
    }
  }

  #wait(seconds: number): Promise<void> {
    return raceAbort(this.#sleep(seconds * 1000, this.#signal), this.#signal);
  }
}
