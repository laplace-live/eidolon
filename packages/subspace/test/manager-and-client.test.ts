import { createSocket } from "node:dgram";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  completeDeviceAuthorization,
  computeRelayControlProof,
  deriveRelayDeviceToken,
  deriveRelayInviteToken,
  encodePairingUrl,
  generateX25519KeyPair,
  importX25519PrivateKey,
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
  utf8Encode,
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
});
