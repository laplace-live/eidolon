// The HTTP surface of the bot for one Bun.serve: every route runs the same wrapper (CORS preflight,
// HEAD rule, idle-timeout opt-out, logged 500, CORS), and everything else gets FastAPI's 404 and
// 405 bodies.
import { STATUS_CODES } from "node:http";
import {
  type CorsPolicy,
  type LoggedInUser,
  OFFER_PATH,
  type OfferAdmission,
  type OfferInput,
  PREFLIGHT_PATH,
} from "@eidolon/access";
import { logger } from "@eidolon/config";
import { SELFIE_PATH } from "@eidolon/imagegen";
import type { MemoryAdmin } from "@eidolon/memory";
import type { SignallingResult, SignallingServer } from "@eidolon/runtime";
import type { IceService } from "@eidolon/turn";
import type { BunRequest, Server } from "bun";
import type { ChatEndpoint } from "./chat/routes.ts";
import type { McpHandler } from "./mcp/index.ts";
import {
  FORGET_MEMORIES_PATH,
  forgetMemories,
  LIST_MEMORIES_PATH,
  listMemories,
  type MemoryRouteParts,
} from "./memory-admin.ts";
import {
  internalServerError,
  jsonResponse,
  methodNotAllowed,
  notFound,
  plainText,
} from "./responses.ts";

export type RouteServer = Pick<Server<undefined>, "requestIP" | "timeout">;
export type RouteHandler = (request: BunRequest, server: RouteServer) => Promise<Response>;
export type RouteMethod = "GET" | "POST" | "PATCH";
export type MethodRoutes = Partial<Record<RouteMethod, RouteHandler>>;

/** The `@eidolon/access` functions the routes call; the module itself in production. */
export interface BotAccess {
  admitOffer(input: OfferInput): Promise<OfferAdmission>;
  preflightOffer(input: OfferInput): Promise<Response>;
  resolveBearerCaller(authorization: string | null): Promise<LoggedInUser | null>;
  resolveClientIp(headers: Headers, peerAddress: string | null | undefined): string;
  corsPreflightResponse(request: Request, policy: CorsPolicy): Response | null;
  withCors(request: Request, response: Response, policy: CorsPolicy): Response;
}

export interface BotAppParts {
  readonly access: BotAccess;
  readonly cors: CorsPolicy;
  /** The process's one IceService; the signalling server shares it. */
  readonly ice: Pick<IceService, "browserPayload">;
  readonly signalling: Pick<SignallingServer, "offer" | "patch">;
  /** null when memory is not configured. */
  readonly memoryAdmin: MemoryAdmin | null;
  readonly selfieResponse: (segment: string) => Response;
  readonly mcp: Pick<McpHandler, "handle">;
  /** The chat endpoint; without it, its paths are unknown routes and every offer is unbound. */
  readonly chat?: ChatEndpoint | null;
}

export interface BotApp {
  /** For `Bun.serve({ routes })`; every handler is wrapped. */
  readonly routes: Record<string, RouteHandler | MethodRoutes>;
  /** For `Bun.serve({ fetch })`: CORS preflights, demo-path 404s, then 405 or 404. */
  readonly fallback: (request: Request, server?: RouteServer) => Response;
  /** For `Bun.serve({ error })`, a last resort only: Bun passes no request, so no CORS. */
  readonly onError: (error: Error) => Response;
}

/** Pipecat's prebuilt demo UI paths, which the bot never serves. */
export function isDemoPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/client" || pathname.startsWith("/client/");
}

function routeMatches(pattern: string, pathname: string): boolean {
  const want = pattern.split("/");
  const got = pathname.split("/");
  return (
    want.length === got.length &&
    want.every((segment, i) => (segment.startsWith(":") ? got[i] !== "" : segment === got[i]))
  );
}

function signallingResponse(result: SignallingResult): Response {
  return jsonResponse(result.status, result.body);
}

/** An access line in uvicorn's format, for every request. */
export function logAccess(
  request: Request,
  server: RouteServer | undefined,
  response: Response,
): void {
  const peer = server?.requestIP(request);
  const url = new URL(request.url);
  const client = peer ? `${peer.address}:${peer.port}` : "-";
  const status = `${response.status} ${STATUS_CODES[response.status] ?? ""}`.trimEnd();
  logger.info(`${client} - "${request.method} ${url.pathname}${url.search} HTTP/1.1" ${status}`);
}

