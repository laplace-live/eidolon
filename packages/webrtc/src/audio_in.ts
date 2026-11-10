// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/transport-smallwebrtc/src/rtc.ts@ce8f8bc
//
// The caller's audio: the RTP of a peer's first transceiver, reordered, concealed where packets
// were lost, and decoded straight to the Ear's 16 kHz mono.
import { errorText, logger } from "@eidolon/config";
import type { MediaStreamTrack, RTCRtpTransceiver } from "werift";
import { AudioJitterBuffer } from "./jitter.ts";
import {
  OPUS_RTP_CLOCK_RATE,
  type OpusCodec,
  type OpusDecoder,
  opusPacketSamples,
} from "./opus.ts";

/** What the caller's audio decodes to: the Ear's rate, mono. */
export const AUDIO_IN_RATE = 16_000;
// How long a gap in the audio may hold the packets after it, at 48 kHz.
const JITTER_LATENCY = 0.06 * OPUS_RTP_CLOCK_RATE;
// The longest gap concealed, in packets; longer gaps are skipped.
const MAX_CONCEALED_PACKETS = 10;
// Packets kept while the Opus decoder loads.
const MAX_PENDING_PACKETS = 50;

export interface AudioPacket {
  readonly sequenceNumber: number;
  readonly timestamp: number;
  readonly payload: Uint8Array;
}

/** Decodes the caller's audio while started; packets that arrive otherwise are dropped. */
export class AudioIn {
  readonly #codec: OpusCodec;
  readonly #jitter = new AudioJitterBuffer<AudioPacket>(JITTER_LATENCY);
  #onPcm: ((pcm: Int16Array) => void) | null = null;
  #stopped = false;
  #decoder: OpusDecoder | null = null;
  #loading: Promise<void> | null = null;
  #pending: { readonly packet: AudioPacket | null; readonly lost: number }[] = [];
  #pendingLoss = 0;
  #lastSamples = AUDIO_IN_RATE * 0.02;

  constructor(codec: OpusCodec) {
    this.#codec = codec;
  }

  /** Feeds it the RTP of `transceiver`'s tracks, those it has and those it gets later. */
  listen(transceiver: RTCRtpTransceiver): void {
    for (const track of transceiver.receiver.tracks) this.#subscribe(track);
    transceiver.onTrack.subscribe((track) => this.#subscribe(track));
  }

  /** Decodes from now on, handing each frame to `onPcm`. */
  start(onPcm: (pcm: Int16Array) => void): void {
    this.#onPcm = onPcm;
  }

  /** Drops what arrives until the next start(), which picks the stream up afresh. */
  pause(): void {
    this.#onPcm = null;
    this.#jitter.reset();
    this.#pending = [];
    this.#pendingLoss = 0;
  }

  stop(): void {
    this.pause();
    this.#stopped = true;
    this.#decoder?.free();
    this.#decoder = null;
  }

  handle(packet: AudioPacket): void {
    if (this.#onPcm === null || this.#stopped) return;
    for (const out of this.#jitter.add(packet)) {
      if (out.packet) this.#decode(out.packet, 0);
      else this.#decode(null, out.lost);
    }
  }

  #subscribe(track: MediaStreamTrack): void {
    track.onReceiveRtp.subscribe((rtp) => {
      try {
        this.handle({
          sequenceNumber: rtp.header.sequenceNumber,
          timestamp: rtp.header.timestamp,
          payload: rtp.payload,
        });
      } catch (error) {
        logger.debug(`[WebRTC] Handling an RTP packet failed: ${errorText(error)}`);
      }
    });
  }

  #ready(): OpusDecoder | null {
    if (this.#decoder !== null) return this.#decoder;
    this.#loading ??= this.#codec
      .createDecoder({ sampleRate: AUDIO_IN_RATE, channels: 1 })
      .then((decoder) => {
        if (this.#stopped) {
          decoder.free();
          return;
        }
        this.#decoder = decoder;
        const pending = this.#pending;
        this.#pending = [];
        for (const p of pending) this.#decode(p.packet, p.lost);
      })
      .catch((error: unknown) => {
        logger.error(`[WebRTC] Can't create the Opus decoder: ${errorText(error)}`);
      });
    return null;
  }

  #decode(packet: AudioPacket | null, lost: number): void {
    const decoder = this.#ready();
    if (decoder === null) {
      if (this.#pending.length < MAX_PENDING_PACKETS) this.#pending.push({ packet, lost });
      return;
    }
    if (packet === null) {
      // A gap: wait for the packet after it, whose FEC data may recover the last lost one.
      this.#pendingLoss += lost;
      return;
    }
    const frameSamples = opusPacketSamples(packet.payload, AUDIO_IN_RATE) || this.#lastSamples;
    const lostPackets = this.#pendingLoss;
    this.#pendingLoss = 0;
    if (lostPackets > 0 && lostPackets <= MAX_CONCEALED_PACKETS) {
      for (let i = 0; i < lostPackets; i++) {
        let concealed: Int16Array;
        try {
          concealed =
            i === lostPackets - 1
              ? decoder.decode(packet.payload, { fec: true, frameSize: this.#lastSamples })
              : decoder.decodePacketLoss(this.#lastSamples);
        } catch {
          continue;
        }
        this.#push(concealed);
      }
    }
    let pcm: Int16Array;
    try {
      pcm = decoder.decode(packet.payload);
    } catch (error) {
      logger.debug(`[WebRTC] Can't decode an Opus packet: ${errorText(error)}`);
      return;
    }
    this.#lastSamples = frameSamples;
    this.#push(pcm);
  }

  #push(pcm: Int16Array): void {
    if (pcm.length > 0) this.#onPcm?.(pcm);
  }
}
