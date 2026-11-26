import { createSocket } from "node:dgram";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  performPairingHandshake,
  SubspaceClient,
  SubspaceHost,
  type SubspaceSavedServer,
  SubspaceStore,
} from "../src/index.ts";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe("Direct WebSocket SubspaceHost <-> SubspaceClient", () => {
  test("pairs once, rejects reused ticket, reconnects with deviceToken, proxies requests, and enforces revoke", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subspace-direct-e2e-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const hostStore = new SubspaceStore(join(dir, "host"));
    const host = new SubspaceHost({
      store: hostStore,
      serverVersion: () => "0.14.0-test",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/local/status") {
          return Response.json({ version: "0.14.0-test", ok: true });
        }
        if (url.pathname === "/api/stream") {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('{"seq":1}\n'));
              controller.enqueue(encoder.encode('{"seq":2}\n'));
              controller.close();
            },
          });
          return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    cleanups.push(() => host.stop());

    const port = await host.startDirect(0);
    const offer = await host.createPairingOffer({
      mode: "direct",
      address: "127.0.0.1",
      port,
    });

    const firstPair = await performPairingHandshake(offer, { clientName: "E2E Laptop" });
    expect(firstPair.serverVersion).toBe("0.14.0-test");
    expect(firstPair.deviceToken.length).toBeGreaterThan(20);
    firstPair.tunnel.mux.close();
    firstPair.tunnel.ws.close();

    // Single-use pairing ticket cannot be redeemed a second time.
    await expect(
      performPairingHandshake(offer, { clientName: "Second Try" }),
    ).rejects.toMatchObject({ code: "pairing-failed" });

    const savedServer: SubspaceSavedServer = {
      id: "srv-direct-1",
      name: firstPair.hostName,
      hostPublicKeyB64: offer.hostPublicKeyB64,
      grantId: firstPair.grantId,
      deviceToken: firstPair.deviceToken,
      mode: "direct",
      endpoint: { host: "127.0.0.1", port },
      addedAt: Date.now(),
      lastConnectedAt: Date.now(),
      lastVersion: firstPair.serverVersion,
    };

    const client = new SubspaceClient(savedServer);
    cleanups.push(() => client.stop());

    const statusRes = await client.proxyFetch(
      new Request("http://127.0.0.1/api/local/status"),
      "/api/local/status",
    );
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual({ version: "0.14.0-test", ok: true });

    const streamRes = await client.proxyFetch(
      new Request("http://127.0.0.1/api/stream"),
      "/api/stream",
    );
    expect(await streamRes.text()).toBe('{"seq":1}\n{"seq":2}\n');

    // Revoking grant disconnects the client and refuses reconnect.
    expect(host.revokeGrant(firstPair.grantId)).toBe(true);
    await vi.waitFor(() => {
      expect(client.state).not.toBe("connected");
    });
    await expect(client.connect()).rejects.toMatchObject({ code: "pairing-failed" });
  });

  test("restricts CALL_UDP_OPEN to ports authorized by 200 OK POST /api/offer answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subspace-udp-gate-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const echoSock = createSocket("udp4");
    cleanups.push(() => {
      echoSock.close();
    });
    await new Promise<void>((resolve) => echoSock.bind(0, "127.0.0.1", () => resolve()));
    const allowedPort = echoSock.address().port;

    const offerSdp = [
      "v=0",
      "o=- 1 1 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "c=IN IP4 127.0.0.1",
      `a=candidate:1 1 udp 2122260223 127.0.0.1 ${allowedPort} typ host generation 0`,
      "a=end-of-candidates",
      "",
    ].join("\r\n");

    const host = new SubspaceHost({
      store: new SubspaceStore(join(dir, "host")),
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: async (request) => {
        if (request.method === "POST" && new URL(request.url).pathname === "/api/offer") {
          return Response.json({ pc_id: "pc-1", sdp: offerSdp });
        }
        return new Response("not found", { status: 404 });
      },
    });
    cleanups.push(() => host.stop());

    const port = await host.startDirect(0);
    const offer = await host.createPairingOffer({ mode: "direct", address: "127.0.0.1", port });
    const paired = await performPairingHandshake(offer, { clientName: "UDP Gate Client" });
    paired.tunnel.ws.on("message", (raw) => {
      void paired.tunnel.session
        .open(new Uint8Array(raw as Buffer))
        .then((plain) => paired.tunnel.mux.handleFrame(plain))
        .catch(() => {});
    });
    cleanups.push(() => {
      paired.tunnel.mux.close();
      paired.tunnel.ws.close();
    });

    // Un-offered port must be rejected immediately with CALL_UDP_CLOSE.
    let unallowedClosed = false;
    const deniedChannel = paired.tunnel.mux.openCallChannel(allowedPort === 49999 ? 49998 : 49999);
    deniedChannel.onClose(() => {
      unallowedClosed = true;
    });
    await vi.waitFor(() => {
      expect(unallowedClosed).toBe(true);
    });

    // Authorizing via 200 OK POST /api/offer allows opening the bridge for `allowedPort`.
    const offerRes = await paired.tunnel.mux.request({
      method: "POST",
      path: "/api/offer",
      headers: [["content-type", "application/json"]],
      body: new Response("{}").body,
    });
    expect(offerRes.status).toBe(200);
    await offerRes.body?.cancel();

    let allowedClosed = false;
    const allowedChannel = paired.tunnel.mux.openCallChannel(allowedPort);
    allowedChannel.onClose(() => {
      allowedClosed = true;
    });
    const echoed = new Promise<string>((resolve) => {
      echoSock.once("message", (msg, rinfo) => {
        echoSock.send(Buffer.from(`pong:${msg.toString("utf8")}`), rinfo.port, rinfo.address);
      });
      allowedChannel.onDatagram((data) => resolve(Buffer.from(data).toString("utf8")));
    });
    await new Promise((r) => setTimeout(r, 25));
    allowedChannel.sendDatagram(Buffer.from("ping"));
    expect(await echoed).toBe("pong:ping");
    expect(allowedClosed).toBe(false);
    allowedChannel.close();
  });

  test("rejects reconnect when grant is revoked mid-handshake during verifyGrantToken", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subspace-revoke-race-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const store = new SubspaceStore(join(dir, "host"));
    const events: string[] = [];
    const host = new SubspaceHost({
      store,
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: async () => Response.json({ ok: true }),
      onEvent: (ev) => {
        events.push(ev.type);
      },
    });
    cleanups.push(() => host.stop());

    const port = await host.startDirect(0);
    const offer = await host.createPairingOffer({ mode: "direct", address: "127.0.0.1", port });
    const paired = await performPairingHandshake(offer, { clientName: "Race Client" });
    paired.tunnel.mux.close();
    paired.tunnel.ws.close();

    // Pause verifyGrantToken until we call host.revokeGrant mid-handshake.
    const originalVerify = store.verifyGrantToken.bind(store);
    const verifyEntered = Promise.withResolvers<void>();
    const releaseVerify = Promise.withResolvers<void>();
    vi.spyOn(store, "verifyGrantToken").mockImplementation(async (grantId, token) => {
      const verified = await originalVerify(grantId, token);
      verifyEntered.resolve();
      await releaseVerify.promise;
      return verified;
    });

    const saved: SubspaceSavedServer = {
      id: "srv-race-1",
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
    const client = new SubspaceClient(saved);
    cleanups.push(() => client.stop());

    const connectPromise = client.connect();
    await verifyEntered.promise;
    expect(host.revokeGrant(paired.grantId)).toBe(true);
    releaseVerify.resolve();

    await expect(connectPromise).rejects.toMatchObject({ code: "pairing-failed" });
    expect(events).not.toContain("device-connected");
  });

  test("binds dual-stack :: so Direct clients pairing over ::1 IPv6 loopback connect", async () => {
    const probe = createServer();
    const hasIpv6Loopback = await new Promise<boolean>((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(0, "::1", () => {
        probe.close(() => resolve(true));
      });
    });
    if (!hasIpv6Loopback) return;

    const dir = mkdtempSync(join(tmpdir(), "subspace-ipv6-e2e-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const host = new SubspaceHost({
      store: new SubspaceStore(join(dir, "host")),
      serverVersion: () => "0.19.0",
      relayUrl: () => "http://127.0.0.1:0",
      dispatch: async () => Response.json({ ipFamily: 6, ok: true }),
    });
    cleanups.push(() => host.stop());

    const port = await host.startDirect(0);
    const offer = await host.createPairingOffer({ mode: "direct", address: "::1", port });
    expect(offer.endpoint).toEqual({ host: "::1", port });

    const paired = await performPairingHandshake(offer, { clientName: "IPv6 Client" });
    const client = new SubspaceClient(
      {
        id: "srv-ipv6-1",
        name: paired.hostName,
        hostPublicKeyB64: offer.hostPublicKeyB64,
        grantId: paired.grantId,
        deviceToken: paired.deviceToken,
        mode: "direct",
        endpoint: offer.endpoint,
        addedAt: Date.now(),
        lastConnectedAt: Date.now(),
        lastVersion: paired.serverVersion,
      },
      {},
      paired.tunnel,
    );
    cleanups.push(() => client.stop());

    const res = await client.proxyFetch(new Request("http://subspace.local/api/ping"), "/api/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ipFamily: 6, ok: true });
  });
});
