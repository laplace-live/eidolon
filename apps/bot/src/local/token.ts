// The local app's one secret, `<data home>/local-token`, and what is derived from it: the link
// code the terminal prints (good for ten minutes) and the session cookie the page trades it for.
// The secret itself reaches no browser; a CLI or test that can read the file sends it as a Bearer
// token. Deleting the file signs every browser out.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "@eidolon/config";
import { writeDataFile } from "./write.ts";

export const TOKEN_FILE = "local-token";
export const LINK_TTL_SECONDS = 600;
/** A month: a browser restart keeps the app signed in. */
export const SESSION_MAX_AGE_SECONDS = 2_592_000;
// A code minted on the same machine can only come from the future through a clock step back.
const FUTURE_SKEW_SECONDS = 60;

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const LINK_CODE = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;
const PROBE_NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export class TokenError extends Error {
  override readonly name = "TokenError";
}

export function tokenPath(): string {
  return join(dataHome(), TOKEN_FILE);
}

export type LinkCheck = "ok" | "expired" | "invalid";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function sessionCookieName(port: number): string {
  return `eidolon_session_${port}`;
}

export class LocalToken {
  readonly #secret: string;
  readonly #secretDigest: Buffer;
  readonly #sessionDigest: Buffer;

  constructor(secret: string) {
    this.#secret = secret;
    this.#secretDigest = digest(secret);
    this.#sessionDigest = digest(this.#sign("session"));
  }

  /** The secret, for a Bearer header this process sends; never for a page. */
  get secret(): string {
    return this.#secret;
  }

  #sign(message: string): string {
    return createHmac("sha256", this.#secret).update(message, "utf8").digest("base64url");
  }

  /** `<unix seconds>.<HMAC(secret, "link:" + seconds)>`: stateless, so it survives a restart. */
  linkCode(nowSeconds: number): string {
    const at = Math.floor(nowSeconds);
    return `${at}.${this.#sign(`link:${at}`)}`;
  }

  checkLinkCode(code: unknown, nowSeconds: number): LinkCheck {
    if (typeof code !== "string") return "invalid";
    const match = LINK_CODE.exec(code);
    if (!match) return "invalid";
    const at = Number(match[1]);
    if (!timingSafeEqual(digest(match[2] as string), digest(this.#sign(`link:${at}`)))) {
      return "invalid";
    }
    const age = nowSeconds - at;
    return age <= LINK_TTL_SECONDS && age >= -FUTURE_SKEW_SECONDS ? "ok" : "expired";
  }

  /** The Set-Cookie value a valid link code earns. */
  sessionCookie(port: number): string {
    return (
      `${sessionCookieName(port)}=${this.#sign("session")}; HttpOnly; SameSite=Strict; Path=/; ` +
      `Max-Age=${SESSION_MAX_AGE_SECONDS}`
    );
  }

  /** Compared as SHA-256 digests, so neither the length nor a prefix leaks through timing. */
  isSecret(value: string): boolean {
    return timingSafeEqual(digest(value), this.#secretDigest);
  }

  isSession(value: string): boolean {
    return timingSafeEqual(digest(value), this.#sessionDigest);
  }

  /** Proves this server holds the secret without sending it: HMAC(secret, "probe:" + nonce). */
  probeProof(nonce: string): string | null {
    return PROBE_NONCE.test(nonce) ? this.#sign(`probe:${nonce}`) : null;
  }
}

/** A nonce for probeProof. */
export function probeNonce(): string {
  return randomBytes(16).toString("base64url");
}

export interface LoadTokenOptions {
  /** The owner the file must have; null skips the check, as on Windows. */
  readonly uid?: number | null;
}

/**
 * The local token, made on first use. A file another user owns, or one other users can read, is
 * refused: whoever reads it can sign in, and a session can run code as this user.
 */
export function loadLocalToken(options: LoadTokenOptions = {}): LocalToken {
  const path = tokenPath();
  const uid = options.uid === undefined ? (process.getuid?.() ?? null) : options.uid;
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const secret = randomBytes(32).toString("base64url");
    writeDataFile(path, `${secret}\n`, { secret: true });
    return new LocalToken(secret);
  }
  const remake = "delete it to make a new one";
  if (!stat.isFile()) throw new TokenError(`${path} is not a regular file; ${remake}`);
  if (uid !== null) {
    if (stat.uid !== uid) throw new TokenError(`${path} belongs to another user; ${remake}`);
    if (stat.mode & 0o077) {
      throw new TokenError(
        `${path} is readable by other users; run \`chmod 600 ${path}\`, or ${remake}`,
      );
    }
  }
  const secret = readFileSync(path, "utf8").trim();
  if (!SECRET.test(secret)) throw new TokenError(`${path} holds no valid token; ${remake}`);
  return new LocalToken(secret);
}
