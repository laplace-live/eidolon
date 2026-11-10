// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/transport-smallwebrtc/test/rtc_media.test.ts@ce8f8bc
//
// The audio reorder buffer, candidate parsing and Opus packet sizes; the port carries no video,
// resampler or ESP32 munging, so their cases aren't ported.
import { describe, expect, test } from "bun:test";
import { AudioJitterBuffer, type JitterPacket } from "../src/jitter.ts";
import { libopusWasmCodec, opusPacketSamples } from "../src/opus.ts";
import { candidateFromSdp, candidateToSdp } from "../src/peer.ts";

const pkt = (sequenceNumber: number, timestamp = sequenceNumber * 960): JitterPacket => ({
  sequenceNumber,
  timestamp,
});

describe("AudioJitterBuffer", () => {
  test("releases in-order packets at once", () => {
    const jb = new AudioJitterBuffer(2880);
    const out = [0, 1, 2].flatMap((s) => jb.add(pkt(s)));
    expect(out.map((o) => o.packet?.sequenceNumber)).toEqual([0, 1, 2]);
  });

  test("reorders a late packet", () => {
    const jb = new AudioJitterBuffer(2880);
    const out = [0, 2, 1, 3].flatMap((s) => jb.add(pkt(s)));
    expect(out.map((o) => o.packet?.sequenceNumber)).toEqual([0, 1, 2, 3]);
  });

  test("reports a gap once the held audio spans the latency", () => {
    const jb = new AudioJitterBuffer(2880); // 3 packets
    const out = [0, 3, 4, 5, 6].flatMap((s) => jb.add(pkt(s)));
    expect(out).toEqual([
      { packet: pkt(0) },
      { lost: 2 },
      { packet: pkt(3) },
      { packet: pkt(4) },
      { packet: pkt(5) },
      { packet: pkt(6) },
    ]);
  });

  test("drops duplicates and wraps sequence numbers", () => {
    const jb = new AudioJitterBuffer(2880);
    const out = [65534, 65535, 65535, 0, 1].flatMap((s) => jb.add(pkt(s)));
    expect(out.map((o) => o.packet?.sequenceNumber)).toEqual([65534, 65535, 0, 1]);
  });

  test("resyncs on a jump of more than 0x1000, as a restarted sender's", () => {
    const jb = new AudioJitterBuffer(2880);
    // After 11 it expects 12; 12 + 0x1001 is a new stream, released at once.
    const out = [10, 11, 12 + 0x1001, 13 + 0x1001].flatMap((s) => jb.add(pkt(s)));
    expect(out.map((o) => o.packet?.sequenceNumber)).toEqual([10, 11, 0x100d, 0x100e]);
  });
});

describe("ICE candidates", () => {
  test("parse with or without the prefix", () => {
    const c = candidateFromSdp(
      "candidate:842163049 1 udp 1677729535 1.2.3.4 46154 typ srflx raddr 10.0.0.1 rport 46154",
    );
    expect(c).toMatchObject({
      foundation: "842163049",
      component: 1,
      ip: "1.2.3.4",
      port: 46154,
      type: "srflx",
    });
    expect(c.relatedAddress).toEqual("10.0.0.1");
    expect(candidateToSdp(c)).toEqual(
      "842163049 1 udp 1677729535 1.2.3.4 46154 typ srflx raddr 10.0.0.1 rport 46154",
    );
    expect(candidateFromSdp("1 1 UDP 1 abc.local 9 typ host").ip).toEqual("abc.local");
    expect(() => candidateFromSdp("")).toThrow();
  });
});

describe("Opus", () => {
  test("packet sizes, PLC and FEC decode at the pipeline rate", async () => {
    const encoder = await libopusWasmCodec.createEncoder({
      sampleRate: 16000,
      channels: 1,
      bitrate: 32000,
    });
    const decoder = await libopusWasmCodec.createDecoder({ sampleRate: 16000, channels: 1 });
    const pcm = new Int16Array(320).map((_, i) => Math.round(8000 * Math.sin(i / 3)));
    const packet = encoder.encode(pcm);
    expect(opusPacketSamples(packet, 16000)).toEqual(320);
    expect(opusPacketSamples(packet, 48000)).toEqual(960);
    expect(decoder.decode(packet).length).toEqual(320);
    expect(decoder.decodePacketLoss(320).length).toEqual(320);
    expect(decoder.decode(packet, { fec: true, frameSize: 320 }).length).toEqual(320);
    encoder.free();
    decoder.free();
  });
});