export function createBotApp(parts: BotAppParts): BotApp {
  const { access, cors } = parts;
  const clientIp = (request: Request, server: RouteServer): string =>
    access.resolveClientIp(request.headers, server.requestIP(request)?.address);
  const memoryParts: MemoryRouteParts = {
    resolveBearerCaller: (authorization) => access.resolveBearerCaller(authorization),
    admin: parts.memoryAdmin,
  };

  const respond = async (
    handler: RouteHandler,
    getOnly: boolean,
    request: BunRequest,
    server: RouteServer,
  ): Promise<Response> => {
    // Bun hands OPTIONS to function-valued routes (/mcp) instead of falling through to fetch.
    const preflight = access.corsPreflightResponse(request, cors);
    if (preflight) return preflight;
    // Bun runs a GET handler for HEAD, which would mint TURN credentials or scroll Qdrant;
    // FastAPI's GET routes answer HEAD with a 405.
    if (getOnly && request.method === "HEAD") {
      return access.withCors(request, methodNotAllowed("GET"), cors);
    }
    // Bun.serve cuts a request whose handler has written nothing for idleTimeout (default 10 s;
    // a 40 s handler got an empty reply at about 12 s). An offer can wait on a 10 s TURN mint
    // plus a 10 s Workers validation.
    server.timeout(request, 0);
    let response: Response;
    try {
      response = await handler(request, server);
    } catch (error) {
      logger.exception(`${request.method} ${new URL(request.url).pathname} failed`, error);
      response = internalServerError();
    }
    return access.withCors(request, response, cors);
  };

  const wrap =
    (handler: RouteHandler, getOnly: boolean): RouteHandler =>
    async (request, server) => {
      const response = await respond(handler, getOnly, request, server);
      logAccess(request, server, response);
      return response;
    };

  const offer: RouteHandler = async (request, server) => {
    const bodyText = await request.text();
    const admission = await access.admitOffer({ bodyText, clientIp: clientIp(request, server) });
    if (!admission.allowed) return admission.response;
    const call = parts.chat ? await parts.chat.bindCall(admission) : null;
    if (call === null) return signallingResponse(await parts.signalling.offer(admission));
    if (call instanceof Response) return call;
    return signallingResponse(await parts.signalling.offer(call.admission, call.binding));
  };

  const methodRoutes: Record<string, MethodRoutes> = {
    "/api/ice-servers": {
      GET: async () => jsonResponse(200, await parts.ice.browserPayload()),
    },
    // Starlette's 405 names only the first route registered for a path, and the runner registers
    // POST /api/offer before PATCH, so keep POST first: the Allow header is taken from it.
    [OFFER_PATH]: {
      POST: offer,
      PATCH: async (request) =>
        signallingResponse(await parts.signalling.patch(await request.text())),
    },
    [PREFLIGHT_PATH]: {
      POST: async (request, server) =>
        access.preflightOffer({
          bodyText: await request.text(),
          clientIp: clientIp(request, server),
        }),
    },
    [LIST_MEMORIES_PATH]: { GET: (request) => listMemories(request, memoryParts) },
    [FORGET_MEMORIES_PATH]: { POST: (request) => forgetMemories(request, memoryParts) },
    [`${SELFIE_PATH}/:id`]: { GET: async (request) => parts.selfieResponse(request.params.id) },
    ...parts.chat?.routes(clientIp),
  };

  const routes: Record<string, RouteHandler | MethodRoutes> = {};
  for (const [path, methods] of Object.entries(methodRoutes)) {
    const wrapped: MethodRoutes = {};
    for (const [method, handler] of Object.entries(methods) as [RouteMethod, RouteHandler][]) {
      wrapped[method] = wrap(handler, method === "GET");
    }
    routes[path] = wrapped;
  }
  const mcp = wrap(
    (request, server) => parts.mcp.handle(request, clientIp(request, server)),
    false,
  );
  routes["/mcp"] = mcp;
  routes["/mcp/"] = mcp;

  const allowed = Object.entries(methodRoutes).map(([path, methods]) => ({
    path,
    allow: Object.keys(methods)[0] as string,
  }));

  const unrouted = (pathname: string): Response => {
    if (isDemoPath(pathname)) return new Response(null, { status: 404 });
    // Every path under /mcp/ gets the plain-text 404 a mounted Starlette router sends.
    if (pathname.startsWith("/mcp/")) return plainText(404, "Not Found");
    const route = allowed.find(({ path }) => routeMatches(path, pathname));
    return route ? methodNotAllowed(route.allow) : notFound();
  };

  return {
    routes,
    fallback: (request, server) => {
      const response =
        access.corsPreflightResponse(request, cors) ??
        access.withCors(request, unrouted(new URL(request.url).pathname), cors);
      logAccess(request, server, response);
      return response;
    },
    onError: (error) => {
      logger.exception("Unhandled error while serving a request", error);
      return internalServerError();
    },
  };
}
