// The guard in front of POST /api/offer: a validated loginSyncToken bypasses the anonymous
// per-IP quota, everything else is charged one slot before any WebRTC pipeline spawns. Token
// presence alone is never enough: an unvalidated string would let anyone skip the quota and spawn
// a full STT+LLM+TTS pipeline per probe.
import { cpLen, logger, pyJsonDumps, pyStr, pyStrip } from "@eidolon/config";
import {
  type AudioQualitySettings,
  audioQualitySettings,
  sessionBitrateFor,
} from "./audio-quality.ts";
import { isJsonObject, type JsonObject } from "./json.ts";
import { anonOfferQuota, type RateLimitResult, type SlidingWindowQuota } from "./rate-limit.ts";
import { ANONYMOUS, resolveUserContext, type UserContext } from "./user-context.ts";

export type { JsonObject };

export const OFFER_PATH = "/api/offer";
export const PREFLIGHT_PATH = "/api/offer/preflight";
export const ANON_QUOTA_EXHAUSTED_ERROR = "匿名用户每小时通话次数已达上限，请登录后再试";

/**
 * The body as a JSON object, or null for anything else. Null reads as a malformed offer from an
 * anonymous viewer, so probes and junk fall under the rate limit by default; a real client never
 * sends junk.
 */
export function parseOfferBody(bodyText: string): JsonObject | null {
  if (!bodyText) return null;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  return isJsonObject(body) ? body : null;
}

/**
 * `requestData` when it is an object, else `request_data` when that is. With both present the
 * guard authenticates by `requestData`, while pipedog's `fromDict` takes `request_data`.
 */
export function offerRequestData(body: JsonObject | null): JsonObject | null {
  if (isJsonObject(body?.requestData)) return body.requestData;
  return isJsonObject(body?.request_data) ? body.request_data : null;
}

/** `loginSyncToken`, stripped, when it is a string with non-whitespace content. */
export function loginSyncTokenFrom(requestData: JsonObject | null | undefined): string | null {
  const token = requestData?.loginSyncToken;
  if (typeof token !== "string") return null;
  return pyStrip(token) || null;
}

/** The raw, unvalidated `audioQuality` (undefined when absent). */
export function audioQualityFrom(requestData: JsonObject | null): unknown {
  return requestData?.audioQuality;
}

export interface OfferInput {
  /**
   * The request body, decoded with U+FFFD replacement (`Request.text()`). A Request body reads
   * once, so the route hands this same text on, never the consumed Request.
   */
  readonly bodyText: string;
  readonly clientIp: string;
}

export interface OfferGuardDeps {
  readonly quota?: SlidingWindowQuota;
  readonly resolveUser?: (token: string) => Promise<UserContext>;
  readonly audio?: AudioQualitySettings;
}

export interface AllowedOffer {
  readonly allowed: true;
  readonly user: UserContext;
  readonly token: string | null;
  /** The parsed body, or null when it is not a JSON object (runtime answers as the runner did). */
  readonly body: JsonObject | null;
  readonly requestData: JsonObject | null;
  readonly opusBitrateBps: number;
  readonly clientIp: string;
  /** null for a validated token, which bypasses the anonymous quota. */
  readonly quota: RateLimitResult | null;
}

export interface RejectedOffer {
  readonly allowed: false;
  readonly user: UserContext;
  readonly clientIp: string;
  readonly quota: RateLimitResult;
  /** The 429, byte-identical to offer_middleware.py's. apps/bot adds CORS. */
  readonly response: Response;
}

export type OfferAdmission = AllowedOffer | RejectedOffer;

/** 429 `{"error": …, "retry_after": R}` with Retry-After, in Python json.dumps bytes. */
export function anonQuotaExceededResponse(result: RateLimitResult): Response {
  const retryAfter = result.retryAfterSeconds;
  const body = pyJsonDumps(
    { error: ANON_QUOTA_EXHAUSTED_ERROR, retry_after: retryAfter },
    { ensureAscii: false },
  );
  return new Response(body, {
    status: 429,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(retryAfter),
    },
  });
}

