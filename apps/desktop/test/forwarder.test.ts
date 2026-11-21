import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BearerToken } from "../src/main/attach.ts";
import type { BackendState } from "../src/main/controller.ts";
import {
  type BackendSource,
  createForwarder,
  type Forwarder,
  type ForwarderOptions,
  fromApp,
  UNREACHABLE,
  type UpstreamFetch,
  WAITING_PAGE_CSP,
} from "../src/main/forwarder.ts";

const SECRET = "t".repeat(43);
const WAITING = "<!doctype html><title>Eidolon</title><p>Waiting for Eidolon's server…";

/** The controller as the forwarder sees it: a state, its changes, and what it is told. */
class FakeBackend implements BackendSource {
  state: BackendState = { phase: "starting" };
  readonly reports: string[] = [];
  readonly #listeners = new Set<(state: BackendState) => void>();
  onRefused: ((origin: string) => void) | null = null;

  subscribe(listener: (state: BackendState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  set(state: BackendState): void {
    this.state = state;
    for (const listener of [...this.#listeners]) listener(state);
  }

  ready(origin: string, secret = SECRET): void {
    this.set({ phase: "ready", origin, token: new BearerToken(secret), owned: true });
  }

  refused(origin: string): void {
    this.reports.push(`refused ${origin}`);
    this.onRefused?.(origin);
  }

  restarted(origin: string): void {
    this.reports.push(`restarted ${origin}`);
  }

  disconnected(origin: string): void {
    this.reports.push(`disconnected ${origin}`);
  }
}

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
}

interface Upstream {
  readonly server: Server;
  readonly origin: string;
  readonly seen: Seen[];
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const servers: Server[] = [];
const forwarders: Forwarder[] = [];

async function upstream(handler?: Handler): Promise<Upstream> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
    if (handler !== undefined) handler(request, response);
    else response.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
  await new Promise<void>((done) => server.listen({ host: "127.0.0.1", port: 0 }, done));
  servers.push(server);
  const { port } = server.address() as { port: number };
  return { server, origin: `http://127.0.0.1:${port}`, seen };
}

/** A port nothing listens on. */
async function closedOrigin(): Promise<string> {
  const server = createServer();
  await new Promise<void>((done) => server.listen({ host: "127.0.0.1", port: 0 }, done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return `http://127.0.0.1:${port}`;
}

function forwarder(backend: BackendSource, options: Partial<ForwarderOptions> = {}): Forwarder {
  const created = createForwarder({
    backend,
    waitingPage: () => WAITING,
    log: { warn: () => {} },
    ...options,
  });
  forwarders.push(created);
  return created;
}

/** A request as protocol.handle hands it, from `initiator` (main's own load when undefined). */
function from(
  initiator: string | undefined,
  path: string,
  init: RequestInit & { duplex?: "half" } = {},
): Request {
  const request = new Request(`eidolon-app://app${path}`, init);
  if (initiator !== undefined)
    Object.defineProperty(request, "initiatorOrigin", { value: initiator });
  return request;
}

const app = (path: string, init: RequestInit & { duplex?: "half" } = {}) =>
  from("eidolon-app://app", path, init);

afterEach(async () => {
  vi.useRealTimers();
  for (const created of forwarders.splice(0)) await created.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

describe("who gets the Bearer", () => {
  test("the app's page and main's own loads, and no one else, an opaque origin included", async () => {
    const backend = new FakeBackend();
    const up = await upstream();
    backend.ready(up.origin);
    const forward = forwarder(backend);
    for (const initiator of [undefined, "eidolon-app://app"]) {
      const response = await forward.handle(from(initiator, "/api/local/status"));
      expect([initiator, response.status]).toEqual([initiator, 200]);
    }
    expect(up.seen.map((seen) => seen.headers.authorization)).toEqual([
      `Bearer ${SECRET}`,
      `Bearer ${SECRET}`,
    ]);
    for (const initiator of [
      "eidolon-app://other",
      "null",
      "data:text/html,<script>fetch('/api')</script>",
      "eidolon-app://shell",
      "eidolon-app://app:7860",
      "eidolon-app://user@app",
      "http://127.0.0.1:5173",
      "https://app",
      "file://app",
      "",
    ]) {
      const response = await forward.handle(
        from(initiator, "/api/local/status", { method: "POST", body: "{}" }),
      );
      expect([initiator, response.status]).toEqual([initiator, 403]);
    }
    expect(up.seen).toHaveLength(2);
  });

  test("compares by protocol and host, since Node's URL gives a custom scheme the origin null", () => {
    expect(new URL("eidolon-app://app").origin).toBe("null");
    expect(fromApp("eidolon-app://app")).toBe(true);
    expect(fromApp("eidolon-app://app/")).toBe(true);
    expect(fromApp("eidolon-app://APP")).toBe(false);
    expect(fromApp("null")).toBe(false);
  });

  test("answers another host of the scheme 404, forwarding nothing", async () => {
    const backend = new FakeBackend();
    const up = await upstream();
    backend.ready(up.origin);
    const response = await forwarder(backend).handle(
      new Request("eidolon-app://shell/api/local/status"),
    );
    expect(response.status).toBe(404);
    expect(up.seen).toEqual([]);
  });
});

describe("headers", () => {
  test("drops what the guard refuses and the page's credentials, sets the Bearer, passes the rest", async () => {
    const backend = new FakeBackend();
    const up = await upstream();
    backend.ready(up.origin);
    const response = await forwarder(backend).handle(
      app("/api/local/files/a.bin?x=1&y=two", {
        method: "POST",
        body: "{}",
        headers: {
          host: "app",
          origin: "eidolon-app://app",
          cookie: "eidolon_session_7860=forged",
          "sec-fetch-site": "cross-site",
          "x-eidolon-proof": "forged",
          authorization: "Bearer the-page's-own",
          "content-type": "application/json",
          range: "bytes=0-9",
          accept: "application/json",
          "x-request-id": "kept",
        },
      }),
    );
    expect(response.status).toBe(200);
    const [seen] = up.seen;
    expect(seen?.url).toBe("/api/local/files/a.bin?x=1&y=two");
    expect(seen?.headers).toMatchObject({
      host: new URL(up.origin).host,
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
      range: "bytes=0-9",
      accept: "application/json",
      "x-request-id": "kept",
    });
    for (const name of ["origin", "cookie", "sec-fetch-site", "x-eidolon-proof"]) {
      expect([name, seen?.headers[name]]).toEqual([name, undefined]);
    }
  });

  test("withholds Set-Cookie, the body's encoding and length, and hop-by-hop headers; passes the rest", async () => {
    const backend = new FakeBackend();
    backend.ready("http://127.0.0.1:7860");
    const withheld = [
      ["set-cookie", "eidolon_session_7860=x; HttpOnly"],
      ["set-cookie", "other=y"],
      ["content-encoding", "gzip"],
      ["content-length", "17"],
      ["transfer-encoding", "chunked"],
      ["connection", "keep-alive"],
      ["keep-alive", "timeout=5"],
      ["te", "trailers"],
      ["trailer", "x-checksum"],
      ["upgrade", "h2c"],
      ["proxy-authenticate", "Basic"],
      ["proxy-authorization", "Basic x"],
    ];
    const passed = {
      "content-security-policy": "default-src 'self'",
      "cache-control": "no-store",
      etag: '"v1"',
      "content-type": "text/plain; charset=utf-8",
      "content-range": "bytes 0-16/100",
      "accept-ranges": "bytes",
    };
    const fetch: UpstreamFetch = async () =>
      new Response("partial", {
        status: 206,
        statusText: "Partial Content",
        headers: [...withheld, ...Object.entries(passed)] as [string, string][],
      });
    const response = await forwarder(backend, { fetch }).handle(app("/api/local/files/x"));
    expect([response.status, response.statusText]).toEqual([206, "Partial Content"]);
    expect(Object.fromEntries(response.headers)).toEqual(passed);
    expect(await response.text()).toBe("partial");
  });

  test("relays the body undici decoded, without the encoding or length it no longer has", async () => {
    const backend = new FakeBackend();
    const body = gzipSync("decoded by undici");
    const up = await upstream((_request, response) => {
      response.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": String(body.length),
        "content-type": "text/plain; charset=utf-8",
        "set-cookie": "eidolon_session_7860=x; HttpOnly",
      });
      response.end(body);
    });
    backend.ready(up.origin);
    const response = await forwarder(backend).handle(
      app("/assets/app.js", { headers: { "accept-encoding": "gzip" } }),
    );
    expect(await response.text()).toBe("decoded by undici");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    for (const name of ["content-encoding", "content-length", "set-cookie"]) {
      expect([name, response.headers.has(name)]).toEqual([name, false]);
    }
  });

  test("passes a redirect through unfollowed, a 304 bodiless, and a HEAD without a body", async () => {
    const backend = new FakeBackend();
    const up = await upstream((request, response) => {
      if (request.url === "/moved") response.writeHead(302, { location: "/elsewhere" }).end();
      else if (request.url === "/cached") response.writeHead(304, { etag: '"v1"' }).end();
      else response.writeHead(200, { "content-type": "text/plain" }).end("body");
    });
    backend.ready(up.origin);
    const forward = forwarder(backend);
    const moved = await forward.handle(app("/moved"));
    expect([moved.status, moved.headers.get("location")]).toEqual([302, "/elsewhere"]);
    const cached = await forward.handle(app("/cached"));
    expect([cached.status, cached.body]).toEqual([304, null]);
    const head = await forward.handle(app("/file", { method: "HEAD" }));
    expect([head.status, await head.text()]).toEqual([200, ""]);
    expect(up.seen.map((seen) => seen.url)).toEqual(["/moved", "/cached", "/file"]);
  });
});

/** Resolves on the next call; `resolve` is what the server calls. */
function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("streams", () => {
  test("a response streams through as it comes, never buffered", async () => {
    const backend = new FakeBackend();
    const rest = signal();
    const up = await upstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write('{"chunk":1}\n');
      void rest.promise.then(() => response.end('{"chunk":2}\n'));
    });
    backend.ready(up.origin);
    const response = await forwarder(backend).handle(
      app("/api/local/chats/c/messages", { method: "POST", body: "{}" }),
    );
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe('{"chunk":1}\n');
    rest.resolve();
    let tail = "";
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      tail += decoder.decode(next.value);
    }
    expect(tail).toBe('{"chunk":2}\n');
  });

  test("an upload streams to the server as the page sends it", async () => {
    const backend = new FakeBackend();
    const firstArrived = signal();
    const received: string[] = [];
    const up = await upstream((request, response) => {
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        received.push(chunk);
        firstArrived.resolve();
      });
      request.on("end", () => response.end(received.join("")));
    });
    backend.ready(up.origin);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode("part one;"));
        // Only a forwarder that streams lets the server see part one before part two exists.
        await firstArrived.promise;
        controller.enqueue(encoder.encode("part two"));
        controller.close();
      },
    });
    const response = await forwarder(backend).handle(
      app("/api/local/files", { method: "POST", body, duplex: "half" }),
    );
    expect(await response.text()).toBe("part one;part two");
    expect(received[0]).toBe("part one;");
  });

  test("the page cancelling a stream closes its connection to the server", async () => {
    const backend = new FakeBackend();
    const closed = signal();
    const up = await upstream((request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write('{"chunk":1}\n');
      request.socket.on("close", closed.resolve);
    });
    backend.ready(up.origin);
    const response = await forwarder(backend).handle(
      app("/api/local/chats/c/messages", { method: "POST", body: "{}" }),
    );
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    const cancelledAt = performance.now();
    // What Electron does with the body it relays when the page aborts.
    await reader.cancel();
    await closed.promise;
    expect(performance.now() - cancelledAt).toBeLessThan(1000);
    expect(up.seen).toHaveLength(1);
  });
});

