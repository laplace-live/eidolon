// Who may call the local API: a browser holding the session cookie, or a CLI or test sending the
// secret as a Bearer token. No token is ever read from a query string, and the cookie is matched
// against every copy the browser sends: a page on another localhost port can plant a decoy, since
// cookies ignore ports.
import { extractBearerToken } from "@eidolon/access";
import { isPlainObject } from "@eidolon/config";
import { localError, localJson, readJson } from "./responses.ts";
import type { Authenticate, LocalApp, LocalRouteSpec } from "./router.ts";
import { type LocalToken, sessionCookieName } from "./token.ts";

/** Every value cookie `name` has in a Cookie header, in order. */
export function cookieValues(header: string | null, name: string): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) values.push(part.slice(eq + 1).trim());
  }
  return values;
}

export function authenticator(token: LocalToken, port: () => number): Authenticate {
  return (request) => {
    const bearer = extractBearerToken(request.headers.get("authorization"));
    if (bearer !== null && token.isSecret(bearer)) return "bearer";
    const cookies = cookieValues(request.headers.get("cookie"), sessionCookieName(port()));
    return cookies.some((value) => token.isSession(value)) ? "cookie" : null;
  };
}

const SESSION_BODY_LIMIT = 4096;

/**
 * POST trades the link code for the cookie; a refused code sets nothing, so a stale link never
 * signs out a working session. GET answers whether the caller is signed in, or, given `probe`, a
 * proof that this server holds the secret (a second `bun run local` asks before printing a link).
 */
export function sessionRoutes(
  app: LocalApp,
  token: LocalToken,
  nowSeconds: () => number = () => Date.now() / 1000,
): LocalRouteSpec[] {
  return [
    {
      route: "POST /api/local/session",
      public: true,
      async handler(request) {
        const body = await readJson(request, SESSION_BODY_LIMIT);
        if (!body.ok) return body.response;
        const code = isPlainObject(body.value) ? body.value.code : undefined;
        if (typeof code !== "string") {
          return localError(400, "bad-request", "Send the code from the link as `code`");
        }
        const check = token.checkLinkCode(code, nowSeconds());
        if (check === "expired") {
          return localError(401, "link-expired", "This link has expired; start Eidolon again");
        }
        if (check === "invalid") {
          return localError(401, "unauthorized", "This link is not this Eidolon's");
        }
        return localJson(200, { ok: true }, { "set-cookie": token.sessionCookie(app.port()) });
      },
    },
    {
      route: "GET /api/local/session",
      public: true,
      handler(_request, { url, caller }) {
        const nonce = url.searchParams.get("probe");
        if (nonce !== null) {
          const proof = token.probeProof(nonce);
          return proof === null
            ? localError(400, "bad-request", "The probe is not a nonce")
            : localJson(200, { proof });
        }
        if (caller === null) {
          return localError(401, "unauthorized", "Open the link Eidolon printed in the terminal");
        }
        return localJson(200, { ok: true });
      },
    },
  ];
}
