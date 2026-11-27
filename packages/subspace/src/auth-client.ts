import { abortableSleep, envOptional, errorText, withoutTrailingSlashes } from "@eidolon/config";
import { base64UrlToBytes, utf8Decode } from "./protocol/encoding.ts";
import { isAllowedAuthUrl } from "./protocol/pairing.ts";
import { DEFAULT_SUBSPACE_RELAY_URL, relayUrlToHttpUrl, subspaceAuthUrl } from "./settings.ts";

export const SUBSPACE_AUTH_CLIENT_ID = "eidolon-subspace";

export interface RelayUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly image?: string | null;
}

export interface DeviceAuthStart {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresAt: number;
  readonly intervalSec: number;
}

export type DeviceTokenPoll =
  | { readonly status: "approved"; readonly accessToken: string }
  | { readonly status: "pending" }
  | { readonly status: "slow_down" }
  | { readonly status: "denied" | "expired" | "error"; readonly message: string };

export class RelayAuthExpiredError extends Error {
  constructor(message = "LAPLACE account session expired; sign in again") {
    super(message);
    this.name = "RelayAuthExpiredError";
  }
}

export interface MintedRelayJwt {
  readonly token: string;
  readonly expiresAt: number;
}

function resolveAuthEndpoint(authUrl: string, pathname: string): string {
  const clean = withoutTrailingSlashes(authUrl.trim());
  if (!isAllowedAuthUrl(clean)) {
    throw new Error(`Subspace Auth URL must use https or loopback http: ${clean}`);
  }
  return new URL(pathname, `${clean}/`).toString();
}

function decodeJwtExpiryMs(jwt: string): number {
  const fallback = Date.now() + 10 * 60_000;
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) return fallback;
  try {
    const payload = JSON.parse(utf8Decode(base64UrlToBytes(parts[1]))) as { exp?: unknown };
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
      return payload.exp * 1000;
    }
  } catch {
    // Ignore malformed payload; caller falls back to conservative 10m TTL.
  }
  return fallback;
}

/**
 * Resolves which auth server URL to authenticate against: uses `EIDOLON_SUBSPACE_AUTH_URL` when
 * explicitly set, else probes a custom Relay's `/healthz` for its advertised `auth.issuer`,
 * falling back to `https://id.laplace.live`.
 */
export async function discoverRelayAuthUrl(
  relayUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  if (envOptional("EIDOLON_SUBSPACE_AUTH_URL") !== undefined) {
    return subspaceAuthUrl();
  }
  const httpRelay = relayUrlToHttpUrl(relayUrl);
  if (httpRelay !== DEFAULT_SUBSPACE_RELAY_URL) {
    try {
      const timeout = AbortSignal.timeout(2_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const res = await fetch(`${httpRelay}/healthz`, { signal: combined });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as {
          auth?: { issuer?: unknown };
        } | null;
        const issuer = body?.auth?.issuer;
        if (typeof issuer === "string") {
          try {
            const parsed = new URL(issuer);
            if (isAllowedAuthUrl(parsed.toString())) {
              return withoutTrailingSlashes(parsed.toString());
            }
          } catch {
            // Malformed issuer URL; fall back to default auth server URL.
          }
        }
      }
    } catch {
      // Unreachable relay or offline; fall back to default auth server URL.
    }
  }
  return subspaceAuthUrl();
}

export async function startDeviceAuthorization(
  authUrl: string,
  signal?: AbortSignal,
): Promise<DeviceAuthStart> {
  const endpoint = resolveAuthEndpoint(authUrl, "/api/auth/device/code");
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: SUBSPACE_AUTH_CLIENT_ID }),
      signal,
    });
  } catch (error) {
    throw new Error(`Could not reach auth server at ${authUrl}: ${errorText(error)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Device authorization failed (${response.status}): ${text}`);
  }
  const data = JSON.parse(text) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  if (typeof data.device_code !== "string" || typeof data.user_code !== "string") {
    throw new Error("Auth server returned an incomplete device authorization payload");
  }
  const base = `${withoutTrailingSlashes(authUrl)}/`;
  const verificationUri = new URL(data.verification_uri ?? "/device", base).toString();
  const verificationUriComplete = new URL(
    data.verification_uri_complete ??
      `${verificationUri}?user_code=${encodeURIComponent(data.user_code)}`,
    base,
  ).toString();
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri,
    verificationUriComplete,
    expiresAt: Date.now() + (data.expires_in ?? 600) * 1000,
    intervalSec: Math.max(2, data.interval ?? 5),
  };
}

