import type { Status } from "@/lib/api";

/** Pages that work before the keys are saved: the wizard, and settings to enter them by hand. */
const OPEN_BEFORE_KEYS = new Set(["/setup", "/settings"]);

/** Where the root loader sends the viewer before any page renders, or null to stay. */
export function firstRunRedirect(status: Pick<Status, "keys">, pathname: string): string | null {
  const keysMissing = Object.values(status.keys).includes(false);
  const page = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return keysMissing && !OPEN_BEFORE_KEYS.has(page) ? "/setup" : null;
}
