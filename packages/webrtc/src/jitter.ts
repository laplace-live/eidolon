// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/transport-smallwebrtc/src/jitter_buffer.ts@ce8f8bc
//
// Only pipedog's own AudioJitterBuffer: the file's video JitterBuffer, aiortc's, isn't ported.

/** The fields of an RTP packet the buffer orders by. */
export interface JitterPacket {
  readonly sequenceNumber: number;
  readonly timestamp: number;
}

/** What `AudioJitterBuffer.add()` releases, in order. */
export type AudioJitterOutput<P extends JitterPacket> =
  | { packet: P; lost?: undefined }
  | { packet?: undefined; lost: number };

function uint16Add(a: number, b: number): number {
  return (a + b) & 0xffff;
}

/**
 * Reorders audio packets with as little delay as possible. A packet in sequence is released at
 * once. A packet after a gap is held until the gap fills or the held audio spans `latency` (in RTP
 * clock units); the gap is then reported as `lost` packets for the decoder to conceal. Late and
 * duplicate packets are dropped.
 */
export class AudioJitterBuffer<P extends JitterPacket = JitterPacket> {
  readonly #latency: number;
  #next: number | null = null;
  readonly #held = new Map<number, P>();

  constructor(latency: number) {
    this.#latency = latency;
  }

  add(packet: P): AudioJitterOutput<P>[] {
    const out: AudioJitterOutput<P>[] = [];
    if (this.#next === null) {
      this.#next = uint16Add(packet.sequenceNumber, 1);
      out.push({ packet });
      return out;
    }
    const ahead = uint16Add(packet.sequenceNumber, -this.#next);
    if (ahead >= 0x8000) return out; // late or duplicate
    if (ahead > 0x1000) {
      // A jump this large is a new stream (the sender restarted): resync.
      this.reset();
      return this.add(packet);
    }
    this.#held.set(packet.sequenceNumber, packet);
    this.#release(out);
    while (this.#held.size > 0) {
      const next = this.#next!;
      const offset = (p: P) => uint16Add(p.sequenceNumber, -next);
      let oldest: P | null = null;
      let newest: P | null = null;
      for (const p of this.#held.values()) {
        if (!oldest || offset(p) < offset(oldest)) oldest = p;
        if (!newest || offset(p) > offset(newest)) newest = p;
      }
      if ((newest!.timestamp - oldest!.timestamp) >>> 0 < this.#latency) break;
      // Give up on the gap before the oldest held packet.
      out.push({ lost: offset(oldest!) });
      this.#next = oldest!.sequenceNumber;
      this.#release(out);
    }
    return out;
  }

  #release(out: AudioJitterOutput<P>[]): void {
    for (;;) {
      const next = this.#held.get(this.#next!);
      if (!next) return;
      this.#held.delete(this.#next!);
      out.push({ packet: next });
      this.#next = uint16Add(this.#next!, 1);
    }
  }

  /** Forgets the stream. */
  reset(): void {
    this.#next = null;
    this.#held.clear();
  }
}