export async function pollDeviceToken(
  authUrl: string,
  deviceCode: string,
  signal?: AbortSignal,
): Promise<DeviceTokenPoll> {
  const endpoint = resolveAuthEndpoint(authUrl, "/api/auth/device/token");
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: SUBSPACE_AUTH_CLIENT_ID,
      }),
      signal,
    });
  } catch {
    if (signal?.aborted) {
      return { status: "error", message: "Sign-in cancelled" };
    }
    return { status: "pending" };
  }
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (response.ok && typeof body.access_token === "string") {
    return { status: "approved", accessToken: body.access_token };
  }
  switch (body.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "access_denied":
      return { status: "denied", message: body.error_description ?? "Sign-in was denied" };
    case "expired_token":
      return { status: "expired", message: body.error_description ?? "Verification code expired" };
    default:
      return {
        status: "error",
        message: body.error_description ?? body.error ?? `HTTP ${response.status}`,
      };
  }
}

export async function fetchRelaySession(
  authUrl: string,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<RelayUser | null> {
  const endpoint = resolveAuthEndpoint(authUrl, "/api/auth/get-session");
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${sessionToken}` },
    signal,
  });
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as {
    user?: { id?: unknown; name?: unknown; email?: unknown; image?: unknown };
  } | null;
  const user = body?.user;
  if (typeof user?.id !== "string") return null;
  return {
    id: user.id,
    name:
      typeof user.name === "string" && user.name
        ? user.name
        : typeof user.email === "string"
          ? user.email
          : "User",
    email: typeof user.email === "string" ? user.email : "",
    image: typeof user.image === "string" ? user.image : null,
  };
}

/** Exchanges a long-lived Better Auth session token at `/api/auth/token` for a short-lived JWT. */
export async function mintRelayJwt(
  authUrl: string,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<MintedRelayJwt> {
  const endpoint = resolveAuthEndpoint(authUrl, "/api/auth/token");
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${sessionToken}` },
    signal,
  });
  const isAntiBotHtml403 =
    response.status === 403 &&
    (response.headers.get("cf-mitigated") !== null ||
      (response.headers.get("content-type") ?? "").toLowerCase().includes("text/html"));
  if (response.status === 401 || (response.status === 403 && !isAntiBotHtml403)) {
    throw new RelayAuthExpiredError();
  }
  if (!response.ok) {
    throw new Error(`Could not mint relay JWT (${response.status})`);
  }
  const body = (await response.json().catch(() => null)) as { token?: unknown } | null;
  if (typeof body?.token !== "string" || body.token === "") {
    throw new Error("Auth server returned no JWT token");
  }
  return {
    token: body.token,
    expiresAt: decodeJwtExpiryMs(body.token),
  };
}

export type DeviceAuthorizationCompletion =
  | { readonly status: "approved"; readonly accessToken: string; readonly user: RelayUser }
  | { readonly status: "aborted" }
  | { readonly status: "expired" }
  | { readonly status: "profile-failed" }
  | { readonly status: "error"; readonly message: string };

/** Polls RFC 8628 `/api/auth/device/token` with `slow_down` backoff and fetches the Relay user profile. */
export async function completeDeviceAuthorization(input: {
  readonly authUrl: string;
  readonly deviceCode: string;
  readonly intervalSec: number;
  readonly expiresAt: number;
  readonly signal?: AbortSignal;
}): Promise<DeviceAuthorizationCompletion> {
  let waitMs = input.intervalSec * 1000;
  while (!input.signal?.aborted && Date.now() < input.expiresAt) {
    try {
      await abortableSleep(waitMs, input.signal);
    } catch {
      return { status: "aborted" };
    }
    if (input.signal?.aborted) return { status: "aborted" };
    const poll = await pollDeviceToken(input.authUrl, input.deviceCode, input.signal);
    if (input.signal?.aborted) return { status: "aborted" };
    if (poll.status === "pending") continue;
    if (poll.status === "slow_down") {
      waitMs += 5_000;
      continue;
    }
    if (poll.status === "approved") {
      const user = await fetchRelaySession(input.authUrl, poll.accessToken, input.signal).catch(
        () => null,
      );
      if (user === null) return { status: "profile-failed" };
      return { status: "approved", accessToken: poll.accessToken, user };
    }
    const fallback =
      poll.status === "denied"
        ? "Sign-in was denied"
        : poll.status === "expired"
          ? "Verification code expired"
          : "Relay sign-in failed";
    return { status: "error", message: poll.message || fallback };
  }
  return input.signal?.aborted ? { status: "aborted" } : { status: "expired" };
}

export async function signOutRelaySession(authUrl: string, sessionToken: string): Promise<void> {
  const endpoint = resolveAuthEndpoint(authUrl, "/api/auth/sign-out");
  await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}
