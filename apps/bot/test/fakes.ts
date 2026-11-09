// Fake parts for the HTTP tests. The fake CORS layer only marks what passed through it, so a test can
// tell a wrapped response (x-fake-cors) from a preflight answer (x-fake-preflight).
import type {
  AllowedOffer,
  LoggedInUser,
  OfferInput,
  RejectedOffer,
  UserContext,
} from "@eidolon/access";
import { consoleSink, type LogRecord, logger } from "@eidolon/config";
import type { Server } from "bun";
import type { BotAccess, BotApp, BotAppParts } from "../src/app.ts";

export const ANON: UserContext = { mid: null, uname: null, face: null, isLoggedIn: false };
export const VIEWER: LoggedInUser = {
  mid: 12345678,
  uname: "明前奶绿粉丝",
  face: null,
  isLoggedIn: true,
};
export const ORIGIN = "https://laplace.live";

export function allowedOffer(input: OfferInput): AllowedOffer {
  return {
    allowed: true,
    user: ANON,
    token: null,
    body: { sdp: "v=0\r\n", type: "offer" },
    requestData: null,
    opusBitrateBps: 96000,
    clientIp: input.clientIp,
    quota: { allowed: true, remaining: 4, retryAfterSeconds: 0 },
  };
}

/** The offer middleware's 429: `json.dumps` separators, charset, Retry-After. */
export function refusedOffer(input: OfferInput): RejectedOffer {
  const body = '{"error": "匿名用户每小时通话次数已达上限，请登录后再试", "retry_after": 3412}';
  return {
    allowed: false,
    user: ANON,
    clientIp: input.clientIp,
    quota: { allowed: false, remaining: 0, retryAfterSeconds: 3412 },
    response: new Response(body, {
      status: 429,
      headers: { "content-type": "application/json; charset=utf-8", "retry-after": "3412" },
    }),
  };
}

export function isFakePreflight(request: Request): boolean {
  return (
    request.method === "OPTIONS" &&
    request.headers.has("origin") &&
    request.headers.has("access-control-request-method")
  );
}

export function fakeAccess(overrides: Partial<BotAccess> = {}): BotAccess {
  return {
    admitOffer: async (input) => allowedOffer(input),
    preflightOffer: async () => new Response('{"ok":true,"anonymous":false}'),
    resolveBearerCaller: async () => null,
    resolveClientIp: (_headers, peer) => `ip:${peer ?? "none"}`,
    corsPreflightResponse: (request) =>
      isFakePreflight(request)
        ? new Response("preflight", { headers: { "x-fake-preflight": "1" } })
        : null,
    withCors: (request, response) => {
      response.headers.set("x-fake-cors", request.headers.get("origin") ?? "none");
      return response;
    },
    ...overrides,
  };
}

export const ANSWER = {
  sdp: "v=0\r\na=candidate:1 1 udp 16777215 104.30.1.1 50000 typ relay raddr 0.0.0.0 rport 0\r\n",
  type: "answer",
  pc_id: "SmallWebRTCConnection#0-3f1c0d4e5a6b7c8d9e0f1a2b3c4d5e6f",
};

export function fakeParts(overrides: Partial<BotAppParts> = {}): BotAppParts {
  return {
    access: fakeAccess(),
    cors: { allowOrigins: [] },
    ice: { browserPayload: async () => ({ iceServers: [] }) },
    signalling: {
      offer: async () => ({ status: 200, body: ANSWER }),
      patch: async () => ({ status: 200, body: { status: "success" } }),
    },
    memoryAdmin: null,
    selfieResponse: () => new Response(null, { status: 404 }),
    mcp: { handle: async () => new Response("mcp") },
    ...overrides,
  };
}

export interface Served {
  readonly server: Server<undefined>;
  readonly url: string;
  stop(): Promise<void>;
}

export function serve(app: BotApp): Served {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    routes: app.routes,
    fetch: app.fallback,
    error: app.onError,
  });
  return { server, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

export interface CapturedLogs {
  /** Everything but the per-request access lines. */
  readonly records: LogRecord[];
  /** The access lines, which carry the client's ephemeral port. */
  readonly access: string[];
  /** `LEVEL message` per record. */
  lines(): string[];
  restore(): void;
}

const ACCESS_LINE = /^\S+ - "[A-Z]+ \S* HTTP\/1\.1" \d{3}/;

export function captureLogs(): CapturedLogs {
  const records: LogRecord[] = [];
  const access: string[] = [];
  logger.setSink((record) => {
    if (record.level === "INFO" && ACCESS_LINE.test(record.message)) access.push(record.message);
    else records.push(record);
  });
  return {
    records,
    access,
    lines: () => records.map((record) => `${record.level} ${record.message}`),
    restore: () => logger.setSink(consoleSink),
  };
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
