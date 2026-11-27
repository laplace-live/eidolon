import { envOptional, envStr, withoutTrailingSlashes } from "@eidolon/config";
import { isAllowedAuthUrl, isAllowedRelayUrl } from "./protocol/pairing.ts";

export const DEFAULT_SUBSPACE_RELAY_URL = "https://eidolon-relay.vrp.moe";
export const DEFAULT_SUBSPACE_AUTH_URL = "https://id.laplace.live";

function normalizeAllowedUrl(
  raw: string,
  fallback: string,
  label: string,
  kind: "relay" | "auth" = "relay",
): string {
  const normalized = withoutTrailingSlashes(raw.trim() || fallback);
  const allowed = kind === "auth" ? isAllowedAuthUrl(normalized) : isAllowedRelayUrl(normalized);
  if (!allowed) {
    throw new Error(
      kind === "auth"
        ? `${label} must use https or loopback http: ${normalized}`
        : `${label} must use https/wss or loopback http/ws: ${normalized}`,
    );
  }
  return normalized;
}

export function subspaceRelayUrl(): string {
  return normalizeAllowedUrl(
    envStr("EIDOLON_SUBSPACE_RELAY_URL", DEFAULT_SUBSPACE_RELAY_URL),
    DEFAULT_SUBSPACE_RELAY_URL,
    "Subspace Relay URL",
  );
}

/**
 * Resolves the active Relay URL: honors `EIDOLON_SUBSPACE_RELAY_URL` when explicitly configured,
 * else reuses a signed-in account's `savedRelayUrl` (set by `eidolon subspace login --relay-url`),
 * else falls back to the default Relay URL.
 */
export function resolveEffectiveRelayUrl(
  savedRelayUrl?: string | null | (() => string | null),
): string {
  if (envOptional("EIDOLON_SUBSPACE_RELAY_URL") !== undefined) {
    return subspaceRelayUrl();
  }
  const resolved = typeof savedRelayUrl === "function" ? savedRelayUrl() : savedRelayUrl;
  const saved = resolved?.trim();
  if (saved) {
    return normalizeAllowedUrl(saved, DEFAULT_SUBSPACE_RELAY_URL, "Subspace Relay URL");
  }
  return subspaceRelayUrl();
}

export function subspaceAuthUrl(): string {
  return normalizeAllowedUrl(
    envStr("EIDOLON_SUBSPACE_AUTH_URL", DEFAULT_SUBSPACE_AUTH_URL),
    DEFAULT_SUBSPACE_AUTH_URL,
    "Subspace Auth URL",
    "auth",
  );
}

export function relayUrlToHttpUrl(baseUrl: string): string {
  const normalized = normalizeAllowedUrl(baseUrl, baseUrl, "Subspace Relay URL");
  const url = new URL(normalized);
  if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol === "ws:") url.protocol = "http:";
  return withoutTrailingSlashes(url.toString());
}

export function httpToWsUrl(baseUrl: string, pathname: string): string {
  const normalized = normalizeAllowedUrl(baseUrl, baseUrl, "Subspace Relay URL");
  const url = new URL(pathname.replace(/^\/+/, ""), `${normalized}/`);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  return url.toString();
}
