/** Items pushed as they come and read once, in order. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  /** Dropped once closed. */
  push(item: T): void {
    if (this.#closed) return;
    this.#items.push(item);
    this.#wake?.();
  }

  /** Reading ends once what is queued has been read. */
  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  /** Reading ends at once. */
  drop(): void {
    this.#items = [];
    this.close();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.#items.length > 0) {
        yield this.#items.shift() as T;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }
}
