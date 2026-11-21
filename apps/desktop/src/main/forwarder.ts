// The eidolon-app://app host: every request the window makes, forwarded to the server the
// controller proved, with the Bearer that only main holds. Electron-free: the scheme's
// handler hands it protocol.handle's requests.
import type { Socket } from "node:net";
import { Agent, buildConnector, fetch } from "undici";
import type { BackendState, ReadyState } from "./controller.ts";

export const APP_ORIGIN = "eidolon-app://app";
/** apps/web's Vite dev server, where dev.ts pins it. */
export const DEV_SERVER = "http://127.0.0.1:5173";
const HOLD_MS = 15_000;
const RESTART_PATH = "/api/local/restart";
/** The code of the connection error for a new connection that didn't prove itself. */
export const UNPROVEN = "EIDOLON_UNPROVEN";

// The guard answers 421 to a Host that isn't the bound loopback address, 403 under /api and /mcp
// to an Origin other than http://<Host>, and 403 to a Sec-Fetch-Site other than same-origin or
// none. The page's cookie, proof and Authorization are no credentials here.
const DROPPED = new Set([
  "host",
  "origin",
  "cookie",
  "sec-fetch-site",
  "x-eidolon-proof",
  "authorization",
]);
// Set-Cookie would fill the page's cookie jar. undici decodes the body, so its encoding and length
// no longer describe it; the rest are hop-by-hop.
const WITHHELD = new Set([
  "set-cookie",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
]);

/** What apps/web's errorFrom reads as `unreachable`, which its restart poll keeps polling. */
export const UNREACHABLE = {
  error: { code: "unreachable", message: "Eidolon's server isn't running" },
} as const;

/** What the forwarder follows and tells: the controller. */
export interface BackendSource {
  readonly state: BackendState;
  subscribe(listener: (state: BackendState) => void): () => void;
  refused(origin: string): void;
  restarted(origin: string): void;
  disconnected(origin: string): void;
  /** Whether a new connection to `origin` reaches the server ready there, before any request. */
  proveConnection(socket: Socket, origin: string): Promise<boolean>;
}

/** A request as protocol.handle hands it: Electron adds the origin that made it. */
export type SchemeRequest = Request & { readonly initiatorOrigin?: string };

export interface UpstreamInit {
  readonly method: string;
  readonly headers: [string, string][];
  readonly body: ReadableStream<Uint8Array> | null;
  readonly duplex: "half";
  readonly redirect: "manual";
  readonly dispatcher: Agent;
}

export interface UpstreamResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: { forEach(callback: (value: string, name: string) => void): void };
  readonly body: ReadableStream<Uint8Array> | null;
}

export type UpstreamFetch = (url: URL, init: UpstreamInit) => Promise<UpstreamResponse>;

/**
 * The small page a document gets while no server answers, with its own CSP; main reloads the window
 * once one does.
 */
export type WaitingPage = () => Promise<Response>;

export interface ForwarderOptions {
  readonly backend: BackendSource;
  readonly waitingPage: WaitingPage;
  /** Dev: Vite's server, which gets every path but /api/ and /mcp, without the Bearer. */
  readonly devServer?: string;
  readonly log?: { warn(message: string): void };
  readonly fetch?: UpstreamFetch;
}

export interface Forwarder {
  /** protocol.handle's handler for the app host. */
  handle(request: SchemeRequest): Promise<Response>;
  /**
   * A GET of main's own at `path`, such as the quit check's, to the server ready now, with the
   * Bearer and over a proven connection; rejects while none is ready. Its connections closing
   * tell the controller nothing.
   */
  get(path: string, signal: AbortSignal): Promise<Response>;
  /** Drops every connection it holds. */
  destroy(): Promise<void>;
}

/**
 * Main's own loads have no initiator; the app's page is eidolon-app://app. Node's URL gives a
 * custom scheme the origin "null", so protocol and host decide; an opaque origin is "null" itself.
 */
export function fromApp(initiatorOrigin: string | undefined): boolean {
  if (initiatorOrigin === undefined) return true;
  let url: URL;
  try {
    url = new URL(initiatorOrigin);
  } catch {
    return false;
  }
  return (
    url.protocol === "eidolon-app:" &&
    url.host === "app" &&
    url.username === "" &&
    url.password === ""
  );
}

