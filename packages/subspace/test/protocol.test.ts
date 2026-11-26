import { afterEach, describe, expect, test, vi } from "vitest";
import {
  acceptHostHandshake,
  ClientAuthSchema,
  completeDeviceAuthorization,
  computeRelayControlProof,
  DirectEndpointSchema,
  deriveRelayDeviceToken,
  deriveRelayHostId,
  deriveRelayInviteToken,
  discoverRelayAuthUrl,
  E2eeError,
  encodePairingCode,
  encodePairingUrl,
  generateX25519KeyPair,
  HostChallengeAckSchema,
  HostChallengeSchema,
  HostHelloAckSchema,
  HostHelloSchema,
  httpToWsUrl,
  importX25519PrivateKey,
  importX25519PublicKey,
  isPairingExpired,
  listShareableAddresses,
  parsePairingInput,
  pollDeviceToken,
  RelayEndpointSchema,
  randomBytes,
  signOutRelaySession,
  startClientHandshake,
  utf8Decode,
  utf8Encode,
} from "../src/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pairing codec", () => {
  test("encodes and parses Direct and Relay pairing links and bare codes", async () => {
    const kp = await generateX25519KeyPair();
    const directOffer = {
      v: 1 as const,
      mode: "direct" as const,
      hostName: "Mac Studio",
      hostPublicKeyB64: kp.publicKeyB64,
      ticket: "abcdefghijklmnopqrstuvwx",
      expiresAt: Date.now() + 60_000,
      endpoint: { host: "100.64.0.8", port: 48921 },
    };
    const url = encodePairingUrl(directOffer);
    expect(url).toStartWith("eidolon://pair?code=");
    const code = encodePairingCode(directOffer);
    expect(parsePairingInput(url)).toEqual({ ok: true, offer: directOffer, code });
    expect(parsePairingInput(`  ${code}\n`)).toEqual({ ok: true, offer: directOffer, code });

    const relayHostId = await deriveRelayHostId(
      Uint8Array.from(Buffer.from(kp.publicKeyB64, "base64")),
    );
    expect(relayHostId).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    const relayOffer = {
      v: 1 as const,
      mode: "relay" as const,
      hostName: "Home Linux",
      hostPublicKeyB64: kp.publicKeyB64,
      ticket: "zzzzzzzzzzzzzzzzzzzzzzzz",
      expiresAt: Date.now() + 60_000,
      relay: { url: "https://eidolon-relay.vrp.moe", relayHostId },
    };
    const parsedRelay = parsePairingInput(encodePairingUrl(relayOffer));
    expect(parsedRelay).toEqual({
      ok: true,
      offer: relayOffer,
      code: encodePairingCode(relayOffer),
    });
  });

  test("rejects malformed links, wrong URI schemes/hosts, and detects expiry", () => {
    expect(parsePairingInput("")).toEqual({ ok: false, reason: "invalid-format" });
    expect(parsePairingInput("https://example.com/?code=abc")).toEqual({
      ok: false,
      reason: "invalid-format",
    });
    expect(parsePairingInput("eidolon://other?code=abc")).toEqual({
      ok: false,
      reason: "invalid-format",
    });
    expect(parsePairingInput("eidolon://pair")).toEqual({
      ok: false,
      reason: "invalid-code",
    });
    expect(parsePairingInput("eidolon://pair?code=not-valid-base64")).toEqual({
      ok: false,
      reason: "invalid-code",
    });
    expect(isPairingExpired({ expiresAt: 1000 }, 1000)).toBe(true);
    expect(isPairingExpired({ expiresAt: 1001 }, 1000)).toBe(false);
  });
});

