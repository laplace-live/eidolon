import { useEffect, useState } from "react";

const DEBOUNCE_MS = 350;

/** `value` once it has held still for a moment, so typing doesn't search on every key. */
export function useDebounced(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}
