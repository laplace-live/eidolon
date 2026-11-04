// The OpenAI Python SDK's retry policy: retry 408/409/429/5xx unless `x-should-retry` says
// otherwise, honour a server `retry-after` up to two minutes, else back off min(0.5·2^n, 8) s less
// up to 25% jitter.
import { pyParseFloat, pyStrip } from "./py.ts";

const INITIAL_RETRY_DELAY_S = 0.5;
const MAX_RETRY_DELAY_S = 8;
const MAX_RETRY_AFTER_S = 120;
const INFINITY_LITERALS = ["inf", "+inf", "infinity", "+infinity"];

/** The SDK's `_parse_retry_after_header`, in seconds. */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | null {
  for (const [name, divisor] of [
    ["retry-after-ms", 1000],
    ["retry-after", 1],
  ] as const) {
    const value = headers.get(name);
    if (value === null) continue;
    const delay = pyParseFloat(value);
    if (delay === null) continue;
    // An overflowing number is an excessive server delay, not an infinity literal.
    if (delay === Infinity && !INFINITY_LITERALS.includes(pyStrip(value).toLowerCase())) {
      return MAX_RETRY_AFTER_S + 1;
    }
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

/** The SDK's `_calculate_retry_timeout`, in seconds. */
export function retryDelaySeconds(
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
    return retryAfter;
  }
  const backoff = Math.min(
    INITIAL_RETRY_DELAY_S * 2 ** Math.min(retriesTaken, 1000),
    MAX_RETRY_DELAY_S,
  );
  return Math.max(backoff * (1 - 0.25 * random()), 0);
}
