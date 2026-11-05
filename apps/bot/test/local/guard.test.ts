// The guard matrix: Host, Origin, Sec-Fetch-Site, the session and the socket peer, for every kind
// of route the local server answers. Raw sockets, so Host says exactly what a test means.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MemoryAdmin } from "@eidolon/memory";
import type { RouteServer } from "../../src/app.ts";
import { allowedHosts, guardRequest, isApiPath, isLoopbackAddress } from "../../src/local/guard.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import { type Booted, bootFixture, cleanUpBoot, type RawResponse, raw } from "./harness.ts";

let booted: Booted;
let logs: CapturedLogs;
let memoryCalls = 0;

beforeAll(async () => {
  logs = captureLogs();
  booted = await bootFixture();
  const admin: MemoryAdmin = {
    list: async () => {
      memoryCalls++;
      return { ok: true, value: [] };
    },
    forget: async () => {
      memoryCalls++;
      return { ok: true, value: undefined };
    },
  };
  booted.fakes.memoryAdmin = admin;
});

afterAll(async () => {
  await booted.stop();
  logs.restore();
  cleanUpBoot();
});

interface Route {
  readonly method: string;
  readonly path: string;
  /** Needs the session cookie or the Bearer secret. */
  readonly session: boolean;
  readonly api: boolean;
  readonly body?: string;
}

const ROUTES: readonly Route[] = [
  { method: "GET", path: "/", session: false, api: false },
  { method: "GET", path: "/assets/app-3f1c0d4e.js", session: false, api: false },
  { method: "GET", path: "/studio/milky-green/prompt", session: false, api: false },
  { method: "GET", path: "/api/ice-servers", session: false, api: true },
  { method: "GET", path: "/api/selfie/abc.png", session: false, api: true },
  { method: "PATCH", path: "/api/offer", session: false, api: true, body: "{}" },
  { method: "POST", path: "/mcp", session: false, api: true, body: "{}" },
  { method: "GET", path: "/api/nope", session: false, api: true },
  {
    method: "POST",
    path: "/api/offer",
    session: true,
    api: true,
    body: '{"sdp":"v=0","type":"offer"}',
  },
  { method: "POST", path: "/api/offer/preflight", session: true, api: true, body: "{}" },
  { method: "GET", path: "/api/memories", session: true, api: true },
  { method: "POST", path: "/api/memories/forget", session: true, api: true, body: "{}" },
  { method: "GET", path: "/api/local/status", session: true, api: true },
  { method: "PUT", path: "/api/local/settings", session: true, api: true, body: "{}" },
];

function send(
  route: Route,
  headers: Record<string, string | undefined> = {},
): Promise<RawResponse> {
  const lines = [`${route.method} ${route.path} HTTP/1.1`];
  const all: Record<string, string | undefined> = {
    Host: `127.0.0.1:${booted.port}`,
    "Content-Type": route.body === undefined ? undefined : "application/json",
    "Content-Length": route.body === undefined ? undefined : String(Buffer.byteLength(route.body)),
    ...headers,
  };
  for (const [name, value] of Object.entries(all))
    if (value !== undefined) lines.push(`${name}: ${value}`);
  return raw(booted.port, lines.join("\n"), route.body ?? "");
}

/** What a signed-in page of the app sends. */
function signedIn(extra: Record<string, string | undefined> = {}) {
  return {
    Cookie: booted.cookie,
    Origin: booted.origin,
    "Sec-Fetch-Site": "same-origin",
    ...extra,
  };
}

function expectNoCors(response: RawResponse, label: string): void {
  const cors = [...response.headers.keys()].filter((name) => name.startsWith("access-control-"));
  expect([label, cors]).toEqual([label, []]);
}

describe("Host", () => {
  test("anything but a loopback name with the bound port is 421, on every route", async () => {
    const port = booted.port;
    for (const route of ROUTES) {
      for (const host of [
        `evil.example:${port}`,
        `localhost:${port + 1}`,
        "localhost",
        "127.0.0.1",
      ]) {
        const response = await send(route, signedIn({ Host: host }));
        expect([route.path, host, response.status]).toEqual([route.path, host, 421]);
        expectNoCors(response, route.path);
      }
    }
  });

  test("localhost, 127.0.0.1 and [::1] with the port pass", async () => {
    for (const name of ["localhost", "127.0.0.1", "[::1]", "LOCALHOST"]) {
      const host = `${name}:${booted.port}`;
      const response = await send(ROUTES[0] as Route, { Host: host });
      expect([host, response.status]).toEqual([host, 200]);
    }
  });

  test("a request with no Host at all is 421, not a crash", async () => {
    const response = await raw(booted.port, "GET /api/local/status HTTP/1.0");
    expect(response.status).toBe(421);
  });
});

