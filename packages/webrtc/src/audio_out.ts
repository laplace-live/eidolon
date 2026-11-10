// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/transport-smallwebrtc/src/transport.ts@ce8f8bc and packages/transport-smallwebrtc/src/rtc.ts@ce8f8bc
//
// Her audio: RawAudioTrack's drift-free 10 ms clock pulling a PcmSource, and RTCRtpSender's 20 ms
// Opus packets on a peer's first transceiver.
import { errorText, logger } from "@eidolon/config";
import { MediaStreamTrack, type RTCRtpSender, RtpHeader, RtpPacket } from "werift";
import { OPUS_RTP_CLOCK_RATE, type OpusCodec } from "./opus.ts";

/** What the clock pulls: `@eidolon/voice`'s PcmSource. */
export interface PcmSource {
  readonly rate: number;
  /** Never blocks: zeros for whatever it doesn't have. */
  pull(samples: number): Int16Array;
}

const PACKET_SECS = 0.02;

/**
 * Sends a PcmSource to the peer while it plays. Sequence numbers and timestamps run on across
 * plays, from random starts, so a pause reads to the client as a gap in one stream.
 */
export class AudioOut {
  readonly #sender: RTCRtpSender;
  readonly #codec: OpusCodec;
  readonly #track = new MediaStreamTrack({ kind: "audio" });
  #attached = false;
  #sequenceNumber = Math.floor(Math.random() * 0x10000);
  readonly #timestampOffset = Math.floor(Math.random() * 2 ** 32);
  /** RTP clock units sent. */
  #timestamp = 0;
  /** Bumped by every play() and stop(): a clock whose run is no longer current ends. */
  #run = 0;

  constructor(sender: RTCRtpSender, codec: OpusCodec) {
    this.#sender = sender;
    this.#codec = codec;
  }

  /**
   * Pulls `source` every 10 ms, from now until the returned stop or the next play(). While `live`
   * says the client is gone, the clock runs on with silence and leaves the source unread.
   */
  play(source: PcmSource, live: () => boolean): () => void {
    const run = ++this.#run;
    if (!this.#attached) {
      this.#attached = true;
      this.#sender.replaceTrack(this.#track).catch((error: unknown) => {
        logger.error(`[WebRTC] Can't attach her audio track: ${errorText(error)}`);
      });
    }
    this.#clock(source, live, run).catch((error: unknown) => {
      logger.error(`[WebRTC] Sending her audio failed: ${errorText(error)}`, error);
    });
    return () => {
      if (this.#run === run) this.#run++;
    };
  }

  stop(): void {
    this.#run++;
  }

  async #clock(source: PcmSource, live: () => boolean, run: number): Promise<void> {
    const rate = source.rate;
    const per10ms = Math.trunc(rate / 100);
    const encoder = await this.#codec.createEncoder({ sampleRate: rate, channels: 1 });
    try {
      const packet = new Int16Array(Math.round(rate * PACKET_SECS));
      let filled = 0;
      let pulled = 0;
      const start = performance.now();
      while (this.#run === run) {
        if (pulled > 0) {
          // From the clock's start, so a stalled event loop catches up instead of drifting.
          const wait = start + (pulled / rate) * 1000 - performance.now();
          if (wait > 0) await Bun.sleep(wait);
          if (this.#run !== run) break;
        }
        if (live()) packet.set(source.pull(per10ms), filled);
        else packet.fill(0, filled, filled + per10ms);
        filled += per10ms;
        pulled += per10ms;
        if (filled === packet.length) {
          this.#send(encoder.encode(packet));
          this.#timestamp += Math.round((packet.length * OPUS_RTP_CLOCK_RATE) / rate);
          filled = 0;
        }
      }
    } finally {
      encoder.free();
    }
  }

  #send(payload: Uint8Array): void {
    this.#sequenceNumber = (this.#sequenceNumber + 1) & 0xffff;
    const header = new RtpHeader({
      payloadType: this.#sender.codec?.payloadType ?? 0,
      sequenceNumber: this.#sequenceNumber,
      timestamp: (this.#timestamp + this.#timestampOffset) >>> 0,
      marker: true,
    });
    this.#track.writeRtp(
      new RtpPacket(header, Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)),
    );
  }
}
