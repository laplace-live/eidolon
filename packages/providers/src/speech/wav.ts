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

/**
 * Strip a leading RIFF/WAVE header when an HTTP TTS server returns WAV-wrapped PCM instead of raw
 * samples. Passes raw PCM chunks through unchanged.
 */
export function stripWavHeader(chunk: Uint8Array): Uint8Array {
  if (chunk.length < 12 || readAscii(chunk, 0, 4) !== "RIFF" || readAscii(chunk, 8, 4) !== "WAVE") {
    return chunk;
  }
  let offset = 12;
  while (offset + 8 <= chunk.length) {
    const id = readAscii(chunk, offset, 4);
    const size = new DataView(chunk.buffer, chunk.byteOffset + offset + 4, 4).getUint32(0, true);
    const dataStart = offset + 8;
    if (id === "data") return chunk.subarray(dataStart);
    offset = dataStart + size + (size & 1);
  }
  return chunk;
}

/** Yield raw PCM chunks from a fetch body, stripping a leading RIFF/WAVE header if present. */
export async function* pcmBody(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array> {
  if (body === null) return;
  let first = true;
  for await (const chunk of body) {
    if (first) {
      first = false;
      const pcm = stripWavHeader(chunk);
      if (pcm.length > 0) yield pcm;
    } else {
      yield chunk;
    }
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
