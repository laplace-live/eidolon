// Bun.serve's routing, which the app was written against, served through srvx: node:http under
// Node, Bun.serve under Bun.
import { type ServerRequest, serve } from "srvx";

export interface PeerAddress {
  readonly address: string;
  readonly port: number;
}
export interface RouteServer {
  requestIP(request: Request): PeerAddress | null;
}
export type RouteRequest = Request & { readonly params: Readonly<Record<string, string>> };
export type RouteHandler = (request: RouteRequest, server: RouteServer) => Promise<Response>;
export type RouteMethod = "GET" | "POST" | "PATCH";
export type MethodRoutes = Partial<Record<RouteMethod, RouteHandler>>;
export type Routes = Readonly<Record<string, RouteHandler | MethodRoutes>>;
export type Fallback = (request: Request, server?: RouteServer) => Response | Promise<Response>;

type Route = RouteHandler | MethodRoutes;

interface ParamRoute {
  readonly pattern: readonly string[];
  readonly literals: number;
  readonly route: Route;
}

interface Match {
  readonly route: Route;
  readonly params: Record<string, string>;
}

/**
 * More literal segments first; of two with as many, the one with a literal where the other has a
 * param first. Only paths of one length can match the same request, so length just keeps the
 * order total.
 */
function byPrecedence(a: ParamRoute, b: ParamRoute): number {
  if (a.literals !== b.literals) return b.literals - a.literals;
  if (a.pattern.length !== b.pattern.length) return a.pattern.length - b.pattern.length;
  for (const [i, segment] of a.pattern.entries()) {
    const literal = !segment.startsWith(":");
    if (literal !== !(b.pattern[i] as string).startsWith(":")) return literal ? -1 : 1;
  }
  return 0;
}

/** Bun hands a route its parameters percent-decoded; one that won't decode stays as sent. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function matchParams(
  pattern: readonly string[],
  segments: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [i, want] of pattern.entries()) {
    const got = segments[i] as string;
    if (want.startsWith(":")) {
      if (got === "") return null;
      params[want.slice(1)] = decodeSegment(got);
    } else if (want !== got) {
      return null;
    }
  }
  return params;
}

/**
 * Dispatch as Bun.serve({routes, fetch}) did: an exact path first, then `:param` paths (most
 * literal segments wins), then `/*` wildcards (longest prefix). A function route takes every
 * method. A method map answers its methods and runs GET for HEAD; any other method goes to
 * `fallback`, as does a path no route matches. Matching uses `new URL(request.url).pathname`.
 */
export function routeRequest(
  routes: Routes,
  fallback: Fallback,
): (request: Request, server: RouteServer) => Promise<Response> {
  const exact = new Map<string, Route>();
  const paramRoutes: ParamRoute[] = [];
  const wildcards: { readonly prefix: string; readonly route: Route }[] = [];
  for (const [path, route] of Object.entries(routes)) {
    const pattern = path.split("/");
    const literals = pattern.filter((segment) => !segment.startsWith(":")).length;
    if (path.endsWith("/*")) wildcards.push({ prefix: path.slice(0, -1), route });
    else if (literals < pattern.length) paramRoutes.push({ pattern, literals, route });
    else exact.set(path, route);
  }
  paramRoutes.sort(byPrecedence);
  wildcards.sort((a, b) => b.prefix.length - a.prefix.length);

  const find = (pathname: string): Match | null => {
    const route = exact.get(pathname);
    if (route !== undefined) return { route, params: {} };
    const segments = pathname.split("/");
    for (const candidate of paramRoutes) {
      const params = matchParams(candidate.pattern, segments);
      if (params !== null) return { route: candidate.route, params };
    }
    const wildcard = wildcards.find(({ prefix }) => pathname.startsWith(prefix));
    return wildcard === undefined ? null : { route: wildcard.route, params: {} };
  };

  return async (request, server) => {
    const found = find(new URL(request.url).pathname);
    if (found === null) return fallback(request, server);
    const { route } = found;
    let handler: RouteHandler | undefined;
    if (typeof route === "function") handler = route;
    else if (request.method === "HEAD") handler = route.GET;
    else if (Object.hasOwn(route, request.method)) handler = route[request.method as RouteMethod];
    if (handler === undefined) return fallback(request, server);
    // srvx's Node request can't be copied into a new Request, so it carries the params itself.
    Object.defineProperty(request, "params", {
      value: found.params,
      enumerable: true,
      configurable: true,
    });
    return handler(request as RouteRequest, server);
  };
}

/** The socket's peer: the Node request's own socket, or Bun's server asked about its request. */
function peerOf(request: Request): PeerAddress | null {
  const runtime = (request as ServerRequest).runtime;
  const socket = runtime?.node?.req.socket;
  if (socket != null) {
    const { remoteAddress, remotePort } = socket;
    return remoteAddress === undefined ? null : { address: remoteAddress, port: remotePort ?? 0 };
  }
  const peer = runtime?.bun?.server.requestIP(request);
  return peer ? { address: peer.address, port: peer.port } : null;
}

export interface Listener {
  readonly hostname: string;
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

/**
 * srvx's serve: reusePort false, silent, gracefulShutdown false, bun: {idleTimeout: 0,
 * development: false}; port 0 picks a free one. stop() closes open connections too (Bun's
 * stop(true)). requestIP reads the socket through srvx's request.runtime (node or bun).
 */
export async function listen(options: {
  readonly hostname: string;
  readonly port: number;
  readonly handle: (request: Request, server: RouteServer) => Promise<Response>;
  readonly onError: (error: unknown) => Response;
}): Promise<Listener> {
  // Read as each request arrives: Node drops the request's socket once a handler cancels its body.
  const peers = new WeakMap<Request, PeerAddress | null>();
  const server: RouteServer = { requestIP: (request) => peers.get(request) ?? peerOf(request) };
  const srvx = serve({
    hostname: options.hostname,
    port: options.port,
    reusePort: false,
    silent: true,
    gracefulShutdown: false,
    // Under Bun: no cut after 10 s with nothing written (node:http makes none), and no HTML debug
    // page for an uncaught error, which Bun serves unless NODE_ENV is "production".
    bun: { idleTimeout: 0, development: false },
    fetch: (request) => {
      peers.set(request, peerOf(request));
      return options.handle(request, server);
    },
    error: options.onError,
  });
  await srvx.ready();
  const address = srvx.node?.server?.address();
  const port =
    typeof address === "object" && address !== null ? address.port : srvx.bun?.server?.port;
  const url = srvx.url;
  if (port === undefined || url === undefined) {
    throw new Error(`Not listening on ${options.hostname}:${options.port}`);
  }
  return { hostname: options.hostname, port, url, stop: () => srvx.close(true) };
}
