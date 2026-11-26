import { envStr, withoutTrailingSlashes } from "@eidolon/config";
import { isAllowedRelayUrl } from "./protocol/pairing.ts";

export const DEFAULT_SUBSPACE_RELAY_URL = "https://eidolon-relay.vrp.moe";
export const DEFAULT_SUBSPACE_AUTH_URL = "https://id.laplace.live";

function normalizeAllowedUrl(raw: string, fallback: string, label: string): string {
  const normalized = withoutTrailingSlashes(raw.trim() || fallback);
  if (!isAllowedRelayUrl(normalized)) {
    throw new Error(`${label} must use https/wss or loopback http/ws: ${normalized}`);
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

export function subspaceAuthUrl(): string {
  return normalizeAllowedUrl(
    envStr("EIDOLON_SUBSPACE_AUTH_URL", DEFAULT_SUBSPACE_AUTH_URL),
    DEFAULT_SUBSPACE_AUTH_URL,
    "Subspace Auth URL",
  );
}

export function httpToWsUrl(baseUrl: string, pathname: string): string {
  const normalized = normalizeAllowedUrl(baseUrl, baseUrl, "Subspace Relay URL");
  const url = new URL(pathname.replace(/^\/+/, ""), `${normalized}/`);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  return url.toString();
}
