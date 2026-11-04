// The OpenAI Python SDK's request policy, which mem0's embedder and extraction LLM run on: two
// retries on connection errors, timeouts, 408/409/429/5xx (or as `x-should-retry` says), backoff
// min(0.5·2^n, 8) s less up to 25% jitter, a server `retry-after` honoured up to two minutes, and a
// 10-minute timeout. Its error texts reach the logs, so they read as the SDK's do.
import { pyError, pyStr, pyStrip, retryDelaySeconds, shouldRetry } from "@eidolon/config";
import { pyJsonLoads } from "./py-json.ts";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 600_000;

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
    this.#sleep = options.sleep ?? Bun.sleep;
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
          await this.#sleep(retryDelaySeconds(retriesTaken, null, this.#random) * 1000);
          continue;
        }
        throw timedOut
          ? pyError("APITimeoutError", "Request timed out.")
          : pyError("APIConnectionError", "Connection error.");
      }
      if (response.ok) return response.json();
      if (remaining > 0 && shouldRetry(response.status, response.headers)) {
        await response.body?.cancel();
        await this.#sleep(retryDelaySeconds(retriesTaken, response.headers, this.#random) * 1000);
        continue;
      }
      throw statusError(response.status, await response.text());
    }
  }
}
