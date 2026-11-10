// The caller's audio decoded to 16 kHz mono with concealment, and hers sent as 20 ms Opus packets
// on a 10 ms clock that never drifts, against libopus itself and a sender that keeps what it gets.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MediaStreamTrack, RTCRtpSender, RtpPacket } from "werift";
import { AUDIO_IN_RATE, AudioIn, type AudioPacket } from "../src/audio_in.ts";
import { AudioOut } from "../src/audio_out.ts";
import { libopusWasmCodec, type OpusEncoder } from "../src/opus.ts";
import { captureLogs, type LogCapture, loud, ToneSource, until } from "./support.ts";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

/** The browser's side: 20 ms Opus packets of a tone at 48 kHz, numbered from `first`. */
async function packets(count: number, first = 0): Promise<AudioPacket[]> {
  const encoder: OpusEncoder = await libopusWasmCodec.createEncoder({
    sampleRate: 48_000,
    channels: 1,
    bitrate: 32_000,
  });
  const tone = new ToneSource(48_000);
  try {
    return Array.from({ length: count }, (_, i) => ({
      sequenceNumber: (first + i) & 0xffff,
      timestamp: ((first + i) * 960) >>> 0,
      payload: encoder.encode(tone.pull(960)),
    }));
  } finally {
    encoder.free();
  }
}

/** An AudioIn started, and the frames it decodes. */
function started(): { audioIn: AudioIn; frames: Int16Array[] } {
  const frames: Int16Array[] = [];
  const audioIn = new AudioIn(libopusWasmCodec);
  audioIn.start((pcm) => frames.push(pcm));
  return { audioIn, frames };
}

describe("AudioIn", () => {
  test("decodes each packet to 20 ms at 16 kHz mono, those that came while the decoder loaded too", async () => {
    const { audioIn, frames } = started();
    for (const packet of await packets(5)) audioIn.handle(packet);
    await until(() => frames.length === 5);
    expect(frames.map((f) => f.length)).toEqual(Array(5).fill(AUDIO_IN_RATE * 0.02));
    expect(frames.slice(1).every(loud)).toBe(true);
    audioIn.stop();
  });

  test("conceals a lost packet, recovering it from the next one's FEC", async () => {
    const { audioIn, frames } = started();
    const all = await packets(7);
    audioIn.handle(all[0]!);
    await until(() => frames.length === 1);
    // Packet 2 never comes: the gap is given up on once 60 ms of audio is held behind it.
    for (const packet of [all[1]!, ...all.slice(3)]) audioIn.handle(packet);
    expect(frames).toHaveLength(7);
    expect(frames.every((f) => f.length === 320)).toBe(true);
    audioIn.stop();
  });

  test("skips a gap of more than 10 packets instead of concealing it", async () => {
    const { audioIn, frames } = started();
    const all = await packets(20);
    audioIn.handle(all[0]!);
    await until(() => frames.length === 1);
    for (const packet of all.slice(12)) audioIn.handle(packet);
    expect(frames).toHaveLength(1 + 8);
    audioIn.stop();
  });

  test("drops what comes before start() and while paused, and takes the stream up afresh", async () => {
    const audioIn = new AudioIn(libopusWasmCodec);
    const all = await packets(4);
    audioIn.handle(all[0]!);
    const frames: Int16Array[] = [];
    audioIn.start((pcm) => frames.push(pcm));
    audioIn.handle(all[1]!);
    await until(() => frames.length === 1);
    audioIn.pause();
    audioIn.handle(all[2]!);
    expect(frames).toHaveLength(1);
    audioIn.start((pcm) => frames.push(pcm));
    // A sender far ahead after the pause is released at once, not held as a gap.
    const later = await packets(1, 3000);
    audioIn.handle(later[0]!);
    expect(frames).toHaveLength(2);
    audioIn.stop();
  });
});

/** A werift sender's stand-in: the RTP its track is written. */
class FakeSender {
  readonly codec = { payloadType: 111 };
  readonly sent: { readonly at: number; readonly rtp: RtpPacket }[] = [];
  replaced = 0;

