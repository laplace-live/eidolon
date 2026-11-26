import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
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
    await expect(performPairingHandshake(offer, { clientName: "Second Try" })).rejects.toThrow();

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
    await new Promise((r) => setTimeout(r, 30));
    await expect(client.connect()).rejects.toThrow();
  });
});
