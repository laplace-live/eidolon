import { useSyncExternalStore } from "react";

/** Below Tailwind's `md`, where the sidebar is a sheet. */
const MOBILE = "(width < 48rem)";

function subscribe(onChange: () => void): () => void {
  const query = matchMedia(MOBILE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, () => matchMedia(MOBILE).matches);
}
