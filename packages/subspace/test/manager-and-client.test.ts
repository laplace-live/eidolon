import "../../../packages/config/test/isolated-guard.ts";
import { createSocket } from "node:dgram";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer, type Socket as TcpSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  completeDeviceAuthorization,
  computeRelayControlProof,
  deriveRelayDeviceToken,
  deriveRelayInviteToken,
  discoverRelayAuthUrl,
  encodePairingUrl,
  generateX25519KeyPair,
  importX25519PrivateKey,
  isAllowedAuthUrl,
  isMacLocalNetworkBlocked,
  mintRelayJwt,
  parsePairingInput,
  RELAY_CLOSE_CODE,
  RELAY_PATHS,
  SubspaceClient,
  SubspaceConnectError,
  SubspaceHost,
  SubspaceManager,
  type SubspaceSavedServer,
  SubspaceStore,
  sha256Hex,
  startClientHandshake,
  subspaceAuthUrl,
  subspaceRelayUrl,
  utf8Encode,
} from "../src/index.ts";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("SubspaceManager, SubspaceClient, and SubspaceHost regressions", () => {
  test("setActiveHostId rejects unknown servers with unknown-subspace-server without stopping the active client", async () => {
    const hostDir = tempDir("subspace-mgr-host-");
    const clientDir = tempDir("subspace-mgr-client-");

    const remoteHost = new SubspaceHost({
      store: new SubspaceStore(hostDir),
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => remoteHost.stop());
    const port = await remoteHost.startDirect(0);
    const offer = await remoteHost.createPairingOffer({
      mode: "direct",
      address: "127.0.0.1",
      port,
    });

    const manager = new SubspaceManager({
      dataHome: clientDir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      dispatchLocal: async () => new Response("local", { status: 200 }),
    });
    cleanups.push(() => manager.stop());

    const { encodePairingUrl } = await import("../src/index.ts");
    const state = await manager.pairServer({
      code: encodePairingUrl(offer),
      activate: true,
    });
    const activeId = state.activeHostId!;
    expect(state.servers[0]?.connectionState).toBe("connected");

    await expect(manager.setActiveHostId("srv_does_not_exist")).rejects.toMatchObject({
      code: "unknown-subspace-server",
    });

    const after = await manager.getState();
    expect(after.activeHostId).toBe(activeId);
    expect(after.servers[0]?.connectionState).toBe("connected");

    const proxied = await manager.proxyToActive(
      new Request("http://127.0.0.1/api/local/status"),
      "/api/local/status",
    );
    expect(proxied.status).toBe(200);
    expect(await proxied.json()).toEqual({ ok: true });
  });

  test("createShareOffer reuses direct offer when address is omitted and hides activeOffer when shareMode is off", async () => {
    const dir = tempDir("subspace-mgr-share-");
    const manager = new SubspaceManager({
      dataHome: dir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      dispatchLocal: async () => new Response("ok"),
    });
    cleanups.push(() => manager.stop());

    const first = await manager.createShareOffer({ mode: "direct", address: "127.0.0.1", port: 0 });
    const reused = await manager.createShareOffer({ mode: "direct" });
    expect(reused.pairingCode).toBe(first.pairingCode);

    const offState = await manager.updateShareSettings({ shareMode: "off" });
    expect(offState.share.shareMode).toBe("off");
    expect(offState.share.activeOffer).toBeNull();
  });

  test("SubspaceClient.stop() cancels an in-flight connect() without flipping state to connected or error", async () => {
    // Hold the WebSocket handshake open indefinitely without sending e2ee_ready.
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/v1/subspace" });
    cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const addr = wss.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const clientConnected = new Promise<void>((resolve) => {
      wss.once("connection", (ws) => {
        ws.once("message", () => resolve());
      });
    });

    const hostKp = await generateX25519KeyPair();
    const client = new SubspaceClient({
      id: "srv-stop-race",
      name: "Slow Host",
      hostPublicKeyB64: hostKp.publicKeyB64,
      grantId: "g-1",
      deviceToken: "tok-1",
      mode: "direct",
      endpoint: { host: "127.0.0.1", port },
      addedAt: Date.now(),
      lastConnectedAt: null,
      lastVersion: null,
    });
    cleanups.push(() => client.stop());

    const pending = client.connect();
    await clientConnected;
    expect(client.state).toBe("connecting");

    client.stop();
    await expect(pending).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 25));
    expect(client.state).toBe("disconnected");
    expect(client.lastError).toBeNull();
  });

  test("SubspaceClient transitions to error on decrypt failure and preserves pairing-failed on revoked device tokens", async () => {
    const dir = tempDir("subspace-client-errors-");
    const hostStore = new SubspaceStore(dir);
    const host = new SubspaceHost({
      store: hostStore,
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => host.stop());

    const port = await host.startDirect(0);
    const offer = await host.createPairingOffer({ mode: "direct", address: "127.0.0.1", port });
    const { performPairingHandshake } = await import("../src/index.ts");
    const paired = await performPairingHandshake(offer, { clientName: "Test Client" });

    const saved: SubspaceSavedServer = {
      id: "srv-err-1",
      name: paired.hostName,
      hostPublicKeyB64: offer.hostPublicKeyB64,
      grantId: paired.grantId,
      deviceToken: paired.deviceToken,
      mode: "direct",
      endpoint: { host: "127.0.0.1", port },
      addedAt: Date.now(),
      lastConnectedAt: Date.now(),
      lastVersion: paired.serverVersion,
    };
    const client = new SubspaceClient(saved, {}, paired.tunnel);
    cleanups.push(() => client.stop());
    expect(client.state).toBe("connected");

    // Simulate a corrupt/tampered encrypted frame reaching the client WebSocket.
    paired.tunnel.ws.emit("message", Buffer.from([1, 2, 3, 4]), true);
    await new Promise((r) => setTimeout(r, 40));
    expect(client.state).not.toBe("connected");
    expect(client.lastError).toBeTruthy();
    client.stop();

    // Revoke the grant and ensure proxyFetch preserves pairing-failed rather than subspace-unreachable.
    expect(host.revokeGrant(paired.grantId)).toBe(true);
    let thrown: unknown = null;
    try {
      await client.proxyFetch(
        new Request("http://127.0.0.1/api/local/status"),
        "/api/local/status",
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SubspaceConnectError);
    expect((thrown as SubspaceConnectError).code).toBe("pairing-failed");
  });

  test("SubspaceHost relay createPairingOffer avoids orphan invites on failure and sends invite_create once on fresh connect", async () => {
    const dir = tempDir("subspace-host-relay-");
    const store = new SubspaceStore(dir);
    store.saveRelayAuth({
      authUrl: "http://127.0.0.1:1",
      relayUrl: "http://127.0.0.1:1",
      token: "sess-1",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });

    // 1. Failing relay connection must not leave an orphan invite in activeOffer("relay").
    const failingHost = new SubspaceHost({
      store,
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:1",
      dispatch: async () => new Response("ok"),
    });
    cleanups.push(() => failingHost.stop());
    await expect(failingHost.createPairingOffer({ mode: "relay" })).rejects.toThrow();
    expect(failingHost.activeOffer("relay")).toBeNull();
    await failingHost.stop();

    // 2. Fresh relay connection sends invite_create only once (not in both host_hello_ack and createPairingOffer).
    const relayKp = await generateX25519KeyPair();
    const relayPriv = await importX25519PrivateKey(relayKp.privateKeyPkcs8B64);
    const inviteCreates: string[] = [];

    const httpServer = createServer((req, res) => {
      if (req.url === "/api/auth/token") {
        const exp = Math.floor(Date.now() / 1000) + 300;
        const header = Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({ exp, sub: "alice" })).toString("base64url");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: `${header}.${payload}.sig` }));
        return;
      }
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req, socket, head) => {
      if (req.url === RELAY_PATHS.HOST_CONTROL) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      } else {
        socket.destroy();
      }
    });
    wss.on("connection", (ws) => {
      let relayHostId = "";
      let expectedProof = "";
      ws.on("message", async (raw) => {
        const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        if (msg.type === "host_hello") {
          relayHostId = String(msg.relayHostId);
          const challengeB64 = Buffer.from("challenge-32-bytes-0123456789abc").toString("base64");
          expectedProof = await computeRelayControlProof(
            relayPriv,
            String(msg.hostPublicKeyB64),
            challengeB64,
            "alice",
          );
          ws.send(
            JSON.stringify({
              type: "host_challenge",
              challengeB64,
              relayEphPubB64: relayKp.publicKeyB64,
              userId: "alice",
            }),
          );
        } else if (msg.type === "host_challenge_ack") {
          expect(msg.proofB64).toBe(expectedProof);
          ws.send(JSON.stringify({ type: "host_hello_ack", relayHostId, userId: "alice" }));
        } else if (msg.type === "invite_create") {
          inviteCreates.push(String(msg.inviteId));
          ws.send(JSON.stringify({ type: "invite_created", inviteId: msg.inviteId }));
        }
      });
    });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of wss.clients) client.terminate();
          wss.close(() => httpServer.close(() => resolve()));
        }),
    );

    store.saveRelayAuth({
      authUrl: baseUrl,
      relayUrl: baseUrl,
      token: "sess-1",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });
    const host = new SubspaceHost({
      store,
      serverVersion: () => "0.19.0",
      relayUrl: () => baseUrl,
      dispatch: async () => new Response("ok"),
    });
    cleanups.push(() => host.stop());

    await host.createPairingOffer({ mode: "relay" });
    await new Promise((r) => setTimeout(r, 30));
    expect(inviteCreates).toHaveLength(1);
  });

  test("SubspaceHost createPairingOffer surfaces coded relay-unreachable, relay-auth-expired, and relay-auth-rejected errors", async () => {
    const dir = tempDir("subspace-relay-error-codes-");
    const store = new SubspaceStore(dir);

    // 1. Auth server is up and mints a JWT, while Relay port is closed -> relay-unreachable.
    type Mode = "ws-refused" | "ws-unauthorized" | "auth-401" | "auth-cf-403" | "cached-retry";
    let mode: Mode = "ws-refused";
    let tokenCalls = 0;
    let firstJwt = "";
    const seenWsAuths: (string | undefined)[] = [];
    const activeControlSockets = new Set<import("ws").default>();
    const relayKp = await generateX25519KeyPair();

    const attachControlResponder = (ws: import("ws").default) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf8")) as {
          type: string;
          inviteId?: string;
        };
        if (msg.type === "host_hello") {
          ws.send(
            JSON.stringify({
              type: "host_challenge",
              challengeB64: Buffer.from("c").toString("base64"),
              relayEphPubB64: relayKp.publicKeyB64,
              userId: "alice",
            }),
          );
        } else if (msg.type === "host_challenge_ack") {
          ws.send(
            JSON.stringify({
              type: "host_hello_ack",
              relayHostId: "host_1234",
              userId: "alice",
            }),
          );
        } else if (msg.type === "invite_create") {
          ws.send(JSON.stringify({ type: "invite_created", inviteId: msg.inviteId }));
        }
      });
    };

    const closedPortServer = createServer();
    await new Promise<void>((resolve) => closedPortServer.listen(0, "127.0.0.1", resolve));
    const closedAddr = closedPortServer.address();
    if (!closedAddr || typeof closedAddr === "string") throw new Error("expected address");
    const closedRelayUrl = `http://127.0.0.1:${closedAddr.port}`;
    await new Promise<void>((resolve) => closedPortServer.close(() => resolve()));

    const makeJwt = (label: string) => {
      const exp = Math.floor(Date.now() / 1000) + 300;
      const header = Buffer.from(JSON.stringify({ alg: "EdDSA", label })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ exp, sub: "alice" })).toString("base64url");
      return `${header}.${payload}.sig`;
    };

    const authAndRelayServer = createServer((req, res) => {
      if (req.url === "/api/auth/token") {
        if (mode === "auth-401") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        if (mode === "auth-cf-403") {
          res.writeHead(403, {
            "content-type": "text/html; charset=utf-8",
            "cf-mitigated": "challenge",
          });
          res.end("<html><body>Just a moment...</body></html>");
          return;
        }
        tokenCalls += 1;
        const jwt = makeJwt(`jwt-${tokenCalls}`);
        if (tokenCalls === 1) firstJwt = jwt;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: jwt }));
        return;
      }
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ noServer: true });
    authAndRelayServer.on("upgrade", (req, socket, head) => {
      if (req.url === RELAY_PATHS.HOST_CONTROL) {
        seenWsAuths.push(req.headers.authorization);
        wss.handleUpgrade(req, socket, head, (ws) => {
          if (mode === "ws-unauthorized") {
            ws.close(RELAY_CLOSE_CODE.UNAUTHORIZED, "Unauthorized");
            return;
          }
          if (mode === "cached-retry") {
            if (req.headers.authorization === `Bearer ${firstJwt}`) {
              // Accept the first connection for jwt-1 to warm #cachedRelayJwt, then reject jwt-1 after disconnect.
              if (seenWsAuths.length === 1) {
                activeControlSockets.add(ws);
                attachControlResponder(ws);
                return;
              }
              ws.close(RELAY_CLOSE_CODE.UNAUTHORIZED, "Stale JWT");
              return;
            }
            attachControlResponder(ws);
            return;
          }
        });
        if (mode !== "ws-refused") return;
      }
      socket.destroy();
    });
    await new Promise<void>((resolve) => authAndRelayServer.listen(0, "127.0.0.1", resolve));
    const authAddr = authAndRelayServer.address();
    if (!authAddr || typeof authAddr === "string") throw new Error("expected auth address");
    const serverBaseUrl = `http://127.0.0.1:${authAddr.port}`;
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of wss.clients) client.terminate();
          wss.close(() => authAndRelayServer.close(() => resolve()));
        }),
    );

    store.saveRelayAuth({
      authUrl: serverBaseUrl,
      relayUrl: closedRelayUrl,
      token: "sess-1",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });
    const hostUnreachable = new SubspaceHost({
      store,
      serverVersion: () => "0.22.0",
      relayUrl: () => closedRelayUrl,
      dispatch: async () => new Response("ok"),
    });
    cleanups.push(() => hostUnreachable.stop());

    await expect(hostUnreachable.createPairingOffer({ mode: "relay" })).rejects.toMatchObject({
      code: "relay-unreachable",
    });
    expect(hostUnreachable.relayError).toContain(closedRelayUrl);
    await hostUnreachable.stop();

    // 2. Freshly minted JWT rejected with UNAUTHORIZED (4401) -> relay-auth-rejected (not "Sign in first").
    mode = "ws-unauthorized";
    store.saveRelayAuth({
      authUrl: serverBaseUrl,
      relayUrl: serverBaseUrl,
      token: "sess-1",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });
    const hostUnauthorized = new SubspaceHost({
      store,
      serverVersion: () => "0.22.0",
      relayUrl: () => serverBaseUrl,
      dispatch: async () => new Response("ok"),
    });
    cleanups.push(() => hostUnauthorized.stop());

    await expect(hostUnauthorized.createPairingOffer({ mode: "relay" })).rejects.toMatchObject({
      code: "relay-auth-rejected",
    });
    expect(hostUnauthorized.relayError).toContain("Relay rejected authentication");
    expect(hostUnauthorized.relayError).toContain("Unauthorized");
    await hostUnauthorized.stop();

    // 3. /api/auth/token 401 -> relay-auth-expired; HTML/cf-mitigated 403 -> non-expired error.
    mode = "auth-cf-403";
    await expect(mintRelayJwt(serverBaseUrl, "sess-1")).rejects.toThrow(
      "Could not mint relay JWT (403)",
    );

    mode = "auth-401";
    const hostExpired = new SubspaceHost({
      store,
      serverVersion: () => "0.22.0",
      relayUrl: () => serverBaseUrl,
      dispatch: async () => new Response("ok"),
    });
    cleanups.push(() => hostExpired.stop());

    await expect(hostExpired.createPairingOffer({ mode: "relay" })).rejects.toMatchObject({
      code: "relay-auth-expired",
    });
    await hostExpired.stop();

    // 4. Cached JWT rejected with 4401 re-mints once and connects without failing.
    mode = "cached-retry";
    tokenCalls = 0;
    seenWsAuths.length = 0;
    activeControlSockets.clear();
    let sawConnected = false;
    let resolveDisconnect!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      resolveDisconnect = resolve;
    });
    const hostCached = new SubspaceHost({
      store,
      serverVersion: () => "0.22.0",
      relayUrl: () => serverBaseUrl,
      dispatch: async () => new Response("ok"),
      onEvent: (event) => {
        if (event.type !== "relay-state") return;
        if (event.connected) sawConnected = true;
        else if (sawConnected) resolveDisconnect();
      },
    });
    cleanups.push(() => hostCached.stop());

    await hostCached.createPairingOffer({ mode: "relay" });
    for (const sock of activeControlSockets) sock.close(1012, "Restart");
    await disconnected;
    const retriedOffer = await hostCached.createPairingOffer({ mode: "relay", rotate: true });
    expect(retriedOffer.mode).toBe("relay");
    expect(tokenCalls).toBe(2);
    expect(seenWsAuths).toHaveLength(3);
  });

  test("completeDeviceAuthorization uses a readable fallback instead of [object Object] on empty error_description", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ error: "", error_description: "" }, { status: 400 }),
    );
    const result = await completeDeviceAuthorization({
      authUrl: "http://127.0.0.1:9999",
      deviceCode: "dev-code",
      intervalSec: 0.01,
      expiresAt: Date.now() + 5_000,
    });
    expect(result).toEqual({ status: "error", message: "Relay sign-in failed" });
  });

  test("Relay credentials are domain-separated from E2EE secrets and cannot be replayed in e2ee_auth", async () => {
    const dir = tempDir("subspace-relay-sep-");
    const store = new SubspaceStore(dir);
    const relayKp = await generateX25519KeyPair();

    const seenInviteHashes: string[] = [];
    const seenDeviceHashes: { grantId: string; tokenHash: string }[] = [];
    const seenClientCredentials: Record<string, unknown>[] = [];
    const controlSockets = new Map<string, import("ws").WebSocket>();
    const pendingClients = new Map<string, import("ws").WebSocket>();

    const httpServer = createServer((req, res) => {
      if (req.url === "/api/auth/token") {
        const exp = Math.floor(Date.now() / 1000) + 300;
        const h = Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url");
        const p = Buffer.from(JSON.stringify({ exp, sub: "alice" })).toString("base64url");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: `${h}.${p}.sig` }));
        return;
      }
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (req.url === RELAY_PATHS.HOST_CONTROL) {
          let relayHostId = "";
          ws.on("message", (raw) => {
            const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
            if (msg.type === "host_hello") {
              relayHostId = String(msg.relayHostId);
              ws.send(
                JSON.stringify({
                  type: "host_challenge",
                  challengeB64: Buffer.from("c").toString("base64"),
                  relayEphPubB64: relayKp.publicKeyB64,
                  userId: "alice",
                }),
              );
            } else if (msg.type === "host_challenge_ack") {
              controlSockets.set(relayHostId, ws);
              ws.send(JSON.stringify({ type: "host_hello_ack", relayHostId, userId: "alice" }));
            } else if (msg.type === "invite_create") {
              seenInviteHashes.push(String(msg.ticketHash));
              ws.send(JSON.stringify({ type: "invite_created", inviteId: msg.inviteId }));
            } else if (msg.type === "device_install") {
              seenDeviceHashes.push({
                grantId: String(msg.grantId),
                tokenHash: String(msg.tokenHash),
              });
              ws.send(JSON.stringify({ type: "device_installed", grantId: msg.grantId }));
            }
          });
        } else if (req.url === RELAY_PATHS.CLIENT_CONNECT) {
          ws.once("message", (raw) => {
            const auth = JSON.parse(raw.toString("utf8")) as {
              relayHostId: string;
              credential: Record<string, unknown>;
            };
            seenClientCredentials.push(auth.credential);
            const sessionId = `sess-${seenClientCredentials.length}`;
            pendingClients.set(sessionId, ws);
            controlSockets
              .get(auth.relayHostId)
              ?.send(JSON.stringify({ type: "connection_open", sessionId, grantId: null }));
          });
        } else if (req.url === RELAY_PATHS.HOST_DATA) {
          ws.once("message", (raw) => {
            const dataAuth = JSON.parse(raw.toString("utf8")) as { sessionId: string };
            const clientWs = pendingClients.get(dataAuth.sessionId)!;
            pendingClients.delete(dataAuth.sessionId);
            clientWs.on("message", (d, isBin) => ws.send(d, { binary: isBin }));
            ws.on("message", (d, isBin) => clientWs.send(d, { binary: isBin }));
            clientWs.send(JSON.stringify({ type: "relay_ready", sessionId: dataAuth.sessionId }));
          });
        }
      });
    });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const c of wss.clients) c.terminate();
          wss.close(() => httpServer.close(() => resolve()));
        }),
    );

    store.saveRelayAuth({
      authUrl: baseUrl,
      relayUrl: baseUrl,
      token: "sess-alice",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });
    const host = new SubspaceHost({
      store,
      serverVersion: () => "0.19.0",
      relayUrl: () => baseUrl,
      dispatch: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => host.stop());

    const offer = await host.createPairingOffer({ mode: "relay" });
    const expectedRelayTicket = await deriveRelayInviteToken(offer.ticket);
    expect(expectedRelayTicket).not.toBe(offer.ticket);
    expect(seenInviteHashes[0]).toBe(await sha256Hex(utf8Encode(expectedRelayTicket)));

    // Relay sees only derived relayTicket, never raw offer.ticket.
    const { performPairingHandshake } = await import("../src/index.ts");
    const paired = await performPairingHandshake(offer, { clientName: "Relay Phone" });
    expect(seenClientCredentials[0]).toEqual({
      kind: "invite",
      relayTicket: expectedRelayTicket,
    });
    paired.tunnel.mux.close();
    paired.tunnel.ws.close();

    // Relay sees only derived relayToken and its hash, never raw deviceToken.
    await vi.waitFor(() => expect(seenDeviceHashes).toHaveLength(1));
    const expectedRelayDeviceToken = await deriveRelayDeviceToken(paired.deviceToken);
    expect(expectedRelayDeviceToken).not.toBe(paired.deviceToken);
    expect(seenDeviceHashes[0]?.tokenHash).toBe(
      await sha256Hex(utf8Encode(expectedRelayDeviceToken)),
    );

    const client = new SubspaceClient({
      id: "srv-relay-sep",
      name: "Relay Host",
      hostPublicKeyB64: offer.hostPublicKeyB64,
      grantId: paired.grantId,
      deviceToken: paired.deviceToken,
      mode: "relay",
      relay: offer.relay,
      addedAt: Date.now(),
      lastConnectedAt: null,
      lastVersion: null,
    });
    cleanups.push(() => client.stop());
    await client.connect();
    expect(seenClientCredentials[1]).toEqual({
      kind: "device",
      grantId: paired.grantId,
      relayToken: expectedRelayDeviceToken,
    });
    client.stop();

    // A rogue Relay cannot replay `relayToken` inside an encrypted `e2ee_auth` handshake.
    const directPort = await host.startDirect(0);
    const replayWs = new (await import("ws")).default(`ws://127.0.0.1:${directPort}/v1/subspace`);
    await new Promise<void>((resolve) => replayWs.once("open", () => resolve()));
    const hs = await startClientHandshake(offer.hostPublicKeyB64);
    replayWs.send(hs.helloRaw);
    const readyRaw = await new Promise<string>((resolve) =>
      replayWs.once("message", (d) => resolve(d.toString("utf8"))),
    );
    const session = await hs.finish(readyRaw);
    await session.sendJson(
      {
        type: "e2ee_auth",
        kind: "token",
        grantId: paired.grantId,
        deviceToken: expectedRelayDeviceToken,
        authBinding: session.authBinding,
      },
      (sealed) => replayWs.send(sealed),
    );
    const authResRaw = await new Promise<Uint8Array>((resolve) =>
      replayWs.once("message", (d) => resolve(new Uint8Array(d as Buffer))),
    );
    const authRes = await session.openJson<{ ok: boolean; code?: string }>(authResRaw);
    expect(authRes).toMatchObject({ ok: false, code: "invalid-token" });
    replayWs.close();
  });

  test("SubspaceClient stops reconnecting when Relay closes with 4401 UNAUTHORIZED", async () => {
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      path: RELAY_PATHS.CLIENT_CONNECT,
    });
    cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const addr = wss.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    let attempts = 0;
    wss.on("connection", (ws) => {
      attempts += 1;
      ws.once("message", () => {
        ws.close(RELAY_CLOSE_CODE.UNAUTHORIZED, "Revoked or invalid device token");
      });
    });

    const kp = await generateX25519KeyPair();
    const client = new SubspaceClient({
      id: "srv-revoked-relay",
      name: "Revoked Relay",
      hostPublicKeyB64: kp.publicKeyB64,
      grantId: "g-revoked",
      deviceToken: "tok-revoked",
      mode: "relay",
      relay: { url: `http://127.0.0.1:${port}`, relayHostId: "host_id_12345678" },
      addedAt: Date.now(),
      lastConnectedAt: null,
      lastVersion: null,
    });
    cleanups.push(() => client.stop());

    client.start();
    await vi.waitFor(() => {
      expect(client.state).toBe("error");
      expect(client.lastError).toBe("Device access was revoked");
    });
    // Wait past initial 500ms reconnect backoff to prove reconnect loop did not reschedule.
    await new Promise((r) => setTimeout(r, 650));
    expect(attempts).toBe(1);
  });

  test("updateShareSettings clears invites, rejects pairing when shareMode is off, and stops direct listener when switching away without direct grants", async () => {
    const hostDir = tempDir("subspace-share-gate-host-");
    const clientDir = tempDir("subspace-share-gate-client-");

    const hostManager = new SubspaceManager({
      dataHome: hostDir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      dispatchLocal: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => hostManager.stop());

    const offer1 = await hostManager.createShareOffer({
      mode: "direct",
      address: "127.0.0.1",
      port: 0,
    });
    const clientManager = new SubspaceManager({
      dataHome: clientDir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      dispatchLocal: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => clientManager.stop());

    // Pair one client so a direct grant keeps the direct listener open even when shareMode becomes "off".
    await clientManager.pairServer({ code: offer1.pairingUrl, activate: true });

    const offer2 = await hostManager.createShareOffer({ mode: "direct", rotate: true });
    const offState = await hostManager.updateShareSettings({ shareMode: "off" });
    expect(offState.share.listening).toBe(true);
    expect(offState.share.activeOffer).toBeNull();
    expect(hostManager.host.activeOffer("direct")).toBeNull();

    await expect(clientManager.pairServer({ code: offer2.pairingUrl })).rejects.toMatchObject({
      code: "pairing-failed",
    });

    // Without grants, switching from direct to relay stops the direct listener.
    const freshHostDir = tempDir("subspace-share-switch-");
    const freshManager = new SubspaceManager({
      dataHome: freshHostDir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      dispatchLocal: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => freshManager.stop());
    freshManager.store.saveRelayAuth({
      authUrl: "http://127.0.0.1:1",
      relayUrl: "http://127.0.0.1:1",
      token: "sess-1",
      user: { id: "u1", name: "User", email: "u@example.com", image: null },
      savedAt: Date.now(),
    });
    await freshManager.updateShareSettings({ shareMode: "direct", directPort: 0 });
    expect(freshManager.host.listening).toBe(true);
    await freshManager.updateShareSettings({ shareMode: "relay" });
    expect(freshManager.host.listening).toBe(false);
  });

  test("activeCalls blocks server switching/removal on tunneled calls, and disconnectServer blocks auto-reconnect", async () => {
    const hostDir1 = tempDir("subspace-call-host1-");
    const hostDir2 = tempDir("subspace-call-host2-");
    const clientDir = tempDir("subspace-call-client-");

    const udpSock = createSocket("udp4");
    cleanups.push(() => {
      udpSock.close();
    });
    await new Promise<void>((resolve) => udpSock.bind(0, "127.0.0.1", () => resolve()));
    const udpPort = udpSock.address().port;
    const sdp = [
      "v=0",
      "o=- 1 1 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "c=IN IP4 127.0.0.1",
      `a=candidate:1 1 udp 2122260223 127.0.0.1 ${udpPort} typ host generation 0`,
      "a=end-of-candidates",
      "",
    ].join("\r\n");

    const host1 = new SubspaceHost({
      store: new SubspaceStore(hostDir1),
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: async (req) => {
        if (req.method === "POST" && new URL(req.url).pathname === "/api/offer") {
          return Response.json({ pc_id: "pc-call-1", sdp });
        }
        return Response.json({ ok: true });
      },
    });
    const host2 = new SubspaceHost({
      store: new SubspaceStore(hostDir2),
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: async () => Response.json({ ok: true }),
    });
    cleanups.push(
      () => host1.stop(),
      () => host2.stop(),
    );

    const p1 = await host1.startDirect(0);
    const p2 = await host2.startDirect(0);
    const o1 = await host1.createPairingOffer({ mode: "direct", address: "127.0.0.1", port: p1 });
    const o2 = await host2.createPairingOffer({ mode: "direct", address: "127.0.0.1", port: p2 });

    const manager = new SubspaceManager({
      dataHome: clientDir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      dispatchLocal: async () => new Response("local"),
    });
    cleanups.push(() => manager.stop());

    const pair1 = await manager.pairServer({ code: encodePairingUrl(o1), activate: true });
    expect(pair1.pairedServerId).toBe(pair1.activeHostId);

    // Start a tunneled WebRTC call via POST /api/offer.
    const offerRes = await manager.proxyToActive(
      new Request("http://127.0.0.1/api/offer", { method: "POST", body: "{}" }),
      "/api/offer",
    );
    expect(offerRes.status).toBe(200);

    await expect(manager.setActiveHostId(null)).rejects.toMatchObject({ code: "call-active" });
    await expect(manager.removeServer(pair1.pairedServerId)).rejects.toMatchObject({
      code: "call-active",
    });

    // Pairing with activate: true must NOT switch away from active host while tunneled call is open.
    const pair2 = await manager.pairServer({ code: encodePairingUrl(o2), activate: true });
    expect(pair2.pairedServerId).not.toBe(pair1.pairedServerId);
    expect(pair2.activeHostId).toBe(pair1.pairedServerId);

    // Manual disconnect stops client and blocks proxyToActive from auto-reconnecting.
    await manager.disconnectServer(pair1.pairedServerId);
    await expect(
      manager.proxyToActive(new Request("http://127.0.0.1/api/local/status"), "/api/local/status"),
    ).rejects.toMatchObject({
      code: "subspace-unreachable",
      message: "Disconnected from remote server",
    });

    // Explicit connect clears manuallyDisconnected.
    await manager.connectServer(pair1.pairedServerId);
    const res = await manager.proxyToActive(
      new Request("http://127.0.0.1/api/local/status"),
      "/api/local/status",
    );
    expect(res.status).toBe(200);
  });

  test("SubspaceStore throws on corrupt JSON instead of wiping identity, grants, or servers, and guards concurrent identity creation", async () => {
    const dir = tempDir("subspace-store-corrupt-");
    const store = new SubspaceStore(dir);

    // Concurrent loadOrCreateIdentity calls resolve to the exact same keypair.
    const [id1, id2] = await Promise.all([
      store.loadOrCreateIdentity(),
      store.loadOrCreateIdentity(),
    ]);
    expect(id1.publicKeyB64).toBe(id2.publicKeyB64);
    expect(id1.privateKeyPkcs8B64).toBe(id2.privateKeyPkcs8B64);

    // saveRelayAuth(null) round-trips cleanly.
    store.saveRelayAuth(null);
    expect(store.readRelayAuth()).toBeNull();

    // Corrupt files must throw rather than silently returning null or regenerating keys.
    writeFileSync(join(store.dir, "host.json"), "{corrupt-json", "utf8");
    await expect(store.loadOrCreateIdentity()).rejects.toThrow();

    writeFileSync(join(store.dir, "grants.json"), '{"grants":"not-an-array"}', "utf8");
    expect(() => store.readGrants()).toThrow();

    writeFileSync(join(store.dir, "servers.json"), "{bad", "utf8");
    expect(() => store.readServers()).toThrow();

    writeFileSync(join(store.dir, "relay-auth.json"), "{bad", "utf8");
    expect(() => store.readRelayAuth()).toThrow();
  });

  test("SubspaceHost serializes concurrent startDirect calls without leaking listeners", async () => {
    const dir = tempDir("subspace-direct-serial-");
    const host = new SubspaceHost({
      store: new SubspaceStore(dir),
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => host.stop());

    const [p1, p2] = await Promise.all([host.startDirect(0), host.startDirect(0)]);
    expect(p1).toBe(p2);
    expect(host.listening).toBe(true);
    await host.stopDirect();
    expect(host.listening).toBe(false);
  });

  test("SubspaceManager boot recovers from corrupt JSON, logout clears corrupt auth, and directPort updates apply with shareMode off", async () => {
    const dir = tempDir("subspace-manager-resilience-");
    const store = new SubspaceStore(dir);
    mkdirSync(store.dir, { recursive: true });
    writeFileSync(join(store.dir, "host.json"), "{corrupt-host", "utf8");
    writeFileSync(join(store.dir, "servers.json"), "{corrupt-servers", "utf8");
    writeFileSync(join(store.dir, "relay-auth.json"), "{corrupt-auth", "utf8");

    const corruptMgr = new SubspaceManager({
      dataHome: dir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      dispatchLocal: async () => Response.json({ ok: true }),
      relayUrl: () => "http://127.0.0.1:0",
    });
    cleanups.push(() => corruptMgr.stop());

    // boot() must log and continue instead of crashing server startup on corrupt JSON.
    await expect(corruptMgr.boot()).resolves.toBeUndefined();

    const cleanDir = tempDir("subspace-manager-logout-port-");
    const cleanStore = new SubspaceStore(cleanDir);
    const mgr = new SubspaceManager({
      dataHome: cleanDir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      dispatchLocal: async () => Response.json({ ok: true }),
      relayUrl: () => "http://127.0.0.1:1",
      authUrl: () => "http://127.0.0.1:1",
    });
    cleanups.push(() => mgr.stop());

    cleanStore.addGrant({
      id: "g_direct_1",
      clientName: "Direct Peer",
      tokenSha256: "b".repeat(64),
      mode: "direct",
      createdAt: 1,
      lastSeenAt: null,
    });
    await mgr.updateShareSettings({ shareMode: "direct", directPort: 0 });
    const firstPort = mgr.host.directPort;
    expect(firstPort).toBeNumber();

    // Switch shareMode to off while retaining a direct grant: Direct listener stays up,
    // and changing directPort must rebind the listener to the new port.
    await mgr.updateShareSettings({ shareMode: "off" });
    expect(mgr.host.directPort).toBe(firstPort);

    const freeServer = createServer();
    await new Promise<void>((resolve) => freeServer.listen(0, "127.0.0.1", resolve));
    const addr = freeServer.address();
    const targetPort = typeof addr === "object" && addr !== null ? addr.port : 0;
    await new Promise<void>((resolve) => freeServer.close(() => resolve()));

    const updated = await mgr.updateShareSettings({ directPort: targetPort });
    expect(updated.share.listeningPort).toBe(targetPort);
    expect(mgr.host.directPort).toBe(targetPort);

    // Corrupt relay-auth.json is cleared cleanly by logoutRelayAuth.
    writeFileSync(join(cleanStore.dir, "relay-auth.json"), "{corrupt-auth", "utf8");
    const afterLogout = await mgr.logoutRelayAuth();
    expect(afterLogout.relayAuth.status).toBe("signed-out");
    expect(cleanStore.readRelayAuth()).toBeNull();

    // Unreachable auth server surfaces coded upstream-failed instead of untyped error.
    await expect(mgr.startRelayAuth()).rejects.toMatchObject({ code: "upstream-failed" });
  });

  test("createPairingOffer cancels cleanly when share state changes while relay WS connection is in flight", async () => {
    const dir = tempDir("subspace-offer-epoch-race-");
    const store = new SubspaceStore(dir);
    const kp = await generateX25519KeyPair();
    store.saveIdentity({
      hostName: "Race Host",
      publicKeyB64: kp.publicKeyB64,
      privateKeyPkcs8B64: kp.privateKeyPkcs8B64,
      shareMode: "off",
      directAddress: null,
      directPort: 0,
      createdAt: Date.now(),
    });

    const relayKp = await generateX25519KeyPair();
    const relayPriv = await importX25519PrivateKey(relayKp.privateKeyPkcs8B64);
    const inviteCreates: string[] = [];
    const ackEntered = Promise.withResolvers<void>();
    const releaseAck = Promise.withResolvers<void>();
    const inviteEntered = Promise.withResolvers<void>();
    const releaseInvite = Promise.withResolvers<void>();

    const httpServer = createServer((req, res) => {
      if (req.url === "/api/auth/token") {
        const exp = Math.floor(Date.now() / 1000) + 300;
        const header = Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({ exp, sub: "alice" })).toString("base64url");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: `${header}.${payload}.sig` }));
        return;
      }
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req, socket, head) => {
      if (req.url === RELAY_PATHS.HOST_CONTROL) {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      } else {
        socket.destroy();
      }
    });
    wss.on("connection", (ws) => {
      let relayHostId = "";
      ws.on("message", async (raw) => {
        const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        if (msg.type === "host_hello") {
          relayHostId = String(msg.relayHostId);
          const challengeB64 = Buffer.from("challenge-32-bytes-0123456789abc").toString("base64");
          await computeRelayControlProof(
            relayPriv,
            String(msg.hostPublicKeyB64),
            challengeB64,
            "alice",
          );
          ws.send(
            JSON.stringify({
              type: "host_challenge",
              challengeB64,
              relayEphPubB64: relayKp.publicKeyB64,
              userId: "alice",
            }),
          );
        } else if (msg.type === "host_challenge_ack") {
          ackEntered.resolve();
          await releaseAck.promise;
          ws.send(JSON.stringify({ type: "host_hello_ack", relayHostId, userId: "alice" }));
        } else if (msg.type === "invite_create") {
          inviteCreates.push(String(msg.inviteId));
          inviteEntered.resolve();
          await releaseInvite.promise;
          ws.send(JSON.stringify({ type: "invite_created", inviteId: msg.inviteId }));
        }
      });
    });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of wss.clients) client.terminate();
          wss.close(() => httpServer.close(() => resolve()));
        }),
    );

    store.saveRelayAuth({
      authUrl: baseUrl,
      relayUrl: baseUrl,
      token: "sess-1",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });
    const host = new SubspaceHost({
      store,
      serverVersion: () => "0.19.0",
      relayUrl: () => baseUrl,
      dispatch: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => host.stop());

    const offerPromise = host.createPairingOffer({ mode: "relay" });
    await ackEntered.promise;
    host.clearInvites();
    releaseAck.resolve();

    await expect(offerPromise).rejects.toMatchObject({ code: "pairing-failed" });
    expect(inviteCreates).toEqual([]);
    expect(host.activeOffer()).toBeNull();
    expect((await store.loadOrCreateIdentity()).shareMode).toBe("off");

    // Also test share state change during the invite_created ACK wait itself.
    const offerDuringAck = host.createPairingOffer({ mode: "relay" });
    await inviteEntered.promise;
    host.clearInvites();
    releaseInvite.resolve();

    await expect(offerDuringAck).rejects.toMatchObject({ code: "pairing-failed" });
    expect(host.activeOffer()).toBeNull();
  });

  test("invalid EIDOLON_SUBSPACE_RELAY_URL does not break getState or Direct mode and records relayError safely", async () => {
    vi.stubEnv("EIDOLON_SUBSPACE_RELAY_URL", "http://evil.example.com");
    const dir = tempDir("subspace-bad-relay-env-");
    const store = new SubspaceStore(dir);
    const mgr = new SubspaceManager({
      dataHome: dir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      dispatchLocal: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => mgr.stop());

    const initialState = await mgr.getState();
    expect(initialState.share.relayError).toBeNull();

    // Direct pairing must continue working even when EIDOLON_SUBSPACE_RELAY_URL is misconfigured.
    const offerSnap = await mgr.createShareOffer({ mode: "direct", address: "127.0.0.1", port: 0 });
    expect(offerSnap.state.share.activeOffer?.mode).toBe("direct");

    // Bad relay URL surfaces bad-request on startRelayAuth and records relayError on relay connect.
    await expect(mgr.startRelayAuth()).rejects.toMatchObject({ code: "bad-request" });

    store.saveRelayAuth({
      authUrl: "https://id.laplace.live",
      relayUrl: "http://evil.example.com",
      token: "tok",
      user: { id: "u1", name: "User", email: "user@example.com", image: null },
      savedAt: Date.now(),
    });
    const relayHost = new SubspaceHost({
      store,
      serverVersion: () => "0.19.0",
      relayUrl: () => subspaceRelayUrl(),
      dispatch: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => relayHost.stop());

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ token: "h.p.s", expiresAt: Date.now() + 60_000 }),
    );
    relayHost.startRelay();
    await vi.waitFor(() => {
      expect(relayHost.relayError).toContain("https/wss or loopback");
    });
  });

  test("SubspaceManager honors custom relayUrl saved in relay-auth.json when no env override is set", async () => {
    vi.stubEnv("EIDOLON_SUBSPACE_RELAY_URL", "");
    const dir = tempDir("subspace-saved-relay-url-");
    const store = new SubspaceStore(dir);
    const relayKp = await generateX25519KeyPair();
    const relayPriv = await importX25519PrivateKey(relayKp.privateKeyPkcs8B64);
    const inviteCreates: string[] = [];

    const httpServer = createServer((req, res) => {
      if (req.url === "/api/auth/token") {
        const exp = Math.floor(Date.now() / 1000) + 300;
        const header = Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({ exp, sub: "alice" })).toString("base64url");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: `${header}.${payload}.sig` }));
        return;
      }
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req, socket, head) => {
      if (req.url === RELAY_PATHS.HOST_CONTROL) {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      } else {
        socket.destroy();
      }
    });
    wss.on("connection", (ws) => {
      let relayHostId = "";
      ws.on("message", async (raw) => {
        const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        if (msg.type === "host_hello") {
          relayHostId = String(msg.relayHostId);
          const challengeB64 = Buffer.from("challenge-32-bytes-0123456789abc").toString("base64");
          await computeRelayControlProof(
            relayPriv,
            String(msg.hostPublicKeyB64),
            challengeB64,
            "alice",
          );
          ws.send(
            JSON.stringify({
              type: "host_challenge",
              challengeB64,
              relayEphPubB64: relayKp.publicKeyB64,
              userId: "alice",
            }),
          );
        } else if (msg.type === "host_challenge_ack") {
          ws.send(JSON.stringify({ type: "host_hello_ack", relayHostId, userId: "alice" }));
        } else if (msg.type === "invite_create") {
          inviteCreates.push(String(msg.inviteId));
          ws.send(JSON.stringify({ type: "invite_created", inviteId: msg.inviteId }));
        }
      });
    });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const customRelayUrl = `http://127.0.0.1:${port}`;
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of wss.clients) client.terminate();
          wss.close(() => httpServer.close(() => resolve()));
        }),
    );

    store.saveRelayAuth({
      authUrl: customRelayUrl,
      relayUrl: customRelayUrl,
      token: "sess-custom",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });

    const mgr = new SubspaceManager({
      dataHome: dir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      dispatchLocal: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => mgr.stop());

    const snap = await mgr.getState();
    expect(snap.relayAuth.relayUrl).toBe(customRelayUrl);

    const offerSnap = await mgr.createShareOffer({ mode: "relay" });
    const parsed = parsePairingInput(offerSnap.pairingUrl);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.offer.relay?.url).toBe(customRelayUrl);
    }
    expect(inviteCreates).toHaveLength(1);
  });

  test("SubspaceStore recovers custom relayUrl from partially corrupt JSON and fails with bad-request on unparseable relay-auth.json", async () => {
    vi.stubEnv("EIDOLON_SUBSPACE_RELAY_URL", "");
    const dir = tempDir("subspace-corrupt-relay-url-");
    const store = new SubspaceStore(dir);
    mkdirSync(store.dir, { recursive: true });

    // Partially corrupt JSON still preserves a valid custom relayUrl.
    writeFileSync(
      join(store.dir, "relay-auth.json"),
      JSON.stringify({ relayUrl: "https://custom.relay.example/", token: "" }),
      "utf8",
    );
    expect(store.readSavedRelayUrl()).toBe("https://custom.relay.example");

    const mgr = new SubspaceManager({
      dataHome: dir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      dispatchLocal: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => mgr.stop());
    const recoveredState = await mgr.getState();
    expect(recoveredState.relayAuth.relayUrl).toBe("https://custom.relay.example");
    expect(recoveredState.relayAuth.status).toBe("signed-out");

    // Unparseable JSON fails explicitly instead of silently falling back to the default relay,
    // yet non-relay updateShareSettings edits (renaming host, switching Direct/Off) still work.
    await mgr.updateShareSettings({
      shareMode: "direct",
      directAddress: "127.0.0.1",
      directPort: 0,
    });
    await mgr.createShareOffer({ mode: "direct", address: "127.0.0.1", port: 0 });
    writeFileSync(
      join(store.dir, "grants.json"),
      JSON.stringify({
        grants: [
          {
            id: "g-relay-1",
            clientName: "Phone",
            tokenSha256: "a".repeat(64),
            mode: "relay",
            createdAt: Date.now(),
            lastSeenAt: null,
          },
        ],
      }),
      "utf8",
    );
    writeFileSync(join(store.dir, "relay-auth.json"), "{not-json", "utf8");
    expect(() => store.readSavedRelayUrl()).toThrowError(/corrupted/i);
    await expect(mgr.startRelayAuth()).rejects.toMatchObject({ code: "bad-request" });
    await expect(mgr.createShareOffer({ mode: "relay" })).rejects.toMatchObject({
      code: "bad-request",
    });
    await expect(mgr.updateShareSettings({ shareMode: "relay" })).rejects.toMatchObject({
      code: "bad-request",
    });

    const renamedState = await mgr.updateShareSettings({ hostName: "Renamed Direct" });
    expect(renamedState.share.hostName).toBe("Renamed Direct");
    const turnedOff = await mgr.updateShareSettings({ shareMode: "off" });
    expect(turnedOff.share.shareMode).toBe("off");
    expect(turnedOff.share.activeOffer).toBeNull();
    const corruptState = await mgr.getState();
    expect(corruptState.relayAuth.status).toBe("signed-out");
  });

  test("SubspaceHost reconnects when saved relayUrl changes and keeps invites/data channels on the active relay", async () => {
    vi.stubEnv("EIDOLON_SUBSPACE_RELAY_URL", "");
    const dir = tempDir("subspace-switch-relay-");
    const store = new SubspaceStore(dir);
    const relayKp = await generateX25519KeyPair();
    const relayPriv = await importX25519PrivateKey(relayKp.privateKeyPkcs8B64);

    async function startMockRelay() {
      const inviteIds: string[] = [];
      const controlSockets = new Set<import("ws").WebSocket>();
      const dataConnections: string[] = [];
      let closedCount = 0;

      const httpServer = createServer((req, res) => {
        if (req.url === "/api/auth/token") {
          const exp = Math.floor(Date.now() / 1000) + 300;
          const header = Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url");
          const payload = Buffer.from(JSON.stringify({ exp, sub: "alice" })).toString("base64url");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ token: `${header}.${payload}.sig` }));
          return;
        }
        res.writeHead(404).end();
      });
      const wss = new WebSocketServer({ noServer: true });
      httpServer.on("upgrade", (req, socket, head) => {
        if (req.url === RELAY_PATHS.HOST_CONTROL || req.url === RELAY_PATHS.HOST_DATA) {
          wss.handleUpgrade(req, socket, head, (ws) => {
            if (req.url === RELAY_PATHS.HOST_CONTROL) {
              controlSockets.add(ws);
              let relayHostId = "";
              ws.on("close", () => {
                controlSockets.delete(ws);
                closedCount += 1;
              });
              ws.on("message", async (raw) => {
                const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
                if (msg.type === "host_hello") {
                  relayHostId = String(msg.relayHostId);
                  const challengeB64 = Buffer.from("challenge-32-bytes-0123456789abc").toString(
                    "base64",
                  );
                  await computeRelayControlProof(
                    relayPriv,
                    String(msg.hostPublicKeyB64),
                    challengeB64,
                    "alice",
                  );
                  ws.send(
                    JSON.stringify({
                      type: "host_challenge",
                      challengeB64,
                      relayEphPubB64: relayKp.publicKeyB64,
                      userId: "alice",
                    }),
                  );
                } else if (msg.type === "host_challenge_ack") {
                  ws.send(JSON.stringify({ type: "host_hello_ack", relayHostId, userId: "alice" }));
                } else if (msg.type === "invite_create") {
                  inviteIds.push(String(msg.inviteId));
                  ws.send(JSON.stringify({ type: "invite_created", inviteId: msg.inviteId }));
                }
              });
            } else {
              ws.once("message", (raw) => {
                const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
                if (msg.type === "host_data_auth") {
                  dataConnections.push(String(msg.sessionId));
                }
              });
            }
          });
        } else {
          socket.destroy();
        }
      });

      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      const url = `http://127.0.0.1:${port}`;
      cleanups.push(
        () =>
          new Promise<void>((resolve) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => httpServer.close(() => resolve()));
          }),
      );
      return {
        url,
        inviteIds,
        dataConnections,
        closedCount: () => closedCount,
        sendConnectionOpen: (sessionId: string) => {
          for (const ws of controlSockets) {
            ws.send(JSON.stringify({ type: "connection_open", sessionId, grantId: null }));
          }
        },
      };
    }

    const relayA = await startMockRelay();
    const relayB = await startMockRelay();
    const relayC = await startMockRelay();

    store.saveRelayAuth({
      authUrl: relayA.url,
      relayUrl: relayA.url,
      token: "sess-a",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });

    const mgr = new SubspaceManager({
      dataHome: dir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      dispatchLocal: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => mgr.stop());

    const offerA = await mgr.createShareOffer({ mode: "relay" });
    const parsedA = parsePairingInput(offerA.pairingUrl);
    expect(parsedA.ok && parsedA.offer.relay?.url).toBe(relayA.url);
    expect(relayA.inviteIds).toHaveLength(1);

    // Path 1: `eidolon subspace login --relay-url B` updates settings via updateShareSettings({}).
    store.saveRelayAuth({
      authUrl: relayB.url,
      relayUrl: relayB.url,
      token: "sess-b",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });
    const switched = await mgr.updateShareSettings({});
    expect(switched.relayAuth.relayUrl).toBe(relayB.url);
    await vi.waitFor(() => {
      expect(mgr.host.activeRelayUrl).toBe(relayB.url);
      expect(mgr.host.relayConnected).toBe(true);
      expect(relayA.closedCount()).toBeGreaterThanOrEqual(1);
    });

    const offerB = await mgr.createShareOffer({ mode: "relay" });
    const parsedB = parsePairingInput(offerB.pairingUrl);
    expect(parsedB.ok && parsedB.offer.relay?.url).toBe(relayB.url);
    expect(relayB.inviteIds).toHaveLength(1);

    // Path 2: Switching to relayC and calling createShareOffer directly (without prior
    // updateShareSettings) must reconnect before capturing offerEpoch and succeed on first try.
    store.saveRelayAuth({
      authUrl: relayC.url,
      relayUrl: relayC.url,
      token: "sess-c",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });
    const offerC = await mgr.createShareOffer({ mode: "relay" });
    expect(offerC.state.relayAuth.relayUrl).toBe(relayC.url);
    expect(mgr.host.activeRelayUrl).toBe(relayC.url);
    expect(mgr.host.relayConnected).toBe(true);
    await vi.waitFor(() => {
      expect(relayB.closedCount()).toBeGreaterThanOrEqual(1);
    });
    const parsedC = parsePairingInput(offerC.pairingUrl);
    expect(parsedC.ok && parsedC.offer.relay?.url).toBe(relayC.url);
    expect(relayA.inviteIds).toHaveLength(1);
    expect(relayB.inviteIds).toHaveLength(1);
    expect(relayC.inviteIds).toHaveLength(1);

    relayC.sendConnectionOpen("sess-on-c");
    await vi.waitFor(() => {
      expect(relayC.dataConnections).toContain("sess-on-c");
    });
    expect(relayA.dataConnections).toEqual([]);
    expect(relayB.dataConnections).toEqual([]);
  });

  test("discoverRelayAuthUrl converts ws/wss relay URLs to HTTP(S), rejects ws auth URLs, and host retries on 4503 AUTH_UNAVAILABLE", async () => {
    vi.stubEnv("EIDOLON_SUBSPACE_AUTH_URL", "");
    expect(isAllowedAuthUrl("https://id.example.com")).toBe(true);
    expect(isAllowedAuthUrl("http://127.0.0.1:8788")).toBe(true);
    expect(isAllowedAuthUrl("wss://id.example.com")).toBe(false);
    expect(isAllowedAuthUrl("ws://127.0.0.1:8788")).toBe(false);
    vi.stubEnv("EIDOLON_SUBSPACE_AUTH_URL", "wss://id.example.com");
    expect(() => subspaceAuthUrl()).toThrowError(/https or loopback http/i);
    vi.stubEnv("EIDOLON_SUBSPACE_AUTH_URL", "");

    const healthServer = createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, auth: { issuer: "http://127.0.0.1:9999" } }));
        return;
      }
      if (req.url === "/api/auth/token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "h.p.s", expiresAt: Date.now() + 60_000 }));
        return;
      }
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ noServer: true });
    let controlAttempts = 0;
    const relayKp = await generateX25519KeyPair();
    const relayPriv = await importX25519PrivateKey(relayKp.privateKeyPkcs8B64);
    healthServer.on("upgrade", (req, socket, head) => {
      if (req.url === RELAY_PATHS.HOST_CONTROL) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          controlAttempts += 1;
          if (controlAttempts === 1) {
            ws.close(
              RELAY_CLOSE_CODE.AUTH_UNAVAILABLE,
              "Authentication service temporarily unavailable",
            );
            return;
          }
          let relayHostId = "";
          ws.on("message", async (raw) => {
            const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
            if (msg.type === "host_hello") {
              relayHostId = String(msg.relayHostId);
              const challengeB64 = Buffer.from("challenge-32-bytes-0123456789abc").toString(
                "base64",
              );
              await computeRelayControlProof(
                relayPriv,
                String(msg.hostPublicKeyB64),
                challengeB64,
                "alice",
              );
              ws.send(
                JSON.stringify({
                  type: "host_challenge",
                  challengeB64,
                  relayEphPubB64: relayKp.publicKeyB64,
                  userId: "alice",
                }),
              );
            } else if (msg.type === "host_challenge_ack") {
              ws.send(JSON.stringify({ type: "host_hello_ack", relayHostId, userId: "alice" }));
            }
          });
        });
      } else {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve) => healthServer.listen(0, "127.0.0.1", resolve));
    const addr = healthServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const c of wss.clients) c.terminate();
          wss.close(() => healthServer.close(() => resolve()));
        }),
    );

    expect(await discoverRelayAuthUrl(`ws://127.0.0.1:${port}`)).toBe("http://127.0.0.1:9999");

    const dir = tempDir("subspace-4503-retry-");
    const store = new SubspaceStore(dir);
    store.saveRelayAuth({
      authUrl: `http://127.0.0.1:${port}`,
      relayUrl: `ws://127.0.0.1:${port}`,
      token: "sess-1",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });
    const host = new SubspaceHost({
      store,
      serverVersion: () => "0.19.0",
      dispatch: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => host.stop());

    // First attempt receives 4503 AUTH_UNAVAILABLE; createPairingOffer must wait through backoff
    // reconnect rather than prematurely reusing an unestablished relay state.
    const offer = await host.createPairingOffer({ mode: "relay" });
    expect(controlAttempts).toBeGreaterThanOrEqual(2);
    expect(host.relayConnected).toBe(true);
    expect(offer.relay?.url).toBe(`ws://127.0.0.1:${port}`);
  });

  test("host_hello_ack restores prior invites before waking createPairingOffer so fresh invites arrive last", async () => {
    const healthServer = createServer((req, res) => {
      if (req.url === "/api/auth/token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "h.p.s", expiresAt: Date.now() + 60_000 }));
        return;
      }
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ noServer: true });
    let controlAttempts = 0;
    let firstSocket: import("ws").WebSocket | null = null;
    const invitesByAttempt: string[][] = [];
    const relayKp = await generateX25519KeyPair();
    const relayPriv = await importX25519PrivateKey(relayKp.privateKeyPkcs8B64);

    healthServer.on("upgrade", (req, socket, head) => {
      if (req.url !== RELAY_PATHS.HOST_CONTROL) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const attemptIndex = controlAttempts;
        controlAttempts += 1;
        if (attemptIndex === 0) firstSocket = ws;
        const sentInvites: string[] = [];
        invitesByAttempt.push(sentInvites);
        let relayHostId = "";
        ws.on("message", async (raw) => {
          const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          if (msg.type === "host_hello") {
            relayHostId = String(msg.relayHostId);
            const challengeB64 = Buffer.from("challenge-32-bytes-0123456789abc").toString("base64");
            await computeRelayControlProof(
              relayPriv,
              String(msg.hostPublicKeyB64),
              challengeB64,
              "alice",
            );
            ws.send(
              JSON.stringify({
                type: "host_challenge",
                challengeB64,
                relayEphPubB64: relayKp.publicKeyB64,
                userId: "alice",
              }),
            );
          } else if (msg.type === "host_challenge_ack") {
            ws.send(JSON.stringify({ type: "host_hello_ack", relayHostId, userId: "alice" }));
          } else if (msg.type === "invite_create") {
            sentInvites.push(String(msg.ticketHash));
            ws.send(JSON.stringify({ type: "invite_created", inviteId: String(msg.inviteId) }));
          }
        });
      });
    });
    await new Promise<void>((resolve) => healthServer.listen(0, "127.0.0.1", resolve));
    const addr = healthServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const c of wss.clients) c.terminate();
          wss.close(() => healthServer.close(() => resolve()));
        }),
    );

    const dir = tempDir("subspace-invite-order-");
    const store = new SubspaceStore(dir);
    store.saveRelayAuth({
      authUrl: `http://127.0.0.1:${port}`,
      relayUrl: `ws://127.0.0.1:${port}`,
      token: "sess-1",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });
    const host = new SubspaceHost({
      store,
      serverVersion: () => "0.19.0",
      dispatch: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => host.stop());

    const offer1 = await host.createPairingOffer({ mode: "relay" });
    const hash1 = await sha256Hex(utf8Encode(await deriveRelayInviteToken(offer1.ticket)));
    expect(invitesByAttempt[0]).toEqual([hash1]);
    expect(firstSocket).not.toBeNull();

    // Drop the relay control connection and immediately request a replacement offer before
    // reconnect completes: restored offer1 must be sent before (never after) fresh offer2.
    (firstSocket as unknown as { close(code: number, reason: string): void }).close(
      1012,
      "restart",
    );
    await vi.waitFor(() => {
      expect(host.relayConnected).toBe(false);
    });
    const offer2 = await host.createPairingOffer({ mode: "relay" });
    const hash2 = await sha256Hex(utf8Encode(await deriveRelayInviteToken(offer2.ticket)));
    expect(offer2.ticket).not.toBe(offer1.ticket);
    expect(controlAttempts).toBeGreaterThanOrEqual(2);
    expect(invitesByAttempt[1]).toEqual([hash1, hash2]);
  });

  test("host_hello_ack installs grants paired mid-restore and refuses connected state if ws closes mid-flush", async () => {
    const healthServer = createServer((req, res) => {
      if (req.url === "/api/auth/token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "h.p.s", expiresAt: Date.now() + 60_000 }));
        return;
      }
      res.writeHead(404).end();
    });
    const wss = new WebSocketServer({ noServer: true });
    let attempt = 0;
    const installedByAttempt: string[][] = [];
    const relayKp = await generateX25519KeyPair();
    const relayPriv = await importX25519PrivateKey(relayKp.privateKeyPkcs8B64);

    const dir = tempDir("subspace-restore-grants-");
    const store = new SubspaceStore(dir);
    store.saveRelayAuth({
      authUrl: "http://127.0.0.1:0",
      relayUrl: "ws://127.0.0.1:0",
      token: "sess-1",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });
    store.addGrant({
      id: "g_initial",
      clientName: "Initial",
      tokenSha256: "a".repeat(64),
      relayTokenSha256: "b".repeat(64),
      mode: "relay",
      createdAt: Date.now(),
      lastSeenAt: null,
    });

    healthServer.on("upgrade", (req, socket, head) => {
      if (req.url !== RELAY_PATHS.HOST_CONTROL) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const myAttempt = attempt;
        attempt += 1;
        const installed: string[] = [];
        installedByAttempt.push(installed);
        let relayHostId = "";
        ws.on("message", async (raw) => {
          const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          if (msg.type === "host_hello") {
            relayHostId = String(msg.relayHostId);
            const challengeB64 = Buffer.from("challenge-32-bytes-0123456789abc").toString("base64");
            await computeRelayControlProof(
              relayPriv,
              String(msg.hostPublicKeyB64),
              challengeB64,
              "alice",
            );
            ws.send(
              JSON.stringify({
                type: "host_challenge",
                challengeB64,
                relayEphPubB64: relayKp.publicKeyB64,
                userId: "alice",
              }),
            );
          } else if (msg.type === "host_challenge_ack") {
            if (myAttempt === 0) {
              // Simulate a concurrent pairing grant arriving while host_hello_ack is flushing g_initial.
              const realRead = store.readGrants.bind(store);
              let addedConcurrent = false;
              vi.spyOn(store, "readGrants").mockImplementation(() => {
                const list = realRead();
                if (!addedConcurrent) {
                  addedConcurrent = true;
                  queueMicrotask(() => {
                    store.addGrant({
                      id: "g_concurrent",
                      clientName: "Concurrent",
                      tokenSha256: "c".repeat(64),
                      relayTokenSha256: "d".repeat(64),
                      mode: "relay",
                      createdAt: Date.now(),
                      lastSeenAt: null,
                    });
                  });
                }
                return list;
              });
            }
            ws.send(JSON.stringify({ type: "host_hello_ack", relayHostId, userId: "alice" }));
            if (myAttempt === 1) {
              // On second connect, immediately close server-side right as host_hello_ack lands.
              ws.close(1012, "closing mid-restore");
            }
          } else if (msg.type === "device_install") {
            installed.push(String(msg.grantId));
            ws.send(JSON.stringify({ type: "device_installed", grantId: String(msg.grantId) }));
          }
        });
      });
    });
    await new Promise<void>((resolve) => healthServer.listen(0, "127.0.0.1", resolve));
    const addr = healthServer.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const c of wss.clients) c.terminate();
          wss.close(() => healthServer.close(() => resolve()));
        }),
    );

    store.saveRelayAuth({
      authUrl: `http://127.0.0.1:${port}`,
      relayUrl: `ws://127.0.0.1:${port}`,
      token: "sess-1",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });
    const events: boolean[] = [];
    const host = new SubspaceHost({
      store,
      serverVersion: () => "0.19.0",
      dispatch: async () => Response.json({ ok: true }),
      onEvent: (ev) => {
        if (ev.type === "relay-state") events.push(ev.connected);
      },
    });
    cleanups.push(() => host.stop());

    host.startRelay();
    await vi.waitFor(() => {
      expect(host.relayConnected).toBe(true);
      expect(installedByAttempt[0]).toEqual(["g_initial", "g_concurrent"]);
    });

    // Trigger reconnect (attempt 1) where server closes socket immediately on host_hello_ack,
    // followed by clean attempt 2; attempt 1 must never publish a transient connected=true.
    vi.restoreAllMocks();
    events.length = 0;
    for (const c of wss.clients) c.close(1012, "cycle");
    await vi.waitFor(
      () => {
        expect(attempt).toBeGreaterThanOrEqual(3);
        expect(host.relayConnected).toBe(true);
      },
      { timeout: 8_000 },
    );
    expect(events.filter(Boolean)).toHaveLength(1);
  });

  test("pairServer rejects re-pairing a host with active calls even when activate is false without dropping its tunnel", async () => {
    const hostDir = tempDir("subspace-repair-host-");
    const clientDir = tempDir("subspace-repair-client-");

    const udpSock = createSocket("udp4");
    cleanups.push(() => {
      udpSock.close();
    });
    await new Promise<void>((resolve) => udpSock.bind(0, "127.0.0.1", () => resolve()));
    const udpPort = udpSock.address().port;
    const sdp = [
      "v=0",
      "o=- 1 1 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "c=IN IP4 127.0.0.1",
      `a=candidate:1 1 udp 2122260223 127.0.0.1 ${udpPort} typ host generation 0`,
      "a=end-of-candidates",
      "",
    ].join("\r\n");

    const host = new SubspaceHost({
      store: new SubspaceStore(hostDir),
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: async (req) => {
        if (req.method === "POST" && new URL(req.url).pathname === "/api/offer") {
          return Response.json({ pc_id: "pc-repair-call", sdp });
        }
        return Response.json({ ok: true });
      },
    });
    cleanups.push(() => host.stop());

    const directPort = await host.startDirect(0);
    const offer1 = await host.createPairingOffer({
      mode: "direct",
      address: "127.0.0.1",
      port: directPort,
    });

    const mgr = new SubspaceManager({
      dataHome: clientDir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      dispatchLocal: async () => new Response("local"),
    });
    cleanups.push(() => mgr.stop());

    const paired1 = await mgr.pairServer({ code: encodePairingUrl(offer1), activate: true });
    const beforeToken = mgr.store.readServers().servers[0]?.deviceToken;

    const offerRes = await mgr.proxyToActive(
      new Request("http://127.0.0.1/api/offer", { method: "POST", body: "{}" }),
      "/api/offer",
    );
    expect(offerRes.status).toBe(200);
    expect(mgr.activeCallCount).toBeGreaterThan(0);

    const offer2 = await host.createPairingOffer({
      mode: "direct",
      address: "127.0.0.1",
      port: directPort,
      rotate: true,
    });
    await expect(
      mgr.pairServer({ code: encodePairingUrl(offer2), activate: false }),
    ).rejects.toMatchObject({ code: "call-active" });

    // Endpoint edits reject during an active call while name-only edits succeed without dropping the tunnel.
    await expect(mgr.updateServer(paired1.pairedServerId, { port: 65000 })).rejects.toMatchObject({
      code: "call-active",
    });
    await expect(
      mgr.updateServer(paired1.pairedServerId, { host: "127.0.0.2" }),
    ).rejects.toMatchObject({ code: "call-active" });
    const renamed = await mgr.updateServer(paired1.pairedServerId, {
      name: "Renamed During Call",
    });
    const savedAfterRename = renamed.servers.find((s) => s.id === paired1.pairedServerId);
    expect(savedAfterRename?.name).toBe("Renamed During Call");
    expect(savedAfterRename?.endpoint?.port).toBe(directPort);

    expect(mgr.activeCallCount).toBeGreaterThan(0);
    expect(mgr.store.readServers().servers[0]?.deviceToken).toBe(beforeToken);
    expect(
      (await mgr.getState()).servers.find((s) => s.id === paired1.pairedServerId)?.connectionState,
    ).toBe("connected");
  });

  test("Direct call remains counted after unused UDP fallback bridge expires until host reports pc_id gone", async () => {
    const hostDir = tempDir("subspace-direct-call-host-");
    const clientDir = tempDir("subspace-direct-call-client-");

    const udpSock = createSocket("udp4");
    cleanups.push(() => {
      udpSock.close();
    });
    await new Promise<void>((resolve) => udpSock.bind(0, "127.0.0.1", () => resolve()));
    const udpPort = udpSock.address().port;
    const sdp = [
      "v=0",
      "o=- 1 1 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "c=IN IP4 127.0.0.1",
      `a=candidate:1 1 udp 2122260223 127.0.0.1 ${udpPort} typ host generation 0`,
      "a=end-of-candidates",
      "",
    ].join("\r\n");

    let callLive = true;
    const patchProbes: { pc_id?: unknown; candidates?: unknown }[] = [];
    const host = new SubspaceHost({
      store: new SubspaceStore(hostDir),
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: async (req) => {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/api/offer" && req.method === "POST") {
          return Response.json({ pc_id: "pc-direct-live", sdp });
        }
        if (pathname === "/api/offer" && req.method === "PATCH") {
          const body = (await req.json()) as { pc_id?: unknown; candidates?: unknown };
          patchProbes.push(body);
          if (callLive && body.pc_id === "pc-direct-live") {
            return Response.json({ status: "success" });
          }
          return Response.json({ detail: "Peer connection not found" }, { status: 404 });
        }
        return Response.json({ ok: true });
      },
    });
    cleanups.push(() => host.stop());

    const directPort = await host.startDirect(0);
    const offer = await host.createPairingOffer({
      mode: "direct",
      address: "127.0.0.1",
      port: directPort,
    });

    const mgr = new SubspaceManager({
      dataHome: clientDir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      callBridgeIdleMs: 60,
      dispatchLocal: async () => new Response("local"),
    });
    cleanups.push(() => mgr.stop());

    const paired = await mgr.pairServer({ code: encodePairingUrl(offer), activate: true });
    const offerRes = await mgr.proxyToActive(
      new Request("http://127.0.0.1/api/offer", { method: "POST", body: "{}" }),
      "/api/offer",
    );
    expect(offerRes.status).toBe(200);
    expect(mgr.activeCallCount).toBe(1);

    // Wait well past callBridgeIdleMs (60ms) with zero UDP packets so the fallback bridge expires
    // and triggers a PATCH /api/offer probe while the direct WebRTC call remains live.
    await vi.waitFor(
      () => {
        expect(patchProbes.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 3_000 },
    );
    expect(patchProbes[0]).toEqual({ pc_id: "pc-direct-live", candidates: [] });
    expect(mgr.activeCallCount).toBe(1);

    // Switching, removing, or changing endpoint must still be blocked while pc-direct-live is up.
    await expect(mgr.setActiveHostId(null)).rejects.toMatchObject({ code: "call-active" });
    await expect(mgr.removeServer(paired.pairedServerId)).rejects.toMatchObject({
      code: "call-active",
    });
    await expect(mgr.updateServer(paired.pairedServerId, { port: 65001 })).rejects.toMatchObject({
      code: "call-active",
    });

    // Once the direct peer hangs up (404 from PATCH /api/offer), host switch clears immediately.
    callLive = false;
    const switched = await mgr.setActiveHostId(null);
    expect(switched.activeHostId).toBeNull();
    expect(mgr.activeCallCount).toBe(0);
  });

  test("Direct call remains counted across transient tunnel disconnect and reconnect until host reports pc_id gone", async () => {
    const hostDir = tempDir("subspace-direct-reconnect-host-");
    const clientDir = tempDir("subspace-direct-reconnect-client-");

    const udpSock = createSocket("udp4");
    cleanups.push(() => {
      udpSock.close();
    });
    await new Promise<void>((resolve) => udpSock.bind(0, "127.0.0.1", () => resolve()));
    const udpPort = udpSock.address().port;
    const sdp = [
      "v=0",
      "o=- 1 1 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "c=IN IP4 127.0.0.1",
      `a=candidate:1 1 udp 2122260223 127.0.0.1 ${udpPort} typ host generation 0`,
      "a=end-of-candidates",
      "",
    ].join("\r\n");

    let callLive = true;
    const reconnectProbes: unknown[] = [];
    const dispatch = async (req: Request, probes?: unknown[]) => {
      const pathname = new URL(req.url).pathname;
      if (pathname === "/api/offer" && req.method === "POST") {
        return Response.json({ pc_id: "pc-direct-reconnect", sdp });
      }
      if (pathname === "/api/offer" && req.method === "PATCH") {
        const body = (await req.json()) as { pc_id?: unknown; candidates?: unknown };
        probes?.push(body);
        if (callLive && body.pc_id === "pc-direct-reconnect") {
          return Response.json({ status: "success" });
        }
        return Response.json({ detail: "Peer connection not found" }, { status: 404 });
      }
      return Response.json({ ok: true });
    };

    const host1 = new SubspaceHost({
      store: new SubspaceStore(hostDir),
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: (req) => dispatch(req),
    });
    const host1Stopped = { done: false };
    cleanups.push(async () => {
      if (!host1Stopped.done) await host1.stop();
    });

    const directPort = await host1.startDirect(0);
    const offer = await host1.createPairingOffer({
      mode: "direct",
      address: "127.0.0.1",
      port: directPort,
    });

    const mgr = new SubspaceManager({
      dataHome: clientDir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      callBridgeIdleMs: 30_000,
      dispatchLocal: async () => new Response("local"),
    });
    cleanups.push(() => mgr.stop());

    const paired = await mgr.pairServer({ code: encodePairingUrl(offer), activate: true });
    const offerRes = await mgr.proxyToActive(
      new Request("http://127.0.0.1/api/offer", { method: "POST", body: "{}" }),
      "/api/offer",
    );
    expect(offerRes.status).toBe(200);
    expect(mgr.activeCallCount).toBe(1);

    // Drop the direct WebSocket tunnel transiently; direct LAN ICE call stays alive.
    await host1.stop();
    host1Stopped.done = true;
    await vi.waitFor(
      async () => {
        const state = await mgr.getState();
        const server = state.servers.find((s) => s.id === paired.pairedServerId);
        expect(server?.connectionState).not.toBe("connected");
      },
      { timeout: 3_000 },
    );
    expect(mgr.activeCallCount).toBe(1);
    await expect(mgr.setActiveHostId(null)).rejects.toMatchObject({ code: "call-active" });
    await expect(mgr.updateServer(paired.pairedServerId, { port: 65001 })).rejects.toMatchObject({
      code: "call-active",
    });

    // Rebind the host on the same port and verify reconnect probes and preserves pc_id while live.
    const host2 = new SubspaceHost({
      store: new SubspaceStore(hostDir),
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: (req) => dispatch(req, reconnectProbes),
    });
    cleanups.push(() => host2.stop());
    await host2.startDirect(directPort);

    await vi.waitFor(
      async () => {
        const state = await mgr.getState();
        const server = state.servers.find((s) => s.id === paired.pairedServerId);
        expect(server?.connectionState).toBe("connected");
        expect(reconnectProbes.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 6_000 },
    );
    expect(mgr.activeCallCount).toBe(1);
    await expect(mgr.setActiveHostId(null)).rejects.toMatchObject({ code: "call-active" });

    callLive = false;
    const switched = await mgr.setActiveHostId(null);
    expect(switched.activeHostId).toBeNull();
    expect(mgr.activeCallCount).toBe(0);
  });

  test("updateServer preserves concurrent store mutations made while active-call probe is in flight", async () => {
    const host1Dir = tempDir("subspace-update-race-host1-");
    const host2Dir = tempDir("subspace-update-race-host2-");
    const clientDir = tempDir("subspace-update-race-client-");

    const udpSock = createSocket("udp4");
    cleanups.push(() => {
      udpSock.close();
    });
    await new Promise<void>((resolve) => udpSock.bind(0, "127.0.0.1", () => resolve()));
    const udpPort = udpSock.address().port;
    const sdp = [
      "v=0",
      "o=- 1 1 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "c=IN IP4 127.0.0.1",
      `a=candidate:1 1 udp 2122260223 127.0.0.1 ${udpPort} typ host generation 0`,
      "a=end-of-candidates",
      "",
    ].join("\r\n");

    let resolveProbeGate = () => {};
    const probeGate = new Promise<void>((resolve) => {
      resolveProbeGate = resolve;
    });
    let notifyProbeEntered = () => {};
    const probeEntered = new Promise<void>((resolve) => {
      notifyProbeEntered = resolve;
    });

    const host1 = new SubspaceHost({
      store: new SubspaceStore(host1Dir),
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: async (req) => {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/api/offer" && req.method === "POST") {
          return Response.json({ pc_id: "pc-race", sdp });
        }
        if (pathname === "/api/offer" && req.method === "PATCH") {
          notifyProbeEntered();
          await probeGate;
          return Response.json({ detail: "Peer connection not found" }, { status: 404 });
        }
        return Response.json({ ok: true });
      },
    });
    cleanups.push(() => host1.stop());
    const direct1Port = await host1.startDirect(0);
    const offer1 = await host1.createPairingOffer({
      mode: "direct",
      address: "127.0.0.1",
      port: direct1Port,
    });

    const host2 = new SubspaceHost({
      store: new SubspaceStore(host2Dir),
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => host2.stop());
    const direct2Port = await host2.startDirect(0);
    const offer2 = await host2.createPairingOffer({
      mode: "direct",
      address: "127.0.0.1",
      port: direct2Port,
    });

    const mgr = new SubspaceManager({
      dataHome: clientDir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      callBridgeIdleMs: 30_000,
      dispatchLocal: async () => new Response("local"),
    });
    cleanups.push(() => mgr.stop());

    const paired1 = await mgr.pairServer({ code: encodePairingUrl(offer1), activate: true });
    const paired2 = await mgr.pairServer({ code: encodePairingUrl(offer2), activate: false });
    await mgr.proxyToActive(
      new Request("http://127.0.0.1/api/offer", { method: "POST", body: "{}" }),
      "/api/offer",
    );
    expect(mgr.activeCallCount).toBe(1);

    const updatePromise = mgr.updateServer(paired1.pairedServerId, {
      name: "Renamed Direct",
      port: 65123,
    });
    await probeEntered;

    // Update paired2 concurrently while paired1's active-call probe awaits.
    await mgr.updateServer(paired2.pairedServerId, { name: "Host 2 Updated" });
    resolveProbeGate();

    const updatedState = await updatePromise;
    expect(updatedState.servers.map((s) => s.id)).toEqual([
      paired1.pairedServerId,
      paired2.pairedServerId,
    ]);
    const saved1 = updatedState.servers.find((s) => s.id === paired1.pairedServerId);
    expect(saved1?.name).toBe("Renamed Direct");
    expect(saved1?.endpoint?.port).toBe(65123);
    expect(updatedState.servers.find((s) => s.id === paired2.pairedServerId)?.name).toBe(
      "Host 2 Updated",
    );
  });

  test("disconnectServer clears retained offline Direct call counts so recovery actions succeed", async () => {
    const hostDir = tempDir("subspace-offline-disconnect-host-");
    const clientDir = tempDir("subspace-offline-disconnect-client-");

    const udpSock = createSocket("udp4");
    cleanups.push(() => {
      udpSock.close();
    });
    await new Promise<void>((resolve) => udpSock.bind(0, "127.0.0.1", () => resolve()));
    const udpPort = udpSock.address().port;
    const sdp = [
      "v=0",
      "o=- 1 1 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "c=IN IP4 127.0.0.1",
      `a=candidate:1 1 udp 2122260223 127.0.0.1 ${udpPort} typ host generation 0`,
      "a=end-of-candidates",
      "",
    ].join("\r\n");

    const host = new SubspaceHost({
      store: new SubspaceStore(hostDir),
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: async (req) => {
        if (new URL(req.url).pathname === "/api/offer" && req.method === "POST") {
          return Response.json({ pc_id: "pc-offline-disconnect", sdp });
        }
        return Response.json({ ok: true });
      },
    });
    const hostStopped = { done: false };
    cleanups.push(async () => {
      if (!hostStopped.done) await host.stop();
    });

    const directPort = await host.startDirect(0);
    const offer = await host.createPairingOffer({
      mode: "direct",
      address: "127.0.0.1",
      port: directPort,
    });

    const mgr = new SubspaceManager({
      dataHome: clientDir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      callBridgeIdleMs: 30_000,
      dispatchLocal: async () => new Response("local"),
    });
    cleanups.push(() => mgr.stop());

    const paired = await mgr.pairServer({ code: encodePairingUrl(offer), activate: true });
    await mgr.proxyToActive(
      new Request("http://127.0.0.1/api/offer", { method: "POST", body: "{}" }),
      "/api/offer",
    );
    expect(mgr.activeCallCount).toBe(1);

    await host.stop();
    hostStopped.done = true;
    await vi.waitFor(
      async () => {
        const state = await mgr.getState();
        expect(state.servers.find((s) => s.id === paired.pairedServerId)?.connectionState).toBe(
          "error",
        );
      },
      { timeout: 3_000 },
    );

    await expect(mgr.setActiveHostId(null)).rejects.toMatchObject({ code: "call-active" });

    const disconnected = await mgr.disconnectServer(paired.pairedServerId);
    expect(disconnected.servers.find((s) => s.id === paired.pairedServerId)?.connectionState).toBe(
      "disconnected",
    );
    expect(mgr.activeCallCount).toBe(0);

    const switched = await mgr.setActiveHostId(null);
    expect(switched.activeHostId).toBeNull();
    const updated = await mgr.updateServer(paired.pairedServerId, { port: 65002 });
    expect(updated.servers.find((s) => s.id === paired.pairedServerId)?.endpoint?.port).toBe(65002);
  });

  test("setActiveHostId preserves active client if target server is removed while refreshing active calls", async () => {
    const host1Dir = tempDir("subspace-switch-race-host1-");
    const host2Dir = tempDir("subspace-switch-race-host2-");
    const clientDir = tempDir("subspace-switch-race-client-");

    const udpSock = createSocket("udp4");
    cleanups.push(() => {
      udpSock.close();
    });
    await new Promise<void>((resolve) => udpSock.bind(0, "127.0.0.1", () => resolve()));
    const udpPort = udpSock.address().port;
    const sdp = [
      "v=0",
      "o=- 1 1 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "c=IN IP4 127.0.0.1",
      `a=candidate:1 1 udp 2122260223 127.0.0.1 ${udpPort} typ host generation 0`,
      "a=end-of-candidates",
      "",
    ].join("\r\n");

    let resolveProbeGate = () => {};
    const probeGate = new Promise<void>((resolve) => {
      resolveProbeGate = resolve;
    });
    let notifyProbeEntered = () => {};
    const probeEntered = new Promise<void>((resolve) => {
      notifyProbeEntered = resolve;
    });

    const host1 = new SubspaceHost({
      store: new SubspaceStore(host1Dir),
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: async (req) => {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/api/offer" && req.method === "POST") {
          return Response.json({ pc_id: "pc-switch-race", sdp });
        }
        if (pathname === "/api/offer" && req.method === "PATCH") {
          notifyProbeEntered();
          await probeGate;
          return Response.json({ detail: "Peer connection not found" }, { status: 404 });
        }
        return Response.json({ ok: true, host: "host1" });
      },
    });
    cleanups.push(() => host1.stop());
    const direct1Port = await host1.startDirect(0);
    const offer1 = await host1.createPairingOffer({
      mode: "direct",
      address: "127.0.0.1",
      port: direct1Port,
    });

    const host2 = new SubspaceHost({
      store: new SubspaceStore(host2Dir),
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => host2.stop());
    const direct2Port = await host2.startDirect(0);
    const offer2 = await host2.createPairingOffer({
      mode: "direct",
      address: "127.0.0.1",
      port: direct2Port,
    });

    const mgr = new SubspaceManager({
      dataHome: clientDir,
      serverVersion: () => "0.19.0",
      activeCalls: () => 0,
      callBridgeIdleMs: 30_000,
      dispatchLocal: async () => new Response("local"),
    });
    cleanups.push(() => mgr.stop());

    const paired1 = await mgr.pairServer({ code: encodePairingUrl(offer1), activate: true });
    const paired2 = await mgr.pairServer({ code: encodePairingUrl(offer2), activate: false });
    await mgr.proxyToActive(
      new Request("http://127.0.0.1/api/offer", { method: "POST", body: "{}" }),
      "/api/offer",
    );
    expect(mgr.activeCallCount).toBe(1);

    const switchPromise = mgr.setActiveHostId(paired2.pairedServerId);
    await probeEntered;

    // Remove inactive target server B while setActiveHostId awaits A's call probe.
    await mgr.removeServer(paired2.pairedServerId);
    resolveProbeGate();

    await expect(switchPromise).rejects.toMatchObject({ code: "unknown-subspace-server" });
    const state = await mgr.getState();
    expect(state.activeHostId).toBe(paired1.pairedServerId);
    expect(state.servers.find((s) => s.id === paired1.pairedServerId)?.connectionState).toBe(
      "connected",
    );

    const checkRes = await mgr.proxyToActive(new Request("http://127.0.0.1/api/ping"), "/api/ping");
    expect(checkRes.status).toBe(200);
    await expect(checkRes.json()).resolves.toEqual({ ok: true, host: "host1" });
  });

  test("isMacLocalNetworkBlocked identifies darwin Direct EHOSTUNREACH against LAN and mDNS hosts", () => {
    const ehostunreach = Object.assign(new Error("connect EHOSTUNREACH 10.0.1.5:63427"), {
      code: "EHOSTUNREACH",
    });
    const econnrefused = Object.assign(new Error("connect ECONNREFUSED 10.0.1.5:63427"), {
      code: "ECONNREFUSED",
    });

    for (const host of [
      "10.0.1.5",
      "192.168.1.25",
      "172.16.0.1",
      "172.31.255.254",
      "169.254.1.2",
      "[fe80::1]",
      "[fe80::1%en0]",
      "fd12:3456::1",
      "fc00::1",
      "asi",
      "asi.local",
      "asi.local.",
    ]) {
      expect([host, isMacLocalNetworkBlocked(ehostunreach, "direct", host, "darwin")]).toEqual([
        host,
        true,
      ]);
    }

    for (const host of [
      "127.0.0.1",
      "127.0.1.1",
      "localhost",
      "localhost.",
      "[::1]",
      "172.15.255.254",
      "172.32.0.1",
      "203.0.113.10",
      "2001:db8::1",
      "subspace.example.com",
      "",
    ]) {
      expect([host, isMacLocalNetworkBlocked(ehostunreach, "direct", host, "darwin")]).toEqual([
        host,
        false,
      ]);
    }

    expect(isMacLocalNetworkBlocked(ehostunreach, "relay", "10.0.1.5", "darwin")).toBe(false);
    expect(isMacLocalNetworkBlocked(ehostunreach, "direct", "10.0.1.5", "linux")).toBe(false);
    expect(isMacLocalNetworkBlocked(ehostunreach, "direct", "10.0.1.5", "win32")).toBe(false);
    expect(isMacLocalNetworkBlocked(econnrefused, "direct", "10.0.1.5", "darwin")).toBe(false);
    expect(
      isMacLocalNetworkBlocked(
        new AggregateError([ehostunreach, ehostunreach]),
        "direct",
        "asi.local",
        "darwin",
      ),
    ).toBe(true);
    expect(
      isMacLocalNetworkBlocked(
        new AggregateError([ehostunreach, econnrefused]),
        "direct",
        "asi.local",
        "darwin",
      ),
    ).toBe(false);
    // Node 24's net.createConnection sets AggregateError.code = errors[0].code; mixed errors must still inspect nested items.
    expect(
      isMacLocalNetworkBlocked(
        Object.assign(new AggregateError([ehostunreach, econnrefused]), { code: "EHOSTUNREACH" }),
        "direct",
        "asi.local",
        "darwin",
      ),
    ).toBe(false);
    expect(
      isMacLocalNetworkBlocked(
        Object.assign(new AggregateError([ehostunreach, ehostunreach]), { code: "EHOSTUNREACH" }),
        "direct",
        "asi.local",
        "darwin",
      ),
    ).toBe(true);
  });

  test("SubspaceClient exposes lastErrorCode on connection failure and clears it on stop", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected HTTP server address");
    const unusedPort = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const hostKp = await generateX25519KeyPair();
    const client = new SubspaceClient({
      id: "srv-err-code",
      name: "Unreachable Host",
      hostPublicKeyB64: hostKp.publicKeyB64,
      grantId: "grant-1",
      deviceToken: "token-1",
      mode: "direct",
      endpoint: { host: "127.0.0.1", port: unusedPort },
      addedAt: Date.now(),
      lastConnectedAt: null,
      lastVersion: null,
    });
    cleanups.push(() => client.stop());
    await expect(client.connect()).rejects.toMatchObject({ code: "subspace-unreachable" });
    expect(client.state).toBe("error");
    expect(client.lastErrorCode).toBe("subspace-unreachable");
    client.stop();
    expect(client.state).toBe("disconnected");
    expect(client.lastErrorCode).toBeNull();
  });

  test("mode=auto succeeds Direct-only when Relay is offline, upgrades Direct clients when Host signs in, and falls back on blackhole timeout", async () => {
    const dirHost = tempDir("subspace-unified-host-");
    const dirClient = tempDir("subspace-unified-client-");

    // Minimal working Relay + auth server started up-front; host stays signed out initially.
    const relayKp = await generateX25519KeyPair();
    const { WebSocketServer: RelayWsServer } = await import("ws");
    const authAndRelay = createServer((req, res) => {
      if (req.url === "/api/auth/token") {
        const exp = Math.floor(Date.now() / 1000) + 300;
        const header = Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({ exp, sub: "alice" })).toString("base64url");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: `${header}.${payload}.sig` }));
        return;
      }
      res.writeHead(404).end();
    });
    const controlWss = new RelayWsServer({ noServer: true });
    const dataWss = new RelayWsServer({ noServer: true });
    let onlineHostWs: import("ws").default | null = null;
    const pendingData = new Map<string, import("ws").default>();
    controlWss.on("connection", (ws) => {
      let relayHostId = "";
      ws.on("message", async (raw) => {
        const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        if (msg.type === "host_hello") {
          relayHostId = String(msg.relayHostId);
          const challengeB64 = Buffer.from("ch-32-bytes-0123456789abcdef0123").toString("base64");
          ws.send(
            JSON.stringify({
              type: "host_challenge",
              challengeB64,
              relayEphPubB64: relayKp.publicKeyB64,
              userId: "alice",
            }),
          );
        } else if (msg.type === "host_challenge_ack") {
          onlineHostWs = ws;
          ws.send(JSON.stringify({ type: "host_hello_ack", relayHostId, userId: "alice" }));
        } else if (msg.type === "invite_create") {
          ws.send(JSON.stringify({ type: "invite_created", inviteId: msg.inviteId }));
        } else if (msg.type === "device_install") {
          ws.send(JSON.stringify({ type: "device_installed", grantId: msg.grantId }));
        }
      });
    });
    dataWss.on("connection", (ws, req) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path === RELAY_PATHS.CLIENT_CONNECT) {
        ws.once("message", () => {
          const sessionId = `sess_${Date.now()}`;
          pendingData.set(sessionId, ws);
          onlineHostWs?.send(JSON.stringify({ type: "connection_open", sessionId, grantId: null }));
        });
      } else if (path === RELAY_PATHS.HOST_DATA) {
        ws.once("message", (raw) => {
          const msg = JSON.parse(raw.toString("utf8")) as { sessionId: string };
          const clientWs = pendingData.get(msg.sessionId);
          pendingData.delete(msg.sessionId);
          if (!clientWs) return;
          clientWs.send(JSON.stringify({ type: "relay_ready", sessionId: msg.sessionId }));
          clientWs.on("message", (d, b) => ws.readyState === 1 && ws.send(d, { binary: b }));
          ws.on("message", (d, b) => clientWs.readyState === 1 && clientWs.send(d, { binary: b }));
        });
      }
    });
    authAndRelay.on("upgrade", (req, socket, head) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path === RELAY_PATHS.HOST_CONTROL) {
        controlWss.handleUpgrade(req, socket, head, (ws) => controlWss.emit("connection", ws, req));
      } else if (path === RELAY_PATHS.CLIENT_CONNECT || path === RELAY_PATHS.HOST_DATA) {
        dataWss.handleUpgrade(req, socket, head, (ws) => dataWss.emit("connection", ws, req));
      } else {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve) => authAndRelay.listen(0, "127.0.0.1", resolve));
    const relayPort = (authAndRelay.address() as { port: number }).port;
    const relayBase = `http://127.0.0.1:${relayPort}`;
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const ws of [...controlWss.clients, ...dataWss.clients]) ws.terminate();
          controlWss.close(() => dataWss.close(() => authAndRelay.close(() => resolve())));
        }),
    );

    // 1. Signed out -> mode=auto creates Direct-only offer without error.
    const hostMgr = new SubspaceManager({
      dataHome: dirHost,
      serverVersion: () => "0.22.0",
      activeCalls: () => 0,
      dispatchLocal: async () => Response.json({ ok: true }),
      relayUrl: () => relayBase,
    });
    cleanups.push(() => hostMgr.stop());

    const signedOutOffer = await hostMgr.createShareOffer({
      mode: "auto",
      address: "127.0.0.1",
      port: 0,
    });
    expect(signedOutOffer.hasRelayFallback).toBe(false);

    const clientMgr = new SubspaceManager({
      dataHome: dirClient,
      serverVersion: () => "0.22.0",
      activeCalls: () => 0,
      dispatchLocal: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => clientMgr.stop());
    const initialPair = await clientMgr.pairServer({
      code: signedOutOffer.pairingUrl,
      activate: true,
    });
    expect(initialPair.servers[0]?.relay).toBeNull();

    // 2. Host later signs in to Relay -> reconnect over Direct automatically attaches host's Relay metadata.
    hostMgr.store.saveRelayAuth({
      authUrl: relayBase,
      relayUrl: relayBase,
      token: "sess-alice",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });
    await hostMgr.updateShareSettings({});
    await vi.waitFor(() => expect(hostMgr.host.relayConnected).toBe(true));

    await clientMgr.disconnectServer(initialPair.pairedServerId);
    await clientMgr.connectServer(initialPair.pairedServerId);
    const upgraded = await clientMgr.getState();
    expect(upgraded.servers[0]?.activeTransport).toBe("direct");
    expect(upgraded.servers[0]?.relay?.url).toBe(relayBase);

    // 3. Direct blackhole (TCP accepts but never completes WS upgrade) falls back cleanly to Relay after timeout.
    const heldSockets: TcpSocket[] = [];
    const blackhole = createTcpServer((sock) => {
      heldSockets.push(sock);
    });
    await new Promise<void>((resolve) => blackhole.listen(0, "127.0.0.1", resolve));
    const blackholePort = (blackhole.address() as { port: number }).port;
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const sock of heldSockets) sock.destroy();
          blackhole.close(() => resolve());
        }),
    );

    const saved = clientMgr.store.readServers().servers[0]!;
    const fallbackClient = new SubspaceClient(
      { ...saved, endpoint: { host: "127.0.0.1", port: blackholePort } },
      {},
      undefined,
      { directFallbackTimeoutMs: 50 },
    );
    cleanups.push(() => fallbackClient.stop());
    const tunnel = await fallbackClient.connect();
    expect(tunnel.transport).toBe("relay");
    expect(fallbackClient.activeTransport).toBe("relay");
  });

  test("startRelay clears stale auth error on retry, legacy Direct grants backfill relay tokens, updateServer leaves Relay fallback, and Direct calls probe over Relay", async () => {
    const startMockRelayServer = async () => {
      const relayKp = await generateX25519KeyPair();
      const { WebSocketServer: RelayWsServer } = await import("ws");
      let tokenStatus: 200 | 401 = 200;
      let tokenDelayMs = 0;
      const installedDevices = new Map<string, string>();
      let onlineHostWs: import("ws").default | null = null;
      const pendingData = new Map<string, import("ws").default>();

      const httpServer = createServer((req, res) => {
        if (req.url === "/api/auth/token") {
          const reply = () => {
            if (tokenStatus === 401) {
              res.writeHead(401, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "unauthorized" }));
              return;
            }
            const exp = Math.floor(Date.now() / 1000) + 300;
            const header = Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url");
            const payload = Buffer.from(JSON.stringify({ exp, sub: "alice" })).toString(
              "base64url",
            );
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ token: `${header}.${payload}.sig` }));
          };
          if (tokenDelayMs > 0) setTimeout(reply, tokenDelayMs);
          else reply();
          return;
        }
        res.writeHead(404).end();
      });

      const controlWss = new RelayWsServer({ noServer: true });
      const dataWss = new RelayWsServer({ noServer: true });
      controlWss.on("connection", (ws) => {
        let relayHostId = "";
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          if (msg.type === "host_hello") {
            relayHostId = String(msg.relayHostId);
            ws.send(
              JSON.stringify({
                type: "host_challenge",
                challengeB64: Buffer.from("ch-32-bytes-0123456789abcdef0123").toString("base64"),
                relayEphPubB64: relayKp.publicKeyB64,
                userId: "alice",
              }),
            );
          } else if (msg.type === "host_challenge_ack") {
            onlineHostWs = ws;
            ws.send(JSON.stringify({ type: "host_hello_ack", relayHostId, userId: "alice" }));
          } else if (msg.type === "invite_create") {
            ws.send(JSON.stringify({ type: "invite_created", inviteId: msg.inviteId }));
          } else if (msg.type === "device_install") {
            installedDevices.set(String(msg.grantId), String(msg.tokenHash));
            ws.send(JSON.stringify({ type: "device_installed", grantId: msg.grantId }));
          } else if (msg.type === "device_revoke") {
            installedDevices.delete(String(msg.grantId));
            ws.send(JSON.stringify({ type: "device_revoked", grantId: msg.grantId }));
          }
        });
      });
      dataWss.on("connection", (ws, req) => {
        const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        if (path === RELAY_PATHS.CLIENT_CONNECT) {
          ws.once("message", async (raw) => {
            const msg = JSON.parse(raw.toString("utf8")) as {
              readonly credential?: {
                readonly kind?: string;
                readonly grantId?: string;
                readonly relayToken?: string;
              };
            };
            if (msg.credential?.kind === "device") {
              const tokenHash = await sha256Hex(
                utf8Encode(String(msg.credential.relayToken ?? "")),
              );
              if (installedDevices.get(String(msg.credential.grantId)) !== tokenHash) {
                ws.close(RELAY_CLOSE_CODE.UNAUTHORIZED, "Revoked or invalid device token");
                return;
              }
            }
            const sessionId = `sess_${Date.now()}_${Math.random()}`;
            pendingData.set(sessionId, ws);
            onlineHostWs?.send(
              JSON.stringify({
                type: "connection_open",
                sessionId,
                grantId: msg.credential?.grantId ?? null,
              }),
            );
          });
        } else if (path === RELAY_PATHS.HOST_DATA) {
          ws.once("message", (raw) => {
            const msg = JSON.parse(raw.toString("utf8")) as { sessionId: string };
            const clientWs = pendingData.get(msg.sessionId);
            pendingData.delete(msg.sessionId);
            if (!clientWs) return;
            clientWs.send(JSON.stringify({ type: "relay_ready", sessionId: msg.sessionId }));
            clientWs.on("message", (d, b) => ws.readyState === 1 && ws.send(d, { binary: b }));
            ws.on(
              "message",
              (d, b) => clientWs.readyState === 1 && clientWs.send(d, { binary: b }),
            );
          });
        }
      });
      httpServer.on("upgrade", (req, socket, head) => {
        const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        if (path === RELAY_PATHS.HOST_CONTROL) {
          controlWss.handleUpgrade(req, socket, head, (ws) =>
            controlWss.emit("connection", ws, req),
          );
        } else if (path === RELAY_PATHS.CLIENT_CONNECT || path === RELAY_PATHS.HOST_DATA) {
          dataWss.handleUpgrade(req, socket, head, (ws) => dataWss.emit("connection", ws, req));
        } else {
          socket.destroy();
        }
      });
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
      const port = (httpServer.address() as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${port}`;
      cleanups.push(
        () =>
          new Promise<void>((resolve) => {
            for (const ws of [...controlWss.clients, ...dataWss.clients]) ws.terminate();
            controlWss.close(() => dataWss.close(() => httpServer.close(() => resolve())));
          }),
      );
      return {
        baseUrl,
        setTokenMode(status: 200 | 401, delayMs = 0) {
          tokenStatus = status;
          tokenDelayMs = delayMs;
        },
      };
    };

    const relay = await startMockRelayServer();

    // 1. Re-login / startRelay() after relay-auth-expired clears stale error code before host_hello_ack completes.
    const dirRetry = tempDir("subspace-retry-clear-");
    const storeRetry = new SubspaceStore(dirRetry);
    storeRetry.saveRelayAuth({
      authUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      token: "sess-expired",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });
    relay.setTokenMode(401);
    const hostRetry = new SubspaceHost({
      store: storeRetry,
      serverVersion: () => "0.22.0",
      relayUrl: () => relay.baseUrl,
      dispatch: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => hostRetry.stop());

    const offerNoRelay = await hostRetry.createPairingOffer({
      mode: "auto",
      address: "127.0.0.1",
      port: 0,
    });
    expect(offerNoRelay.relay).toBeUndefined();
    expect(hostRetry.relayError).toContain("expired");

    relay.setTokenMode(200, 40);
    storeRetry.saveRelayAuth({
      authUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      token: "sess-fresh",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });
    hostRetry.startRelay();
    const offerWithRelay = await hostRetry.createPairingOffer({
      mode: "auto",
      address: "127.0.0.1",
    });
    expect(offerWithRelay.relay?.url).toBe(relay.baseUrl);
    expect(offerWithRelay.ticket).not.toBe(offerNoRelay.ticket);
    expect(hostRetry.relayConnected).toBe(true);
    await hostRetry.stop();

    // 2. Legacy Direct grant (relayTokenSha256 omitted) backfills on Direct reconnect, then falls back cleanly.
    relay.setTokenMode(200, 0);
    const dirHost = tempDir("subspace-reg-host-");
    const dirClient = tempDir("subspace-reg-client-");
    let callActive = true;
    let patchCalls = 0;

    const hostMgr = new SubspaceManager({
      dataHome: dirHost,
      serverVersion: () => "0.22.0",
      activeCalls: () => 0,
      dispatchLocal: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/api/offer" && req.method === "POST") {
          return Response.json({
            sdp: [
              "v=0",
              "o=- 1 1 IN IP4 127.0.0.1",
              "s=-",
              "t=0 0",
              "m=audio 9 UDP/TLS/RTP/SAVPF 111",
              "a=candidate:1 1 udp 2122260223 127.0.0.1 45678 typ host generation 0",
              "",
            ].join("\r\n"),
            type: "answer",
            pc_id: "pc-roam",
          });
        }
        if (path === "/api/offer" && req.method === "PATCH") {
          patchCalls += 1;
          return Response.json(callActive ? { status: "success" } : { detail: "Gone" }, {
            status: callActive ? 200 : 410,
          });
        }
        return Response.json({ path });
      },
      relayUrl: () => relay.baseUrl,
    });
    cleanups.push(() => hostMgr.stop());

    const directOnlyOffer = await hostMgr.createShareOffer({
      mode: "direct",
      address: "127.0.0.1",
      port: 0,
    });
    const clientMgr = new SubspaceManager({
      dataHome: dirClient,
      serverVersion: () => "0.22.0",
      activeCalls: () => 0,
      dispatchLocal: async () => Response.json({ ok: true }),
    });
    cleanups.push(() => clientMgr.stop());

    const paired = await clientMgr.pairServer({ code: directOnlyOffer.pairingUrl, activate: true });
    const legacyGrants = hostMgr.store
      .readGrants()
      .map(({ relayTokenSha256: _r, ...rest }) => rest);
    hostMgr.store.saveGrants(legacyGrants);

    hostMgr.store.saveRelayAuth({
      authUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      token: "sess-host",
      user: { id: "alice", name: "Alice", email: "alice@example.com", image: null },
      savedAt: Date.now(),
    });
    await hostMgr.updateShareSettings({});
    await vi.waitFor(() => expect(hostMgr.host.relayConnected).toBe(true));

    await clientMgr.disconnectServer(paired.pairedServerId);
    await clientMgr.connectServer(paired.pairedServerId);
    expect(hostMgr.store.readGrants()[0]?.relayTokenSha256).toMatch(/^[0-9a-f]{64}$/);

    // 3. Direct call survives Direct tunnel drop onto Relay reconnect and clears when PATCH /api/offer returns 410.
    const savedHybrid = clientMgr.store.readServers().servers[0]!;
    const callClient = new SubspaceClient(savedHybrid, {}, undefined, {
      callBridgeIdleMs: 5_000,
      callProbeIntervalMs: 60_000,
      directFallbackTimeoutMs: 50,
    });
    cleanups.push(() => callClient.stop());
    await callClient.connect();
    expect(callClient.activeTransport).toBe("direct");

    const offerRes = await callClient.proxyFetch(
      new Request("http://local/api/offer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdp: "v=0", type: "offer" }),
      }),
      "/api/offer",
    );
    expect(offerRes.status).toBe(200);
    expect(callClient.activeCallCount).toBe(1);

    await hostMgr.host.stopDirect();
    await vi.waitFor(() => expect(callClient.activeTransport).toBe("relay"));
    expect(callClient.activeCallCount).toBe(1);
    expect(await callClient.refreshActiveCallCount()).toBe(1);
    expect(patchCalls).toBeGreaterThanOrEqual(1);

    callActive = false;
    expect(await callClient.refreshActiveCallCount()).toBe(0);
    callClient.stop();

    // Legacy client falling back to Relay succeeds with backfilled relayTokenSha256.
    await clientMgr.disconnectServer(paired.pairedServerId);
    await clientMgr.connectServer(paired.pairedServerId);
    const relayedState = await clientMgr.getState();
    expect(relayedState.servers[0]?.activeTransport).toBe("relay");
    const pingRes = await clientMgr.proxyToActive(new Request("http://local/ping"), "/ping");
    expect(pingRes.status).toBe(200);
    expect(await pingRes.json()).toEqual({ path: "/ping" });

    // 4. Editing Direct endpoint while connected on Relay fallback reconnects back to Direct.
    const newDirectPort = await hostMgr.host.startDirect(0);
    await clientMgr.updateServer(paired.pairedServerId, {
      host: "127.0.0.1",
      port: newDirectPort,
    });
    await vi.waitFor(async () => {
      const s = await clientMgr.getState();
      expect(s.servers[0]?.activeTransport).toBe("direct");
    });
  });
});
