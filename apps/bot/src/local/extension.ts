// The local web app's hold on the bot server: the guard in front of every route and the fallback,
// the local viewer on the offer and memory routes, the /api/local router, the task manager,
// Subspace remote pairing/host-switching, and the built app for every other GET. A listed origin
// gets this machine's own bot routes, as a deployment serves them.
import { OFFER_PATH, PREFLIGHT_PATH, withCors } from "@eidolon/access";
import { assistantSettings, dataHome, errorText, logger } from "@eidolon/config";
import type { MemoryAdmin } from "@eidolon/memory";
import { SubspaceConnectError, SubspaceManager } from "@eidolon/subspace";
import type { ServerRequest } from "srvx";
import manifest from "../../package.json" with { type: "json" };
import { logAccess, type MethodRoutes, type RouteHandler, type RouteMethod } from "../app.ts";
import { FORGET_MEMORIES_PATH, LIST_MEMORIES_PATH } from "../memory-admin.ts";
import { type Fallback, routeRequest } from "../routing.ts";
import type { LocalContext, LocalExtension } from "../server.ts";
import {
  type ErrorCode,
  EXPECTED_HOST_HEADER,
  SUBSPACE_HOST_HEADER,
  SUBSPACE_REMOTE_HEADER,
  TARGET_HEADER,
} from "./api.ts";
import type { ChatRunner } from "./chats/runner.ts";
import { allowedHosts, guardRequest, isApiPath, listedOrigin } from "./guard.ts";
import { identityHandlers } from "./identity.ts";
import { localError, localFailure } from "./responses.ts";
import {
  type Authenticate,
  createLocalRouter,
  LOCAL_PREFIX,
  type LocalApp,
  type LocalRouteSpec,
  localRoute,
  unauthenticated,
} from "./router.ts";
import { accountsRoutes } from "./routes/accounts.ts";
import { appearanceRoutes } from "./routes/appearance.ts";
import { chatRunner, chatsRoutes } from "./routes/chats.ts";
import { credentialsRoutes } from "./routes/credentials.ts";
import { jobsRoutes } from "./routes/jobs.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { memoriesRoutes } from "./routes/memories.ts";
import { personasRoutes } from "./routes/personas.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { skillsRoutes } from "./routes/skills.ts";
import { statusRoutes } from "./routes/status.ts";
import { subspaceRoutes } from "./routes/subspace.ts";
import { addAssistantFolder, tasksRoutes } from "./routes/tasks.ts";
import { usageRoutes } from "./routes/usage.ts";
import { voicesRoutes } from "./routes/voices.ts";
import { authenticator, sessionRoutes } from "./session.ts";
import type { StaticSite } from "./static.ts";
import { assistantProblem, defaultStatusDeps } from "./status.ts";
import { TaskManager } from "./tasks/manager.ts";
import type { LocalToken } from "./token.ts";

/** Every route the local router serves, besides the session exchange. */
export function localRouteModules(
  app: LocalApp,
  chats: () => ChatRunner,
  tasks: TaskManager,
  subspace?: SubspaceManager | null,
): LocalRouteSpec[] {
  return [
    ...statusRoutes(app, defaultStatusDeps, tasks),
    ...settingsRoutes(app, (enabled) => tasks.modeChanged(enabled)),
    ...credentialsRoutes(app),
    ...accountsRoutes(app),
    ...personasRoutes(app),
    ...appearanceRoutes(app),
    ...voicesRoutes(app),
    ...jobsRoutes(app),
    ...memoriesRoutes(app),
    ...usageRoutes(),
    ...chatsRoutes(chats),
    ...tasksRoutes(tasks),
    ...mcpRoutes(tasks),
    ...skillsRoutes(tasks),
    ...subspaceRoutes(subspace),
  ];
}

export interface LocalExtensionOptions {
  readonly token: LocalToken;
  readonly site: StaticSite;
  /** Bound IP literals that Host may name besides localhost, 127.0.0.1 and [::1]. */
  readonly boundLiterals: readonly string[];
  readonly memoryAdmin: () => MemoryAdmin | null;
  readonly restart: () => void;
  /** The clock link codes are checked against. */
  readonly nowSeconds: () => number;
  /** EIDOLON_LOCAL_ALLOWED_ORIGINS: other sites whose pages may call the bot's API. */
  readonly origins?: ReadonlySet<string>;
}