describe("Dual-DH X25519 + AES-256-GCM", () => {
  test("derives matching channel bindings and encrypts bidirectionally in sequence", async () => {
    const hostKp = await generateX25519KeyPair();
    const hostPriv = await importX25519PrivateKey(hostKp.privateKeyPkcs8B64);

    const clientHs = await startClientHandshake(hostKp.publicKeyB64);
    const { readyRaw, session: hostSession } = await acceptHostHandshake(
      { publicKeyB64: hostKp.publicKeyB64, privateKey: hostPriv },
      clientHs.helloRaw,
    );
    const clientSession = await clientHs.finish(readyRaw);

    expect(clientSession.authBinding).toBe(hostSession.authBinding);
    expect(clientSession.authBinding.length).toBeGreaterThan(20);

    const sealedFromClient = await clientSession.seal(utf8Encode("hello host"));
    expect(utf8Decode(await hostSession.open(sealedFromClient))).toBe("hello host");

    const sealedFromHost = await hostSession.seal(utf8Encode("hello client"));
    expect(utf8Decode(await clientSession.open(sealedFromHost))).toBe("hello client");
  });

  test("refuses pinned host key mismatches (MITM protection)", async () => {
    const realHost = await generateX25519KeyPair();
    const attackerHost = await generateX25519KeyPair();
    const attackerPriv = await importX25519PrivateKey(attackerHost.privateKeyPkcs8B64);

    const clientHs = await startClientHandshake(realHost.publicKeyB64);
    const { readyRaw } = await acceptHostHandshake(
      { publicKeyB64: attackerHost.publicKeyB64, privateKey: attackerPriv },
      clientHs.helloRaw,
    );

    await expect(clientHs.finish(readyRaw)).rejects.toMatchObject({
      name: "E2eeError",
      code: "key-mismatch",
    });
  });

  test("rejects malformed base64 pinned or peer host keys with E2eeError", async () => {
    await expect(startClientHandshake("not-valid-base64!")).rejects.toMatchObject({
      name: "E2eeError",
      code: "invalid-key",
    });

    const realHost = await generateX25519KeyPair();
    const eph = await generateX25519KeyPair();
    const clientHs = await startClientHandshake(realHost.publicKeyB64);
    await expect(
      clientHs.finish(
        JSON.stringify({
          type: "e2ee_ready",
          v: 1,
          hostPubB64: "not-valid-base64!",
          hostEphPubB64: eph.publicKeyB64,
        }),
      ),
    ).rejects.toMatchObject({
      name: "E2eeError",
      code: "invalid-key",
    });
  });

  test("refuses replayed, reordered, truncated, or tampered frames", async () => {
    const hostKp = await generateX25519KeyPair();
    const hostPriv = await importX25519PrivateKey(hostKp.privateKeyPkcs8B64);
    const clientHs = await startClientHandshake(hostKp.publicKeyB64);
    const { readyRaw, session: host } = await acceptHostHandshake(
      { publicKeyB64: hostKp.publicKeyB64, privateKey: hostPriv },
      clientHs.helloRaw,
    );
    const client = await clientHs.finish(readyRaw);

    const f0 = await client.seal(utf8Encode("msg-0"));
    const f1 = await client.seal(utf8Encode("msg-1"));

    // Truncated frame.
    await expect(host.open(f0.subarray(0, 12))).rejects.toThrow(E2eeError);

    // Tampered ciphertext (clone so f0 stays intact).
    const tampered = new Uint8Array(f0);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(host.open(tampered)).rejects.toMatchObject({ code: "decrypt-failed" });

    // Out-of-order frame (seq 1 when expecting 0).
    await expect(host.open(f1)).rejects.toMatchObject({ code: "sequence-error" });

    // Valid seq 0 advances recvSeq to 1.
    expect(utf8Decode(await host.open(f0))).toBe("msg-0");
    // Replaying seq 0 fails.
    await expect(host.open(f0)).rejects.toMatchObject({ code: "sequence-error" });
    // Seq 1 now succeeds.
    expect(utf8Decode(await host.open(f1))).toBe("msg-1");
  });

  test("computes identical X25519 ECDH control proofs from either side and rejects wrong user/key", async () => {
    const hostKp = await generateX25519KeyPair();
    const relayKp = await generateX25519KeyPair();
    const otherKp = await generateX25519KeyPair();

    const hostPriv = await importX25519PrivateKey(hostKp.privateKeyPkcs8B64);
    const relayPriv = await importX25519PrivateKey(relayKp.privateKeyPkcs8B64);
    const otherPriv = await importX25519PrivateKey(otherKp.privateKeyPkcs8B64);
    await importX25519PublicKey(hostKp.publicKeyB64);

    const challenge = Buffer.from(randomBytes(32)).toString("base64");
    const proofHost = await computeRelayControlProof(
      hostPriv,
      relayKp.publicKeyB64,
      challenge,
      "user_1",
    );
    const proofRelay = await computeRelayControlProof(
      relayPriv,
      hostKp.publicKeyB64,
      challenge,
      "user_1",
    );
    const proofWrongUser = await computeRelayControlProof(
      relayPriv,
      hostKp.publicKeyB64,
      challenge,
      "user_2",
    );
    const proofWrongKey = await computeRelayControlProof(
      otherPriv,
      relayKp.publicKeyB64,
      challenge,
      "user_1",
    );

    expect(proofHost).toBe(proofRelay);
    expect(proofWrongUser).not.toBe(proofHost);
    expect(proofWrongKey).not.toBe(proofHost);
  });

  test("enforces fatal UTF-8 decoding, endpoint validation, relay contract bounds, and derived tokens", async () => {
    expect(() => utf8Decode(new Uint8Array([0xff, 0xfe]))).toThrow(TypeError);

    expect(DirectEndpointSchema.safeParse({ host: "100.64.0.8", port: 48921 }).success).toBe(true);
    expect(DirectEndpointSchema.safeParse({ host: "::1", port: 48921 }).success).toBe(true);
    expect(DirectEndpointSchema.safeParse({ host: "[2001:db8::1]", port: 48921 }).success).toBe(
      true,
    );
    for (const badHost of [
      "evil.com/path",
      "user@127.0.0.1",
      "host?x=1",
      "host#frag",
      "bad host",
      "127.0.0.1:8080",
    ]) {
      expect(DirectEndpointSchema.safeParse({ host: badHost, port: 48921 }).success).toBe(false);
    }

    expect(
      RelayEndpointSchema.safeParse({
        url: "https://eidolon-relay.vrp.moe",
        relayHostId: "host_12345678",
      }).success,
    ).toBe(true);
    expect(
      RelayEndpointSchema.safeParse({
        url: "wss://eidolon-relay.vrp.moe",
        relayHostId: "host_12345678",
      }).success,
    ).toBe(true);
    expect(
      RelayEndpointSchema.safeParse({
        url: "http://127.0.0.1:8787",
        relayHostId: "host_12345678",
      }).success,
    ).toBe(true);
    expect(
      RelayEndpointSchema.safeParse({
        url: "ws://[::1]:8787",
        relayHostId: "host_12345678",
      }).success,
    ).toBe(true);
    expect(
      RelayEndpointSchema.safeParse({
        url: "http://relay.example.com",
        relayHostId: "host_12345678",
      }).success,
    ).toBe(false);

    const long = "a".repeat(257);
    expect(
      HostHelloSchema.safeParse({
        type: "host_hello",
        v: 1,
        relayHostId: "host_12345678",
        hostPublicKeyB64: long,
        hostName: "Mac",
      }).success,
    ).toBe(false);
    expect(
      HostChallengeSchema.safeParse({
        type: "host_challenge",
        challengeB64: long,
        relayEphPubB64: "abc",
        userId: "u1",
      }).success,
    ).toBe(false);
    expect(
      HostChallengeAckSchema.safeParse({ type: "host_challenge_ack", proofB64: long }).success,
    ).toBe(false);
    expect(
      HostHelloAckSchema.safeParse({
        type: "host_hello_ack",
        relayHostId: "host_12345678",
        userId: long,
      }).success,
    ).toBe(false);

    const inviteTok = await deriveRelayInviteToken("secret-ticket");
    const deviceTok = await deriveRelayDeviceToken("secret-device");
    expect(inviteTok).toMatch(/^[0-9a-f]{64}$/);
    expect(deviceTok).toMatch(/^[0-9a-f]{64}$/);
    expect(inviteTok).not.toBe(deviceTok);
    expect(
      ClientAuthSchema.safeParse({
        type: "client_auth",
        v: 1,
        relayHostId: "host_12345678",
        credential: { kind: "invite", relayTicket: inviteTok },
      }).success,
    ).toBe(true);
    expect(
      ClientAuthSchema.safeParse({
        type: "client_auth",
        v: 1,
        relayHostId: "host_12345678",
        credential: { kind: "invite", ticket: "raw-ticket" },
      }).success,
    ).toBe(false);
  });

  test("httpToWsUrl preserves wss:/ws: protocols and base path prefixes", () => {
    expect(httpToWsUrl("https://eidolon-relay.vrp.moe", "/v1/client/connect")).toBe(
      "wss://eidolon-relay.vrp.moe/v1/client/connect",
    );
    expect(httpToWsUrl("wss://relay.example.com/subpath/", "/v1/client/connect")).toBe(
      "wss://relay.example.com/subpath/v1/client/connect",
    );
    expect(httpToWsUrl("http://127.0.0.1:8080/proxy", "/v1/host/control")).toBe(
      "ws://127.0.0.1:8080/proxy/v1/host/control",
    );
    expect(httpToWsUrl("ws://localhost:8080/app/", "/v1/host/data")).toBe(
      "ws://localhost:8080/app/v1/host/data",
    );
  });

  test("listShareableAddresses skips 169.254.*, sorts octets numerically, and ranks 172.16/12 after 10/8 and 192.168/16", () => {
    const info = (address: string) => ({
      address,
      netmask: "255.255.255.0",
      family: "IPv4" as const,
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: `${address}/24`,
    });
    const list = listShareableAddresses({
      en1: [info("169.254.10.20")],
      docker0: [info("172.17.0.1")],
      en0: [info("192.168.1.10"), info("192.168.1.2")],
      utun3: [info("100.64.0.9")],
      en2: [info("10.0.0.5")],
      eth0: [info("203.0.113.5")],
    });
    expect(list.map((x) => x.address)).toEqual([
      "100.64.0.9",
      "10.0.0.5",
      "192.168.1.2",
      "192.168.1.10",
      "172.17.0.1",
      "203.0.113.5",
    ]);
  });

  test("auth-client validates issuer scheme, retries transient poll failures, respects abort, and times out signOut", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ auth: { issuer: "http://evil.example.com" } }),
    );
    expect(await discoverRelayAuthUrl("https://custom-relay.example.com")).toBe(
      "https://id.laplace.live",
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ auth: { issuer: "http://127.0.0.1:4321/" } }),
    );
    expect(await discoverRelayAuthUrl("https://custom-relay.example.com")).toBe(
      "http://127.0.0.1:4321",
    );

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await pollDeviceToken("https://id.laplace.live", "code-1")).toEqual({
      status: "pending",
    });

    const ac = new AbortController();
    ac.abort();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("aborted"));
    expect(await pollDeviceToken("https://id.laplace.live", "code-1", ac.signal)).toEqual({
      status: "error",
      message: "Sign-in cancelled",
    });

    const abortDuringPoll = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      abortDuringPoll.abort();
      return Response.json({ error: "authorization_pending" }, { status: 400 });
    });
    expect(
      await completeDeviceAuthorization({
        authUrl: "https://id.laplace.live",
        deviceCode: "code-2",
        intervalSec: 0.005,
        expiresAt: Date.now() + 5_000,
        signal: abortDuringPoll.signal,
      }),
    ).toEqual({ status: "aborted" });

    let signOutSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
      signOutSignal = init?.signal ?? undefined;
      return new Response(null, { status: 200 });
    });
    await signOutRelaySession("https://id.laplace.live", "tok-1");
    expect(signOutSignal).toBeInstanceOf(AbortSignal);
  });
});
