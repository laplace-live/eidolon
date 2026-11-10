// A running reply's stream lines, kept from its start: a greeting's turn, or a viewer line's
// decisions and turns. POST messages and GET live read the same buffer, so a reader that joins late,
// or comes back after a dropped connection, misses nothing.
import type { ChatStreamLine } from "@eidolon/chat";

const encoder = new TextEncoder();

export class LiveTurn {
  readonly controller = new AbortController();
  /** Resolves once the reply has stored everything it will. */
  readonly ended: Promise<void>;
  readonly #lines: string[] = [];
  readonly #wakers = new Set<() => void>();
  #done = false;
  #markEnded: () => void = () => {};

  constructor() {
    this.ended = new Promise((resolve) => {
      this.#markEnded = resolve;
    });
  }

  push(line: ChatStreamLine): void {
    if (this.#done) return;
    this.#lines.push(`${JSON.stringify(line)}\n`);
    this.#wake();
  }

  end(): void {
    if (this.#done) return;
    this.#done = true;
    this.#wake();
    this.#markEnded();
  }

  /** NDJSON of every line so far, then each as it comes, until the end. Cancelling it stops nothing. */
  stream(): ReadableStream<Uint8Array> {
    let next = 0;
    let waker: (() => void) | null = null;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        for (;;) {
          if (next < this.#lines.length) {
            const text = this.#lines.slice(next).join("");
            next = this.#lines.length;
            controller.enqueue(encoder.encode(text));
            return;
          }
          if (this.#done) {
            controller.close();
            return;
          }
          await new Promise<void>((resolve) => {
            waker = resolve;
            this.#wakers.add(resolve);
          });
        }
      },
      cancel: () => {
        if (waker !== null) this.#wakers.delete(waker);
      },
    });
  }

  #wake(): void {
    const wakers = [...this.#wakers];
    this.#wakers.clear();
    for (const wake of wakers) wake();
  }
}
