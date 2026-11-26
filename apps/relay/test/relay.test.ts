import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateX25519KeyPair,
  performPairingHandshake,
  SubspaceClient,
  SubspaceHost,
  type SubspaceSavedServer,
  SubspaceStore,
} from "@eidolon/subspace";
import { RELAY_CLOSE_CODE, RELAY_PATHS } from "@eidolon/subspace/relay-contract";
import { serve } from "srvx";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { createRelayTokenVerifier } from "../src/jwks-verifier.ts";
import { startRelayServer } from "../src/server.ts";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function encodeJsonB64u(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signEdDsaJwt(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  kid: string,
  claims: Record<string, unknown>,
): string {
  const header = encodeJsonB64u({ alg: "EdDSA", typ: "JWT", kid });
  const payload = encodeJsonB64u(claims);
  const sig = sign(null, Buffer.from(`${header}.${payload}`, "utf8"), privateKey).toString(
    "base64url",
  );
  return `${header}.${payload}.${sig}`;
}

function signEs256Jwt(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  kid: string,
  claims: Record<string, unknown>,
): string {
  const header = encodeJsonB64u({ alg: "ES256", typ: "JWT", kid });
  const payload = encodeJsonB64u(claims);
  const sig = sign("sha256", Buffer.from(`${header}.${payload}`, "utf8"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

async function startMockAuthServer(sessions: ReadonlyMap<string, string>) {
  const ed = generateKeyPairSync("ed25519");
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const edJwk = {
    ...(ed.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
    kid: "ed-1",
    alg: "EdDSA",
    use: "sig",
  };
  const ecJwk = {
    ...(ec.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
    kid: "ec-1",
    alg: "ES256",
    use: "sig",
  };

  let failJwks = false;
  const issuer = "https://id.laplace.live";
  const srvx = serve({
    hostname: "127.0.0.1",
    port: 0,
    reusePort: false,
    silent: true,
    gracefulShutdown: false,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/.well-known/jwks.json") {
        if (failJwks) return new Response("unavailable", { status: 503 });
        return Response.json({ keys: [edJwk, ecJwk] });
      }
      if (pathname === "/api/auth/token") {
        const auth = request.headers.get("authorization") ?? "";
        const sessionToken = auth.replace(/^Bearer\s+/i, "");
        const userId = sessions.get(sessionToken);
        if (userId === undefined) return Response.json({ error: "unauthorized" }, { status: 401 });
        const now = Math.floor(Date.now() / 1000);
        const token = signEdDsaJwt(ed.privateKey, "ed-1", {
          iss: issuer,
          aud: ["https://id.laplace.live", "eidolon-relay"],
          sub: userId,
          iat: now,
          exp: now + 900,
        });
        return Response.json({ token });
      }
      return Response.json({ error: "not-found" }, { status: 404 });
    },
  });

  await srvx.ready();
  const address = srvx.node?.server?.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;
  cleanups.push(() => srvx.close(true));

  return {
    url,
    issuer,
    ed,
    ec,
    setFailJwks: (next: boolean) => {
      failJwks = next;
    },
  };
}

describe("Eidolon Subspace Relay (@eidolon/relay)", () => {
  test("verifies EdDSA and ES256 JWTs against JWKS, rejects invalid claims, and uses bounded stale cache", async () => {
    const auth = await startMockAuthServer(new Map());
    let nowMs = Date.now();
    const verifier = createRelayTokenVerifier(
      {
        authIssuer: auth.issuer,
        authAudience: "eidolon-relay",
        jwksUrl: `${auth.url}/.well-known/jwks.json`,
      },
      { now: () => nowMs, maxStaleMs: 60_000 },
    );

    const nowSec = Math.floor(nowMs / 1000);
    const validEd = signEdDsaJwt(auth.ed.privateKey, "ed-1", {
      iss: auth.issuer,
      aud: ["eidolon-relay", "laplace"],
      sub: "user-ed",
      exp: nowSec + 300,
    });
    const validEc = signEs256Jwt(auth.ec.privateKey, "ec-1", {
      iss: auth.issuer,
      aud: "eidolon-relay",
      sub: "user-ec",
      exp: nowSec + 300,
    });
    const wrongAud = signEdDsaJwt(auth.ed.privateKey, "ed-1", {
      iss: auth.issuer,
      aud: "other-app",
      sub: "user-ed",
      exp: nowSec + 300,
    });
    const wrongIss = signEdDsaJwt(auth.ed.privateKey, "ed-1", {
      iss: "https://evil.example",
      aud: "eidolon-relay",
      sub: "user-ed",
      exp: nowSec + 300,
    });
    const expired = signEdDsaJwt(auth.ed.privateKey, "ed-1", {
      iss: auth.issuer,
      aud: "eidolon-relay",
      sub: "user-ed",
      exp: nowSec - 120,
    });

    expect(await verifier(`Bearer ${validEd}`)).toEqual({ userId: "user-ed" });
    expect(await verifier(`Bearer ${validEc}`)).toEqual({ userId: "user-ec" });
    expect(await verifier(`Bearer ${wrongAud}`)).toBeNull();
    expect(await verifier(`Bearer ${wrongIss}`)).toBeNull();
    expect(await verifier(`Bearer ${expired}`)).toBeNull();
    expect(await verifier("Bearer not-a-jwt")).toBeNull();

    // Advance past 10m cache TTL while JWKS fails -> stale fallback still works within 60s wait.
    auth.setFailJwks(true);
    nowMs += 11 * 60_000;
    expect(await verifier(`Bearer ${validEd}`)).toBeNull(); // exp exceeded at +11m
    const freshToken = signEdDsaJwt(auth.ed.privateKey, "ed-1", {
      iss: auth.issuer,
      aud: "eidolon-relay",
      sub: "user-ed",
      exp: Math.floor(nowMs / 1000) + 300,
    });
    // Wait: maxStaleMs=60_000 is relative to fetchedAt, so beyond 11m cache is staler than 60s and fails closed.
    expect(await verifier(`Bearer ${freshToken}`)).toBeNull();

    // Re-seed cache when auth recovers, then simulate brief outage within 60s maxStaleMs.
    auth.setFailJwks(false);
    expect(await verifier(`Bearer ${freshToken}`)).toEqual({ userId: "user-ed" });
    auth.setFailJwks(true);
    nowMs += 30_000;
    expect(await verifier(`Bearer ${freshToken}`)).toEqual({ userId: "user-ed" });
  });

  test("serves /healthz, validates JWT + X25519 challenge, blocks hijack, splices E2EE, and enforces revocation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eidolon-relay-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const sessions = new Map([
      ["sess-alice", "alice"],
      ["sess-bob", "bob"],
    ]);
    const auth = await startMockAuthServer(sessions);
    const relay = await startRelayServer({
      host: "127.0.0.1",
      port: 0,
      authIssuer: auth.issuer,
      authAudience: "eidolon-relay",
      jwksUrl: `${auth.url}/.well-known/jwks.json`,
      dbPath: ":memory:",
    });
    cleanups.push(() => relay.stop());
    const relayUrl = `http://127.0.0.1:${relay.port}`;

    const health = await fetch(`${relay.url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      ok: true,
      onlineHosts: 0,
      auth: { issuer: auth.issuer, audience: "eidolon-relay" },
    });

    const hostStore = new SubspaceStore(join(dir, "host"));
    hostStore.saveRelayAuth({
      authUrl: auth.url,
      relayUrl,
      token: "sess-alice",
      user: { id: "alice", name: "Alice", email: "alice@laplace.live", image: null },
      savedAt: Date.now(),
    });
    const host = new SubspaceHost({
      store: hostStore,
      serverVersion: () => "0.17.0-relay-test",
      relayUrl: () => relayUrl,
      dispatch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/local/status") {
          return Response.json({ version: "0.17.0-relay-test", proxiedVia: "relay" });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    cleanups.push(() => host.stop());

    const offer = await host.createPairingOffer({ mode: "relay" });
    expect(relay.hub.onlineHostCount).toBe(1);

    // Bob cannot hijack Alice's relayHostId even with a valid JWT.
    const bobJwtRes = await fetch(`${auth.url}/api/auth/token`, {
      headers: { authorization: "Bearer sess-bob" },
    });
    const { token: bobJwt } = (await bobJwtRes.json()) as { token: string };
    const bobKeys = await generateX25519KeyPair();
    const hijackWs = new WebSocket(`${relayUrl.replace("http", "ws")}${RELAY_PATHS.HOST_CONTROL}`, {
      headers: { authorization: `Bearer ${bobJwt}` },
    });
    const hijackClose = new Promise<number>((resolve) => {
      hijackWs.on("open", () => {
        hijackWs.send(
          JSON.stringify({
            type: "host_hello",
            v: 1,
            relayHostId: offer.relay!.relayHostId,
            hostPublicKeyB64: bobKeys.publicKeyB64,
            hostName: "EvilHost",
          }),
        );
      });
      hijackWs.on("close", (code) => resolve(code));
    });
    expect(await hijackClose).toBe(RELAY_CLOSE_CODE.UNAUTHORIZED);

    // Pair legitimate client through the blind E2EE relay.
    const paired = await performPairingHandshake(offer, { clientName: "Relay Client" });
    const saved: SubspaceSavedServer = {
      id: "srv-relay",
      name: "Alice Relay Host",
      hostPublicKeyB64: offer.hostPublicKeyB64,
      grantId: paired.grantId,
      deviceToken: paired.deviceToken,
      mode: "relay",
      relay: offer.relay,
      addedAt: Date.now(),
      lastConnectedAt: Date.now(),
      lastVersion: paired.serverVersion,
    };
    const client = new SubspaceClient(saved, {}, paired.tunnel);
    const res1 = await client.proxyFetch(
      new Request("http://127.0.0.1/api/local/status"),
      "/api/local/status",
    );
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ version: "0.17.0-relay-test", proxiedVia: "relay" });
    client.stop();

    // Reconnect using deviceToken over relay.
    const client2 = new SubspaceClient(saved);
    await client2.connect();
    const res2 = await client2.proxyFetch(
      new Request("http://127.0.0.1/api/local/status"),
      "/api/local/status",
    );
    expect(await res2.json()).toEqual({ version: "0.17.0-relay-test", proxiedVia: "relay" });
    client2.stop();

    // Revoke grant on host -> relay rejects subsequent client connection with deviceToken.
    expect(host.revokeGrant(paired.grantId)).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    const client3 = new SubspaceClient(saved);
    await expect(client3.connect()).rejects.toThrow();
    client3.stop();
  });
});
