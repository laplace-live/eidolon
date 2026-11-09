// Per-key sliding-window quota: the anonymous offer limit and both MCP tiers. A quota's map grows
// with the number of distinct keys seen and is reclaimed only by a process restart.
import { envInt } from "@eidolon/config";

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Slots left: after recording for tryConsume, without taking one for peek. Floored at 0. */
  readonly remaining: number;
  /** Seconds until the oldest in-window attempt ages out; 0 when allowed. */
  readonly retryAfterSeconds: number;
}

/** Monotonic seconds. */
export type MonotonicClock = () => number;

// performance.now(), not Date.now(), so an NTP correction or VM clock skew during a long call
// can't reset or extend the window.
export const monotonicSeconds: MonotonicClock = () => performance.now() / 1000;

export class SlidingWindowQuota {
  readonly maxPerWindow: number;
  readonly windowSeconds: number;
  readonly #now: MonotonicClock;
  readonly #hits = new Map<string, number[]>();

  constructor(maxPerWindow: number, windowSeconds: number, now: MonotonicClock = monotonicSeconds) {
    // max=0 ("block every anonymous caller") is a legal config.
    this.maxPerWindow = Math.max(0, maxPerWindow);
    this.windowSeconds = Math.max(1, windowSeconds);
    this.#now = now;
  }

  /**
   * Check and record one attempt. Synchronous on purpose: an await between the check and the
   * append would let two simultaneous offers both pass a full bucket.
   */
  tryConsume(key: string): RateLimitResult {
    const now = this.#now();
    const hits = this.#inWindow(key, now);
    if (hits.length >= this.maxPerWindow) return this.#result(hits, now, false);
    hits.push(now);
    if (hits.length === 1) this.#hits.set(key, hits);
    return this.#result(hits, now, true);
  }

  /** Same answer as tryConsume, without recording an attempt. */
  peek(key: string): RateLimitResult {
    const now = this.#now();
    return this.#result(this.#inWindow(key, now), now, false);
  }

  #inWindow(key: string, now: number): number[] {
    // Only tryConsume adds a key: a peek (the preflight) costs nothing, so it mustn't grow the map.
    const hits = this.#hits.get(key) ?? [];
    // Strict: an attempt exactly windowSeconds old still counts.
    const cutoff = now - this.windowSeconds;
    let expired = 0;
    while (expired < hits.length && (hits[expired] as number) < cutoff) expired++;
    if (expired > 0) hits.splice(0, expired);
    return hits;
  }

  #result(hits: readonly number[], now: number, consumed: boolean): RateLimitResult {
    const allowed = consumed || hits.length < this.maxPerWindow;
    let retryAfterSeconds = 0;
    if (!allowed) {
      const oldest = hits[0];
      // Floor of 1 so the client isn't told "retry in 0 seconds" and doesn't collide again on
      // the next tick. An empty window only happens with max=0: report the whole window.
      retryAfterSeconds =
        oldest === undefined
          ? this.windowSeconds
          : Math.max(1, Math.trunc(this.windowSeconds - (now - oldest)));
    }
    return Object.freeze({
      allowed,
      remaining: Math.max(0, this.maxPerWindow - hits.length),
      retryAfterSeconds,
    });
  }
}

/** A quota sized by two env vars, read now; the vars are per window, whatever their names say. */
export function quotaFromEnv(
  perWindowVar: string,
  defaultPerWindow: number,
  windowVar: string,
  defaultWindowSec: number,
): SlidingWindowQuota {
  return new SlidingWindowQuota(
    envInt(perWindowVar, defaultPerWindow),
    envInt(windowVar, defaultWindowSec),
  );
}

export const ANON_OFFER_DEFAULT_PER_WINDOW = 5;
export const ANON_OFFER_DEFAULT_WINDOW_SEC = 3600;

let anonQuota: SlidingWindowQuota | undefined;

/**
 * EIDOLON_ANON_RATE_LIMIT_PER_HOUR (5) per EIDOLON_ANON_RATE_LIMIT_WINDOW_SEC (3600), clamped. A
 * process singleton built on first call (after the .env load); the default quota of both
 * admitOffer and preflightOffer. apps/bot logs its values in the `[offer-middleware] Installed …`
 * line.
 */
export function anonOfferQuota(): SlidingWindowQuota {
  anonQuota ??= quotaFromEnv(
    "EIDOLON_ANON_RATE_LIMIT_PER_HOUR",
    ANON_OFFER_DEFAULT_PER_WINDOW,
    "EIDOLON_ANON_RATE_LIMIT_WINDOW_SEC",
    ANON_OFFER_DEFAULT_WINDOW_SEC,
  );
  return anonQuota;
}
