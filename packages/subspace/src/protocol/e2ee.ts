import {
  base64ToBytes,
  bytesToBase64,
  bytesToBase64Url,
  concatBytes,
  constantTimeEqual,
  randomBytes,
  sha256,
  toBufferBytes,
  utf8Decode,
  utf8Encode,
} from "./encoding.ts";

export interface X25519KeyPair {
  /** Raw 32-byte X25519 public key, base64-encoded. */
  readonly publicKeyB64: string;
  /** PKCS#8 DER X25519 private key, base64-encoded for 0600 local storage. */
  readonly privateKeyPkcs8B64: string;
}

export interface E2eeHelloMessage {
  readonly type: "e2ee_hello";
  readonly v: 1;
  readonly clientEphPubB64: string;
  readonly clientNonceB64: string;
}

export interface E2eeReadyMessage {
  readonly type: "e2ee_ready";
  readonly v: 1;
  readonly hostPubB64: string;
  readonly hostEphPubB64: string;
  readonly hostNonceB64: string;
}

export type E2eeAuthRequest =
  | {
      readonly type: "e2ee_auth";
      readonly kind: "pair";
      readonly ticket: string;
      readonly clientName: string;
      readonly authBinding: string;
    }
  | {
      readonly type: "e2ee_auth";
      readonly kind: "token";
      readonly grantId: string;
      readonly deviceToken: string;
      readonly authBinding: string;
    };

export type E2eeAuthResponse =
  | {
      readonly type: "e2ee_authenticated";
      readonly ok: true;
      readonly grantId: string;
      readonly hostName: string;
      readonly serverVersion: string;
      readonly deviceToken?: string;
    }
  | {
      readonly type: "e2ee_authenticated";
      readonly ok: false;
      readonly code: "invalid-ticket" | "invalid-token" | "invalid-binding" | "unauthorized";
      readonly message: string;
    };

export class E2eeError extends Error {
  readonly code:
    | "key-mismatch"
    | "invalid-key"
    | "invalid-frame"
    | "sequence-error"
    | "decrypt-failed";

  constructor(code: E2eeError["code"], message: string) {
    super(message);
    this.name = "E2eeError";
    this.code = code;
  }
}

async function generateX25519RawKeyPair(): Promise<{
  readonly kp: CryptoKeyPair;
  readonly publicKeyB64: string;
}> {
  const kp = (await globalThis.crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", kp.publicKey));
  return { kp, publicKeyB64: bytesToBase64(rawPub) };
}

export async function generateEphemeralX25519(): Promise<{
  readonly privateKey: CryptoKey;
  readonly publicKeyB64: string;
}> {
  const { kp, publicKeyB64 } = await generateX25519RawKeyPair();
  return { privateKey: kp.privateKey, publicKeyB64 };
}

export async function generateX25519KeyPair(): Promise<X25519KeyPair> {
  const { kp, publicKeyB64 } = await generateX25519RawKeyPair();
  const pkcs8Priv = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("pkcs8", kp.privateKey),
  );
  return {
    publicKeyB64,
    privateKeyPkcs8B64: bytesToBase64(pkcs8Priv),
  };
}

export async function importX25519PublicKey(publicKeyB64: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64ToBytes(publicKeyB64);
  } catch {
    throw new E2eeError("invalid-key", "X25519 public key is not valid base64");
  }
  if (raw.byteLength !== 32) {
    throw new E2eeError("invalid-key", `Expected 32-byte X25519 public key, got ${raw.byteLength}`);
  }
  return await globalThis.crypto.subtle.importKey("raw", raw, { name: "X25519" }, false, []);
}

export async function importX25519PrivateKey(pkcs8B64: string): Promise<CryptoKey> {
  let pkcs8: Uint8Array<ArrayBuffer>;
  try {
    pkcs8 = base64ToBytes(pkcs8B64);
  } catch {
    throw new E2eeError("invalid-key", "X25519 private key is not valid base64");
  }
  return await globalThis.crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, [
    "deriveBits",
  ]);
}

function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (const byte of bytes) acc |= byte;
  return acc === 0;
}

async function x25519(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> {
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: "X25519", public: publicKey },
    privateKey,
    256,
  );
  const out = new Uint8Array(bits);
  if (isAllZero(out)) {
    throw new E2eeError("invalid-key", "X25519 shared secret is degenerate");
  }
  return out;
}

/**
 * Computes or verifies the Relay control authentication proof using X25519 ECDH between the
 * host's static X25519 key and an ephemeral Relay X25519 key, avoiding separate signing keys.
 */
export async function computeRelayControlProof(
  privateKey: CryptoKey,
  peerPublicKeyB64: string,
  challengeB64: string,
  userId: string,
): Promise<string> {
  const shared = await x25519(privateKey, await importX25519PublicKey(peerPublicKeyB64));
  const hmacKey = await globalThis.crypto.subtle.importKey(
    "raw",
    shared,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const msg = utf8Encode(`eidolon-subspace-relay-proof-v1:${challengeB64}:${userId}`);
  const sig = await globalThis.crypto.subtle.sign("HMAC", hmacKey, msg);
  return bytesToBase64(new Uint8Array(sig));
}

async function hkdfBits(
  ikmKey: CryptoKey,
  salt: Uint8Array<ArrayBuffer>,
  info: string,
  byteLength: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: utf8Encode(info),
    },
    ikmKey,
    byteLength * 8,
  );
  return new Uint8Array(bits);
}

