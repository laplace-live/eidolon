// Browser-, mobile-, and Node-safe byte/base64/SHA-256 primitives using WebCrypto only.

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Copy or cast to an ArrayBuffer-backed Uint8Array accepted by WebCrypto SubtleCrypto. */
export function toBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  return new Uint8Array(bytes);
}

export function utf8Encode(text: string): Uint8Array<ArrayBuffer> {
  return toBufferBytes(textEncoder.encode(text));
}

export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof globalThis.Buffer === "function") {
    return globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      "base64",
    );
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return globalThis.btoa(binary);
}

export function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const normalized = encoded.trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
    throw new Error("Invalid base64 input");
  }
  if (typeof globalThis.Buffer === "function") {
    return new Uint8Array(globalThis.Buffer.from(normalized, "base64"));
  }
  const binary = globalThis.atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  if (typeof globalThis.Buffer === "function") {
    return globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      "base64url",
    );
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64URL_ALPHABET[(triple >>> 18) & 63];
    out += BASE64URL_ALPHABET[(triple >>> 12) & 63];
    if (i + 1 < bytes.length) out += BASE64URL_ALPHABET[(triple >>> 6) & 63];
    if (i + 2 < bytes.length) out += BASE64URL_ALPHABET[triple & 63];
  }
  return out;
}

export function base64UrlToBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const normalized = encoded.trim();
  if (!/^[A-Za-z0-9_-]*$/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error("Invalid base64url input");
  }
  const pad = (4 - (normalized.length % 4)) % 4;
  return base64ToBytes(`${normalized.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat(pad)}`);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", toBufferBytes(data));
  return new Uint8Array(digest);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await sha256(data);
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Deterministic short Relay host identifier derived from the raw 32-byte X25519 public key. */
export async function deriveRelayHostId(publicKeyBytes: Uint8Array): Promise<string> {
  return bytesToBase64Url(await sha256(publicKeyBytes)).slice(0, 16);
}
