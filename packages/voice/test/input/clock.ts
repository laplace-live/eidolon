import type { Clock } from "../../src/types.ts";

interface Timer {
  readonly at: number;
  readonly seq: number;
  readonly fire: () => void;
}

/** A Clock that moves only when told, firing each timer at its own time, in order. */
export class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  #timers = new Set<Timer>();

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimer(ms: number, fire: () => void): () => void {
    const timer = { at: this.#now + Math.max(0, ms), seq: this.#seq++, fire };
    this.#timers.add(timer);
    return () => this.#timers.delete(timer);
  }

  /** Moves `ms` on; a timer set while firing fires too when it falls due within them. */
  advance(ms: number): void {
    const end = this.#now + ms;
    for (;;) {
      const [next] = [...this.#timers]
        .filter((t) => t.at <= end)
        .sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (next === undefined) break;
      this.#timers.delete(next);
      this.#now = Math.max(this.#now, next.at);
      next.fire();
    }
    this.#now = end;
  }

  /** How many timers are waiting. */
  get pending(): number {
    return this.#timers.size;
  }
}
