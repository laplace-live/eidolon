// Every request to the local server passes here before any route runs. A session can run code as
// the user (a path setting, a provider's base URL), so these checks are the boundary: only this
// computer, only under a loopback Host (no DNS rebinding), and, for the API, only the app's own
// pages, since every localhost port is same-site and SameSite cookies don't tell them apart.
import { logger } from "@eidolon/config";
import { logAccess, type RouteServer } from "../app.ts";
import { localError } from "./responses.ts";

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

/**
 * The refusal for a request the local server must not serve, or null. The order matters: the URL
 * is parsed only once Host has passed, because without one Bun's request.url is not absolute.
 */
export function guardRequest(
  request: Request,
  server: RouteServer | undefined,
  hosts: ReadonlySet<string>,
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
  // A CORS preflight would be answered by the bot's allow-every-origin policy.
  if (request.method === "OPTIONS") {
    return localError(
      405,
      "method-not-allowed",
      "Eidolon's local server takes no cross-origin calls",
    );
  }
  if (!isApiPath(new URL(request.url).pathname)) return null;
  const origin = request.headers.get("origin");
  if (origin !== null && origin.toLowerCase() !== `http://${host}`) {
    return localError(403, "forbidden", "Only Eidolon's own pages may call its API");
  }
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && !SAME_ORIGIN_FETCH.has(site.toLowerCase())) {
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
