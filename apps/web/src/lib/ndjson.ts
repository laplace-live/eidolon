// A job's events arrive as NDJSON over a streamed fetch body. Lines are cut at the newline byte
// before decoding, so a character split across chunks is only ever decoded whole, and each line
// reports the byte offset past it, which `?after=` takes to resume the stream.

const NEWLINE = 0x0a;

export interface Line {
  readonly text: string;
  /** Bytes from the start of the file to just past this line's newline. */
  readonly offset: number;
}

export interface NdjsonRecord<T> {
  readonly value: T;
  readonly offset: number;
}

export class LineSplitter {
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;
  #offset: number;
  readonly #decoder = new TextDecoder();

  /** `offset` is where the stream starts in the file: the `after` it was requested with. */
  constructor(offset = 0) {
    this.#offset = offset;
  }

  /** The lines `chunk` completes. A line still missing its newline waits for the next chunk. */
  push(chunk: Uint8Array): Line[] {
    const lines: Line[] = [];
    let start = 0;
    for (let end = chunk.indexOf(NEWLINE); end !== -1; end = chunk.indexOf(NEWLINE, start)) {
      const bytes = this.#line(chunk.subarray(start, end));
      this.#offset += bytes.length + 1;
      const text = this.#decoder.decode(bytes).replace(/\r$/, "");
      if (text.trim() !== "") lines.push({ text, offset: this.#offset });
      start = end + 1;
    }
    if (start < chunk.length) {
      this.#pending.push(chunk.slice(start));
      this.#pendingBytes += chunk.length - start;
    }
    return lines;
  }

  /** A line's bytes: `tail` alone, copied together only when earlier chunks left a start. */
  #line(tail: Uint8Array): Uint8Array {
    if (this.#pending.length === 0) return tail;
    const bytes = new Uint8Array(this.#pendingBytes + tail.length);
    let at = 0;
    for (const part of [...this.#pending, tail]) {
      bytes.set(part, at);
      at += part.length;
    }
    this.#pending = [];
    this.#pendingBytes = 0;
    return bytes;
  }
}

/**
 * Each JSON line of `body` as it arrives. A last line without its newline is never yielded: a
 * running job may still be writing it, and a read resumed from the last offset gets it whole.
 * Returning early from the loop cancels the body, which closes the request.
 */
export async function* readNdjson<T = unknown>(
  body: ReadableStream<Uint8Array>,
  offset = 0,
): AsyncGenerator<NdjsonRecord<T>> {
  const splitter = new LineSplitter(offset);
  const reader = body.getReader();
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      for (const line of splitter.push(read.value)) {
        yield { value: JSON.parse(line.text) as T, offset: line.offset };
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
