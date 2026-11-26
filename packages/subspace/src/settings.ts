import { envStr, withoutTrailingSlashes } from "@eidolon/config";

export const DEFAULT_SUBSPACE_RELAY_URL = "https://eidolon-relay.vrp.moe";
export const DEFAULT_SUBSPACE_AUTH_URL = "https://id.laplace.live";

export function subspaceRelayUrl(): string {
  const configured = envStr("EIDOLON_SUBSPACE_RELAY_URL", DEFAULT_SUBSPACE_RELAY_URL).trim();
  return withoutTrailingSlashes(configured || DEFAULT_SUBSPACE_RELAY_URL);
}

export function subspaceAuthUrl(): string {
  const configured = envStr("EIDOLON_SUBSPACE_AUTH_URL", DEFAULT_SUBSPACE_AUTH_URL).trim();
  return withoutTrailingSlashes(configured || DEFAULT_SUBSPACE_AUTH_URL);
}

export function httpToWsUrl(baseUrl: string, pathname: string): string {
  const url = new URL(pathname, `${withoutTrailingSlashes(baseUrl)}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
