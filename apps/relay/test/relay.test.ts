import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  base64ToBytes,
  computeRelayControlProof,
  deriveRelayDeviceToken,
  deriveRelayHostId,
  deriveRelayInviteToken,
  generateX25519KeyPair,
  importX25519PrivateKey,
  performPairingHandshake,
  SubspaceClient,
  SubspaceHost,
  type SubspaceSavedServer,
  SubspaceStore,
  sha256Hex,
  utf8Encode,
} from "@eidolon/subspace";
import { RELAY_CLOSE_CODE, RELAY_PATHS } from "@eidolon/subspace/relay-contract";
import { serve } from "srvx";
import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { loadRelayConfig } from "../src/config.ts";
import { createRelayTokenVerifier, RelayJwksUnavailableError } from "../src/jwks-verifier.ts";
import { openRelayDatabase, RelayStore } from "../src/relay-db.ts";
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
  let jwksRequests = 0;
  const extraJwks: Record<string, unknown>[] = [];
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
        jwksRequests += 1;
        if (failJwks) return new Response("unavailable", { status: 503 });
        return Response.json({ keys: [edJwk, ecJwk, ...extraJwks] });
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
    addJwk: (jwk: Record<string, unknown>) => {
      extraJwks.push(jwk);
    },
    jwksRequests: () => jwksRequests,
  };
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("error", () => {});
    if (ws.readyState === WebSocket.CLOSED) {
      resolve({ code: 1006, reason: "" });
      return;
    }
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
  });
}

