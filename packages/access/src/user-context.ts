// Validates a viewer's loginSyncToken against the Workers helper API. Everything fails open:
// network errors, malformed JSON and `code != 0` all collapse to ANONYMOUS, so a Workers outage
// demotes every viewer to anonymous rather than taking the bot down.
import { createHash } from "node:crypto";
import {
  envInt,
  envOptional,
  errorText,
  httpxStatusMessage,
  isJsonObject,
  logger,
  pyParseInt,
  pyRepr,
  pyStr,
  pyStrip,
  pyTruthy,
} from "@eidolon/config";
import { type MonotonicClock, monotonicSeconds } from "./rate-limit.ts";

export interface UserContext {
  readonly mid: number | null;
  readonly uname: string | null;
  readonly face: string | null;
  /** Branch on this, never on field truthiness: `face` is legitimately absent for some viewers. */
  readonly isLoggedIn: boolean;
}

export type LoggedInUser = UserContext & { readonly isLoggedIn: true; readonly mid: number };

/** The one value for every "no token / can't validate / not logged in" outcome. */
export const ANONYMOUS: UserContext = Object.freeze({
  mid: null,
  uname: null,
  face: null,
  isLoggedIn: false,
});

export const VALIDATE_PATH = "/bilibili/validate-login-sync-v2";
export const VALIDATE_TIMEOUT_MS = 10_000;
export const DEFAULT_VALIDATE_TTL_SEC = 60;
export const WAF_BYPASS_HEADER = "x-laplace-cf-waf-bypass";

/** Python `int(raw)`, or null where it raises. */
function midOf(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    const mid = Math.trunc(raw);
    return mid === 0 ? 0 : mid;
  }
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "string") return pyParseInt(raw);
  return null;
}

/** Python `_parse_response`: a validate-login-sync-v2 payload as a UserContext. */
export function parseValidateResponse(payload: unknown): UserContext {
  if (!isJsonObject(payload)) return ANONYMOUS;
  // -101 = not logged in, 404 = token unknown, anything else = upstream error. The caller logs
  // the raw code. Python's `!= 0` lets `false` through too.
  const code = payload.code;
  if (code !== 0 && code !== false) return ANONYMOUS;
  const data = payload.data;
  if (!isJsonObject(data)) return ANONYMOUS;
  // data.mid is the canonical Bilibili nav field; data.fetcher is the Workers wrapper's alias,
  // which the laplace frontend reads (login-sync-token-input.tsx).
  const mid = midOf(data.mid ?? data.fetcher);
  const uname = data.uname;
  const face = data.face;
  // Nothing to personalize without both, and a half-populated context is worse than an honest
  // anonymous one.
  if (mid === null || !pyTruthy(uname)) return ANONYMOUS;
  return Object.freeze({
    mid,
    uname: pyStr(uname),
    face: pyTruthy(face) ? pyStr(face) : null,
    isLoggedIn: true,
  });
}

/** The resolver's cache key for a stripped token. */
export function validateCacheKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface UserContextResolverOptions {
  /** Default: EIDOLON_VALIDATE_TTL_SEC (60), unclamped, read at construction. */
  readonly ttlSeconds?: number;
  /** Default: WORKERS_BASE_URL, read on every call. */
  readonly workersBaseUrl?: () => string | undefined;
  /** Default: CF_WAF_BYPASS_TOKEN, read at construction. Empty sends no header. */
  readonly wafBypassToken?: string;
  readonly fetch?: FetchLike;
  readonly now?: MonotonicClock;
  /** One deadline for the request and its body. */
  readonly timeoutMs?: number;
}

interface CacheEntry {
  readonly ctx: UserContext;
  readonly expiry: number;
}

interface WorkersReply {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly body: ArrayBuffer;
}

// Fatal, so invalid UTF-8 is a non-JSON reply rather than U+FFFD inside a uname.
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

