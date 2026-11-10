// Signed 16-bit little-endian mono PCM, as every speech provider here sends it, read into samples.

/**
 * Samples from a byte stream that may split one between chunks: an odd byte waits for the next
 * chunk.
 */
export class PcmBytes {
  #carry: number | null = null;

  push(bytes: Uint8Array): Int16Array {
    const total = bytes.length + (this.#carry === null ? 0 : 1);
    const samples = new Int16Array(total >> 1);
    const view = new DataView(samples.buffer);
    let at = 0;
    let from = 0;
    if (this.#carry !== null && bytes.length > 0) {
      view.setUint8(0, this.#carry);
      view.setUint8(1, bytes[0] as number);
      at = 2;
      from = 1;
      this.#carry = null;
    }
    const whole = (bytes.length - from) & ~1;
    new Uint8Array(samples.buffer, at, whole).set(bytes.subarray(from, from + whole));
    if (from + whole < bytes.length) this.#carry = bytes[from + whole] as number;
    // Typed arrays use the host's byte order; every host Bun ships for is little-endian.
    return samples;
  }
}

export function bytesOfBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}