async function connectRawRelayHost(
  relayUrl: string,
  jwt: string,
  options: { readonly autoPong?: boolean; readonly hostName?: string } = {},
): Promise<{
  readonly ws: WebSocket;
  readonly relayHostId: string;
  readonly closed: Promise<{ code: number; reason: string }>;
  waitMessage(
    predicate: (msg: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>>;
}> {
  const keys = await generateX25519KeyPair();
  const privateKey = await importX25519PrivateKey(keys.privateKeyPkcs8B64);
  const relayHostId = await deriveRelayHostId(base64ToBytes(keys.publicKeyB64));
  const ws = new WebSocket(`${relayUrl.replace("http", "ws")}${RELAY_PATHS.HOST_CONTROL}`, {
    autoPong: options.autoPong ?? true,
    headers: { authorization: `Bearer ${jwt}` },
  });
  cleanups.push(() => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  });

  const closed = waitForClose(ws);
  const messages: Record<string, unknown>[] = [];
  const waiters: {
    readonly predicate: (msg: Record<string, unknown>) => boolean;
    readonly resolve: (msg: Record<string, unknown>) => void;
    readonly reject: (err: Error) => void;
  }[] = [];
  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
    const idx = waiters.findIndex((w) => w.predicate(parsed));
    if (idx !== -1) {
      waiters.splice(idx, 1)[0]!.resolve(parsed);
    } else {
      messages.push(parsed);
    }
  });
  void closed.then(() => {
    for (const waiter of waiters.splice(0)) {
      waiter.reject(new Error("Host control socket closed"));
    }
  });
  const waitMessage = (
    predicate: (msg: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> => {
    const idx = messages.findIndex(predicate);
    if (idx !== -1) return Promise.resolve(messages.splice(idx, 1)[0]!);
    return new Promise((resolve, reject) => {
      waiters.push({ predicate, resolve, reject });
    });
  };

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(
    JSON.stringify({
      type: "host_hello",
      v: 1,
      relayHostId,
      hostPublicKeyB64: keys.publicKeyB64,
      hostName: options.hostName ?? "RawTestHost",
    }),
  );

  const challenge = await waitMessage((m) => m.type === "host_challenge");
  const proofB64 = await computeRelayControlProof(
    privateKey,
    String(challenge.relayEphPubB64),
    String(challenge.challengeB64),
    String(challenge.userId),
  );
  ws.send(JSON.stringify({ type: "host_challenge_ack", proofB64 }));

  await waitMessage((m) => m.type === "host_hello_ack");
  return { ws, relayHostId, closed, waitMessage };
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
      { now: () => nowMs, maxStaleMs: 12 * 60_000 },
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

    // Advance past maxStaleMs (12m) while JWKS fails -> throws RelayJwksUnavailableError (503-equivalent retryable outage)
    // while expired/invalid claims still return null (4401 UNAUTHORIZED).
    auth.setFailJwks(true);
    nowMs += 13 * 60_000;
    expect(await verifier(`Bearer ${validEd}`)).toBeNull();
    const freshToken = signEdDsaJwt(auth.ed.privateKey, "ed-1", {
      iss: auth.issuer,
      aud: "eidolon-relay",
      sub: "user-ed",
      exp: Math.floor(nowMs / 1000) + 300,
    });
    await expect(verifier(`Bearer ${freshToken}`)).rejects.toBeInstanceOf(
      RelayJwksUnavailableError,
    );
    expect(await verifier(`Bearer ${wrongIss}`)).toBeNull();

    // Re-seed cache after cooldown when auth recovers, then advance past CACHE_TTL_MS into stale window inside maxStaleMs.
    auth.setFailJwks(false);
    nowMs += 31_000;
    const recoveredToken = signEdDsaJwt(auth.ed.privateKey, "ed-1", {
      iss: auth.issuer,
      aud: "eidolon-relay",
      sub: "user-ed",
      exp: Math.floor(nowMs / 1000) + 1200,
    });
    expect(await verifier(`Bearer ${recoveredToken}`)).toEqual({ userId: "user-ed" });
    auth.setFailJwks(true);
    nowMs += 11 * 60_000;
    const fetchesBeforeOutage = auth.jwksRequests();
    expect(await verifier(`Bearer ${recoveredToken}`)).toEqual({ userId: "user-ed" });
    expect(auth.jwksRequests()).toBe(fetchesBeforeOutage + 1);
    nowMs += 10_000;
    expect(await verifier(`Bearer ${recoveredToken}`)).toEqual({ userId: "user-ed" });
    expect(auth.jwksRequests()).toBe(fetchesBeforeOutage + 1);
  });

  test("throws RelayJwksUnavailableError during retry cooldown without hammering JWKS when cache is empty, and closes host sockets with 4503", async () => {
    const auth = await startMockAuthServer(new Map());
    auth.setFailJwks(true);
    let nowMs = Date.now();
    const verifier = createRelayTokenVerifier(
      {
        authIssuer: auth.issuer,
        authAudience: "eidolon-relay",
        jwksUrl: `${auth.url}/.well-known/jwks.json`,
      },
      { now: () => nowMs },
    );

    const token = signEdDsaJwt(auth.ed.privateKey, "ed-1", {
      iss: auth.issuer,
      aud: "eidolon-relay",
      sub: "user-ed",
      exp: Math.floor(nowMs / 1000) + 300,
    });

    await expect(verifier(`Bearer ${token}`)).rejects.toBeInstanceOf(RelayJwksUnavailableError);
    expect(auth.jwksRequests()).toBe(1);

    nowMs += 10_000;
    await expect(verifier(`Bearer ${token}`)).rejects.toBeInstanceOf(RelayJwksUnavailableError);
    expect(auth.jwksRequests()).toBe(1);

    // Invalid JWT still returns null without triggering JWKS fetch or 4503.
    expect(await verifier("Bearer bad")).toBeNull();

    nowMs += 21_000;
    auth.setFailJwks(false);
    expect(await verifier(`Bearer ${token}`)).toEqual({ userId: "user-ed" });
    expect(auth.jwksRequests()).toBe(2);

    // End-to-end relay WebSocket close code: 4503 during JWKS outage vs 4401 on invalid token.
    auth.setFailJwks(true);
    const dir = mkdtempSync(join(tmpdir(), "eidolon-relay-4503-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const relay = await startRelayServer({
      port: 0,
      host: "127.0.0.1",
      dbPath: join(dir, "relay.sqlite"),
      authIssuer: auth.issuer,
      authAudience: "eidolon-relay",
      jwksUrl: `${auth.url}/.well-known/jwks.json`,
      publicUrl: "http://127.0.0.1:0",
    });
    cleanups.push(() => relay.stop());

    const outageToken = signEdDsaJwt(auth.ed.privateKey, "ed-1", {
      iss: auth.issuer,
      aud: "eidolon-relay",
      sub: "user-ed",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const wsOutage = new WebSocket(
      `${relay.url.replace("http", "ws")}${RELAY_PATHS.HOST_CONTROL}`,
      { headers: { authorization: `Bearer ${outageToken}` } },
    );
    cleanups.push(() => wsOutage.terminate());
    expect((await waitForClose(wsOutage)).code).toBe(RELAY_CLOSE_CODE.AUTH_UNAVAILABLE);

    const wsBad = new WebSocket(`${relay.url.replace("http", "ws")}${RELAY_PATHS.HOST_CONTROL}`, {
      headers: { authorization: "Bearer not-a-jwt" },
    });
    cleanups.push(() => wsBad.terminate());
    expect((await waitForClose(wsBad)).code).toBe(RELAY_CLOSE_CODE.UNAUTHORIZED);
  });

  test("treats uncached kid during 30s cooldown or outage fallback as RelayJwksUnavailableError (4503) instead of 4401", async () => {
    const auth = await startMockAuthServer(new Map());
    let nowMs = Date.now();
    const verifier = createRelayTokenVerifier(
      {
        authIssuer: auth.issuer,
        authAudience: "eidolon-relay",
        jwksUrl: `${auth.url}/.well-known/jwks.json`,
      },
      { now: () => nowMs },
    );

    const ed1Token = signEdDsaJwt(auth.ed.privateKey, "ed-1", {
      iss: auth.issuer,
      aud: "eidolon-relay",
      sub: "user-ed1",
      exp: Math.floor(nowMs / 1000) + 1800,
    });
    expect(await verifier(`Bearer ${ed1Token}`)).toEqual({ userId: "user-ed1" });
    expect(auth.jwksRequests()).toBe(1);

    const ed2 = generateKeyPairSync("ed25519");
    const ed2Jwk = {
      ...(ed2.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
      kid: "ed-2",
      alg: "EdDSA",
      use: "sig",
    };
    auth.addJwk(ed2Jwk);

    // Within 30s cooldown after initial JWKS fetch, new kid triggers retryable RelayJwksUnavailableError (4503).
    nowMs += 5_000;
    const ed2Token = signEdDsaJwt(ed2.privateKey, "ed-2", {
      iss: auth.issuer,
      aud: "eidolon-relay",
      sub: "user-ed2",
      exp: Math.floor(nowMs / 1000) + 1800,
    });
    await expect(verifier(`Bearer ${ed2Token}`)).rejects.toBeInstanceOf(RelayJwksUnavailableError);
    expect(auth.jwksRequests()).toBe(1);

    // Once past 30s cooldown, verifier refreshes JWKS and accepts the rotated kid.
    nowMs += 26_000;
    expect(await verifier(`Bearer ${ed2Token}`)).toEqual({ userId: "user-ed2" });
    expect(auth.jwksRequests()).toBe(2);

    // After cooldown expires again, a genuinely unknown kid triggers a fresh fetch and returns null (4401).
    nowMs += 31_000;
    const unknownToken = signEdDsaJwt(ed2.privateKey, "unknown-kid", {
      iss: auth.issuer,
      aud: "eidolon-relay",
      sub: "user-unknown",
      exp: Math.floor(nowMs / 1000) + 1800,
    });
    expect(await verifier(`Bearer ${unknownToken}`)).toBeNull();
    expect(auth.jwksRequests()).toBe(3);

    // During a later JWKS outage, cached kid ed-2 still verifies from stale cache while an uncached kid yields 4503.
    auth.setFailJwks(true);
    nowMs += 11 * 60_000;
    const ed3Token = signEdDsaJwt(ed2.privateKey, "ed-3", {
      iss: auth.issuer,
      aud: "eidolon-relay",
      sub: "user-ed3",
      exp: Math.floor(nowMs / 1000) + 1800,
    });
    expect(await verifier(`Bearer ${ed2Token}`)).toEqual({ userId: "user-ed2" });
    await expect(verifier(`Bearer ${ed3Token}`)).rejects.toBeInstanceOf(RelayJwksUnavailableError);

    // Live relay server E2E: warm cache with ed-1, add key ed-4 during cooldown -> host socket closes 4503 instead of 4401.
    const liveAuth = await startMockAuthServer(new Map());
    const liveDir = mkdtempSync(join(tmpdir(), "eidolon-relay-kid-cooldown-"));
    cleanups.push(() => rmSync(liveDir, { recursive: true, force: true }));
    const relay = await startRelayServer({
      port: 0,
      host: "127.0.0.1",
      dbPath: join(liveDir, "relay.sqlite"),
      authIssuer: liveAuth.issuer,
      authAudience: "eidolon-relay",
      jwksUrl: `${liveAuth.url}/.well-known/jwks.json`,
      publicUrl: "http://127.0.0.1:0",
    });
    cleanups.push(() => relay.stop());

    const liveEd1 = signEdDsaJwt(liveAuth.ed.privateKey, "ed-1", {
      iss: liveAuth.issuer,
      aud: "eidolon-relay",
      sub: "user-ed1",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const warm = await connectRawRelayHost(relay.url, liveEd1);
    warm.ws.close(1000, "done");
    await warm.closed;

    const ed4 = generateKeyPairSync("ed25519");
    liveAuth.addJwk({
      ...(ed4.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
      kid: "ed-4",
      alg: "EdDSA",
      use: "sig",
    });
    const liveEd4 = signEdDsaJwt(ed4.privateKey, "ed-4", {
      iss: liveAuth.issuer,
      aud: "eidolon-relay",
      sub: "user-ed4",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const wsRotated = new WebSocket(
      `${relay.url.replace("http", "ws")}${RELAY_PATHS.HOST_CONTROL}`,
      {
        headers: { authorization: `Bearer ${liveEd4}` },
      },
    );
    cleanups.push(() => wsRotated.terminate());
    expect((await waitForClose(wsRotated)).code).toBe(RELAY_CLOSE_CODE.AUTH_UNAVAILABLE);
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
      publicUrl: "https://relay.example.test",
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
      publicUrl: "https://relay.example.test",
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

  test("putInvite replaces prior host invites and clamps TTL to 11 minutes", async () => {
    const db = openRelayDatabase(":memory:");
    cleanups.push(() => db.close());
    const store = new RelayStore(db);

    const now = 1_700_000_000_000;
    const hashA = await sha256Hex(utf8Encode("ticket-a"));
    const hashB = await sha256Hex(utf8Encode("ticket-b"));
    const hashOther = await sha256Hex(utf8Encode("ticket-other"));

    store.putInvite(
      {
        inviteId: "inv-a",
        relayHostId: "host-alpha",
        ticketSha256: hashA,
        expiresAt: now + 60 * 60_000,
      },
      now,
    );
    expect(store.consumeInvite("host-alpha", hashA, now + 11 * 60_000)).toBe(false);

    store.putInvite(
      {
        inviteId: "inv-a-2",
        relayHostId: "host-alpha",
        ticketSha256: hashA,
        expiresAt: now + 60 * 60_000,
      },
      now,
    );
    store.putInvite(
      {
        inviteId: "inv-b",
        relayHostId: "host-alpha",
        ticketSha256: hashB,
        expiresAt: now + 60 * 60_000,
      },
      now,
    );
    store.putInvite(
      {
        inviteId: "inv-other",
        relayHostId: "host-beta",
        ticketSha256: hashOther,
        expiresAt: now + 60 * 60_000,
      },
      now,
    );

    expect(store.consumeInvite("host-alpha", hashA, now + 1000)).toBe(false);
    expect(store.consumeInvite("host-alpha", hashB, now + 10 * 60_000)).toBe(true);
    expect(store.consumeInvite("host-alpha", hashB, now + 10 * 60_000)).toBe(false);
    expect(store.consumeInvite("host-beta", hashOther, now + 1000)).toBe(true);
  });

  test("closes sockets that exceed the 64 KiB pre-auth frame limit", async () => {
    const auth = await startMockAuthServer(new Map([["sess-alice", "alice"]]));
    let releaseJwks!: () => void;
    let holdJwks = true;
    const gate = new Promise<void>((resolve) => {
      releaseJwks = resolve;
    });
    const relay = await startRelayServer({
      host: "127.0.0.1",
      port: 0,
      authIssuer: auth.issuer,
      authAudience: "eidolon-relay",
      jwksUrl: `${auth.url}/.well-known/jwks.json`,
      dbPath: ":memory:",
      fetch: async (input, init) => {
        if (holdJwks) await gate;
        return fetch(input, init);
      },
    });
    cleanups.push(() => {
      holdJwks = false;
      releaseJwks();
      return relay.stop();
    });

    const clientWs = new WebSocket(
      `${relay.url.replace("http", "ws")}${RELAY_PATHS.CLIENT_CONNECT}`,
    );
    const clientClosed = waitForClose(clientWs);
    await new Promise<void>((resolve, reject) => {
      clientWs.once("open", () => resolve());
      clientWs.once("error", reject);
    });
    clientWs.send("x".repeat(65 * 1024));
    await clientClosed;

    const jwtRes = await fetch(`${auth.url}/api/auth/token`, {
      headers: { authorization: "Bearer sess-alice" },
    });
    const { token: jwt } = (await jwtRes.json()) as { token: string };
    const hostWs = new WebSocket(`${relay.url.replace("http", "ws")}${RELAY_PATHS.HOST_CONTROL}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const hostClosed = waitForClose(hostWs);
    await new Promise<void>((resolve, reject) => {
      hostWs.once("open", () => resolve());
      hostWs.once("error", reject);
    });
    hostWs.send("a".repeat(40 * 1024));
    hostWs.send("b".repeat(40 * 1024));
    await hostClosed;

    holdJwks = false;
    releaseJwks();
    await new Promise((r) => setTimeout(r, 30));
    expect(relay.hub.onlineHostCount).toBe(0);
    expect((await fetch(`${relay.url}/healthz`)).status).toBe(200);
  });

  test("handles errors on authenticated host control sockets without crashing", async () => {
    const auth = await startMockAuthServer(new Map([["sess-alice", "alice"]]));
    const relay = await startRelayServer({
      host: "127.0.0.1",
      port: 0,
      authIssuer: auth.issuer,
      authAudience: "eidolon-relay",
      jwksUrl: `${auth.url}/.well-known/jwks.json`,
      dbPath: ":memory:",
    });
    cleanups.push(() => relay.stop());

    const { token: jwt } = (await (
      await fetch(`${auth.url}/api/auth/token`, {
        headers: { authorization: "Bearer sess-alice" },
      })
    ).json()) as { token: string };

    const host = await connectRawRelayHost(relay.url, jwt);
    expect(relay.hub.onlineHostCount).toBe(1);

    // Exceeds WebSocketServer maxPayload (16 MiB), triggering Receiver error after queue detachment.
    host.ws.send(Buffer.alloc(16 * 1024 * 1024 + 1024));
    await host.closed;

    expect(relay.hub.onlineHostCount).toBe(0);
    expect((await fetch(`${relay.url}/healthz`)).status).toBe(200);
  });

  test("evicts hosts that miss heartbeat pongs and retains responsive hosts", async () => {
    const auth = await startMockAuthServer(
      new Map([
        ["sess-alice", "alice"],
        ["sess-bob", "bob"],
      ]),
    );
    const relay = await startRelayServer({
      host: "127.0.0.1",
      port: 0,
      authIssuer: auth.issuer,
      authAudience: "eidolon-relay",
      jwksUrl: `${auth.url}/.well-known/jwks.json`,
      dbPath: ":memory:",
      heartbeatMs: 25,
    });
    cleanups.push(() => relay.stop());

    const { token: aliceJwt } = (await (
      await fetch(`${auth.url}/api/auth/token`, {
        headers: { authorization: "Bearer sess-alice" },
      })
    ).json()) as { token: string };
    const { token: bobJwt } = (await (
      await fetch(`${auth.url}/api/auth/token`, {
        headers: { authorization: "Bearer sess-bob" },
      })
    ).json()) as { token: string };

    const aliveHost = await connectRawRelayHost(relay.url, aliceJwt, { autoPong: true });
    const silentHost = await connectRawRelayHost(relay.url, bobJwt, { autoPong: false });
    expect(relay.hub.onlineHostCount).toBe(2);

    await silentHost.closed;
    await new Promise((r) => setTimeout(r, 80));

    expect(relay.hub.onlineHostCount).toBe(1);
    expect(aliveHost.ws.readyState).toBe(WebSocket.OPEN);
  });

  test("validates client_auth relayTicket and relayToken credentials", async () => {
    const auth = await startMockAuthServer(new Map([["sess-alice", "alice"]]));
    const relay = await startRelayServer({
      host: "127.0.0.1",
      port: 0,
      authIssuer: auth.issuer,
      authAudience: "eidolon-relay",
      jwksUrl: `${auth.url}/.well-known/jwks.json`,
      dbPath: ":memory:",
    });
    cleanups.push(() => relay.stop());

    const { token: jwt } = (await (
      await fetch(`${auth.url}/api/auth/token`, {
        headers: { authorization: "Bearer sess-alice" },
      })
    ).json()) as { token: string };
    const host = await connectRawRelayHost(relay.url, jwt);

    const goodRelayTicket = await deriveRelayInviteToken("good-ticket");
    const wrongRelayTicket = await deriveRelayInviteToken("wrong-ticket");
    const goodRelayToken = await deriveRelayDeviceToken("good-token");
    const wrongRelayToken = await deriveRelayDeviceToken("wrong-token");
    const inviteHash = await sha256Hex(utf8Encode(goodRelayTicket));
    const deviceHash = await sha256Hex(utf8Encode(goodRelayToken));
    host.ws.send(
      JSON.stringify({
        type: "invite_create",
        inviteId: "inv-1",
        ticketHash: inviteHash,
        expiresAt: Date.now() + 60_000,
      }),
    );
    host.ws.send(
      JSON.stringify({
        type: "device_install",
        grantId: "grant-1",
        tokenHash: deviceHash,
        clientName: "Phone",
      }),
    );

    const sendClientAuth = async (credential: Record<string, unknown>) => {
      const ws = new WebSocket(`${relay.url.replace("http", "ws")}${RELAY_PATHS.CLIENT_CONNECT}`);
      cleanups.push(() => {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      });
      const closed = waitForClose(ws);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      ws.send(
        JSON.stringify({
          type: "client_auth",
          v: 1,
          relayHostId: host.relayHostId,
          credential,
        }),
      );
      return { ws, closed };
    };

    await host.waitMessage((m) => m.type === "invite_created");
    await host.waitMessage((m) => m.type === "device_installed");

    const badInvite = await sendClientAuth({ kind: "invite", relayTicket: wrongRelayTicket });
    expect((await badInvite.closed).code).toBe(RELAY_CLOSE_CODE.UNAUTHORIZED);

    const badDevice = await sendClientAuth({
      kind: "device",
      grantId: "grant-1",
      relayToken: wrongRelayToken,
    });
    expect((await badDevice.closed).code).toBe(RELAY_CLOSE_CODE.UNAUTHORIZED);

    const openInvitePromise = host.waitMessage(
      (m) => m.type === "connection_open" && m.grantId === null,
    );
    const goodInvite = await sendClientAuth({ kind: "invite", relayTicket: goodRelayTicket });
    const inviteOpen = await Promise.race([
      openInvitePromise,
      goodInvite.closed.then((c) => {
        throw new Error(`Invite auth closed early (${c.code}): ${c.reason}`);
      }),
    ]);
    expect(inviteOpen.grantId).toBeNull();

    const openDevicePromise = host.waitMessage(
      (m) => m.type === "connection_open" && m.grantId === "grant-1",
    );
    const goodDevice = await sendClientAuth({
      kind: "device",
      grantId: "grant-1",
      relayToken: goodRelayToken,
    });
    const deviceOpen = await Promise.race([
      openDevicePromise,
      goodDevice.closed.then((c) => {
        throw new Error(`Device auth closed early (${c.code}): ${c.reason}`);
      }),
    ]);
    expect(deviceOpen.grantId).toBe("grant-1");
  });

  test("loadRelayConfig trims surrounding spaces and rejects trailing backslashes or whitespace", () => {
    const keys = [
      "EIDOLON_RELAY_PUBLIC_URL",
      "EIDOLON_RELAY_AUTH_ISSUER",
      "EIDOLON_RELAY_AUTH_AUDIENCE",
      "EIDOLON_RELAY_JWKS_URL",
    ] as const;
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const restore = () => {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    };
    try {
      process.env.EIDOLON_RELAY_PUBLIC_URL = " https://relay.example.com/ ";
      process.env.EIDOLON_RELAY_AUTH_ISSUER = " https://id.example.com/ ";
      process.env.EIDOLON_RELAY_AUTH_AUDIENCE = " eidolon-relay ";
      delete process.env.EIDOLON_RELAY_JWKS_URL;
      expect(loadRelayConfig()).toMatchObject({
        publicUrl: "https://relay.example.com",
        authIssuer: "https://id.example.com",
        authAudience: "eidolon-relay",
        jwksUrl: "https://id.example.com/.well-known/jwks.json",
      });

      for (const [key, badValue] of [
        ["EIDOLON_RELAY_AUTH_ISSUER", "https://id.laplace.live \\"],
        ["EIDOLON_RELAY_PUBLIC_URL", "https://eidolon-relay.vrp.moe \\"],
        ["EIDOLON_RELAY_AUTH_AUDIENCE", "eidolon-relay \\"],
        ["EIDOLON_RELAY_JWKS_URL", "https://id.laplace.live/.well-known/jwks.json \\"],
      ] as const) {
        for (const k of keys) delete process.env[k];
        process.env[key] = badValue;
        expect(() => loadRelayConfig()).toThrow(key);
      }
    } finally {
      restore();
    }
  });
});