  async replaceTrack(track: MediaStreamTrack): Promise<void> {
    this.replaced++;
    track.onReceiveRtp.subscribe((rtp) => this.sent.push({ at: performance.now(), rtp }));
  }
}

describe("AudioOut", () => {
  test("pulls 10 ms on the clock and sends 20 ms Opus packets: seq +1, timestamp +960, marked", async () => {
    const sender = new FakeSender();
    const out = new AudioOut(sender as unknown as RTCRtpSender, libopusWasmCodec);
    const source = new ToneSource(24_000);
    const stop = out.play(source, () => true);
    await until(() => sender.sent.length >= 5, 4000);
    stop();
    expect(source.pulls.slice(0, 10).every((n) => n === 240)).toBe(true);
    const headers = sender.sent.slice(0, 5).map(({ rtp }) => rtp.header);
    for (const [i, header] of headers.entries()) {
      expect(header.payloadType).toBe(111);
      expect(header.marker).toBe(true);
      if (i === 0) continue;
      const previous = headers[i - 1]!;
      expect(header.sequenceNumber).toBe((previous.sequenceNumber + 1) & 0xffff);
      expect(header.timestamp).toBe((previous.timestamp + 960) >>> 0);
    }
    // Paced at 20 ms a packet from the clock's start, which it never drifts from.
    const first = sender.sent[0]!.at;
    expect(sender.sent[4]!.at - first).toBeGreaterThanOrEqual(75);
    expect(sender.replaced).toBe(1);
  });

  test("while the client is gone, the clock sends silence and leaves the source unread", async () => {
    const sender = new FakeSender();
    const out = new AudioOut(sender as unknown as RTCRtpSender, libopusWasmCodec);
    const source = new ToneSource(24_000);
    let live = false;
    const stop = out.play(source, () => live);
    await until(() => sender.sent.length >= 2, 4000);
    expect(source.pulls).toEqual([]);
    live = true;
    await until(() => source.pulls.length >= 2, 4000);
    stop();
  });

  test("a second play() stops the first clock and runs the stream on from where it was", async () => {
    const sender = new FakeSender();
    const out = new AudioOut(sender as unknown as RTCRtpSender, libopusWasmCodec);
    const first = new ToneSource(24_000);
    out.play(first, () => true);
    await until(() => sender.sent.length >= 2, 4000);
    const second = new ToneSource(24_000);
    out.play(second, () => true);
    const pulledFirst = first.pulls.length;
    const sentBefore = sender.sent.length;
    await until(() => sender.sent.length >= sentBefore + 2, 4000);
    out.stop();
    expect(first.pulls.length).toBeLessThanOrEqual(pulledFirst + 1);
    expect(second.pulls.length).toBeGreaterThan(0);
    const headers = sender.sent.map(({ rtp }) => rtp.header);
    for (const [i, header] of headers.entries()) {
      if (i > 0) expect(header.sequenceNumber).toBe((headers[i - 1]!.sequenceNumber + 1) & 0xffff);
    }
    expect(sender.replaced).toBe(1);
  });

  test("a pause between plays advances the timestamp by the time nothing was sent", async () => {
    const sender = new FakeSender();
    const out = new AudioOut(sender as unknown as RTCRtpSender, libopusWasmCodec);
    const stop = out.play(new ToneSource(24_000), () => true);
    await until(() => sender.sent.length >= 2, 4000);
    stop();
    const before = sender.sent.length;
    const last = sender.sent[before - 1]!;
    await Bun.sleep(300);
    out.play(new ToneSource(24_000), () => true);
    await until(() => sender.sent.length > before, 4000);
    out.stop();
    const next = sender.sent[before]!;
    expect(next.rtp.header.sequenceNumber).toBe((last.rtp.header.sequenceNumber + 1) & 0xffff);
    const ticks = (next.rtp.header.timestamp - last.rtp.header.timestamp) >>> 0;
    expect(ticks).toBeGreaterThanOrEqual(300 * 48);
    expect(ticks).toBeLessThanOrEqual((next.at - last.at) * 48 + 960);
  });
});
