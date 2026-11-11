import { useEffect, useState } from "react";

/** The time, ticking every `everyMs` (a second by default) while `ticking`. */
export function useNow(ticking: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [ticking, everyMs]);
  return now;
}
