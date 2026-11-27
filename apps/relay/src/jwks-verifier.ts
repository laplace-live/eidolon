import { createPublicKey, type JsonWebKey, type KeyObject, verify } from "node:crypto";
import { withoutTrailingSlashes } from "@eidolon/config";
import type { RelayConfig } from "./config.ts";

const CACHE_TTL_MS = 10 * 60_000;
const FETCH_RETRY_COOLDOWN_MS = 30_000;
const MAX_STALE_MS = 30 * 60_000;
const CLOCK_SKEW_SEC = 30;
const JWKS_TIMEOUT_MS = 5_000;

export interface VerifiedRelayCaller {
  readonly userId: string;
}

export class RelayJwksUnavailableError extends Error {
  override readonly name = "RelayJwksUnavailableError";

  constructor(message = "Relay JWKS temporarily unavailable") {
    super(message);
  }
}

export type RelayTokenVerifier = (
  authorizationHeader: string | undefined,
) => Promise<VerifiedRelayCaller | null>;

interface CachedKey {
  readonly kid: string | undefined;
  readonly alg: string | undefined;
  readonly kty: string;
  readonly publicKey: KeyObject;
}

interface JwkEntry extends JsonWebKey {
  readonly kid?: unknown;
  readonly alg?: unknown;
  readonly use?: unknown;
}

export interface RelayVerifierOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly maxStaleMs?: number;
}

export function readBearerToken(authorizationHeader: string | undefined): string | null {
  if (authorizationHeader === undefined) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorizationHeader.trim());
  return match?.[1] ?? null;
}

function decodeBase64UrlJson<T>(segment: string): T | null {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.some((entry) => entry === expected);
  return false;
}

function parseJwks(payload: unknown): CachedKey[] {
  const rawKeys = (payload as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(rawKeys)) return [];
  const out: CachedKey[] = [];
  for (const item of rawKeys) {
    if (item === null || typeof item !== "object") continue;
    const jwk = item as JwkEntry;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if (typeof jwk.kty !== "string") continue;
    try {
      const publicKey = createPublicKey({ key: jwk, format: "jwk" });
      out.push({
        kid: typeof jwk.kid === "string" && jwk.kid !== "" ? jwk.kid : undefined,
        alg: typeof jwk.alg === "string" && jwk.alg !== "" ? jwk.alg : undefined,
        kty: jwk.kty,
        publicKey,
      });
    } catch {
      // Skip unsupported JWKs rather than failing valid sibling keys.
    }
  }
  return out;
}

function verifySignature(
  alg: string,
  signingInput: Buffer,
  signature: Buffer,
  candidate: CachedKey,
): boolean {
  if (candidate.alg !== undefined && candidate.alg !== alg) return false;
  try {
    switch (alg) {
      case "EdDSA":
        return (
          candidate.kty === "OKP" && verify(null, signingInput, candidate.publicKey, signature)
        );
      case "ES256":
        return (
          candidate.kty === "EC" &&
          verify(
            "sha256",
            signingInput,
            { key: candidate.publicKey, dsaEncoding: "ieee-p1363" },
            signature,
          )
        );
      case "RS256":
        return (
          candidate.kty === "RSA" && verify("sha256", signingInput, candidate.publicKey, signature)
        );
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Verifies bearer JWTs locally against the auth server's JWKS with bounded stale-if-error
 * caching so short auth-server outages never interrupt relay connections.
 */
export function createRelayTokenVerifier(
  config: Pick<RelayConfig, "authIssuer" | "authAudience" | "jwksUrl">,
  options: RelayVerifierOptions = {},
): RelayTokenVerifier {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const maxStaleMs = options.maxStaleMs ?? MAX_STALE_MS;
  const expectedIssuer = withoutTrailingSlashes(config.authIssuer);

  let cache: { keys: CachedKey[]; fetchedAt: number } | null = null;
  let lastFetchAttemptAt = 0;
  let lastFailedAt: number | null = null;
  let inflightFetch: Promise<CachedKey[]> | null = null;

  async function refreshJwks(): Promise<CachedKey[]> {
    if (inflightFetch !== null) return inflightFetch;
    const attemptAt = now();
    lastFetchAttemptAt = attemptAt;
    const task = (async () => {
      try {
        const res = await fetchFn(config.jwksUrl, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
        const keys = parseJwks(await res.json());
        if (keys.length === 0) throw new Error("JWKS contained no usable signing keys");
        cache = { keys, fetchedAt: now() };
        lastFailedAt = null;
        return keys;
      } catch (error) {
        lastFailedAt = now();
        if (cache !== null && now() - cache.fetchedAt <= maxStaleMs) {
          return cache.keys;
        }
        throw error;
      } finally {
        inflightFetch = null;
      }
    })();
    inflightFetch = task;
    return task;
  }

  async function resolveKeys(kid: string | undefined): Promise<CachedKey[]> {
    const current = now();
    const fresh = cache !== null && current - cache.fetchedAt < CACHE_TTL_MS;
    const inBackoff = lastFailedAt !== null && current - lastFailedAt < FETCH_RETRY_COOLDOWN_MS;
    if (fresh) {
      const hasKid = kid === undefined || cache!.keys.some((k) => k.kid === kid);
      if (hasKid || current - lastFetchAttemptAt < FETCH_RETRY_COOLDOWN_MS) {
        return cache!.keys;
      }
    } else if (inBackoff) {
      if (cache !== null && current - cache.fetchedAt <= maxStaleMs) {
        return cache.keys;
      }
      throw new RelayJwksUnavailableError();
    }
    try {
      return await refreshJwks();
    } catch (error) {
      throw new RelayJwksUnavailableError(
        error instanceof Error ? error.message : "Relay JWKS temporarily unavailable",
      );
    }
  }

  return async (authorizationHeader) => {
    const token = readBearerToken(authorizationHeader);
    if (token === null) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;

    const header = decodeBase64UrlJson<{ alg?: unknown; kid?: unknown; typ?: unknown }>(parts[0]);
    const payload = decodeBase64UrlJson<{
      iss?: unknown;
      aud?: unknown;
      sub?: unknown;
      exp?: unknown;
      nbf?: unknown;
    }>(parts[1]);
    if (header === null || payload === null) return null;

    const alg = header.alg;
    if (alg !== "EdDSA" && alg !== "ES256" && alg !== "RS256") return null;
    if (typeof payload.iss !== "string" || withoutTrailingSlashes(payload.iss) !== expectedIssuer) {
      return null;
    }
    if (!audienceMatches(payload.aud, config.authAudience)) return null;
    if (typeof payload.sub !== "string" || payload.sub.trim() === "") return null;
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;

    const nowSec = now() / 1000;
    if (nowSec >= payload.exp + CLOCK_SKEW_SEC) return null;
    if (
      payload.nbf !== undefined &&
      (typeof payload.nbf !== "number" ||
        !Number.isFinite(payload.nbf) ||
        nowSec < payload.nbf - CLOCK_SKEW_SEC)
    ) {
      return null;
    }

    const kid = typeof header.kid === "string" && header.kid !== "" ? header.kid : undefined;
    const keys = await resolveKeys(kid);

    const matching = kid !== undefined ? keys.filter((k) => k.kid === kid) : keys;
    if (matching.length === 0) return null;

    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
    const signature = Buffer.from(parts[2], "base64url");
    for (const candidate of matching) {
      if (verifySignature(alg, signingInput, signature, candidate)) {
        return { userId: payload.sub };
      }
    }
    return null;
  };
}
