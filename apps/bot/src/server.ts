// Boot and shutdown. The packages come in as their module namespaces (main.ts) or as fakes (tests).
import { lookup } from "node:dns/promises";
import {
  type AudioQualitySettings,
  type CorsPolicy,
  OFFER_PATH,
  type SlidingWindowQuota,
} from "@eidolon/access";
import { type LogLevel, logger } from "@eidolon/config";
import { SELFIE_PATH } from "@eidolon/imagegen";
import type { MemoryAdmin } from "@eidolon/memory";
import type { SignallingServer } from "@eidolon/runtime";
import type { IceService } from "@eidolon/turn";
import type { Server } from "bun";
import { type BotAccess, type BotApp, createBotApp } from "./app.ts";
import type { BotArgs } from "./args.ts";
import type { McpHandler } from "./mcp/index.ts";
import { FORGET_MEMORIES_PATH, LIST_MEMORIES_PATH } from "./memory-admin.ts";

export interface BotDeps {
  readonly access: BotAccess & {
    corsPolicyFromEnv(): CorsPolicy;
    anonOfferQuota(): Pick<SlidingWindowQuota, "maxPerWindow" | "windowSeconds">;
    audioQualitySettings(): AudioQualitySettings;
    describeOpusBitrates(settings: AudioQualitySettings): string;
  };
  readonly imagegen: { selfieResponse(segment: string): Response };
  readonly memory: { memoryAdmin(): MemoryAdmin | null };
  readonly retrieval: {
    warmTokenizer(): void;
    resolveDbPath(): string;
    warmStreamCatalog(dbPath: string): Promise<void>;
  };
  readonly runtime: {
    configureLogging(options: { level: LogLevel }): void;
    warmAudioModels(): Promise<void>;
    createSignallingServer(options: {
      ice: Pick<IceService, "serverPlan">;
    }): Pick<SignallingServer, "offer" | "patch" | "close">;
  };
  readonly turn: { iceServiceFromEnv(): IceService };
  readonly mcp: { createMcpHandler(): Promise<Pick<McpHandler, "handle">> };
  /** The local web app (apps/bot/src/local); production passes none. */
  readonly local?: LocalExtension;
}

/** What the local extension gets from the server it extends. */
export interface LocalContext {
  readonly signalling: Pick<SignallingServer, "offer" | "patch">;
  /** The port the server listens on; valid once a request arrives. */
  port(): number;
}

/** The local web app's hold on the server: it rewrites the routes and the fallback. */
export interface LocalExtension {
  routes(routes: BotApp["routes"], context: LocalContext): BotApp["routes"];
  fallback(fallback: BotApp["fallback"], context: LocalContext): BotApp["fallback"];
  /** Runs on stop(), once the server no longer listens and before the peers disconnect. */
  stop(): Promise<void>;
}

export interface BotServer {
  readonly server: Server<undefined>;
  /** Stops listening and drops in-flight requests, then disconnects every peer. No drain. */
  stop(): Promise<void>;
}

/** Warms everything a call needs, then listens. Rejects when a warm-up fails: boot fails loudly. */
export async function startBotServer(args: BotArgs, deps: BotDeps): Promise<BotServer> {
  const { access, retrieval, runtime } = deps;
  runtime.configureLogging({ level: args.verbose > 0 ? "TRACE" : "DEBUG" });
  // Before listening, while no call's audio can stall on the CPU-bound loads.
  retrieval.warmTokenizer();
  await retrieval.warmStreamCatalog(retrieval.resolveDbPath());
  await runtime.warmAudioModels();
  logger.info(access.describeOpusBitrates(access.audioQualitySettings()));

  const ice = deps.turn.iceServiceFromEnv();
  const signalling = runtime.createSignallingServer({ ice });
  const quota = access.anonOfferQuota();
  logger.info(
    `[offer-middleware] Installed on ${OFFER_PATH} ` +
      `(anonymous quota: ${quota.maxPerWindow}/${quota.windowSeconds}s)`,
  );
  logger.info(
    `[memory-admin] Installed routes: GET ${LIST_MEMORIES_PATH}, POST ${FORGET_MEMORIES_PATH}`,
  );
  logger.info(`[selfie] Installed route: GET ${SELFIE_PATH}/{selfie_id}`);
  const app = createBotApp({
    access,
    cors: access.corsPolicyFromEnv(),
    ice,
    signalling,
    memoryAdmin: deps.memory.memoryAdmin(),
    selfieResponse: (segment) => deps.imagegen.selfieResponse(segment),
    mcp: await deps.mcp.createMcpHandler(),
  });

  const local = deps.local;
  const context: LocalContext = { signalling, port: () => server.port as number };
  const routes = local ? local.routes(app.routes, context) : app.routes;
  const fallback = local ? local.fallback(app.fallback, context) : app.fallback;

  const listen = (hostname: string, port: number) =>
    Bun.serve({
      hostname,
      port,
      // The default is NODE_ENV !== "production", which answers an uncaught error with an HTML
      // debug page.
      development: false,
      // With development off, Bun sets SO_REUSEPORT unless told not to, so another server could
      // bind the same port and take its requests, cookies included. The local app's port is its own.
      ...(local ? { reusePort: false } : {}),
      routes,
      fetch: fallback,
      error: app.onError,
    });
  const [first, ...rest] = await bindAddresses(args.host);
  const server = listen(first as string, args.port);
  const servers = [server, ...rest.map((hostname) => listen(hostname, server.port as number))];
  const url = args.host === "localhost" ? `http://localhost:${server.port}/` : server.url;
  logger.info(`Bot server listening on ${url}`);
  return {
    server,
    async stop() {
      await Promise.all(servers.map((s) => s.stop(true)));
      try {
        await local?.stop();
      } finally {
        await signalling.close();
      }
    },
  };
}

// uvicorn binds every address `localhost` resolves to; Bun.serve binds only the first (::1 on
// macOS), which would refuse a client that dials 127.0.0.1.
async function bindAddresses(host: string): Promise<string[]> {
  if (host !== "localhost") return [host];
  const found = await lookup(host, { all: true });
  return [...new Set(found.map((entry) => entry.address))];
}

/** The SIGTERM/SIGINT handler: stop, then exit 0. A second signal while stopping exits at once. */
export function shutdownHandler(
  bot: Pick<BotServer, "stop">,
  exit: (code: number) => void,
): () => void {
  let stopping = false;
  return () => {
    if (stopping) {
      exit(0);
      return;
    }
    stopping = true;
    void bot
      .stop()
      .catch((error: unknown) => logger.error("Shutdown failed", error))
      .finally(() => exit(0));
  };
}
