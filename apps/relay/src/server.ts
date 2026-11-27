import { logger, withoutTrailingSlashes } from "@eidolon/config";
import { serve } from "srvx";
import { loadRelayConfig, type RelayConfig } from "./config.ts";
import { createRelayTokenVerifier, type RelayTokenVerifier } from "./jwks-verifier.ts";
import { RelayHub } from "./relay.ts";
import { openRelayDatabase, RelayStore } from "./relay-db.ts";

export interface RelayServerHandle {
  readonly port: number;
  readonly url: string;
  readonly publicUrl: string;
  readonly hub: RelayHub;
  readonly verifyToken: RelayTokenVerifier;
  stop(): Promise<void>;
}

export async function startRelayServer(
  overrides: Partial<RelayConfig> & {
    readonly fetch?: typeof fetch;
    readonly heartbeatMs?: number;
    readonly syncTimeoutMs?: number;
  } = {},
): Promise<RelayServerHandle> {
  const { fetch: fetchImpl, heartbeatMs, syncTimeoutMs, ...configOverrides } = overrides;
  const config: RelayConfig = { ...loadRelayConfig(), ...configOverrides };
  const db = openRelayDatabase(config.dbPath);
  const store = new RelayStore(db);
  const verifyToken = createRelayTokenVerifier(config, { fetch: fetchImpl });
  const hub = new RelayHub(verifyToken, store, { heartbeatMs, syncTimeoutMs });

  const srvx = serve({
    hostname: config.host,
    port: config.port,
    reusePort: false,
    silent: true,
    gracefulShutdown: false,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/healthz") {
        return Response.json({
          ok: true,
          onlineHosts: hub.onlineHostCount,
          publicUrl: config.publicUrl,
          auth: {
            issuer: config.authIssuer,
            audience: config.authAudience,
          },
        });
      }
      return Response.json({ error: { code: "not-found", message: "Not Found" } }, { status: 404 });
    },
    error(error) {
      logger.error("Unhandled relay server error", error);
      return Response.json(
        { error: { code: "internal", message: "Internal Server Error" } },
        { status: 500 },
      );
    },
  });

  try {
    await srvx.ready();
  } catch (error) {
    await srvx.close(true).catch(() => {});
    await hub.close().catch(() => {});
    try {
      db.close();
    } catch {
      // Preserve startup error if database close also fails.
    }
    throw error;
  }
  const nodeServer = srvx.node?.server;
  const address = nodeServer?.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  const url = srvx.url;
  if (nodeServer === undefined || port === undefined || url === undefined) {
    await srvx.close(true);
    await hub.close();
    db.close();
    throw new Error(`Eidolon Relay failed to listen on ${config.host}:${config.port}`);
  }

  nodeServer.on("upgrade", (req, socket, head) => {
    if (!hub.handleUpgrade(req, socket, head)) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });

  return {
    port,
    url: withoutTrailingSlashes(url),
    publicUrl: config.publicUrl,
    hub,
    verifyToken,
    async stop() {
      await hub.close();
      await srvx.close(true);
      db.close();
    },
  };
}