/**
 * POST /api/offer's guard: token bypass, else the anonymous per-IP quota. Only the POST is
 * gated: PATCH /api/offer (trickled ICE candidates) can only follow an admitted POST, so
 * throttling it would punish a caller who already paid.
 */
export async function admitOffer(
  input: OfferInput,
  deps: OfferGuardDeps = {},
): Promise<OfferAdmission> {
  const { clientIp } = input;
  const quota = deps.quota ?? anonOfferQuota();
  const body = parseOfferBody(input.bodyText);
  const requestData = offerRequestData(body);
  const opusBitrateBps = sessionBitrateFor(
    audioQualityFrom(requestData),
    deps.audio ?? audioQualitySettings(),
  );
  const token = loginSyncTokenFrom(requestData);
  let user = ANONYMOUS;
  if (token !== null) {
    user = await (deps.resolveUser ?? resolveUserContext)(token);
    if (user.isLoggedIn) {
      logger.info(
        `[offer-middleware] Logged-in offer (validated mid=${pyStr(user.mid)}, ` +
          `len=${cpLen(token)}); bypassing rate limit`,
      );
      return {
        allowed: true,
        user,
        token,
        body,
        requestData,
        opusBitrateBps,
        clientIp,
        quota: null,
      };
    }
    // Revoked, malformed or forged: all fall through to the plain anonymous path with an
    // identical 429, so the response never reveals whether a token was a near-miss.
    logger.info(
      `[offer-middleware] Token present but did not validate (len=${cpLen(token)}); ` +
        "falling through to anonymous quota",
    );
  }

  const result = quota.tryConsume(clientIp);
  if (!result.allowed) {
    logger.info(
      `[offer-rate-limit] Anonymous quota exhausted for ip=${clientIp}; rejecting offer ` +
        `(retry_after=${result.retryAfterSeconds}s, window=${quota.windowSeconds}s, ` +
        `max=${quota.maxPerWindow})`,
    );
    return {
      allowed: false,
      user,
      clientIp,
      quota: result,
      response: anonQuotaExceededResponse(result),
    };
  }
  logger.debug(
    `[offer-rate-limit] Anonymous offer allowed for ip=${clientIp}; ` +
      `remaining=${result.remaining}/${quota.maxPerWindow}`,
  );
  return { allowed: true, user, token, body, requestData, opusBitrateBps, clientIp, quota: result };
}

// Starlette's JSONResponse bytes: compact JSON and a bare `application/json`, where Bun's
// Response.json() would add `;charset=utf-8`.
function starletteJson(
  content: JsonObject,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(content), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });
}

/**
 * POST /api/offer/preflight, for clients that check the quota before connecting. It peeks and
 * never consumes, so preflight plus the real offer counts as one attempt.
 */
export async function preflightOffer(
  input: OfferInput,
  deps: OfferGuardDeps = {},
): Promise<Response> {
  const quota = deps.quota ?? anonOfferQuota();
  const token = loginSyncTokenFrom(offerRequestData(parseOfferBody(input.bodyText)));
  if (token !== null) {
    // Shares the resolver's cache with the real offer, so both calls cost one Workers round-trip.
    const user = await (deps.resolveUser ?? resolveUserContext)(token);
    if (user.isLoggedIn) return starletteJson({ ok: true, anonymous: false });
    // A bad token reports the plain anonymous quota state: the response shape never
    // distinguishes it from "no token".
  }
  const result = quota.peek(input.clientIp);
  if (result.allowed) {
    return starletteJson({ ok: true, anonymous: true, remaining: result.remaining });
  }
  return starletteJson(
    {
      ok: false,
      anonymous: true,
      error: ANON_QUOTA_EXHAUSTED_ERROR,
      retry_after: result.retryAfterSeconds,
    },
    429,
    { "retry-after": String(result.retryAfterSeconds) },
  );
}
