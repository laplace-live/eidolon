// The local API under /api/local. A single Bun wildcard route hands every request here, so no
// exact route can fall through to the bot's fallback and its allow-every-origin preflight answer;
// the 404 and 405 are this router's own. Each route runs one pipeline: the session check, the
// idle-timeout opt-out, a logged 500, no-store, and the access line.
import type { MemoryAdmin } from "@eidolon/memory";
import type { BunRequest } from "bun";
import { logAccess, type RouteHandler, type RouteServer } from "../app.ts";
import type { LocalRoute } from "./api.ts";
import { internalError, localError, NO_STORE } from "./responses.ts";

export const LOCAL_PREFIX = "/api/local";

/** Who is calling: a browser with the session cookie, or a holder of the secret. */
export type Caller = "cookie" | "bearer";

/**
 * What a request proves: the secret as a Bearer token, the session cookie with the proof header
 * the app's pages send, or the cookie alone, which a service on another localhost port receives
 * too, since cookies ignore ports.
 */
export type Auth = "bearer" | "session" | "cookie" | null;
export type Authenticate = (request: Request) => Auth;

/** What a route module gets from the server it serves. */
export interface LocalApp {
  /** The bound port; read it while serving, not while building routes. */
  port(): number;
  activeCalls(): number;
  /** Stops the server shortly after the current response, and asks the supervisor for a new one. */
  restart(): void;
  /** Runs when the server stops, before the peers disconnect. */
  onStop(hook: () => Promise<void>): void;
  /** Mem0's admin, built per call so saved Qdrant settings apply at once; null while memory is off. */
  memoryAdmin(): MemoryAdmin | null;
}

export interface LocalRequestContext {
  readonly url: URL;
  /** Percent-decoded path segments by name; validate each before it touches the disk. */
  readonly params: Readonly<Record<string, string>>;
  readonly server: RouteServer;
  /** Null only on a public route. */
  readonly caller: Caller | null;
}

export type LocalHandler = (
  request: Request,
  context: LocalRequestContext,
) => Response | Promise<Response>;

export interface LocalRouteSpec {
  readonly route: LocalRoute;
  readonly handler: LocalHandler;
  /** Served without a session; the handler checks `caller` itself where it matters. */
  readonly public?: boolean;
  /** A picture the app shows as an <img>, which can't send the proof: the cookie alone reads it. */
  readonly image?: boolean;
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

function withNoStore(response: Response): Response {
  try {
    response.headers.set("cache-control", NO_STORE);
    return response;
  } catch {
    // A response another fetch produced has immutable headers.
    const copy = new Response(response.body, response);
    copy.headers.set("cache-control", NO_STORE);
    return copy;
  }
}

function finish(request: Request, server: RouteServer, response: Response): Response {
  const sent = withNoStore(response);
  logAccess(request, server, sent);
  return sent;
}

/** The 401 for a request without a session; a cookie that came without its proof says so. */
export function unauthenticated(auth: Auth): Response {
  if (auth === "cookie") {
    return localError(
      401,
      "proof-missing",
      "The session cookie came without the page's proof; open the link Eidolon printed",
    );
  }
  return localError(401, "unauthorized", "Open the link Eidolon printed in the terminal");
}

/** Who `auth` lets in: the cookie alone only to a picture. */
function callerOf(auth: Auth, image: boolean): Caller | null {
  if (auth === "bearer") return "bearer";
  return auth === "session" || (auth === "cookie" && image) ? "cookie" : null;
}

async function respond(
  request: Request,
  server: RouteServer,
  route: Pick<LocalRouteSpec, "handler" | "public" | "image">,
  params: Readonly<Record<string, string>>,
  authenticate: Authenticate,
): Promise<Response> {
  const auth = authenticate(request);
  const caller = callerOf(auth, route.image === true);
  if (!route.public) {
    if (caller === null) return unauthenticated(auth);
    // The cookie rides along on any request the browser sends; Origin shows the app sent it.
    if (
      caller === "cookie" &&
      !SAFE_METHODS.has(request.method) &&
      !request.headers.has("origin")
    ) {
      return localError(403, "forbidden", "A change needs the Origin header the app's pages send");
    }
  }
  try {
    return await route.handler(request, { url: new URL(request.url), params, server, caller });
  } catch (error) {
    return internalError(request, error);
  }
}

/**
 * One route at a fixed path outside /api/local (the /api/offer and /api/memories overrides),
 * through the same pipeline. HEAD on a GET route is a 405, as the bot's own routes answer it.
 */
export function localRoute(
  method: "GET" | "POST",
  handler: LocalHandler,
  authenticate: Authenticate,
): RouteHandler {
  return async (request: BunRequest, server: RouteServer) => {
    if (request.method !== method) {
      const refused = localError(405, "method-not-allowed", `Use ${method}`, { allow: method });
      return finish(request, server, refused);
    }
    server.timeout(request, 0);
    return finish(request, server, await respond(request, server, { handler }, {}, authenticate));
  };
}

interface CompiledRoute extends LocalRouteSpec {
  readonly method: string;
  readonly pattern: readonly string[];
  readonly literals: number;
}

function compile(spec: LocalRouteSpec): CompiledRoute {
  const [method, path] = spec.route.split(" ") as [string, string];
  const pattern = path.split("/");
  return { ...spec, method, pattern, literals: pattern.filter((s) => !s.startsWith(":")).length };
}

function match(
  pattern: readonly string[],
  segments: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [i, want] of pattern.entries()) {
    const got = segments[i] as string;
    if (want.startsWith(":")) {
      if (got === "") return null;
      params[want.slice(1)] = got;
    } else if (want !== got) {
      return null;
    }
  }
  return params;
}

function decodeParams(raw: Record<string, string>): Record<string, string> | null {
  const params: Record<string, string> = {};
  try {
    for (const [name, value] of Object.entries(raw)) params[name] = decodeURIComponent(value);
  } catch {
    return null;
  }
  return params;
}

/** The handler for Bun's `/api/local/*` route. Routes with literal segments beat parameters. */
export function createLocalRouter(
  specs: readonly LocalRouteSpec[],
  authenticate: Authenticate,
): RouteHandler {
  const table = specs.map(compile);
  const seen = new Set<string>();
  for (const route of table) {
    if (seen.has(route.route)) throw new Error(`${route.route} is registered twice`);
    seen.add(route.route);
  }
  return async (request: BunRequest, server: RouteServer) => {
    // Job events stream for as long as a job runs; Bun would cut them after 10 s of quiet.
    server.timeout(request, 0);
    // Bun matches the wildcard on the raw path, which `..` segments can lead out of /api/local.
    const segments = new URL(request.url).pathname.split("/");
    const candidates = table
      .map((route) => ({ route, raw: match(route.pattern, segments) }))
      .filter((found): found is { route: CompiledRoute; raw: Record<string, string> } => {
        return found.raw !== null;
      });
    if (candidates.length === 0) {
      return finish(request, server, localError(404, "not-found", "No such API route"));
    }
    const chosen = candidates
      .filter(({ route }) => route.method === request.method)
      .sort((a, b) => b.route.literals - a.route.literals)[0];
    if (chosen === undefined) {
      const allow = [...new Set(candidates.map(({ route }) => route.method))].join(", ");
      const refused = localError(405, "method-not-allowed", `Use ${allow}`, { allow });
      return finish(request, server, refused);
    }
    const params = decodeParams(chosen.raw);
    if (params === null) {
      return finish(request, server, localError(400, "bad-request", "A path segment is malformed"));
    }
    return finish(
      request,
      server,
      await respond(request, server, chosen.route, params, authenticate),
    );
  };
}
