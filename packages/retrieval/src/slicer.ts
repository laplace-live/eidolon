// Long synchronous work cut into slices, so a live call's audio keeps flowing on Bun's one thread.

// Measured on the 30 MB catalog: 2 ms slices keep the worst event-loop stall near 5 ms (two
// slices can run back to back), against ~45 ms for one JSON.parse, at the same ~65 ms wall time.
const SLICE_MS = 2;

/** Yields to the event loop once the current slice has run for SLICE_MS. */
export class Slicer {
  #deadline = performance.now() + SLICE_MS;

  async tick(): Promise<void> {
    if (performance.now() < this.#deadline) return;
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    this.#deadline = performance.now() + SLICE_MS;
  }
}
