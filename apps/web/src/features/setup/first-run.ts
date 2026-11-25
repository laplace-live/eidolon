import type { Status } from "@/lib/api";
import type { RoleId } from "@/lib/providers";

/** Pages that work before the keys are saved: the wizard, and settings to enter them by hand. */
const OPEN_BEFORE_KEYS = new Set(["/setup", "/settings"]);

/**
 * A call's roles that chats go without, hearing and speaking: setup recommends their accounts' keys
 * rather than waiting for them.
 */
export const RECOMMENDED_ROLES: ReadonlySet<string> = new Set<RoleId>(["hearing", "voice"]);

/** Whether a key the app waits for is missing: one serving a role setup doesn't only recommend. */
export function requiredKeyMissing(status: Pick<Status, "keys">): boolean {
  return status.keys.some(
    (key) => !key.set && key.roles.some((role) => !RECOMMENDED_ROLES.has(role)),
  );
}

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
  const page = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return requiredKeyMissing(status) && !OPEN_BEFORE_KEYS.has(page) ? "/setup" : null;
}
