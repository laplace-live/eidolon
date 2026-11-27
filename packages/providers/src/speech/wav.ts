// Small WAV container helpers and URL normalization shared by HTTP speech and STT transports.
import { withoutTrailingSlashes } from "@eidolon/config";

/** Strip trailing slashes and any accidental `/v1` suffix so callers can enter host or `/v1`. */
export function fishSpeechRoot(baseUrl: string): string {
  return withoutTrailingSlashes(baseUrl).replace(/\/v1$/i, "");
}

/** Wrap signed 16-bit little-endian PCM samples in a standard 44-byte RIFF/WAVE header. */
export function encodeWav(
  pcm: Int16Array,
  sampleRate: number,
  channels = 1,
): Uint8Array<ArrayBuffer> {
  const dataBytes = pcm.byteLength;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  writeAscii(out, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(out, 8, "WAVE");
  writeAscii(out, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(out, 36, "data");
  view.setUint32(40, dataBytes, true);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataBytes), 44);
  return out;
}

const RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const EMPTY = new Uint8Array(0);
const MAX_WAV_HEADER_BYTES = 64 * 1024;

function appendBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Index past the `data` subchunk header once a RIFF/WAVE header is complete, -1 while the prefix
 * could still complete one, or null when the stream is not RIFF/WAVE.
 */
function wavHeaderEnd(bytes: Uint8Array): number | null {
  const prefix = Math.min(bytes.length, RIFF.length);
  for (let i = 0; i < prefix; i++) {
    if (bytes[i] !== RIFF[i]) return null;
  }
  if (bytes.length < 12) return -1;
  if (readAscii(bytes, 8, 4) !== "WAVE") return null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = readAscii(bytes, offset, 4);
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    const dataStart = offset + 8;
    if (id === "data") return dataStart;
    offset = dataStart + size + (size & 1);
  }
  return bytes.length > MAX_WAV_HEADER_BYTES ? null : -1;
}

/**
 * Strip a leading RIFF/WAVE header when an HTTP TTS server returns WAV-wrapped PCM instead of raw
 * samples. Passes raw PCM chunks through unchanged.
 */
export function stripWavHeader(chunk: Uint8Array): Uint8Array {
  const end = wavHeaderEnd(chunk);
  return end !== null && end > 0 ? chunk.subarray(end) : chunk;
}

/** Yield raw PCM chunks from a fetch body, stripping a leading RIFF/WAVE header if present. */
export async function* pcmBody(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array> {
  if (body === null) return;
  let probed = false;
  let pending: Uint8Array = EMPTY;
  for await (const chunk of body) {
    if (chunk.length === 0) continue;
    if (probed) {
      yield chunk;
      continue;
    }
    pending = appendBytes(pending, chunk);
    const end = wavHeaderEnd(pending);
    if (end === null) {
      probed = true;
      yield pending;
      pending = EMPTY;
    } else if (end > 0) {
      probed = true;
      const pcm = pending.subarray(end);
      pending = EMPTY;
      if (pcm.length > 0) yield pcm;
    }
  }
  if (!probed && pending.length > 0) yield pending;
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    target[offset + i] = text.charCodeAt(i);
  }
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(bytes[offset + i] ?? 0);
  }
  return out;
}
