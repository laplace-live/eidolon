// Finding a server that already serves the data home, and proving it is this home's Eidolon before
// a Bearer goes to it (§2.2): the hint its lock's .info gives, and a probe that only a holder of
// local-token can answer.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The server lock's .info, named by the first 12 hex digits of SHA-256("local-server"). */
export const SERVER_INFO = join("locks", "4273f434b594.info");
const TOKEN_FILE = "local-token";
const PROBE_TIMEOUT_MS = 2000;
const MAX_ANSWER_BYTES = 4096;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** local-token's secret. It prints as `BearerToken {}`, so a logged state can't leak it. */
export class BearerToken {
  readonly #secret: string;

  constructor(secret: string) {
    this.#secret = secret;
  }

  get secret(): string {
    return this.#secret;
  }
}

/** What the .info says of the server holding the data home; a field it lacks or garbles is null. */
export interface ServerInfo {
  readonly pid: number | null;
  readonly port: number | null;
  /** The loopback address it bound, as a URL names it: 127.0.0.1, [::1]. */
  readonly host: string | null;
}

/** A server worth probing: one whose .info names its pid, port and host. */
export interface ServerHint {
  readonly pid: number;
  readonly port: number;
  readonly host: string;
}

export function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
}

/** 127.0.0.0/8 or ::1, as `new URL()` writes them: the addresses a local server binds. */
function isLoopbackHost(host: string): boolean {
  if (host === "[::1]") return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)?.slice(1) ?? [];
  return (
    octets.length === 3 &&
    octets.every((octet) => String(Number(octet)) === octet && Number(octet) <= 255)
  );
}

/**
 * The .info, or null where there is none or it isn't JSON: lock.ts writes it in place, so a reader
 * can catch it half written. Never the .lock, which only its holder opens.
 */
export function readServerInfo(home: string): ServerInfo | null {
  let info: unknown;
  try {
    info = JSON.parse(readFileSync(join(home, SERVER_INFO), "utf8"));
  } catch {
    return null;
  }
  if (typeof info !== "object" || info === null || Array.isArray(info)) return null;
  const { pid, port, host } = info as Record<string, unknown>;
  return {
    pid: Number.isSafeInteger(pid) && (pid as number) > 0 ? (pid as number) : null,
    port: isPort(port) ? port : null,
    host: typeof host === "string" && isLoopbackHost(host) ? host : null,
  };
}

/** Null unless the .info names all three: a server older than the recorded host is never probed. */
export function hintFrom(info: ServerInfo | null): ServerHint | null {
  if (info === null || info.pid === null || info.port === null || info.host === null) return null;
  return { pid: info.pid, port: info.port, host: info.host };
}

export function originOf(hint: Pick<ServerHint, "host" | "port">): string {
  return `http://${hint.host}:${hint.port}`;
}

/** local-token as the server would take it, or null while there is none it could use. */
export function readToken(home: string): BearerToken | null {
  const path = join(home, TOKEN_FILE);
  try {
    if (!lstatSync(path).isFile()) return null;
    const secret = readFileSync(path, "utf8").trim();
    return SECRET.test(secret) ? new BearerToken(secret) : null;
  } catch {
    return null;
  }
}

/** Whether `pid` runs; EPERM is a process of another user's, which runs too. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 22 base64url characters; the server takes 16 to 64. */
export function probeNonce(): string {
  return randomBytes(16).toString("base64url");
}

/** HMAC-SHA256(local-token, "probe:" + nonce), as the server's probeProof signs it. */
export function probeProof(token: BearerToken, nonce: string): string {
  return createHmac("sha256", token.secret).update(`probe:${nonce}`, "utf8").digest("base64url");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** A JSON answer with status 200 within `timeoutMs`, over a connection of its own; else null. */
function getJson(url: URL, timeoutMs: number): Promise<unknown> {
  return new Promise((done) => {
    const sent = request(
      url,
      {
        agent: false,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          done(null);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ANSWER_BYTES) sent.destroy();
          else chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            done(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            done(null);
          }
        });
        response.on("error", () => done(null));
        response.on("close", () => done(null));
      },
    );
    sent.on("error", () => done(null));
    sent.end();
  });
}

/**
 * Whether what answers at `origin` holds `token`: GET /api/local/session?probe=<nonce>, whose proof
 * only a holder can sign. Neither side sends the token.
 */
export async function probe(
  origin: string,
  token: BearerToken,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const nonce = probeNonce();
  const answer = await getJson(new URL(`/api/local/session?probe=${nonce}`, origin), timeoutMs);
  const proof = (answer as { proof?: unknown } | null)?.proof;
  return (
    typeof proof === "string" && timingSafeEqual(digest(proof), digest(probeProof(token, nonce)))
  );
}

/** EIDOLON_HOME, or ~/.laplace/eidolon, read from `env` as the backend's dataHome() reads it. */
export function dataHome(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const name = Object.keys(env).find(
    (key) =>
      key === "EIDOLON_HOME" || (platform === "win32" && key.toUpperCase() === "EIDOLON_HOME"),
  );
  const configured = name === undefined ? undefined : env[name];
  if (!configured) return join(homedir(), ".laplace", "eidolon");
  if (configured === "~") return homedir();
  const atHome =
    configured.startsWith("~/") || (platform === "win32" && configured.startsWith("~\\"));
  return resolve(atHome ? join(homedir(), configured.slice(2)) : configured);
}