describe("reports to the controller", () => {
  test("a 2xx to a forwarded POST /api/local/restart, and nothing else", async () => {
    const backend = new FakeBackend();
    let status = 200;
    const up = await upstream((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" }).end("{}");
    });
    backend.ready(up.origin);
    const forward = forwarder(backend);
    await forward.handle(app("/api/local/restart", { method: "POST" }));
    await forward.handle(app("/api/local/restart"));
    await forward.handle(app("/api/local/restart/", { method: "POST" }));
    status = 409;
    await forward.handle(app("/api/local/restart", { method: "POST" }));
    expect(backend.reports.filter((report) => report.startsWith("restarted"))).toEqual([
      `restarted ${up.origin}`,
    ]);
  });

  test("a refused connection, held the same way until a server is ready again", async () => {
    const backend = new FakeBackend();
    const gone = await closedOrigin();
    const up = await upstream();
    backend.ready(gone);
    backend.onRefused = () => {
      backend.set({ phase: "holding", owned: true });
      setTimeout(() => backend.ready(up.origin, "n".repeat(43)), 50);
    };
    const response = await forwarder(backend).handle(app("/api/local/status"));
    expect(response.status).toBe(200);
    expect(backend.reports).toEqual([`refused ${gone}`]);
    expect(up.seen.map((seen) => seen.headers.authorization)).toEqual([`Bearer ${"n".repeat(43)}`]);
  });

  test("a refused request with a body isn't held: undici has taken the body, which is never buffered", async () => {
    const backend = new FakeBackend();
    const gone = await closedOrigin();
    backend.ready(gone);
    backend.onRefused = () => backend.set({ phase: "holding", owned: true });
    const started = performance.now();
    const response = await forwarder(backend).handle(
      app("/api/local/chats/c/messages", { method: "POST", body: '{"text":"hi"}' }),
    );
    expect([response.status, await response.json()]).toEqual([503, UNREACHABLE]);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(backend.reports).toEqual([`refused ${gone}`]);
  });

  test("a refused connection the controller doesn't act on is the no-backend answer at once", async () => {
    const backend = new FakeBackend();
    const gone = await closedOrigin();
    backend.ready(gone);
    const response = await forwarder(backend).handle(app("/api/local/status"));
    expect([response.status, await response.json()]).toEqual([503, UNREACHABLE]);
    expect(backend.reports).toEqual([`refused ${gone}`]);
  });

  test("a server that drops the request without an answer is the no-backend answer, not a refusal", async () => {
    const backend = new FakeBackend();
    const up = await upstream((request) => request.socket.destroy());
    backend.ready(up.origin);
    const response = await forwarder(backend).handle(app("/api/local/status"));
    expect(response.status).toBe(503);
    expect(backend.reports.filter((report) => report.startsWith("refused"))).toEqual([]);
  });

  test("undici's disconnect: a connection to the server closing", async () => {
    const backend = new FakeBackend();
    const up = await upstream();
    backend.ready(up.origin);
    const forward = forwarder(backend);
    expect((await forward.handle(app("/api/local/status"))).status).toBe(200);
    up.server.closeAllConnections();
    await vi.waitFor(() => expect(backend.reports).toContain(`disconnected ${up.origin}`));
  });
});

