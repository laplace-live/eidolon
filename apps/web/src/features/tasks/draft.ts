// What the owner picks at a waiting task's prompt before answering: the card and the waiting bar
// show the same prompt, so they keep one draft between them.
import { useCallback, useSyncExternalStore } from "react";

const drafts = new Map<string, unknown>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The draft kept under `key`, else `initial`. A key names the question, so a new one starts afresh. */
export function useDraft<T>(key: string, initial: T): readonly [T, (next: T) => void] {
  const kept = useSyncExternalStore(subscribe, () => drafts.get(key) as T | undefined);
  const set = useCallback(
    (next: T) => {
      drafts.set(key, next);
      for (const listener of listeners) listener();
    },
    [key],
  );
  return [kept ?? initial, set];
}