async function importAesKey(rawKey: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return await globalThis.crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const TRANSCRIPT_PREFIX = utf8Encode("eidolon-subspace-v1");
const HEADER_BYTES = 8;
const GCM_TAG_BYTES = 16;

function writeUint64BE(seq: bigint): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(HEADER_BYTES);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, seq, false);
  return out;
}

function readUint64BE(bytes: Uint8Array): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
  return view.getBigUint64(0, false);
}

/**
 * Bidirectional AES-256-GCM transport with strictly monotonic 64-bit sequence numbers and
 * serialized send/receive queues so concurrent mux callers never emit frames out of sequence.
 */
export class E2eeSession {
  readonly authBinding: string;
  readonly #sendKey: CryptoKey;
  readonly #sendIvPrefix: Uint8Array<ArrayBuffer>;
  readonly #recvKey: CryptoKey;
  readonly #recvIvPrefix: Uint8Array<ArrayBuffer>;
  #sendSeq = 0n;
  #recvSeq = 0n;
  #sendQueue: Promise<unknown> = Promise.resolve();
  #recvQueue: Promise<unknown> = Promise.resolve();

  constructor(params: {
    readonly authBinding: string;
    readonly sendKey: CryptoKey;
    readonly sendIvPrefix: Uint8Array<ArrayBuffer>;
    readonly recvKey: CryptoKey;
    readonly recvIvPrefix: Uint8Array<ArrayBuffer>;
  }) {
    this.authBinding = params.authBinding;
    this.#sendKey = params.sendKey;
    this.#sendIvPrefix = params.sendIvPrefix;
    this.#recvKey = params.recvKey;
    this.#recvIvPrefix = params.recvIvPrefix;
  }

  /** Encrypts `plaintext` and invokes `emit` strictly in sequence-number order. */
  send(
    plaintext: Uint8Array,
    emit: (sealedFrame: Uint8Array) => Promise<void> | void,
  ): Promise<void> {
    const task = this.#sendQueue.then(async () => {
      const sealed = await this.#sealNext(plaintext);
      await emit(sealed);
    });
    this.#sendQueue = task.catch(() => {});
    return task;
  }

  sendJson(value: unknown, emit: (sealedFrame: Uint8Array) => Promise<void> | void): Promise<void> {
    return this.send(utf8Encode(JSON.stringify(value)), emit);
  }

  seal(plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const task = this.#sendQueue.then(() => this.#sealNext(plaintext));
    this.#sendQueue = task.catch(() => {});
    return task;
  }

  open(frame: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const task = this.#recvQueue.then(() => this.#openNext(frame));
    this.#recvQueue = task.catch(() => {});
    return task;
  }

  async openJson<T>(frame: Uint8Array): Promise<T> {
    const plain = await this.open(frame);
    return JSON.parse(utf8Decode(plain)) as T;
  }

  async #sealNext(plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const header = writeUint64BE(this.#sendSeq++);
    const iv = concatBytes(this.#sendIvPrefix, header);
    const encrypted = await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: header, tagLength: 128 },
      this.#sendKey,
      toBufferBytes(plaintext),
    );
    return concatBytes(header, new Uint8Array(encrypted));
  }

  async #openNext(frame: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    if (frame.byteLength < HEADER_BYTES + GCM_TAG_BYTES) {
      throw new E2eeError("invalid-frame", "Encrypted frame is truncated");
    }
    const header = toBufferBytes(frame.subarray(0, HEADER_BYTES));
    const seq = readUint64BE(header);
    if (seq !== this.#recvSeq) {
      throw new E2eeError("sequence-error", `Expected frame seq ${this.#recvSeq}, got ${seq}`);
    }
    const iv = concatBytes(this.#recvIvPrefix, header);
    const ciphertext = toBufferBytes(frame.subarray(HEADER_BYTES));
    let plain: ArrayBuffer;
    try {
      plain = await globalThis.crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: header, tagLength: 128 },
        this.#recvKey,
        ciphertext,
      );
    } catch {
      throw new E2eeError("decrypt-failed", "Encrypted frame failed authentication");
    }
    this.#recvSeq += 1n;
    return new Uint8Array(plain);
  }
}