/** The backend's own paths, as its guard draws them; in dev, Vite serves the rest. */
export function isApiPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/")
  );
}

/** A navigation: Chromium asks for HTML, a fetch() for anything. */
function isDocument(request: Request): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    /\btext\/html\b/i.test(request.headers.get("accept") ?? "")
  );
}

/**
 * The answer while no server answers: the waiting page for a document, else the 503 that apps/web
 * reads as `unreachable`.
 */
export function unreachable(request: Request, waitingPage: WaitingPage): Promise<Response> {
  void request.body?.cancel().catch(() => {});
  if (isDocument(request)) return waitingPage();
  return Promise.resolve(
    Response.json(UNREACHABLE, { status: 503, headers: { "cache-control": "no-store" } }),
  );
}

function errorCodes(error: unknown): string[] {
  if (typeof error !== "object" || error === null) return [];
  const { code, errors } = error as { code?: unknown; errors?: unknown };
  return [
    ...(typeof code === "string" ? [code] : []),
    ...(Array.isArray(errors) ? errors.flatMap(errorCodes) : []),
  ];
}

/**
 * Nothing listens there, or what does didn't prove itself: the server may have changed, and the
 * request reached none, so it can go again.
 */
function refusedConnection(error: unknown): boolean {
  const codes = errorCodes((error as { cause?: unknown } | null)?.cause);
  return codes.includes("ECONNREFUSED") || codes.includes(UNPROVEN);
}

function originOf(url: unknown): string {
  return new URL(String(url)).origin;
}

/** undici's own connector, handing a new connection on once the backend proved itself on it. */
function provingConnector(backend: BackendSource): buildConnector.connector {
  const connect = buildConnector({});
  return (connection, callback) => {
    // A failed connect calls back with the error alone, no null after it.
    connect(connection, (...connected) => {
      if (connected[0] !== null) {
        callback(connected[0], null);
        return;
      }
      const socket = connected[1];
      const origin = originOf(`${connection.protocol}//${connection.host}`);
      const unproven = (): void => {
        socket.destroy();
        const error = new Error(`${origin} didn't prove itself on a new connection`);
        callback(Object.assign(error, { code: UNPROVEN }), null);
      };
      backend
        .proveConnection(socket, origin)
        .then((proven) => (proven ? callback(null, socket) : unproven()), unproven);
    });
  };
}

// undici's 300 s defaults would cut an NDJSON stream that idles, such as a task card that waits on
// the owner.
const TIMEOUTS = { bodyTimeout: 0, headersTimeout: 0 } as const;

