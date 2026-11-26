import { describe, expect, test } from "vitest";
import {
  acceptHostHandshake,
  computeRelayControlProof,
  deriveRelayHostId,
  E2eeError,
  encodePairingCode,
  encodePairingUrl,
  generateX25519KeyPair,
  importX25519PrivateKey,
  importX25519PublicKey,
  isPairingExpired,
  parsePairingInput,
  randomBytes,
  startClientHandshake,
  utf8Decode,
  utf8Encode,
} from "../src/index.ts";

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
});
