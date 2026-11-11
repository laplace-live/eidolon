// Catches the intervals code starts, so a test fires a keepalive by hand. Bun's fake timers also
// stop Bun.sleep, which the socket tests wait with.

export interface CaughtInterval {
  readonly ms: number;
  fire(): void;
}

export interface Intervals extends Array<CaughtInterval> {
  restore(): void;
}

export function captureIntervals(): Intervals {
  const real = globalThis.setInterval;
  const caught = [] as unknown as Intervals;
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    caught.push({ ms, fire: callback });
    return real(() => {}, 2 ** 30);
  }) as unknown as typeof setInterval;
  caught.restore = () => {
    globalThis.setInterval = real;
  };
  return caught;
}
