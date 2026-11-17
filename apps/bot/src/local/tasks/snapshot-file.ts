// A task's task.json as the manager keeps it: replaced whole through a rename, one write at a time,
// and while a run streams at most once a second.
import { type TaskSnapshot, writeSnapshot } from "@eidolon/assistant";
import { logger } from "@eidolon/config";

const EVERY_MS = 1000;

export class SnapshotFile {
  readonly #dir: string;
  #latest: TaskSnapshot;
  /** What the file holds. */
  #written: string;
  #lastAt = Number.NEGATIVE_INFINITY;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writes: Promise<void> = Promise.resolve();

  /** `written`: what the file holds already. */
  constructor(dir: string, written: TaskSnapshot) {
    this.#dir = dir;
    this.#latest = written;
    this.#written = JSON.stringify(written);
  }

  /**
   * Writes `snapshot` now, or with `soon`, once a second has passed since the last write. Resolves
   * once the write it asks for is done; a failed one is logged, as the transcript still holds it.
   */
  save(snapshot: TaskSnapshot, soon: boolean): Promise<void> {
    this.#latest = snapshot;
    const wait = this.#lastAt + EVERY_MS - performance.now();
    if (!soon || wait <= 0) return this.#write();
    if (this.#timer === null) {
      this.#timer = setTimeout(() => void this.#write(), wait);
      this.#timer.unref();
    }
    return this.#writes;
  }

  /** Writes what a timer still waits to. */
  flush(): Promise<void> {
    return this.#timer === null ? this.#writes : this.#write();
  }

  #write(): Promise<void> {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#lastAt = performance.now();
    this.#writes = this.#writes.then(async () => {
      const snapshot = this.#latest;
      const text = JSON.stringify(snapshot);
      if (text === this.#written) return;
      try {
        await writeSnapshot(this.#dir, snapshot);
        this.#written = text;
      } catch (error) {
        logger.error(`Task ${snapshot.id}'s task.json wasn't written`, error);
      }
    });
    return this.#writes;
  }
}