describe("Origin and Sec-Fetch-Site on the API", () => {
  test("another origin is 403 on every API route, with no CORS header, even signed in", async () => {
    for (const route of ROUTES.filter((r) => r.api)) {
      for (const origin of [
        "http://localhost:3000",
        "null",
        `http://evil.example:${booted.port}`,
      ]) {
        const response = await send(route, signedIn({ Origin: origin }));
        expect([route.path, origin, response.status]).toEqual([route.path, origin, 403]);
        expectNoCors(response, route.path);
      }
    }
  });

  test("a text/plain forget from another origin is refused before it runs", async () => {
    const calls = memoryCalls;
    const response = await send(
      { method: "POST", path: "/api/memories/forget", session: true, api: true, body: "x" },
      signedIn({ Origin: "http://localhost:3000", "Content-Type": "text/plain" }),
    );
    expect(response.status).toBe(403);
    expect(memoryCalls).toBe(calls);
  });

  test("Sec-Fetch-Site other than same-origin or none is 403 on the API", async () => {
    for (const route of ROUTES.filter((r) => r.api)) {
      for (const site of ["same-site", "cross-site"]) {
        const response = await send(route, signedIn({ "Sec-Fetch-Site": site }));
        expect([route.path, site, response.status]).toEqual([route.path, site, 403]);
      }
    }
    const typed = await send(ROUTES[12] as Route, signedIn({ "Sec-Fetch-Site": "none" }));
    expect(typed.status).toBe(501);
  });

  test("the web app's pages are served whatever Origin or Sec-Fetch-Site say", async () => {
    for (const route of ROUTES.filter((r) => !r.api)) {
      const response = await send(route, {
        Origin: "http://localhost:3000",
        "Sec-Fetch-Site": "cross-site",
      });
      expect([route.path, response.status]).toEqual([route.path, 200]);
    }
  });
});

describe("the session", () => {
  test("its routes are 401 without the cookie, with a wrong one, and with ?token=", async () => {
    for (const route of ROUTES.filter((r) => r.session)) {
      for (const cookie of [undefined, `${booted.cookie.split("=")[0]}=wrong`]) {
        const response = await send(route, signedIn({ Cookie: cookie }));
        expect([route.path, cookie, response.status]).toEqual([route.path, cookie, 401]);
      }
      const query = { ...route, path: `${route.path}?token=${booted.token.secret}` };
      const response = await send(query, signedIn({ Cookie: undefined }));
      expect([query.path, response.status]).toEqual([query.path, 401]);
    }
  });

  test("its routes answer a signed-in page", async () => {
    const statuses: [string, number][] = [];
    for (const route of ROUTES.filter((r) => r.session)) {
      statuses.push([`${route.method} ${route.path}`, (await send(route, signedIn())).status]);
    }
    expect(statuses).toEqual([
      ["POST /api/offer", 200],
      ["POST /api/offer/preflight", 200],
      ["GET /api/memories", 200],
      ["POST /api/memories/forget", 200],
      ["GET /api/local/status", 501],
      ["PUT /api/local/settings", 501],
    ]);
  });

  test("a change carried by the cookie alone, without Origin, is 403; the Bearer secret isn't", async () => {
    for (const route of ROUTES.filter((r) => r.session && r.method !== "GET")) {
      const cookie = await send(route, { Cookie: booted.cookie });
      expect([route.path, cookie.status]).toEqual([route.path, 403]);
      const bearer = await send(route, { Authorization: `Bearer ${booted.token.secret}` });
      expect([route.path, bearer.status === 401 || bearer.status === 403]).toEqual([
        route.path,
        false,
      ]);
    }
  });

  test("routes gated by their own capability need no session", async () => {
    for (const route of ROUTES.filter((r) => r.api && !r.session)) {
      const response = await send(route, {});
      expect([route.path, response.status === 401]).toEqual([route.path, false]);
    }
  });
});

