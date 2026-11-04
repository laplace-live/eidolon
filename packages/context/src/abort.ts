// asyncio delivers cancellation at the awaited call, so nothing after an interrupted await runs.
// A promise keeps running after its caller stops waiting, so every provider re-checks its signal
// after each await, before it touches the shared context.

export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** Settles with `promise`, or rejects with `signal.reason` as soon as `signal` aborts. */
export function raceAbort<T>(promise: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return Promise.resolve(promise);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
