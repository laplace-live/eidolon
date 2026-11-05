import type { Status } from "@/lib/api";

/** Where the root loader sends the viewer before any page renders, or null to stay. */
export function firstRunRedirect(status: Status, pathname: string): string | null {
  const keysMissing = Object.values(status.keys).includes(false);
  return keysMissing && pathname !== "/setup" ? "/setup" : null;
}
