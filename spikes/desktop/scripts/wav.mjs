// The fake microphone's WAV: 48 kHz mono 16-bit, which Chromium's file capture loops. On macOS,
// speech from `say`: 1 s of silence, the question 12 dB down (Chromium's capture AGC clips `say`'s
// level), and 3 s of silence so the voice detection ends a segment. Elsewhere, silence: with no file,
// Chromium's fake device beeps into the call.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const RATE = 48_000;
const QUESTION = "你听得到我说话吗？";

function wav(samples) {
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

/** The 16-bit mono samples of a PCM WAV at RATE. */
function samplesOf(file) {
  const bytes = readFileSync(file);
  let format = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = bytes.toString("latin1", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === "fmt ") {
      format = { channels: bytes.readUInt16LE(at + 10), rate: bytes.readUInt32LE(at + 12), bits: bytes.readUInt16LE(at + 22) };
    } else if (id === "data") {
      if (!format || format.channels !== 1 || format.rate !== RATE || format.bits !== 16) {
        throw new Error(`${file} is not 48 kHz mono 16-bit: ${JSON.stringify(format)}`);
      }
      const data = bytes.subarray(at + 8, at + 8 + size);
      return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${file} has no data chunk`);
}

/** Writes the fake microphone's WAV to `out`; returns what it holds. */
export function fakeMicWav(out) {
  mkdirSync(dirname(out), { recursive: true });
  if (process.platform !== "darwin") {
    writeFileSync(out, wav(new Int16Array(RATE)));
    return { kind: "silence", seconds: 1 };
  }
  const raw = `${out}.say.wav`;
  let voice = "Tingting";
  let text = QUESTION;
  let speech;
  for (const [v, t] of [["Tingting", QUESTION], [null, "Can you hear me?"]]) {
    try {
      // `say` exits 0 for a voice that isn't installed and renders nothing.
      execFileSync("say", [...(v ? ["-v", v] : []), "-o", raw, "--file-format=WAVE", `--data-format=LEI16@${RATE}`, t]);
      speech = samplesOf(raw);
      if (speech.length > RATE / 2) {
        voice = v ?? "default";
        text = t;
        break;
      }
    } catch {}
    speech = undefined;
  }
  rmSync(raw, { force: true });
  if (!speech) {
    writeFileSync(out, wav(new Int16Array(RATE)));
    return { kind: "silence", seconds: 1, note: "say rendered no speech" };
  }
  const gain = 10 ** (-12 / 20);
  const all = new Int16Array(RATE + speech.length + 3 * RATE);
  for (let i = 0; i < speech.length; i++) all[RATE + i] = Math.round(speech[i] * gain);
  writeFileSync(out, wav(all));
  return { kind: "speech", voice, text, seconds: Math.round((all.length / RATE) * 100) / 100 };
}
