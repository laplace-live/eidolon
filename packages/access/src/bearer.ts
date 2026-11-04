import { isPySpace, pyStrip } from "@eidolon/config";
import { type LoggedInUser, resolveUserContext, type UserContext } from "./user-context.ts";

/**
 * The token in `Authorization: Bearer <token>`; the scheme match is case-insensitive. Null for a
 * missing, malformed or non-Bearer header, which callers read as anonymous.
 */
export function extractBearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  // Python `header.strip().split(None, 1)`: the scheme, then the rest after one whitespace run.
  const points = [...pyStrip(authorization)];
  const gap = points.findIndex(isPySpace);
  if (gap === -1 || points.slice(0, gap).join("").toLowerCase() !== "bearer") return null;
  return pyStrip(points.slice(gap).join("")) || null;
}

/** The logged-in caller behind an `Authorization: Bearer <loginSyncToken>`, or null. */
export async function resolveBearerCaller(
  authorization: string | null | undefined,
  resolve: (token: string) => Promise<UserContext> = resolveUserContext,
): Promise<LoggedInUser | null> {
  const token = extractBearerToken(authorization);
  if (token === null) return null;
  const user = await resolve(token);
  if (!user.isLoggedIn || typeof user.mid !== "number") return null;
  return user as LoggedInUser;
}
