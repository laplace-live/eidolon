// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/transport-smallwebrtc/src/opus.ts@ce8f8bc
//
// Opus through libopus compiled to WebAssembly, behind the small interface the peer's codec seam
// takes. PCM is 16-bit signed, interleaved.
import { logger } from "@eidolon/config";
import { Application, createDecoder, createEncoder, type SampleRate } from "libopus-wasm";

/** The sample rates libopus encodes from and decodes to directly. */
const OPUS_SAMPLE_RATES: readonly number[] = [8000, 12000, 16000, 24000, 48000];

/** The RTP clock rate of Opus, whatever the audio's sample rate (RFC 7587). */
export const OPUS_RTP_CLOCK_RATE = 48000;

export interface OpusEncoder {
  readonly sampleRate: number;
  readonly channels: number;
  /** One frame (2.5 to 60 ms of interleaved PCM) into one Opus packet. */
  encode(pcm: Int16Array): Uint8Array;
  free(): void;
}

export interface OpusDecoder {
  readonly sampleRate: number;
  readonly channels: number;
  /**
   * With `fec`, decodes the in-band forward error correction the packet carries for the packet
   * before it; `frameSize` (samples per channel) is then required.
   */
  decode(packet: Uint8Array, options?: { fec?: boolean; frameSize?: number }): Int16Array;
  /** Conceals a lost packet, `frameSize` samples per channel. */
  decodePacketLoss(frameSize: number): Int16Array;
  free(): void;
}

export interface OpusEncoderOptions {
  sampleRate: number;
  channels: number;
  /** Bits per second. */
  bitrate?: number;
}

export interface OpusDecoderOptions {
  sampleRate: number;
  channels: number;
}

export interface OpusCodec {
  createEncoder(options: OpusEncoderOptions): Promise<OpusEncoder>;
  createDecoder(options: OpusDecoderOptions): Promise<OpusDecoder>;
}

function asSampleRate(sampleRate: number): SampleRate {
  if (!OPUS_SAMPLE_RATES.includes(sampleRate)) {
    throw new Error(`Opus does not support a sample rate of ${sampleRate} Hz`);
  }
  return sampleRate as SampleRate;
}

function asChannels(channels: number): 1 | 2 {
  if (channels !== 1 && channels !== 2) {
    throw new Error(`Opus supports 1 or 2 channels, not ${channels}`);
  }
  return channels;
}

/**
 * libopus's `voip` application, as aiortc ran it: better speech timbre than `audio` at equal
 * bitrate.
 */
export const libopusWasmCodec: OpusCodec = {
  async createEncoder(options) {
    const sampleRate = asSampleRate(options.sampleRate);
    const channels = asChannels(options.channels);
    const encoder = await createEncoder({
      sampleRate,
      channels,
      application: Application.Voip,
      bitrate: options.bitrate ?? "auto",
    });
    return {
      sampleRate,
      channels,
      encode: (pcm) => encoder.encode(pcm, { frameSize: pcm.length / channels }),
      free: () => encoder.free(),
    };
  },

  async createDecoder(options) {
    const sampleRate = asSampleRate(options.sampleRate);
    const channels = asChannels(options.channels);
    const decoder = await createDecoder({ sampleRate, channels });
    return {
      sampleRate,
      channels,
      decode: (packet, opts = {}) =>
        opts.fec
          ? decoder.decode(packet, { decodeFec: true, frameSize: opts.frameSize })
          : decoder.decode(packet),
      decodePacketLoss: (frameSize) => decoder.decodePacketLoss(frameSize),
      free: () => decoder.free(),
    };
  },
};

/**
 * `base` with every encoder at `bitrateBps`, the offer's audio quality. A renegotiation keeps the
 * peer's codec, so a new quality needs a new call.
 */
export function opusCodecAtBitrate(base: OpusCodec, bitrateBps: number): OpusCodec {
  return {
    createEncoder(options) {
      logger.debug(`[WebRTC] Opus encoder constructed at ${Math.floor(bitrateBps / 1000)} kbps`);
      return base.createEncoder({ ...options, bitrate: bitrateBps });
    },
    createDecoder(options) {
      return base.createDecoder(options);
    },
  };
}

// Frame durations, in 48 kHz samples, of the 32 TOC configurations (RFC 6716 §3.1).
const TOC_FRAME_SAMPLES_48K = [
  480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 480, 960, 120, 240,
  480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960,
];

/** Samples per channel `packet` decodes to at `sampleRate`, from its TOC byte; 0 if malformed. */
export function opusPacketSamples(packet: Uint8Array, sampleRate: number): number {
  if (packet.length === 0) return 0;
  const toc = packet[0]!;
  const frameSamples = TOC_FRAME_SAMPLES_48K[toc >> 3]!;
  let frames: number;
  switch (toc & 0x3) {
    case 0:
      frames = 1;
      break;
    case 1:
    case 2:
      frames = 2;
      break;
    default:
      if (packet.length < 2) return 0;
      frames = packet[1]! & 0x3f;
  }
  return (frames * frameSamples * sampleRate) / OPUS_RTP_CLOCK_RATE;
}
