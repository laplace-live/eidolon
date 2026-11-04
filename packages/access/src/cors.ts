// Starlette's CORSMiddleware as the Pipecat runner configured it: the allowed origins (every
// origin when none are set), credentials on, every method and every header. Every response needs
// these headers, the 429 included: without them the browser's fetch fails with a network error,
// the client never sees the status, and it retries instead of showing the rate-limit toast.
import { envOptional, pyStrip } from "@eidolon/config";

/** `PIPECAT_ALLOWED_ORIGINS`; empty means every origin, mirrored with credentials. */
export interface CorsPolicy {
  readonly allowOrigins: readonly string[];
}

/** Starlette's ALL_METHODS: the preflight answer for `allow_methods=["*"]`. */
export const CORS_ALLOWED_METHODS: readonly string[] = Object.freeze([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "QUERY",
]);

const PREFLIGHT_VARY =
  "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, " +
  "Access-Control-Request-Private-Network";
const PREFLIGHT_MAX_AGE = "600";

/** Comma-separated, entries stripped, empties dropped; read on every call. */
export function corsPolicyFromEnv(): CorsPolicy {
  const origins = (envOptional("PIPECAT_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((origin) => pyStrip(origin))
    .filter((origin) => origin !== "");
  return Object.freeze({ allowOrigins: Object.freeze(origins) });
}

// The runner passes `origins or ["*"]`, and Starlette allows all as soon as "*" is listed.
function allowsEveryOrigin(policy: CorsPolicy): boolean {
  return policy.allowOrigins.length === 0 || policy.allowOrigins.includes("*");
}

// Exact and case-sensitive: https://LAPLACE.live is not https://laplace.live.
function isAllowedOrigin(policy: CorsPolicy, origin: string): boolean {
  return allowsEveryOrigin(policy) || policy.allowOrigins.includes(origin);
}

/**
 * The response to a CORS preflight (OPTIONS with Origin and Access-Control-Request-Method, on
 * any path), or null when `request` is not one.
 */
export function corsPreflightResponse(request: Request, policy: CorsPolicy): Response | null {
  const requested = request.headers;
  const origin = requested.get("origin");
  const method = requested.get("access-control-request-method");
  if (request.method !== "OPTIONS" || origin === null || method === null) return null;

  const headers = new Headers({
    vary: PREFLIGHT_VARY,
    "access-control-allow-methods": CORS_ALLOWED_METHODS.join(", "),
    "access-control-max-age": PREFLIGHT_MAX_AGE,
    "access-control-allow-credentials": "true",
    "content-type": "text/plain; charset=utf-8",
  });
  const failures: string[] = [];
  if (isAllowedOrigin(policy, origin)) headers.set("access-control-allow-origin", origin);
  else failures.push("origin");
  if (!CORS_ALLOWED_METHODS.includes(method)) failures.push("method");
  // Every header is allowed, so the requested ones are mirrored back verbatim.
  const requestedHeaders = requested.get("access-control-request-headers");
  if (requestedHeaders !== null) headers.set("access-control-allow-headers", requestedHeaders);
  if (requested.has("access-control-request-private-network")) failures.push("private-network");

  if (failures.length > 0) {
    return new Response(`Disallowed CORS ${failures.join(", ")}`, { status: 400, headers });
  }
  return new Response("OK", { status: 200, headers });
}

/** `response` with Starlette CORSMiddleware's headers for `request`, as a new Response. */
export function withCors(request: Request, response: Response, policy: CorsPolicy): Response {
  const origin = request.headers.get("origin");
  const headers = new Headers(response.headers);
  if (origin !== null) {
    headers.set("access-control-allow-credentials", "true");
    // Credentials rule out `*`, so an allowed origin is echoed back. A disallowed one gets no
    // Access-Control-Allow-Origin, and the response is still served: CORS never stops a request.
    if (isAllowedOrigin(policy, origin)) headers.set("access-control-allow-origin", origin);
  }
  const vary = headers.get("vary");
  headers.set("vary", vary === null ? "Origin" : `${vary}, Origin`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
