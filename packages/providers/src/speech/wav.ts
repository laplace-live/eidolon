// Small WAV container helpers and URL normalization shared by HTTP speech and STT transports.
import { withoutTrailingSlashes } from "@eidolon/config";
import { SpeechError } from "./stream/http.ts";

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

interface WavHeader {
  readonly dataStart: number;
  readonly dataBytes: number | null;
}

/**
 * Locate the `data` subchunk once a RIFF/WAVE header is complete, return `-1` while more bytes
 * are needed (within the 64 KiB cap), or `null` when the stream is not RIFF/WAVE. Validates the
 * `fmt ` chunk when present so non-mono/non-PCM16 or mismatched-rate WAV streams fail loudly.
 */
function wavHeaderEnd(bytes: Uint8Array, expectedRate?: number): WavHeader | -1 | null {
  const prefix = Math.min(bytes.length, RIFF.length);
  for (let i = 0; i < prefix; i++) {
    if (bytes[i] !== RIFF[i]) return null;
  }
  if (bytes.length < 12) return -1;
  if (readAscii(bytes, 8, 4) !== "WAVE") return null;
  let offset = 12;
  let checkedFmt = false;
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const id = readAscii(bytes, offset, 4);
    const size = view.getUint32(4, true);
    const dataStart = offset + 8;
    if (id === "fmt ") {
      if (size < 16) throw new SpeechError(`Unsupported WAV fmt chunk size: ${size}`);
      if (dataStart + 16 > bytes.length) {
        return bytes.length > MAX_WAV_HEADER_BYTES ? null : -1;
      }
      if (!checkedFmt) {
        checkedFmt = true;
        const fmt = new DataView(bytes.buffer, bytes.byteOffset + dataStart, 16);
        const audioFormat = fmt.getUint16(0, true);
        const channels = fmt.getUint16(2, true);
        const sampleRate = fmt.getUint32(4, true);
        const bitsPerSample = fmt.getUint16(14, true);
        if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16) {
          throw new SpeechError(
            `Unsupported WAV format (format=${audioFormat}, channels=${channels}, bits=${bitsPerSample}; expected mono 16-bit PCM)`,
          );
        }
        if (expectedRate !== undefined && sampleRate !== expectedRate) {
          throw new SpeechError(
            `Unsupported WAV sample rate (${sampleRate} Hz; expected ${expectedRate} Hz)`,
          );
        }
      }
    } else if (id === "data") {
      // Streaming WAV servers emit 0xffffffff or 0x7fffffff when total length isn't known upfront.
      const dataBytes = size === 0xffffffff || size === 0x7fffffff ? null : size;
      return { dataStart, dataBytes };
    }
    offset = dataStart + size + (size & 1);
  }
  return bytes.length > MAX_WAV_HEADER_BYTES ? null : -1;
}

/**
 * Strip a leading RIFF/WAVE header (and any trailing RIFF subchunks past `data`) when an HTTP TTS
 * server returns WAV-wrapped PCM instead of raw samples. Passes raw PCM chunks through unchanged.
 */
export function stripWavHeader(chunk: Uint8Array, expectedRate?: number): Uint8Array {
  const header = wavHeaderEnd(chunk, expectedRate);
  if (header === null || header === -1) return chunk;
  const end =
    header.dataBytes === null
      ? chunk.length
      : Math.min(chunk.length, header.dataStart + header.dataBytes);
  return chunk.subarray(header.dataStart, end);
}

/** Yield raw PCM chunks from a fetch body, stripping a leading RIFF/WAVE header if present. */
export async function* pcmBody(
  body: ReadableStream<Uint8Array> | null,
  expectedRate?: number,
): AsyncGenerator<Uint8Array> {
  if (body === null) return;
  let probed = false;
  let pending: Uint8Array = EMPTY;
  let remaining: number | null = null;
  for await (const chunk of body) {
    if (chunk.length === 0) continue;
    let out: Uint8Array;
    if (probed) {
      out = chunk;
    } else {
      pending = appendBytes(pending, chunk);
      const header = wavHeaderEnd(pending, expectedRate);
      if (header === -1) continue;
      probed = true;
      if (header === null) {
        out = pending;
      } else {
        remaining = header.dataBytes;
        out = pending.subarray(header.dataStart);
      }
      pending = EMPTY;
    }
    if (remaining === null) {
      if (out.length > 0) yield out;
    } else {
      if (remaining === 0) return;
      const slice = out.length > remaining ? out.subarray(0, remaining) : out;
      remaining -= slice.length;
      if (slice.length > 0) yield slice;
      if (remaining === 0) return;
    }
  }
  if (!probed && pending.length > 0) yield pending;
  if (probed && remaining !== null && remaining > 0) {
    throw new SpeechError(`Truncated WAV audio: expected ${remaining} more byte(s)`);
  }
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