describe("methods", () => {
  test("every OPTIONS is refused, with no CORS header, preflight or not", async () => {
    for (const route of ROUTES) {
      const response = await send(
        { ...route, method: "OPTIONS", body: undefined },
        signedIn({ "Access-Control-Request-Method": "POST", Origin: booted.origin }),
      );
      expect([route.path, response.status]).toEqual([route.path, 405]);
      expectNoCors(response, route.path);
    }
  });

  test("HEAD on a GET API route is 405 and runs nothing", async () => {
    const calls = memoryCalls;
    for (const [path, allow] of [
      ["/api/ice-servers", "GET"],
      ["/api/memories", "GET"],
      ["/api/local/status", "GET"],
      ["/api/local/session", "POST, GET"],
    ]) {
      const response = await send({ method: "HEAD", path, session: true, api: true }, signedIn());
      expect([path, response.status, response.headers.get("allow")]).toEqual([path, 405, allow]);
    }
    expect(memoryCalls).toBe(calls);
  });

  test("the app's pages answer HEAD with headers and no body", async () => {
    const response = await send({ method: "HEAD", path: "/", session: false, api: false });
    expect(response.status).toBe(200);
    expect(response.body).toBe("");
    expect(response.headers.get("content-type")).toBe("text/html;charset=utf-8");
  });
});

test("no response the matrix saw carried a CORS header", async () => {
  for (const route of ROUTES) expectNoCors(await send(route, signedIn()), route.path);
});

test("/api/local/* answers no-store; a path that `..` leads out of it is the router's 404", async () => {
  const status = await send(ROUTES[12] as Route, signedIn());
  expect(status.headers.get("cache-control")).toBe("no-store");
  const escaped = await send(
    { method: "GET", path: "/api/local/../memories", session: true, api: true },
    signedIn(),
  );
  expect([escaped.status, escaped.body]).toEqual([
    404,
    '{"error":{"code":"not-found","message":"No such API route"}}',
  ]);
});

describe("guardRequest", () => {
  const hosts = allowedHosts(7860);
  const server = (address: string): RouteServer =>
    ({
      requestIP: () => ({ address, family: "IPv4", port: 50000 }),
      timeout: () => {},
    }) as unknown as RouteServer;

  test("a peer off this computer is 403, whatever a forwarding header claims", () => {
    process.env.EIDOLON_REAL_IP_HEADER = "x-forwarded-for";
    try {
      const request = new Request("http://127.0.0.1:7860/api/local/status", {
        headers: { Host: "127.0.0.1:7860", "X-Forwarded-For": "127.0.0.1" },
      });
      expect(guardRequest(request, server("192.168.1.9"), hosts)?.status).toBe(403);
      expect(guardRequest(request, server("::ffff:127.0.0.1"), hosts)).toBeNull();
      expect(guardRequest(request, undefined, hosts)?.status).toBe(403);
    } finally {
      delete process.env.EIDOLON_REAL_IP_HEADER;
    }
  });

  test("the dev proxy's rewritten Origin with Sec-Fetch-Site: same-site is still 403", () => {
    const request = new Request("http://127.0.0.1:7860/api/local/status", {
      headers: {
        Host: "127.0.0.1:7860",
        Origin: "http://127.0.0.1:7860",
        "Sec-Fetch-Site": "same-site",
      },
    });
    expect(guardRequest(request, server("127.0.0.1"), hosts)?.status).toBe(403);
  });

  test("loopback addresses", () => {
    for (const address of ["127.0.0.1", "127.8.9.10", "::1", "[::1]", "0:0:0:0:0:0:0:1"]) {
      expect([address, isLoopbackAddress(address)]).toEqual([address, true]);
    }
    for (const address of ["::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      expect([address, isLoopbackAddress(address)]).toEqual([address, true]);
    }
    for (const address of [
      "0.0.0.0",
      "::",
      "192.168.1.9",
      "128.0.0.1",
      "127.0.0.256",
      "::2",
      "x",
    ]) {
      expect([address, isLoopbackAddress(address)]).toEqual([address, false]);
    }
  });

  test("allowed hosts and API paths", () => {
    expect([...allowedHosts(7860, ["127.0.0.2"])]).toEqual([
      "localhost:7860",
      "127.0.0.1:7860",
      "[::1]:7860",
      "127.0.0.2:7860",
    ]);
    expect(allowedHosts(80).has("localhost")).toBe(true);
    expect(["/api", "/api/x", "/mcp", "/mcp/", "/mcpx", "/apix", "/"].map(isApiPath)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});
