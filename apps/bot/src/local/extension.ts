// The local web app's hold on the bot server: the guard in front of every route and the fallback,
// the local viewer on the offer and memory routes, the /api/local router, and the built app for
// every other GET. A listed origin gets the bot's own routes, as a deployment serves them.
import { OFFER_PATH, PREFLIGHT_PATH, withCors } from "@eidolon/access";
import { logger } from "@eidolon/config";
import type { MemoryAdmin } from "@eidolon/memory";
import { logAccess, type MethodRoutes, type RouteHandler, type RouteMethod } from "../app.ts";
import { FORGET_MEMORIES_PATH, LIST_MEMORIES_PATH } from "../memory-admin.ts";
import type { LocalContext, LocalExtension } from "../server.ts";
import type { ChatRunner } from "./chats/runner.ts";
import { allowedHosts, guardRequest, isApiPath, listedOrigin, logRefused } from "./guard.ts";
import { identityHandlers } from "./identity.ts";
import {
  createLocalRouter,
  LOCAL_PREFIX,
  type LocalApp,
  type LocalRouteSpec,
  localRoute,
} from "./router.ts";
import { accountsRoutes } from "./routes/accounts.ts";
import { chatRunner, chatsRoutes } from "./routes/chats.ts";
import { credentialsRoutes } from "./routes/credentials.ts";
import { jobsRoutes } from "./routes/jobs.ts";
import { memoriesRoutes } from "./routes/memories.ts";
import { personasRoutes } from "./routes/personas.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { statusRoutes } from "./routes/status.ts";
import { usageRoutes } from "./routes/usage.ts";
import { voicesRoutes } from "./routes/voices.ts";
import { authenticator, sessionRoutes } from "./session.ts";
import type { StaticSite } from "./static.ts";
import type { LocalToken } from "./token.ts";

/** Every route module the local API serves, besides the session exchange. */
export function localRouteModules(app: LocalApp, chats: () => ChatRunner): LocalRouteSpec[] {
  return [
    ...statusRoutes(app),
    ...settingsRoutes(app),
    ...credentialsRoutes(app),
    ...accountsRoutes(app),
    ...personasRoutes(app),
    ...voicesRoutes(app),
    ...jobsRoutes(app),
    ...memoriesRoutes(app),
    ...usageRoutes(),
    ...chatsRoutes(chats),
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

export function createLocalExtension(options: LocalExtensionOptions): LocalExtension {
  const stopHooks: (() => Promise<void>)[] = [];
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
        logRefused(request, server, refused);
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
      const chats = chatRunner({ onStop });
      const identity = identityHandlers({
        signalling: context.signalling,
        memoryAdmin: options.memoryAdmin,
        chats,
      });
      const app: LocalApp = {
        port: context.port,
        // A connecting offer is a call already: a switch or restart now would cut it off.
        activeCalls: () => context.signalling.activeSessions + identity.pendingOffers(),
        restart: options.restart,
        onStop,
        memoryAdmin: options.memoryAdmin,
      };
      const routes: Record<string, RouteHandler | MethodRoutes> = {};
      for (const [path, value] of Object.entries(botRoutes)) {
        if (typeof value === "function") {
          routes[path] = guarded(value, context);
          continue;
        }
        const methods: MethodRoutes = {};
        for (const [method, handler] of Object.entries(value) as [RouteMethod, RouteHandler][]) {
          methods[method] = guarded(handler, context);
        }
        routes[path] = methods;
      }

      const authenticate = authenticator(options.token, context.port);
      // A listed origin gets the bot's own handler: a stranger or a LAPLACE login, never the
      // local viewer.
      const local = (
        path: string,
        method: "GET" | "POST",
        handler: Parameters<typeof localRoute>[1],
      ) =>
        guarded(
          localRoute(method, handler, authenticate),
          context,
          (botRoutes[path] as MethodRoutes)[method],
        );
      // POST stays first: the bot's 405 for this path takes Allow from the first method.
      routes[OFFER_PATH] = {
        POST: local(OFFER_PATH, "POST", identity.offer),
        PATCH: (routes[OFFER_PATH] as MethodRoutes).PATCH,
      };
      routes[PREFLIGHT_PATH] = { POST: local(PREFLIGHT_PATH, "POST", identity.preflight) };
      routes[LIST_MEMORIES_PATH] = {
        GET: local(LIST_MEMORIES_PATH, "GET", identity.listMemories),
      };
      routes[FORGET_MEMORIES_PATH] = {
        POST: local(FORGET_MEMORIES_PATH, "POST", identity.forgetMemories),
      };

      const specs = [
        ...sessionRoutes(app, options.token, options.nowSeconds),
        ...localRouteModules(app, chats),
      ];
      routes[`${LOCAL_PREFIX}/*`] = guarded(createLocalRouter(specs, authenticate), context);
      return routes;
    },

    fallback(botFallback, context) {
      return (request, server) => {
        const refused = guardRequest(request, server, hostsOf(context), origins);
        if (refused !== null) {
          logRefused(request, server, refused);
          return refused;
        }
        const { pathname } = new URL(request.url);
        if ((request.method === "GET" || request.method === "HEAD") && !isApiPath(pathname)) {
          const response = options.site.respond(pathname, request);
          logAccess(request, server, response);
          return response;
        }
        // Unknown /api and /mcp paths keep the bot's own 404 and 405 bytes.
        const response = botFallback(request, server);
        const origin = listedOrigin(request, origins);
        return origin === null ? response : withCors(request, response, { allowOrigins: [origin] });
      };
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