describe("no backend", () => {
  test("at startup, after a failure and once stopped: 503 JSON, or the waiting page for a document", async () => {
    const backend = new FakeBackend();
    const forward = forwarder(backend);
    for (const state of [
      { phase: "starting" },
      { phase: "failed", failure: { reason: "exited", stderr: [] } },
      { phase: "stopped" },
    ] as const) {
      backend.set(state);
      const api = await forward.handle(app("/api/local/status"));
      expect([state.phase, api.status, api.headers.get("cache-control")]).toEqual([
        state.phase,
        503,
        "no-store",
      ]);
      expect(api.headers.get("content-type")).toBe("application/json");
      expect(await api.text()).toBe(
        '{"error":{"code":"unreachable","message":"Eidolon\'s server isn\'t running"}}',
      );
      const page = await forward.handle(
        from(undefined, "/chats/c1", {
          headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
        }),
      );
      expect([page.status, await page.text()]).toEqual([503, WAITING]);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(page.headers.get("content-security-policy")).toBe(WAITING_PAGE_CSP);
    }
  });
});

describe("holding", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** A fetch that records what it was sent and answers 200. */
  function recordingFetch(): {
    fetch: UpstreamFetch;
    sent: { url: string; authorization: string | undefined }[];
  } {
    const sent: { url: string; authorization: string | undefined }[] = [];
    return {
      sent,
      fetch: async (url, init) => {
        sent.push({
          url: url.href,
          authorization: init.headers.find(([name]) => name === "authorization")?.[1],
        });
        return new Response("ok");
      },
    };
  }

  test("forwards nothing until the server is ready, then with the new server's Bearer", async () => {
    const backend = new FakeBackend();
    backend.set({ phase: "holding", owned: false });
    const { fetch, sent } = recordingFetch();
    const pending = forwarder(backend, { fetch }).handle(app("/api/local/status"));
    await vi.advanceTimersByTimeAsync(14_000);
    expect(sent).toEqual([]);
    backend.ready("http://[::1]:7861", "r".repeat(43));
    const response = await pending;
    expect(response.status).toBe(200);
    expect(sent).toEqual([
      { url: "http://[::1]:7861/api/local/status", authorization: `Bearer ${"r".repeat(43)}` },
    ]);
  });

  test("gives up after 15 s: the no-backend answer, never forwarded", async () => {
    const backend = new FakeBackend();
    backend.set({ phase: "holding", owned: true });
    const { fetch, sent } = recordingFetch();
    const forward = forwarder(backend, { fetch });
    const api = forward.handle(app("/api/local/status"));
    const page = forward.handle(from(undefined, "/", { headers: { accept: "text/html" } }));
    let settled = false;
    void api.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect([(await api).status, await (await api).json()]).toEqual([503, UNREACHABLE]);
    expect(await (await page).text()).toBe(WAITING);
    backend.ready("http://127.0.0.1:7860");
    expect(sent).toEqual([]);
  });

  test("a hold that ends in failure answers at once", async () => {
    const backend = new FakeBackend();
    backend.set({ phase: "holding", owned: true });
    const { fetch, sent } = recordingFetch();
    const pending = forwarder(backend, { fetch }).handle(app("/api/local/status"));
    await vi.advanceTimersByTimeAsync(1000);
    backend.set({ phase: "failed", failure: { reason: "exited", stderr: [] } });
    expect((await pending).status).toBe(503);
    expect(sent).toEqual([]);
  });
});

