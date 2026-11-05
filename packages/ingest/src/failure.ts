// The event code for an error, so the web app can say what went wrong in the viewer's language and
// point at what to fix; the error's own text stays the event's message.
import { EVENT_CODES, type EventCode, type Provider } from "./progress.ts";

/** An event's `code`, with `provider` when the code is about a provider's key, credit or reach. */
export interface Failure {
  readonly code: EventCode;
  readonly provider?: Provider;
}

const CODES: ReadonlySet<string> = new Set(EVENT_CODES);

// Node's ENOSPC, SQLite's SQLITE_FULL, and the OS text LanceDB and yt-dlp pass along.
const DISK_FULL = /\bENOSPC\b|No space left on device|database or disk is full/i;

// The OpenAI SDK's error names, which OpenAIClient keeps.
const STATUS_BY_NAME: Readonly<Record<string, number>> = {
  AuthenticationError: 401,
  RateLimitError: 429,
};
const STATUS_CODES: Readonly<Record<number, EventCode>> = {
  401: "auth-failed",
  402: "insufficient-credits",
  429: "rate-limited",
};
const NETWORK_NAMES: ReadonlySet<string> = new Set([
  "SonioxConnectionError",
  "APIConnectionError",
  "APITimeoutError",
]);
// The embedding client's transport failures, which carry no name of their own.
const NETWORK_MESSAGES: ReadonlySet<string> = new Set(["Connection error.", "Request timed out."]);
// What the embedding client appends once OpenRouter has answered 200 with a quota error.
const QUOTA_EXHAUSTED = "Sustained quota error";

/** The status an API error carries: Soniox's errors hold it; the OpenAI-style texts start with it. */
function httpStatus(error: Error): number | null {
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") return status;
  const match = /^Error code: (\d{3})\b/.exec(error.message);
  if (match) return Number(match[1]);
  return STATUS_BY_NAME[error.name] ?? null;
}

/**
 * The code for `error`, thrown while talking to `provider`'s API, or null for an error that has
 * none. A full disk is recognised whatever threw it; an error that carries a known code keeps it.
 */
export function failureOf(error: unknown, provider?: Provider): Failure | null {
  if (!(error instanceof Error)) return null;
  const own = (error as { code?: unknown }).code;
  if (own === "ENOSPC" || own === "SQLITE_FULL" || DISK_FULL.test(error.message)) {
    return { code: "disk-full" };
  }
  if (typeof own === "string" && CODES.has(own)) return { code: own as EventCode };
  if (provider === undefined) return null;
  const status = httpStatus(error);
  const code = status === null ? undefined : STATUS_CODES[status];
  if (code !== undefined) return { code, provider };
  if (NETWORK_NAMES.has(error.name) || NETWORK_MESSAGES.has(error.message)) {
    return { code: "network", provider };
  }
  if (error.message.includes(QUOTA_EXHAUSTED)) return { code: "rate-limited", provider };
  return null;
}

/** The failure every one of `failures` shares, for the stage they all ended; else null. */
export function sharedFailure(failures: readonly (Failure | null)[]): Failure | null {
  const [first] = failures;
  if (first === undefined || first === null) return null;
  const same = failures.every(
    (failure) => failure?.code === first.code && failure.provider === first.provider,
  );
  return same ? first : null;
}
