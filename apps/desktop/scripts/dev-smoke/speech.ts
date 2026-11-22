// The call's fake microphone: Mandarin from macOS's Tingting voice, which ends a voice-detection
// segment, rendered by `say -o` into a file (never aloud) and converted by afconvert to the 48 kHz
// mono 16-bit WAV that Chromium's file capture plays, on a loop.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const RATE = 48_000;
/** Chromium's capture gain clips `say`'s level. */
const GAIN_DB = -12;
const LEAD_SECONDS = 1;
/** Silence after the speech, long enough for the voice detection to end its segment. */
const TAIL_SECONDS = 3;

/** A PCM WAV's samples, which must be 16-bit mono at RATE. */
export function wavSamples(bytes: Buffer): Int16Array {
  if (bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let format: { channels: number; rate: number; bits: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = bytes.toString("latin1", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === "fmt ") {
      format = {
        channels: bytes.readUInt16LE(at + 10),
        rate: bytes.readUInt32LE(at + 12),
        bits: bytes.readUInt16LE(at + 22),
      };
    } else if (id === "data") {
      if (format?.channels !== 1 || format.rate !== RATE || format.bits !== 16) {
        throw new Error(`the WAV isn't ${RATE} Hz mono 16-bit: ${JSON.stringify(format)}`);
      }
      const data = bytes.subarray(at + 8, at + 8 + size);
      return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
    }
    // Chunks are padded to an even size.
    at += 8 + size + (size % 2);
  }
  throw new Error("the WAV has no data");
}

/** A 16-bit mono PCM WAV of `samples` at RATE. */
export function wavFile(samples: Int16Array): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** `speech` turned down GAIN_DB, between LEAD_SECONDS and TAIL_SECONDS of silence. */
export function framed(speech: Int16Array): Int16Array {
  const gain = 10 ** (GAIN_DB / 20);
  const lead = LEAD_SECONDS * RATE;
  const all = new Int16Array(lead + speech.length + TAIL_SECONDS * RATE);
  for (let i = 0; i < speech.length; i++) all[lead + i] = Math.round(speech[i] * gain);
  return all;
}

export interface Microphone {
  readonly file: string;
  readonly seconds: number;
  /** How long the speech itself is. */
  readonly speechSeconds: number;
}

/**
 * Writes `text`, spoken by Tingting, as the microphone's WAV in `folder`. Throws off macOS, and
 * when the voice isn't installed: `say` then exits 0 having rendered nothing.
 */
export async function microphoneWav(folder: string, text: string): Promise<Microphone> {
  if (process.platform !== "darwin") {
    throw new Error("the call's speech comes from macOS's say and afconvert");
  }
  const spoken = join(folder, "speech.aiff");
  const converted = join(folder, "speech.wav");
  await run("say", ["-v", "Tingting", "-o", spoken, text]);
  await run("afconvert", ["-f", "WAVE", "-d", `LEI16@${RATE}`, "-c", "1", spoken, converted]);
  const speech = wavSamples(readFileSync(converted));
  if (speech.length < RATE / 2) {
    throw new Error(`say rendered ${speech.length} samples: is the Tingting voice installed?`);
  }
  const samples = framed(speech);
  const file = join(folder, "microphone.wav");
  writeFileSync(file, wavFile(samples));
  return { file, seconds: samples.length / RATE, speechSeconds: speech.length / RATE };
}
