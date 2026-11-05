/**
 * Bun.sleep(ms), but once `signal` aborts it rejects with the signal's reason and clears its timer,
 * which would otherwise keep a cancelled process alive until it fired.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return Bun.sleep(ms);
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Settles with `promise`, or rejects with `signal.reason` as soon as `signal` aborts. The promise
 * runs on unread after an abort, so it is always subscribed to and a late rejection stays handled.
 */
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