function describeError(error: unknown): string {
  if (error instanceof Error || error instanceof DOMException) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

export class UserContextResolver {
  readonly #ttlSeconds: number;
  readonly #workersBaseUrl: () => string | undefined;
  readonly #wafBypassToken: string | undefined;
  readonly #fetch: FetchLike;
  readonly #now: MonotonicClock;
  readonly #timeoutMs: number;
  // Keyed on sha256(token) for the TTL (default 60 s): short enough to honor a Bilibili-side
  // sign-out, long enough to absorb WebRTC reconnect storms, and it keeps the raw token out of
  // long-lived process memory.
  readonly #cache = new Map<string, CacheEntry>();

  constructor(options: UserContextResolverOptions = {}) {
    this.#ttlSeconds =
      options.ttlSeconds ?? envInt("EIDOLON_VALIDATE_TTL_SEC", DEFAULT_VALIDATE_TTL_SEC);
    this.#workersBaseUrl = options.workersBaseUrl ?? (() => envOptional("WORKERS_BASE_URL"));
    // Cloudflare's WAF 403s server-to-server calls that lack a browser-like fingerprint, and a
    // custom rule on the Workers side matches this header, so the value must stay in sync with
    // that rule. Read once, so rolling the token needs a bot restart.
    this.#wafBypassToken = options.wafBypassToken ?? envOptional("CF_WAF_BYPASS_TOKEN");
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? monotonicSeconds;
    this.#timeoutMs = options.timeoutMs ?? VALIDATE_TIMEOUT_MS;
  }

  /**
   * The viewer behind `token`; never rejects. Parsed Workers answers are cached for the TTL
   * whether or not they validate, so a flood of the same bad token costs one Workers hit per
   * TTL. Transport failures, HTTP errors and non-JSON bodies are not cached.
   */
  async resolve(token: string | null | undefined): Promise<UserContext> {
    const stripped = token ? pyStrip(token) : "";
    if (!stripped) {
      logger.info("[user-context] No loginSyncToken; viewer is anonymous");
      return ANONYMOUS;
    }
    const baseUrl = (this.#workersBaseUrl() ?? "").replace(/\/+$/, "");
    if (!baseUrl) {
      logger.warning(
        "[user-context] WORKERS_BASE_URL not set; cannot validate token; treating viewer as anonymous",
      );
      return ANONYMOUS;
    }

    const key = validateCacheKey(stripped);
    const now = this.#now();
    // An expired entry stays in scope as the stale fallback below.
    const cached = this.#cache.get(key);
    if (cached !== undefined && now < cached.expiry) {
      logger.info(
        `[user-context] Cache hit (logged_in=${pyStr(cached.ctx.isLoggedIn)}, ` +
          `mid=${pyStr(cached.ctx.mid)}); skipping Workers call`,
      );
      return cached.ctx;
    }

    const url = `${baseUrl}${VALIDATE_PATH}`;
    logger.info(`[user-context] Validating token against Workers at ${url}`);
    let reply: WorkersReply;
    try {
      reply = await this.#post(url, stripped);
    } catch (error) {
      return this.#failOpen(describeError(error), cached);
    }
    if (!reply.ok) {
      const message = httpxStatusMessage(reply, url, { statusLineOnly: true });
      return this.#failOpen(`HTTPStatusError: ${message}`, cached);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(STRICT_UTF8.decode(reply.body));
    } catch (error) {
      logger.warning(
        `[user-context] Workers returned non-JSON (${errorText(error)}); treating viewer as anonymous`,
      );
      return ANONYMOUS;
    }

    const ctx = parseValidateResponse(payload);
    if (ctx.isLoggedIn) {
      logger.info(
        `[user-context] Resolved viewer mid=${pyStr(ctx.mid)} uname=${pyRepr(ctx.uname)}`,
      );
    } else {
      const code = isJsonObject(payload) ? pyStr(payload.code) : "?";
      logger.info(`[user-context] Token did not resolve to a logged-in user (code=${code})`);
    }
    this.#cache.set(key, { ctx, expiry: now + this.#ttlSeconds });
    // Opportunistic GC, on writes only, of entries expired for a further full TTL.
    const cutoff = now - this.#ttlSeconds;
    for (const [k, entry] of this.#cache) {
      if (entry.expiry < cutoff) this.#cache.delete(k);
    }
    return ctx;
  }

  async #post(url: string, token: string): Promise<WorkersReply> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#wafBypassToken) headers[WAF_BYPASS_HEADER] = this.#wafBypassToken;
    const res = await this.#fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ token }),
      // A 3xx fails validation; following it would re-send the token wherever it points.
      redirect: "manual",
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    // Read before the status check, as httpx does, so no reply leaves its body unconsumed.
    const body = await res.arrayBuffer();
    return { status: res.status, statusText: res.statusText, ok: res.ok, body };
  }

  // A failed refresh falls back to the stale entry when there is one, so a transient network
  // blip can't flap a logged-in viewer to anonymous mid-call.
  #failOpen(reason: string, stale: CacheEntry | undefined): UserContext {
    logger.warning(
      `[user-context] Workers validation request failed (${reason}); falling back to ` +
        (stale !== undefined ? "stale cache" : "anonymous"),
    );
    return stale?.ctx ?? ANONYMOUS;
  }
}

let sharedResolver: UserContextResolver | undefined;

/** The process-wide resolver, built on first use. Every caller shares its cache. */
export function userContextResolver(): UserContextResolver {
  sharedResolver ??= new UserContextResolver();
  return sharedResolver;
}

/** Validates a loginSyncToken through the Workers helper API; never rejects (fails open). */
export function resolveUserContext(token: string | null | undefined): Promise<UserContext> {
  return userContextResolver().resolve(token);
}
