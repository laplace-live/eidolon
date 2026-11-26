import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  completeDeviceAuthorization,
  computeRelayControlProof,
  generateX25519KeyPair,
  importX25519PrivateKey,
  RELAY_PATHS,
  SubspaceClient,
  SubspaceConnectError,
  SubspaceHost,
  SubspaceManager,
  type SubspaceSavedServer,
  SubspaceStore,
} from "../src/index.ts";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
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
      ws.on("message", async (raw) => {
        const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        if (msg.type === "host_hello") {
          relayHostId = String(msg.relayHostId);
          const challengeB64 = Buffer.from("challenge-32-bytes-0123456789abc").toString("base64");
          // Validate our proof helper works cleanly for handshake ack.
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
});