export function createForwarder(options: ForwarderOptions): Forwarder {
  const { backend, waitingPage, devServer } = options;
  const log = options.log ?? console;
  // The Bearer goes only over a connection the backend proved itself on.
  const agent = new Agent({ ...TIMEOUTS, connect: provingConnector(backend) });
  // Main's own connections close idle soon after each read. On the page's agent each close would
  // start an attached server's grace period, holding the page's requests for a server that never
  // changed.
  const ownAgent = new Agent({ ...TIMEOUTS, connect: provingConnector(backend) });
  // Vite's server gets no Bearer, so its connections need no proof.
  const devAgent = new Agent(TIMEOUTS);
  const upstreamFetch: UpstreamFetch =
    options.fetch ??
    ((url, init) =>
      fetch(url, init as Parameters<typeof fetch>[1]) as unknown as Promise<UpstreamResponse>);
  // An attached server closing a connection may be restarting, maybe onto another address.
  agent.on("disconnect", (origin) => backend.disconnected(originOf(origin)));

  function send(
    request: Request,
    url: URL,
    origin: string,
    secret: string | null,
    dispatcher: Agent,
  ): Promise<UpstreamResponse> {
    const target = new URL(origin);
    target.pathname = url.pathname;
    target.search = url.search;
    const headers: [string, string][] = [];
    request.headers.forEach((value, name) => {
      if (!DROPPED.has(name)) headers.push([name, value]);
    });
    if (secret !== null) headers.push(["authorization", `Bearer ${secret}`]);
    const bodiless = request.method === "GET" || request.method === "HEAD";
    // protocol.handle's Request has no signal: when the page aborts, Electron cancels the body it
    // relays, which is the upstream body itself, and that ends the upstream request.
    return upstreamFetch(target, {
      method: request.method,
      headers,
      body: bodiless ? null : request.body,
      duplex: "half",
      redirect: "manual",
      dispatcher,
    });
  }

  function relay(upstream: UpstreamResponse): Response {
    const headers = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!WITHHELD.has(name)) headers.append(name, value);
    });
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  function discard(request: Request, status: number): Response {
    void request.body?.cancel().catch(() => {});
    return new Response(null, { status });
  }

  const noBackend = (request: Request): Promise<Response> => unreachable(request, waitingPage);

  /** The server to forward to: at once when ready, after the hold while holding, else none. */
  function settled(deadline: number): Promise<ReadyState | null> {
    const state = backend.state;
    if (state.phase === "ready") return Promise.resolve(state);
    if (state.phase !== "holding") return Promise.resolve(null);
    return new Promise((done) => {
      const finish = (ready: ReadyState | null): void => {
        clearTimeout(timer);
        unsubscribe();
        done(ready);
      };
      const timer = setTimeout(() => finish(null), Math.max(0, deadline - Date.now()));
      const unsubscribe = backend.subscribe((next) => {
        if (next.phase !== "holding") finish(next.phase === "ready" ? next : null);
      });
    });
  }

  async function toBackend(request: Request, url: URL): Promise<Response> {
    const deadline = Date.now() + HOLD_MS;
    for (;;) {
      const target = await settled(deadline);
      if (target === null) return noBackend(request);
      let upstream: UpstreamResponse;
      try {
        upstream = await send(request, url, target.origin, target.token.secret, agent);
      } catch (error) {
        if (!refusedConnection(error)) {
          const cause = (error as { cause?: unknown } | null)?.cause ?? error;
          log.warn(`Eidolon: ${request.method} ${url.pathname} found no server: ${String(cause)}`);
          return noBackend(request);
        }
        // The server may be closing for a restart, or another may hold its address: held like the
        // requests after it. undici takes a request's body even when the connection fails, and a
        // body is never buffered, so only a request without one can go again.
        backend.refused(target.origin);
        if (request.body !== null || backend.state === target) return noBackend(request);
        continue;
      }
      if (
        request.method === "POST" &&
        url.pathname === RESTART_PATH &&
        upstream.status >= 200 &&
        upstream.status < 300
      ) {
        backend.restarted(target.origin);
      }
      return relay(upstream);
    }
  }

  async function toDevServer(request: Request, url: URL, server: string): Promise<Response> {
    try {
      return relay(await send(request, url, server, null, devAgent));
    } catch (error) {
      log.warn(`Eidolon: Vite's dev server didn't answer ${url.pathname}: ${String(error)}`);
      return discard(request, 502);
    }
  }

  return {
    handle(request) {
      const url = new URL(request.url);
      if (url.protocol !== "eidolon-app:" || url.host !== "app") {
        return Promise.resolve(discard(request, 404));
      }
      if (!fromApp(request.initiatorOrigin)) return Promise.resolve(discard(request, 403));
      if (devServer !== undefined && !isApiPath(url.pathname)) {
        return toDevServer(request, url, devServer);
      }
      return toBackend(request, url);
    },
    async get(path, signal) {
      const state = backend.state;
      if (state.phase !== "ready") throw new Error("no server is ready");
      // The path's own host, if it named one, never takes the Bearer elsewhere.
      const target = new URL(state.origin);
      const { pathname, search } = new URL(path, target);
      target.pathname = pathname;
      target.search = search;
      const response = await fetch(target, {
        headers: { authorization: `Bearer ${state.token.secret}` },
        redirect: "manual",
        signal,
        dispatcher: ownAgent,
      });
      return response as unknown as Response;
    },
    async destroy() {
      await Promise.all([agent.destroy(), ownAgent.destroy(), devAgent.destroy()]);
    },
  };
}
