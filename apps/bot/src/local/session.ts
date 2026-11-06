// Who may call the local API: a browser holding the session cookie and the proof its page sends as
// a header, or a CLI or test sending the secret as a Bearer token. Cookies ignore ports, so a
// service on another localhost port receives the cookie and could replay it; the proof lives in
// the app's own origin's storage. No token is ever read from a query string, and the cookie is
// matched against every copy the browser sends: a page on another port can plant a decoy.
import { extractBearerToken } from "@eidolon/access";
import { isPlainObject } from "@eidolon/config";
import { PROOF_HEADER, type SessionGrant } from "./api.ts";
import { localError, localJson, readJson } from "./responses.ts";
import {
  type Authenticate,
  type LocalApp,
  type LocalRouteSpec,
  unauthenticated,
} from "./router.ts";
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
    if (!cookies.some((value) => token.isSession(value))) return null;
    const proof = request.headers.get(PROOF_HEADER);
    return proof !== null && token.isProof(proof) ? "session" : "cookie";
  };
}

const SESSION_BODY_LIMIT = 4096;

/**
 * POST trades the link code for the cookie and the proof; a refused code sets nothing, so a stale
 * link never signs out a working session. GET answers whether the caller is signed in, or, given
 * `probe`, a proof that this server holds the secret (a second `bun run local` asks before
 * printing a link).
 */
export function sessionRoutes(
  app: LocalApp,
  token: LocalToken,
  nowSeconds: () => number = () => Date.now() / 1000,
): LocalRouteSpec[] {
  const authenticate = authenticator(token, app.port);
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
        const grant: SessionGrant = { ok: true, proof: token.proof() };
        return localJson(200, grant, { "set-cookie": token.sessionCookie(app.port()) });
      },
    },
    {
      route: "GET /api/local/session",
      public: true,
      handler(request, { url, caller }) {
        const nonce = url.searchParams.get("probe");
        if (nonce !== null) {
          const proof = token.probeProof(nonce);
          return proof === null
            ? localError(400, "bad-request", "The probe is not a nonce")
            : localJson(200, { proof });
        }
        if (caller === null) return unauthenticated(authenticate(request));
        return localJson(200, { ok: true });
      },
    },
  ];
}
