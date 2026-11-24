import type { Status } from "@/lib/api";

/** Pages that work before the keys are saved: the wizard, and settings to enter them by hand. */
const OPEN_BEFORE_KEYS = new Set(["/setup", "/settings"]);

/**
 * Where the root loader sends the viewer before any page renders, or null to stay. Never during a
 * call: the wizard is outside the shell, so opening it ends the tab's call, and the loader runs
 * again on every change of a page's search.
 */
export function firstRunRedirect(
  status: Pick<Status, "keys" | "activeCalls">,
  pathname: string,
): string | null {
  if (status.activeCalls > 0) return null;
  const keysMissing = status.keys.some((key) => !key.set);
  const page = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return keysMissing && !OPEN_BEFORE_KEYS.has(page) ? "/setup" : null;
}