async function deriveDirectionKeys(
  ikm: Uint8Array<ArrayBuffer>,
  helloRaw: string,
  readyRaw: string,
  role: "client" | "host",
): Promise<E2eeSession> {
  const salt = await sha256(
    concatBytes(TRANSCRIPT_PREFIX, utf8Encode(helloRaw), utf8Encode(readyRaw)),
  );
  const ikmKey = await globalThis.crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  const [c2hRaw, c2hIv, h2cRaw, h2cIv, bindingRaw] = await Promise.all([
    hkdfBits(ikmKey, salt, "c2h-key", 32),
    hkdfBits(ikmKey, salt, "c2h-iv", 4),
    hkdfBits(ikmKey, salt, "h2c-key", 32),
    hkdfBits(ikmKey, salt, "h2c-iv", 4),
    hkdfBits(ikmKey, salt, "auth-binding", 32),
  ]);
  const [c2hKey, h2cKey] = await Promise.all([importAesKey(c2hRaw), importAesKey(h2cRaw)]);
  return new E2eeSession({
    authBinding: bytesToBase64Url(bindingRaw),
    sendKey: role === "client" ? c2hKey : h2cKey,
    sendIvPrefix: role === "client" ? c2hIv : h2cIv,
    recvKey: role === "client" ? h2cKey : c2hKey,
    recvIvPrefix: role === "client" ? h2cIv : c2hIv,
  });
}

export interface ClientHandshakeState {
  readonly helloRaw: string;
  finish(readyRaw: string): Promise<E2eeSession>;
}

/** Starts the client side of the Dual-DH X25519 handshake pinned to `expectedHostPublicKeyB64`. */
export async function startClientHandshake(
  expectedHostPublicKeyB64: string,
): Promise<ClientHandshakeState> {
  const hostStaticKey = await importX25519PublicKey(expectedHostPublicKeyB64);
  const expectedHostBytes = base64ToBytes(expectedHostPublicKeyB64);
  const clientEph = await generateEphemeralX25519();
  const nonce = randomBytes(16);
  const hello: E2eeHelloMessage = {
    type: "e2ee_hello",
    v: 1,
    clientEphPubB64: clientEph.publicKeyB64,
    clientNonceB64: bytesToBase64(nonce),
  };
  const helloRaw = JSON.stringify(hello);
  return {
    helloRaw,
    async finish(readyRaw) {
      let ready: E2eeReadyMessage;
      try {
        ready = JSON.parse(readyRaw) as E2eeReadyMessage;
      } catch {
        throw new E2eeError("invalid-frame", "Malformed e2ee_ready message");
      }
      if (
        ready?.type !== "e2ee_ready" ||
        ready.v !== 1 ||
        typeof ready.hostPubB64 !== "string" ||
        typeof ready.hostEphPubB64 !== "string"
      ) {
        throw new E2eeError("invalid-frame", "Invalid e2ee_ready message");
      }
      let receivedHostBytes: Uint8Array<ArrayBuffer>;
      try {
        receivedHostBytes = base64ToBytes(ready.hostPubB64);
      } catch {
        throw new E2eeError("invalid-key", "Remote host public key is not valid base64");
      }
      if (!constantTimeEqual(receivedHostBytes, expectedHostBytes)) {
        throw new E2eeError("key-mismatch", "Remote host public key does not match pinned key");
      }
      const hostEphKey = await importX25519PublicKey(ready.hostEphPubB64);
      const [dh1, dh2] = await Promise.all([
        x25519(clientEph.privateKey, hostEphKey),
        x25519(clientEph.privateKey, hostStaticKey),
      ]);
      return await deriveDirectionKeys(concatBytes(dh1, dh2), helloRaw, readyRaw, "client");
    },
  };
}

/** Completes the host side of the Dual-DH X25519 handshake for an incoming `e2ee_hello`. */
export async function acceptHostHandshake(
  hostStaticKeyPair: {
    readonly publicKeyB64: string;
    readonly privateKey: CryptoKey;
  },
  helloRaw: string,
): Promise<{ readonly readyRaw: string; readonly session: E2eeSession }> {
  let hello: E2eeHelloMessage;
  try {
    hello = JSON.parse(helloRaw) as E2eeHelloMessage;
  } catch {
    throw new E2eeError("invalid-frame", "Malformed e2ee_hello message");
  }
  if (hello?.type !== "e2ee_hello" || hello.v !== 1 || typeof hello.clientEphPubB64 !== "string") {
    throw new E2eeError("invalid-frame", "Invalid e2ee_hello message");
  }
  const clientEphKey = await importX25519PublicKey(hello.clientEphPubB64);
  const hostEph = await generateEphemeralX25519();
  const nonce = randomBytes(16);
  const ready: E2eeReadyMessage = {
    type: "e2ee_ready",
    v: 1,
    hostPubB64: hostStaticKeyPair.publicKeyB64,
    hostEphPubB64: hostEph.publicKeyB64,
    hostNonceB64: bytesToBase64(nonce),
  };
  const readyRaw = JSON.stringify(ready);
  const [dh1, dh2] = await Promise.all([
    x25519(hostEph.privateKey, clientEphKey),
    x25519(hostStaticKeyPair.privateKey, clientEphKey),
  ]);
  const session = await deriveDirectionKeys(concatBytes(dh1, dh2), helloRaw, readyRaw, "host");
  return { readyRaw, session };
}
