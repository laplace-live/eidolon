import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  libopusWasmCodec,
  type OpusCodec,
  type OpusDecoder,
  type OpusDecoderOptions,
  type OpusEncoder,
  type OpusEncoderOptions,
} from "@pipedog/transport-smallwebrtc/opus";
import { opusCodecAtBitrate } from "../src/webrtc/opus.ts";
import { captureLogs, type LogCapture } from "./support.ts";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

function recordingCodec() {
  const encoders: OpusEncoderOptions[] = [];
  const decoders: OpusDecoderOptions[] = [];
  const decoder = { sampleRate: 24000, channels: 1 } as OpusDecoder;
  const codec: OpusCodec = {
    async createEncoder(options) {
      encoders.push(options);
      return { sampleRate: options.sampleRate, channels: options.channels } as OpusEncoder;
    },
    async createDecoder(options) {
      decoders.push(options);
      return decoder;
    },
  };
  return { codec, encoders, decoders, decoder };
}

describe("opusCodecAtBitrate", () => {
  test("every encoder gets the session bitrate in place of pipedog's 96 kbps", async () => {
    const base = recordingCodec();
    const codec = opusCodecAtBitrate(base.codec, 192000);
    await codec.createEncoder({ sampleRate: 24000, channels: 1, bitrate: 96000 });
    await codec.createEncoder({ sampleRate: 48000, channels: 2, bitrate: 96000 });
    expect(base.encoders).toEqual([
      { sampleRate: 24000, channels: 1, bitrate: 192000 },
      { sampleRate: 48000, channels: 2, bitrate: 192000 },
    ]);
  });

  test("decoders pass through untouched", async () => {
    const base = recordingCodec();
    const decoder = await opusCodecAtBitrate(base.codec, 8000).createDecoder({
      sampleRate: 48000,
      channels: 2,
    });
    expect(decoder).toBe(base.decoder);
    expect(base.decoders).toEqual([{ sampleRate: 48000, channels: 2 }]);
  });

  test("logs each encoder at DEBUG in whole kbps", async () => {
    const base = recordingCodec();
    await opusCodecAtBitrate(base.codec, 192000).createEncoder({ sampleRate: 24000, channels: 1 });
    await opusCodecAtBitrate(base.codec, 12345).createEncoder({ sampleRate: 24000, channels: 1 });
    expect(logs.messages("DEBUG")).toEqual([
      "[WebRTC] Opus encoder constructed at 192 kbps",
      "[WebRTC] Opus encoder constructed at 12 kbps",
    ]);
  });

  test("the bitrate reaches libopus", async () => {
    let seed = 1;
    const noise = new Int16Array(480).map(() => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return (seed % 20000) - 10000;
    });
    const packetBytes = async (bps: number) => {
      const encoder = await opusCodecAtBitrate(libopusWasmCodec, bps).createEncoder({
        sampleRate: 24000,
        channels: 1,
        bitrate: 96000,
      });
      try {
        let packet: Uint8Array = new Uint8Array(0);
        for (let i = 0; i < 5; i++) packet = encoder.encode(noise.slice());
        return packet.length;
      } finally {
        encoder.free();
      }
    };
    const low = await packetBytes(8000);
    const high = await packetBytes(192000);
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(high);
  });
});