describe("in dev", () => {
  test("/api/ and /mcp go to the backend with the Bearer, everything else to Vite without it", async () => {
    const backend = new FakeBackend();
    const api = await upstream();
    const vite = await upstream();
    backend.ready(api.origin);
    const forward = forwarder(backend, { devServer: vite.origin });
    const page = { headers: { accept: "text/html", authorization: "Bearer the-page's-own" } };
    for (const path of ["/", "/src/main.tsx", "/@vite/client", "/apiary", "/mcpx"]) {
      expect((await forward.handle(app(path, page))).status).toBe(200);
    }
    for (const path of ["/api", "/api/local/status", "/mcp", "/mcp/x"]) {
      expect((await forward.handle(app(path))).status).toBe(200);
    }
    expect(vite.seen.map((seen) => [seen.url, seen.headers.authorization])).toEqual([
      ["/", undefined],
      ["/src/main.tsx", undefined],
      ["/@vite/client", undefined],
      ["/apiary", undefined],
      ["/mcpx", undefined],
    ]);
    expect(api.seen.map((seen) => [seen.url, seen.headers.authorization])).toEqual([
      ["/api", `Bearer ${SECRET}`],
      ["/api/local/status", `Bearer ${SECRET}`],
      ["/mcp", `Bearer ${SECRET}`],
      ["/mcp/x", `Bearer ${SECRET}`],
    ]);
  });

  test("Vite's server still answers while the backend is starting", async () => {
    const backend = new FakeBackend();
    const vite = await upstream();
    const forward = forwarder(backend, { devServer: vite.origin });
    expect((await forward.handle(app("/src/main.tsx"))).status).toBe(200);
    expect((await forward.handle(app("/api/local/status"))).status).toBe(503);
  });
});
