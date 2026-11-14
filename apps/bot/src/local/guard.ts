// Every request to the local server passes here before any route runs. A session can run code as
// the user (a path setting, a provider's base URL), so these checks are the boundary: only this
// computer, only under a loopback Host (no DNS rebinding), and, for the API, only the app's own
// pages, since every localhost port is same-site and SameSite cookies don't tell them apart. The
// one way in for another page is an origin EIDOLON_LOCAL_ALLOWED_ORIGINS lists, and only to the
// bot's API, never to /api/local.
import { corsPreflightResponse } from "@eidolon/access";
import { logger } from "@eidolon/config";
import { SELFIE_PATH } from "@eidolon/imagegen";
import { logAccess, type RouteServer } from "../app.ts";
import { localError } from "./responses.ts";
import { LOCAL_PREFIX } from "./router.ts";

/** Host names that can only mean this computer; the bound IP literals join them. */
const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "[::1]"];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// How the URL parser writes an IPv4-mapped 127.0.0.0/8 address.
const MAPPED_LOOPBACK = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/;

function isLoopbackV4(address: string): boolean {
  const octets = IPV4.exec(address)?.slice(1).map(Number);
  return octets !== undefined && octets[0] === 127 && octets.every((octet) => octet <= 255);
}

/** 127.0.0.0/8 or ::1, plain, bracketed or IPv4-mapped (`::ffff:127.0.0.1`). */
export function isLoopbackAddress(address: string): boolean {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const mapped = /^::ffff:(.+)$/i.exec(bare)?.[1];
  if (isLoopbackV4(mapped ?? bare)) return true;
  if (!bare.includes(":")) return false;
  try {
    const host = new URL(`http://[${bare}]/`).hostname;
    return host === "[::1]" || MAPPED_LOOPBACK.test(host);
  } catch {
    return false;
  }
}

/** Every Host header the server answers: a loopback name with the bound port. */
export function allowedHosts(port: number, boundLiterals: readonly string[] = []): Set<string> {
  const names = [...new Set([...LOOPBACK_NAMES, ...boundLiterals])];
  const hosts = new Set(names.map((name) => `${name}:${port}`));
  // A browser leaves the default port out of Host.
  if (port === 80) for (const name of names) hosts.add(name);
  return hosts;
}

/** Paths the bot's own API owns; everything else is the web app's. */
export function isApiPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/")
  );
}

const SAME_ORIGIN_FETCH = new Set(["same-origin", "none"]);

const NO_ORIGINS: ReadonlySet<string> = new Set();

export interface ListedOrigins {
  readonly origins: ReadonlySet<string>;
  /** Entries that name no http(s) origin, such as `null` or `localhost:3000`. */
  readonly rejected: readonly string[];
}

/** EIDOLON_LOCAL_ALLOWED_ORIGINS: comma-separated, each entry reduced to its URL's origin. */
export function parseListedOrigins(value: string | undefined): ListedOrigins {
  const origins = new Set<string>();
  const rejected: string[] = [];
  for (const entry of (value ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const url = URL.parse(trimmed);
    if (url?.protocol === "http:" || url?.protocol === "https:") origins.add(url.origin);
    else rejected.push(trimmed);
  }
  return { origins, rejected };
}

function isLocalApiPath(pathname: string): boolean {
  return pathname === LOCAL_PREFIX || pathname.startsWith(`${LOCAL_PREFIX}/`);
}

/**
 * The listed origin of a request to the bot's API, or null: the app's own pages stay the local
 * viewer's even when their origin is listed. Call it only once Host has passed.
 */
export function listedOrigin(request: Request, listed: ReadonlySet<string>): string | null {
  const origin = request.headers.get("origin");
  if (origin === null || !listed.has(origin)) return null;
  if (origin === `http://${request.headers.get("host")?.toLowerCase()}`) return null;
  const { pathname } = new URL(request.url);
  return isApiPath(pathname) && !isLocalApiPath(pathname) ? origin : null;
}

/**
 * The guard's own answer: a refusal, or a listed origin's preflight; null lets the routes answer.
 * The order matters: the URL is parsed only once Host has passed, because without one Bun's
 * request.url is not absolute.
 */
export function guardRequest(
  request: Request,
  server: RouteServer | undefined,
  hosts: ReadonlySet<string>,
  listed: ReadonlySet<string> = NO_ORIGINS,
): Response | null {
  // The socket peer itself: EIDOLON_REAL_IP_HEADER names a header any client can forge.
  const peer = server?.requestIP(request)?.address;
  if (!peer || !isLoopbackAddress(peer)) {
    return localError(403, "forbidden", "Only this computer may use Eidolon's local server");
  }
  const host = request.headers.get("host")?.toLowerCase();
  if (!host || !hosts.has(host)) {
    return localError(421, "misdirected", "Open Eidolon through localhost or 127.0.0.1");
  }
  const crossOrigin = listedOrigin(request, listed);
  // Bun hands a preflight to a function route or the fallback, both guarded, so it is answered
  // here or nowhere: the bot's own answer would allow every origin.
  if (request.method === "OPTIONS") {
    const preflight =
      crossOrigin === null ? null : corsPreflightResponse(request, { allowOrigins: [crossOrigin] });
    return (
      preflight ??
      localError(
        405,
        "method-not-allowed",
        "Eidolon's local server takes cross-origin calls only from EIDOLON_LOCAL_ALLOWED_ORIGINS",
      )
    );
  }
  const { pathname } = new URL(request.url);
  if (!isApiPath(pathname) || crossOrigin !== null) return null;
  const origin = request.headers.get("origin");
  if (origin !== null && origin.toLowerCase() !== `http://${host}`) {
    const who = isLocalApiPath(pathname)
      ? "Eidolon's own pages"
      : "Eidolon's own pages and EIDOLON_LOCAL_ALLOWED_ORIGINS";
    return localError(403, "forbidden", `Only ${who} may call its API`);
  }
  // A listed origin's page shows a selfie as an <img>, which sends no Origin; its id is its key.
  const selfie =
    listed.size > 0 &&
    (request.method === "GET" || request.method === "HEAD") &&
    pathname.startsWith(`${SELFIE_PATH}/`);
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && !SAME_ORIGIN_FETCH.has(site.toLowerCase()) && !selfie) {
    return localError(403, "forbidden", "Only Eidolon's own pages may call its API");
  }
  return null;
}

/** The access line for a refused request, which may lack the Host its URL needs. */
export function logRefused(
  request: Request,
  server: RouteServer | undefined,
  response: Response,
): void {
  try {
    logAccess(request, server, response);
  } catch {
    logger.info(`- - "${request.method} - HTTP/1.1" ${response.status}`);
  }
}