export interface LocalAppExtension extends LocalExtension {
  /**
   * Loads the app's tasks and Subspace tunnels once the server listens: a start that can't bind
   * its port exits, and would cut a resumed task or Subspace tunnel off.
   */
  startTasks(): Promise<void>;
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const HOST_TAGGED_PATHS = new Set(["/api/local/tasks", "/api/local/chats"]);
const LOCAL_IMAGE_PATH =
  /^\/api\/local\/(?:personas\/[^/]+\/(?:avatar|references\/[^/]+\/[^/]+)|chats\/[^/]+\/files\/[^/]+)$/;

function isLocalOnlySubspacePath(pathname: string): boolean {
  return (
    pathname === "/api/local/session" ||
    pathname.startsWith("/api/local/session/") ||
    pathname === "/api/local/subspace" ||
    pathname.startsWith("/api/local/subspace/")
  );
}

function shouldBypassSubspace(request: Request, pathname: string): boolean {
  return (
    request.headers.get(TARGET_HEADER)?.toLowerCase() === "local" ||
    isLocalOnlySubspacePath(pathname)
  );
}

function rawTargetPathInvalid(target: string): boolean {
  const end = target.search(/[?#]/);
  const rawPath = end >= 0 ? target.slice(0, end) : target;
  return !rawPath.startsWith("/") || rawPath.startsWith("//") || rawPath.includes("\\");
}

function hasInvalidRequestTarget(request: Request, pathname: string): boolean {
  if (pathname.startsWith("//") || pathname.includes("\\")) return true;
  const nodeUrl = (request as ServerRequest).runtime?.node?.req?.url;
  if (typeof nodeUrl === "string" && rawTargetPathInvalid(nodeUrl)) return true;
  const schemeEnd = request.url.indexOf("://");
  if (schemeEnd >= 0) {
    const pathStart = request.url.indexOf("/", schemeEnd + 3);
    if (pathStart >= 0 && rawTargetPathInvalid(request.url.slice(pathStart))) return true;
  }
  return false;
}

function proxyFailure(error: unknown, mapPairingFailed: boolean): readonly [ErrorCode, string] {
  if (error instanceof SubspaceConnectError) {
    if (error.code === "local-network-blocked") {
      return [
        "local-network-blocked",
        "Could not reach the server on your local network; check that it is running and that Local Network access is enabled in macOS System Settings",
      ];
    }
    if (mapPairingFailed && error.code === "pairing-failed") {
      return ["pairing-failed", "Remote server rejected this device's pairing token"];
    }
  }
  return ["subspace-unreachable", "Could not reach the active Subspace server"];
}

async function forwardToSubspace(
  subspace: SubspaceManager,
  request: Request,
  targetPathWithSearch: string,
  expectedHostId?: string,
  mapPairingFailed = false,
): Promise<Response> {
  try {
    return await subspace.proxyToActive(request, targetPathWithSearch, expectedHostId);
  } catch (error) {
    const [code, message] = proxyFailure(error, mapPairingFailed);
    return localFailure(502, code, message, (id) =>
      logger.warning(`[subspace] Proxy request failed (error ${id}): ${errorText(error)}`),
    );
  }
}

function checkExpectedHost(request: Request, activeHostId: string | null): Response | null {
  const expected = request.headers.get(EXPECTED_HOST_HEADER);
  if (expected !== null && expected !== (activeHostId ?? "local")) {
    return localError(409, "conflict", "Active Subspace server changed; reload and try again");
  }
  return null;
}

function setHeaderMutable(response: Response, name: string, value: string): Response {
  try {
    response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set(name, value);
    return copy;
  }
}

type ProxyAuthPolicy = "none" | "strict" | "local-router";

function checkProxyAuth(
  request: Request,
  pathname: string,
  policy: ProxyAuthPolicy,
  authenticate: Authenticate,
): Response | null {
  if (policy === "none") return null;
  const auth = authenticate(request);
  const allowCookieImage =
    policy === "local-router" &&
    SAFE_METHODS.has(request.method) &&
    LOCAL_IMAGE_PATH.test(pathname);
  const caller =
    auth === "bearer"
      ? "bearer"
      : auth === "session" || (auth === "cookie" && allowCookieImage)
        ? "cookie"
        : null;
  if (caller === null) return unauthenticated(auth);
  if (caller === "cookie" && !SAFE_METHODS.has(request.method) && !request.headers.has("origin")) {
    return localError(403, "forbidden", "A change needs the Origin header the app's pages send");
  }
  return null;
}

export function createLocalExtension(options: LocalExtensionOptions): LocalAppExtension {
  const stopHooks: (() => Promise<void>)[] = [];
  let manager: TaskManager | null = null;
  let subspaceManager: SubspaceManager | null = null;
  let authenticateRequest: Authenticate | null = null;
  let botFallbackHandler: Fallback | null = null;
  const origins = options.origins ?? new Set<string>();
  let hosts: ReadonlySet<string> | null = null;
  const hostsOf = (context: LocalContext): ReadonlySet<string> => {
    hosts ??= allowedHosts(context.port(), options.boundLiterals);
    return hosts;
  };

  /** `crossOrigin` answers a listed origin, with its CORS headers; `handler` everyone else. */
  const guarded =
    (handler: RouteHandler, context: LocalContext, crossOrigin = handler): RouteHandler =>
    async (request, server) => {
      const refused = guardRequest(request, server, hostsOf(context), origins);
      if (refused !== null) {
        logAccess(request, server, refused);
        return refused;
      }
      const origin = listedOrigin(request, origins);
      if (origin === null) return handler(request, server);
      return withCors(request, await crossOrigin(request, server), { allowOrigins: [origin] });
    };

  return {
    routes(botRoutes, context) {
      const onStop = (hook: () => Promise<void>): void => {
        stopHooks.push(hook);
      };
      // Made once, at boot. Its hooks use `chats` and `app`, declared below: nothing calls them
      // before startTasks(), once the server listens.
      const tasks = new TaskManager({
        dataHome: dataHome(),
        settings: assistantSettings,
        addFolder: (folder) => addAssistantFolder(app, folder),
        problem: assistantProblem,
        report: (snapshot) => chats().report(snapshot),
        waiting: (snapshot) => chats().taskWaiting(snapshot),
        progress: (snapshot) => chats().taskProgress(snapshot),
        permissions: (chat) => chats().permissionsOf(chat.id),
      });
      manager = tasks;
      const chats = chatRunner({ onStop }, { tasks });
      // Stop hooks run newest first: every run is left before the chats shut down.
      onStop(() => tasks.stop());
      const tunneledRequests = new WeakSet<Request>();
      const identity = identityHandlers({
        signalling: context.signalling,
        memoryAdmin: options.memoryAdmin,
        chats,
        isTunneledRequest: (request) => tunneledRequests.has(request),
      });
      let listedOffers = 0;
      const localActiveCalls = () =>
        context.signalling.activeSessions + identity.pendingOffers() + listedOffers;
      const app: LocalApp = {
        port: context.port,
        // Include tunneled Relay/Direct calls so quit/restart guards never cut active UDP bridges.
        activeCalls: () => localActiveCalls() + (subspaceManager?.activeCallCount ?? 0),
        restart: options.restart,
        onStop,
        memoryAdmin: options.memoryAdmin,
      };

      const authenticate = authenticator(options.token, context.port);
      authenticateRequest = authenticate;
      let dispatchInProcess: ((request: Request) => Promise<Response>) | null = null;
      const subspace = new SubspaceManager({
        dataHome: dataHome(),
        serverVersion: () => manifest.version,
        activeCalls: localActiveCalls,
        dispatchLocal: async (request) => {
          if (dispatchInProcess === null) {
            return localError(503, "unavailable", "Local routes are not initialized");
          }
          const { pathname } = new URL(request.url);
          if (isLocalOnlySubspacePath(pathname)) {
            return localError(
              403,
              "forbidden",
              "Remote peers cannot access this computer's Subspace or session settings",
            );
          }
          const headers = new Headers(request.headers);
          headers.set("authorization", `Bearer ${options.token.secret}`);
          headers.set("host", `127.0.0.1:${context.port()}`);
          headers.set("origin", `http://127.0.0.1:${context.port()}`);
          const authorized = new Request(request.url, {
            method: request.method,
            headers,
            body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
            ...(request.method === "GET" || request.method === "HEAD"
              ? {}
              : { duplex: "half" as const }),
            signal: request.signal,
          });
          tunneledRequests.add(authorized);
          return await dispatchInProcess(authorized);
        },
      });
      subspaceManager = subspace;
      onStop(() => subspace.stop());

      const guardHost = (
        request: Request,
        server: Parameters<RouteHandler>[1],
        pathname: string,
        policy: ProxyAuthPolicy,
        activeHostId: string | null,
      ): Response | null => {
        const failure =
          checkProxyAuth(request, pathname, policy, authenticate) ??
          checkExpectedHost(request, activeHostId);
        if (failure !== null) logAccess(request, server, failure);
        return failure;
      };

      const withProxy =
        (localHandler: RouteHandler, policy: ProxyAuthPolicy): RouteHandler =>
        async (request, server) => {
          const url = new URL(request.url);
          const { pathname } = url;
          if (hasInvalidRequestTarget(request, pathname)) {
            const invalid = localError(400, "bad-request", "Invalid request path");
            logAccess(request, server, invalid);
            return invalid;
          }
          const bypass = shouldBypassSubspace(request, pathname);
          const activeHostId = subspace.activeHostId;
          if (activeHostId === null || bypass) {
            if (!bypass && request.headers.has(EXPECTED_HOST_HEADER)) {
              const failure = guardHost(request, server, pathname, policy, null);
              if (failure !== null) return failure;
            }
            const response = await localHandler(request, server);
            if (request.method === "GET" && HOST_TAGGED_PATHS.has(pathname)) {
              return setHeaderMutable(response, SUBSPACE_HOST_HEADER, "local");
            }
            return response;
          }
          const failure = guardHost(request, server, pathname, policy, activeHostId);
          if (failure !== null) return failure;
          let response = await forwardToSubspace(
            subspace,
            request,
            `${pathname}${url.search}`,
            activeHostId,
            true,
          );
          if (request.method === "POST" && pathname === "/api/local/restart" && response.ok) {
            response = setHeaderMutable(response, SUBSPACE_REMOTE_HEADER, "remote");
          }
          if (request.method === "GET" && HOST_TAGGED_PATHS.has(pathname)) {
            response = setHeaderMutable(response, SUBSPACE_HOST_HEADER, activeHostId);
          }
          logAccess(request, server, response);
          return response;
        };

      const rawRoutes: Record<string, RouteHandler | MethodRoutes> = {};
      const routes: Record<string, RouteHandler | MethodRoutes> = {};
      for (const [path, value] of Object.entries(botRoutes)) {
        if (typeof value === "function") {
          rawRoutes[path] = value;
          routes[path] = guarded(withProxy(value, "none"), context, value);
          continue;
        }
        const rawMethods: MethodRoutes = {};
        const methods: MethodRoutes = {};
        for (const [method, handler] of Object.entries(value) as [RouteMethod, RouteHandler][]) {
          rawMethods[method] = handler;
          methods[method] = guarded(withProxy(handler, "none"), context, handler);
        }
        rawRoutes[path] = rawMethods;
        routes[path] = methods;
      }

      // A listed origin gets the bot's own handler: a stranger or a LAPLACE login, never the
      // local viewer.
      const local = (
        method: "GET" | "POST",
        handler: Parameters<typeof localRoute>[1],
        crossOrigin: RouteHandler | undefined,
      ) => {
        const direct = localRoute(method, handler, authenticate);
        return {
          direct,
          wrapped: guarded(withProxy(direct, "strict"), context, crossOrigin),
        };
      };
      const bot = (path: string, method: RouteMethod) => (botRoutes[path] as MethodRoutes)[method];
      const botOffer = bot(OFFER_PATH, "POST");
      const offerLocal = local(
        "POST",
        identity.offer,
        botOffer &&
          (async (request, server) => {
            listedOffers++;
            try {
              return await botOffer(request, server);
            } finally {
              listedOffers--;
            }
          }),
      );
      const preflightLocal = local("POST", identity.preflight, bot(PREFLIGHT_PATH, "POST"));
      const listMemoriesLocal = local("GET", identity.listMemories, bot(LIST_MEMORIES_PATH, "GET"));
      const forgetMemoriesLocal = local(
        "POST",
        identity.forgetMemories,
        bot(FORGET_MEMORIES_PATH, "POST"),
      );

      rawRoutes[OFFER_PATH] = {
        POST: offerLocal.direct,
        PATCH: (rawRoutes[OFFER_PATH] as MethodRoutes).PATCH,
      };
      // POST stays first: the bot's 405 for this path takes Allow from the first method.
      routes[OFFER_PATH] = {
        POST: offerLocal.wrapped,
        PATCH: (routes[OFFER_PATH] as MethodRoutes).PATCH,
      };
      rawRoutes[PREFLIGHT_PATH] = { POST: preflightLocal.direct };
      routes[PREFLIGHT_PATH] = { POST: preflightLocal.wrapped };
      rawRoutes[LIST_MEMORIES_PATH] = { GET: listMemoriesLocal.direct };
      routes[LIST_MEMORIES_PATH] = { GET: listMemoriesLocal.wrapped };
      rawRoutes[FORGET_MEMORIES_PATH] = { POST: forgetMemoriesLocal.direct };
      routes[FORGET_MEMORIES_PATH] = { POST: forgetMemoriesLocal.wrapped };

      const specs = [
        ...sessionRoutes(app, options.token, options.nowSeconds),
        ...localRouteModules(app, chats, tasks, subspace),
      ];
      const localRouter = createLocalRouter(specs, authenticate);
      rawRoutes[`${LOCAL_PREFIX}/*`] = localRouter;
      routes[`${LOCAL_PREFIX}/*`] = guarded(withProxy(localRouter, "local-router"), context);

      const dispatchRaw = routeRequest(rawRoutes, (req, srv) =>
        botFallbackHandler
          ? botFallbackHandler(req, srv)
          : Promise.resolve(localError(404, "not-found", "No such API route")),
      );
      dispatchInProcess = (req) =>
        dispatchRaw(req, { requestIP: () => ({ address: "127.0.0.1", port: context.port() }) });

      return routes;
    },

    fallback(botFallback, context) {
      botFallbackHandler = botFallback;
      return async (request, server) => {
        const refused = guardRequest(request, server, hostsOf(context), origins);
        if (refused !== null) {
          logAccess(request, server, refused);
          return refused;
        }
        const url = new URL(request.url);
        const { pathname } = url;
        if (hasInvalidRequestTarget(request, pathname)) {
          const invalid = localError(400, "bad-request", "Invalid request path");
          logAccess(request, server, invalid);
          return invalid;
        }
        if ((request.method === "GET" || request.method === "HEAD") && !isApiPath(pathname)) {
          const response = options.site.respond(pathname, request);
          logAccess(request, server, response);
          return response;
        }
        const origin = listedOrigin(request, origins);
        const subspace = subspaceManager;
        const activeHostId = subspace?.activeHostId ?? null;
        if (origin === null && subspace !== null && !shouldBypassSubspace(request, pathname)) {
          if (activeHostId !== null || request.headers.has(EXPECTED_HOST_HEADER)) {
            if (authenticateRequest === null) {
              const unavail = localError(503, "unavailable", "Authentication is not initialized");
              logAccess(request, server, unavail);
              return unavail;
            }
            const authFailure = checkProxyAuth(
              request,
              pathname,
              "local-router",
              authenticateRequest,
            );
            if (authFailure !== null) {
              logAccess(request, server, authFailure);
              return authFailure;
            }
          }
          const hostConflict = checkExpectedHost(request, activeHostId);
          if (hostConflict !== null) {
            logAccess(request, server, hostConflict);
            return hostConflict;
          }
          if (activeHostId !== null) {
            const response = await forwardToSubspace(
              subspace,
              request,
              `${pathname}${url.search}`,
              activeHostId,
            );
            logAccess(request, server, response);
            return response;
          }
        }
        // Unknown /api and /mcp paths keep the bot's own 404 and 405 bytes.
        const response = await botFallback(request, server);
        return origin === null ? response : withCors(request, response, { allowOrigins: [origin] });
      };
    },

    async startTasks() {
      await manager?.boot();
      await subspaceManager?.boot();
    },

    async stop() {
      for (const hook of stopHooks.splice(0).reverse()) {
        try {
          await hook();
        } catch (error) {
          logger.error("A local stop hook failed", error);
        }
      }
    },
  };
}
