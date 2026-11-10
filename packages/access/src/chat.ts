// Who may use the production chat endpoint, and how much: each viewer line costs a slot, a
// validated loginSyncToken's from its mid's quota, everyone else's from their IP's. Token presence
// alone is never enough: an unvalidated string would buy any probe the logged-in quota.
import { activePersona, cpLen, envInt, envOptional, logger, pyJsonDumps } from "@eidolon/config";
import { type RateLimitResult, SlidingWindowQuota } from "./rate-limit.ts";
import { ANONYMOUS, resolveUserContext, type UserContext } from "./user-context.ts";

export const CHAT_ANON_DEFAULT_PER_HOUR = 20;
export const CHAT_USER_DEFAULT_PER_HOUR = 200;
const HOUR_SEC = 3600;

export const CHAT_ANON_QUOTA_ERROR = "匿名用户每小时聊天次数已达上限，请登录后再试";
export const CHAT_USER_QUOTA_ERROR = "每小时聊天次数已达上限，请稍后再试";

export interface ChatQuotas {
  /** Keyed by client IP. */
  readonly anonymous: SlidingWindowQuota;
  /** Keyed by mid. */
  readonly loggedIn: SlidingWindowQuota;
}

let quotas: ChatQuotas | undefined;

/**
 * EIDOLON_CHAT_ANON_QUOTA (20) and EIDOLON_CHAT_USER_QUOTA (200) turns an hour, read on first call
 * and kept for the process.
 */
export function chatQuotas(): ChatQuotas {
  quotas ??= {
    anonymous: new SlidingWindowQuota(
      envInt("EIDOLON_CHAT_ANON_QUOTA", CHAT_ANON_DEFAULT_PER_HOUR),
      HOUR_SEC,
    ),
    loggedIn: new SlidingWindowQuota(
      envInt("EIDOLON_CHAT_USER_QUOTA", CHAT_USER_DEFAULT_PER_HOUR),
      HOUR_SEC,
    ),
  };
  return quotas;
}

/** EIDOLON_CHAT_PERSONAS, comma-separated, else the installed persona alone; read on every call. */
export function chatPersonas(): string[] {
  const listed = (envOptional("EIDOLON_CHAT_PERSONAS") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  return listed.length > 0 ? [...new Set(listed)] : [activePersona().id];
}

export interface ChatTurnInput {
  /** The request's loginSyncToken, unvalidated; null without one. */
  readonly token: string | null;
  readonly clientIp: string;
}

export interface ChatGuardDeps {
  readonly quotas?: ChatQuotas;
  readonly resolveUser?: (token: string) => Promise<UserContext>;
}

export type ChatAdmission =
  | { readonly allowed: true; readonly user: UserContext; readonly quota: RateLimitResult }
  | {
      readonly allowed: false;
      readonly user: UserContext;
      readonly quota: RateLimitResult;
      /** The 429 chatQuotaExceededResponse builds. apps/bot adds CORS. */
      readonly response: Response;
    };

/** 429 `{"error": …, "retry_after": R}` with Retry-After, as the offer's anonymous 429 is shaped. */
export function chatQuotaExceededResponse(result: RateLimitResult, loggedIn: boolean): Response {
  const retryAfter = result.retryAfterSeconds;
  const error = loggedIn ? CHAT_USER_QUOTA_ERROR : CHAT_ANON_QUOTA_ERROR;
  return new Response(pyJsonDumps({ error, retry_after: retryAfter }, { ensureAscii: false }), {
    status: 429,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "retry-after": String(retryAfter),
    },
  });
}

/**
 * Charges one chat turn: a token that validates to a logged-in viewer is charged to its mid, and
 * anything else, a forged or expired token included, to the client IP as anonymous.
 */
export async function admitChatTurn(
  input: ChatTurnInput,
  deps: ChatGuardDeps = {},
): Promise<ChatAdmission> {
  const { anonymous, loggedIn } = deps.quotas ?? chatQuotas();
  let user = ANONYMOUS;
  if (input.token !== null) {
    user = await (deps.resolveUser ?? resolveUserContext)(input.token);
    if (!user.isLoggedIn) {
      logger.info(
        `[chat-quota] Token present but did not validate (len=${cpLen(input.token)}); ` +
          "charging the anonymous quota",
      );
    }
  }
  const [quota, key, who] = user.isLoggedIn
    ? [loggedIn, String(user.mid), `mid=${user.mid}`]
    : [anonymous, input.clientIp, `ip=${input.clientIp}`];
  const result = quota.tryConsume(key);
  if (!result.allowed) {
    logger.info(
      `[chat-quota] Quota exhausted for ${who}; rejecting the turn ` +
        `(retry_after=${result.retryAfterSeconds}s, max=${quota.maxPerWindow})`,
    );
    return {
      allowed: false,
      user,
      quota: result,
      response: chatQuotaExceededResponse(result, user.isLoggedIn),
    };
  }
  return { allowed: true, user, quota: result };
}
