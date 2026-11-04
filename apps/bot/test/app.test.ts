import { afterEach, describe, expect, test } from "bun:test";
import type { OfferAdmission, OfferInput } from "@eidolon/access";
import type { BunRequest } from "bun";
import {
  type BotAppParts,
  createBotApp,
  isDemoPath,
  type RouteHandler,
  type RouteServer,
} from "../src/app.ts";
import {
  ANSWER,
  captureLogs,
  fakeAccess,
  fakeParts,
  ORIGIN,
  refusedOffer,
  type Served,
  serve,
} from "./fakes.ts";

let served: Served | null = null;
afterEach(async () => {
  await served?.stop();
  served = null;
});

function start(overrides: Partial<BotAppParts> = {}): Served {
  served = serve(createBotApp(fakeParts(overrides)));
  return served;
}

async function call(
  url: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<{ response: Response; body: string }> {
  const response = await fetch(url, { redirect: "manual", ...init });
  return { response, body: await response.text() };
}

const PREFLIGHT = { Origin: ORIGIN, "Access-Control-Request-Method": "POST" };

describe("routes", () => {
  test("GET /api/ice-servers serves the payload verbatim as compact JSON", async () => {
    const payload = {
      iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
      extra: { kept: "中文" },
    };
    const { url } = start({ ice: { browserPayload: async () => payload } });
    const { response, body } = await call(`${url}/api/ice-servers`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(body).toBe(
      '{"iceServers":[{"urls":["stun:stun.cloudflare.com:3478"]}],"extra":{"kept":"中文"}}',
    );
    expect(response.headers.get("x-fake-cors")).toBe("none");
  });

  test("POST /api/offer gives the guard the body text and client IP, then signalling the admission", async () => {
    const inputs: OfferInput[] = [];
    const admissions: OfferAdmission[] = [];
    const peers: (string | null | undefined)[] = [];
    const { url } = start({
      access: fakeAccess({
        resolveClientIp: (_headers, peer) => {
          peers.push(peer);
          return "198.51.100.7";
        },
        admitOffer: async (input) => {
          inputs.push(input);
          const admission: OfferAdmission = {
            allowed: true,
            user: { mid: 1, uname: "u", face: null, isLoggedIn: true },
            token: "tok",
            body: { sdp: "v=0", type: "offer" },
            requestData: { loginSyncToken: "tok" },
            opusBitrateBps: 192000,
            clientIp: input.clientIp,
            quota: null,
          };
          return admission;
        },
      }),
      signalling: {
        offer: async (admission) => {
          admissions.push(admission);
          return { status: 200, body: ANSWER };
        },
        patch: async () => ({ status: 500, body: null }),
      },
    });
    const text = '{"sdp":"v=0","type":"offer","requestData":{"loginSyncToken":"tok"}}';
    const { response, body } = await call(`${url}/api/offer`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: ORIGIN },
      body: text,
    });
    expect(inputs).toEqual([{ bodyText: text, clientIp: "198.51.100.7" }]);
    expect(peers).toEqual(["127.0.0.1"]);
    expect(admissions).toHaveLength(1);
    expect(admissions[0]?.allowed && admissions[0].opusBitrateBps).toBe(192000);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(body).toBe(JSON.stringify(ANSWER));
    expect(body).toContain("v=0\\r\\na=candidate:");
    expect(response.headers.get("x-fake-cors")).toBe(ORIGIN);
  });

  test("POST /api/offer decodes invalid UTF-8 as U+FFFD before the guard parses it", async () => {
    const inputs: OfferInput[] = [];
    const { url } = start({
      access: fakeAccess({
        admitOffer: async (input) => {
          inputs.push(input);
          return refusedOffer(input);
        },
      }),
    });
    await call(`${url}/api/offer`, {
      method: "POST",
      body: new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    });
    expect(inputs[0]?.bodyText).toBe('{"a":"�"}');
  });

  test("a refused offer is the guard's 429, with CORS, and never reaches signalling", async () => {
    let offers = 0;
    const { url } = start({
      access: fakeAccess({ admitOffer: async (input) => refusedOffer(input) }),
      signalling: {
        offer: async () => {
          offers++;
          return { status: 200, body: ANSWER };
        },
        patch: async () => ({ status: 200, body: {} }),
      },
    });
    const { response, body } = await call(`${url}/api/offer`, {
      method: "POST",
      headers: { Origin: ORIGIN },
      body: "{}",
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3412");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(body).toBe(
      '{"error": "匿名用户每小时通话次数已达上限，请登录后再试", "retry_after": 3412}',
    );
    expect(response.headers.get("x-fake-cors")).toBe(ORIGIN);
    expect(offers).toBe(0);
  });

  test("POST /api/offer answers signalling's status and body", async () => {
    const { url } = start({
      signalling: {
        offer: async () => ({
          status: 400,
          body: { detail: "Invalid WebRTC request: sdp and type are required" },
        }),
        patch: async () => ({ status: 200, body: {} }),
      },
    });
    const { response, body } = await call(`${url}/api/offer`, { method: "POST", body: "{}" });
    expect(response.status).toBe(400);
    expect(body).toBe('{"detail":"Invalid WebRTC request: sdp and type are required"}');
  });

  test("PATCH /api/offer passes the raw body text to signalling and skips the guard", async () => {
    const bodies: string[] = [];
    let guarded = 0;
    const { url } = start({
      access: fakeAccess({
        admitOffer: async (input) => {
          guarded++;
          return refusedOffer(input);
        },
      }),
      signalling: {
        offer: async () => ({ status: 200, body: ANSWER }),
        patch: async (bodyText) => {
          bodies.push(bodyText);
          return { status: 404, body: { detail: "Peer connection not found" } };
        },
      },
    });
    const text = '{"pc_id":"x","candidates":[{"candidate":"","sdp_mid":"0","sdp_mline_index":0}]}';
    const { response, body } = await call(`${url}/api/offer`, { method: "PATCH", body: text });
    expect(bodies).toEqual([text]);
    expect(guarded).toBe(0);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(body).toBe('{"detail":"Peer connection not found"}');
  });

  test("POST /api/offer/preflight answers with the guard's response", async () => {
    const inputs: OfferInput[] = [];
    const { url } = start({
      access: fakeAccess({
        resolveClientIp: () => "203.0.113.1",
        preflightOffer: async (input) => {
          inputs.push(input);
          return new Response('{"ok":true,"anonymous":true,"remaining":5}', {
            headers: { "content-type": "application/json" },
          });
        },
      }),
    });
    const { response, body } = await call(`${url}/api/offer/preflight`, {
      method: "POST",
      body: '{"requestData":{}}',
    });
    expect(inputs).toEqual([{ bodyText: '{"requestData":{}}', clientIp: "203.0.113.1" }]);
    expect(response.status).toBe(200);
    expect(body).toBe('{"ok":true,"anonymous":true,"remaining":5}');
    expect(response.headers.get("x-fake-cors")).toBe("none");
  });

  test("GET /api/selfie/:id serves the percent-decoded segment", async () => {
    const segments: string[] = [];
    const { url } = start({
      selfieResponse: (segment) => {
        segments.push(segment);
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        });
      },
    });
    const { response } = await call(`${url}/api/selfie/abc%2Epng`);
    await call(`${url}/api/selfie/v-sFAsHadyrW6qUtt4GrHA`);
    expect(segments).toEqual(["abc.png", "v-sFAsHadyrW6qUtt4GrHA"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-fake-cors")).toBe("none");
  });

  test("/mcp and /mcp/ reach the MCP handler for every method, with no redirect", async () => {
    const seen: string[] = [];
    const { url } = start({
      access: fakeAccess({ resolveClientIp: () => "192.0.2.4" }),
      mcp: {
        handle: async (request, clientIp) => {
          seen.push(`${request.method} ${new URL(request.url).pathname} ${clientIp}`);
          return new Response("mcp", { status: request.method === "POST" ? 200 : 405 });
        },
      },
    });
    for (const path of ["/mcp", "/mcp/"]) {
      for (const method of ["POST", "GET", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"]) {
        const { response } = await call(`${url}${path}`, { method });
        expect(response.status).toBe(method === "POST" ? 200 : 405);
        expect(response.headers.get("x-fake-cors")).toBe("none");
      }
    }
    expect(seen).toEqual(
      ["/mcp", "/mcp/"].flatMap((path) =>
        ["POST", "GET", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS"].map(
          (method) => `${method} ${path} 192.0.2.4`,
        ),
      ),
    );
  });
});

describe("fallback", () => {
  test("isDemoPath covers /, /client and everything under /client/", () => {
    for (const path of ["/", "/client", "/client/", "/client/x.js", "/client/a/b"]) {
      expect(isDemoPath(path)).toBe(true);
    }
    for (const path of ["/clientx", "/api/offer", "/clients/x", ""]) {
      expect(isDemoPath(path)).toBe(false);
    }
  });

  test("demo paths answer an empty 404 for every method, with CORS", async () => {
    const { url } = start();
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/client"],
      ["GET", "/client/"],
      ["GET", "/client/x.js"],
      ["POST", "/"],
      ["OPTIONS", "/client/x"],
      ["HEAD", "/"],
    ] as const) {
      const { response, body } = await call(`${url}${path}`, {
        method,
        headers: { Origin: ORIGIN },
      });
      expect(response.status).toBe(404);
      expect(body).toBe("");
      expect(response.headers.get("content-length")).toBe("0");
      expect(response.headers.get("content-type")).toBeNull();
      expect(response.headers.get("x-fake-cors")).toBe(ORIGIN);
    }
  });

  test("unknown paths answer FastAPI's JSON 404, the runner's own routes included", async () => {
    const { url } = start();
    for (const [method, path] of [
      ["GET", "/nope"],
      ["POST", "/nope"],
      ["POST", "/start"],
      ["POST", "/sessions/abc/api/offer"],
      ["GET", "/status"],
      ["GET", "/docs"],
      ["GET", "/openapi.json"],
      ["GET", "/files/x"],
      ["GET", "/clientx"],
      ["GET", "/mcpfoo"],
      ["GET", "/api/memories/"],
      ["POST", "/api/offer/"],
      ["GET", "/api/selfie/"],
      ["GET", "/api/selfie"],
      ["GET", "/api/selfie/a/b"],
    ] as const) {
      const { response, body } = await call(`${url}${path}`, {
        method,
        headers: { Origin: ORIGIN },
      });
      expect(`${method} ${path} ${response.status}`).toBe(`${method} ${path} 404`);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(body).toBe('{"detail":"Not Found"}');
      expect(response.headers.get("x-fake-cors")).toBe(ORIGIN);
    }
  });

  test("paths under /mcp/ answer the mount's plain-text 404", async () => {
    const { url } = start();
    const { response, body } = await call(`${url}/mcp/extra`, { method: "POST" });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(body).toBe("Not Found");
    expect(response.headers.get("x-fake-cors")).toBe("none");
  });

  test("a known path with the wrong method answers 405 with the first route's Allow", async () => {
    const { url } = start();
    for (const [method, path, allow] of [
      ["GET", "/api/offer", "POST"],
      ["PUT", "/api/offer", "POST"],
      ["DELETE", "/api/offer", "POST"],
      ["OPTIONS", "/api/offer", "POST"],
      ["HEAD", "/api/offer", "POST"],
      ["GET", "/api/offer/preflight", "POST"],
      ["PATCH", "/api/offer/preflight", "POST"],
      ["POST", "/api/ice-servers", "GET"],
      ["DELETE", "/api/ice-servers", "GET"],
      ["POST", "/api/memories", "GET"],
      ["GET", "/api/memories/forget", "POST"],
      ["DELETE", "/api/selfie/x", "GET"],
      ["POST", "/api/selfie/abc.png", "GET"],
    ] as const) {
      const { response, body } = await call(`${url}${path}`, {
        method,
        headers: { Origin: ORIGIN },
      });
      expect(`${method} ${path} ${response.status}`).toBe(`${method} ${path} 405`);
      expect(response.headers.get("allow")).toBe(allow);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(body).toBe(method === "HEAD" ? "" : '{"detail":"Method Not Allowed"}');
      expect(response.headers.get("x-fake-cors")).toBe(ORIGIN);
    }
  });

  test("CORS preflights are answered before routing, on every path", async () => {
    let mcpCalls = 0;
    const { url } = start({
      mcp: {
        handle: async () => {
          mcpCalls++;
          return new Response("mcp");
        },
      },
    });
    for (const path of ["/api/offer", "/api/memories/forget", "/mcp", "/mcp/", "/", "/nope"]) {
      const { response, body } = await call(`${url}${path}`, {
        method: "OPTIONS",
        headers: PREFLIGHT,
      });
      expect(response.status).toBe(200);
      expect(body).toBe("preflight");
      expect(response.headers.get("x-fake-preflight")).toBe("1");
      expect(response.headers.get("x-fake-cors")).toBeNull();
    }
    expect(mcpCalls).toBe(0);
  });
});

describe("route wrapper", () => {
  test("HEAD on a GET route answers 405 Allow: GET without running the handler", async () => {
    let handlerRuns = 0;
    const counted = async (): Promise<never> => {
      handlerRuns++;
      throw new Error("the GET handler ran for HEAD");
    };
    const { url } = start({
      ice: { browserPayload: counted },
      access: fakeAccess({ resolveBearerCaller: counted }),
      selfieResponse: () => {
        handlerRuns++;
        return new Response("x");
      },
    });
    for (const path of ["/api/ice-servers", "/api/memories", "/api/selfie/abc.png"]) {
      const { response, body } = await call(`${url}${path}`, {
        method: "HEAD",
        headers: { Origin: ORIGIN },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
      expect(response.headers.get("content-length")).toBe("31");
      expect(body).toBe("");
      expect(response.headers.get("x-fake-cors")).toBe(ORIGIN);
    }
    expect(handlerRuns).toBe(0);
  });

  test("a throwing handler becomes a logged plain 500 that still carries CORS", async () => {
    const logs = captureLogs();
    try {
      const { url } = start({
        ice: {
          browserPayload: async () => {
            throw new Error("secret detail");
          },
        },
      });
      const { response, body } = await call(`${url}/api/ice-servers`, {
        headers: { Origin: ORIGIN },
      });
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(body).toBe("Internal Server Error");
      expect(response.headers.get("x-fake-cors")).toBe(ORIGIN);
      const errors = logs.records.filter((record) => record.level === "ERROR");
      expect(errors.map((record) => record.message)).toEqual(["GET /api/ice-servers failed"]);
      expect(errors[0]?.error).toBeInstanceOf(Error);
      expect(String(errors[0]?.error)).toBe("Error: secret detail");
    } finally {
      logs.restore();
    }
  });

  test("a rejected signalling call is a 500 too", async () => {
    const logs = captureLogs();
    try {
      const { url } = start({
        signalling: {
          offer: async () => {
            throw new Error("werift exploded");
          },
          patch: async () => ({ status: 200, body: {} }),
        },
      });
      const { response, body } = await call(`${url}/api/offer`, { method: "POST", body: "{}" });
      expect(response.status).toBe(500);
      expect(body).toBe("Internal Server Error");
      expect(logs.lines()).toEqual(["ERROR POST /api/offer failed"]);
    } finally {
      logs.restore();
    }
  });

  test("every request leaves uvicorn's access line, whatever path answered it", async () => {
    const logs = captureLogs();
    try {
      const { url } = start({
        signalling: {
          offer: async () => ({ status: 200, body: ANSWER }),
          patch: async () => {
            throw new Error("boom");
          },
        },
      });
      await call(`${url}/api/ice-servers?x=1`);
      await call(`${url}/api/ice-servers`, { method: "HEAD" });
      await call(`${url}/mcp`, { method: "OPTIONS", headers: PREFLIGHT });
      await call(`${url}/nope`);
      await call(`${url}/api/offer`, { method: "PATCH", body: "{}" });
      const port = /^127\.0\.0\.1:\d+ - /;
      expect(logs.access.every((line) => port.test(line))).toBe(true);
      expect(logs.access.map((line) => line.replace(port, ""))).toEqual([
        '"GET /api/ice-servers?x=1 HTTP/1.1" 200 OK',
        '"HEAD /api/ice-servers HTTP/1.1" 405 Method Not Allowed',
        '"OPTIONS /mcp HTTP/1.1" 200 OK',
        '"GET /nope HTTP/1.1" 404 Not Found',
        '"PATCH /api/offer HTTP/1.1" 500 Internal Server Error',
      ]);
    } finally {
      logs.restore();
    }
  });

  test("onError, the last resort, logs and answers a plain 500 without CORS", () => {
    const logs = captureLogs();
    try {
      const response = createBotApp(fakeParts()).onError(new Error("escaped"));
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("x-fake-cors")).toBeNull();
      expect(logs.records).toHaveLength(1);
      expect(logs.records[0]?.level).toBe("ERROR");
    } finally {
      logs.restore();
    }
  });

  describe("idle timeout", () => {
    function fakeServer(order: string[]): RouteServer {
      return {
        timeout: (_request, seconds) => {
          order.push(`timeout ${seconds}`);
        },
        requestIP: () => ({ address: "203.0.113.9", family: "IPv4", port: 50000 }),
      };
    }

    function routeOf(
      parts: BotAppParts,
      path: string,
      method?: "GET" | "POST" | "PATCH",
    ): RouteHandler {
      const entry = createBotApp(parts).routes[path];
      const handler = typeof entry === "function" ? entry : method ? entry?.[method] : undefined;
      if (!handler) throw new Error(`no ${method} route for ${path}`);
      return handler;
    }

    function request(path: string, init: RequestInit = {}): BunRequest {
      return Object.assign(new Request(`http://bot.test${path}`, init), {
        params: { id: "abc.png" },
      }) as unknown as BunRequest;
    }

    test("every route turns the idle timeout off before awaiting its handler", async () => {
      const order: string[] = [];
      const mark = (name: string) => {
        order.push(name);
      };
      const parts = fakeParts({
        access: fakeAccess({
          admitOffer: async (input) => {
            mark("offer");
            return refusedOffer(input);
          },
          preflightOffer: async () => {
            mark("preflight");
            return new Response("{}");
          },
          resolveBearerCaller: async () => {
            mark("memories");
            return null;
          },
        }),
        ice: {
          browserPayload: async () => {
            mark("ice");
            return { iceServers: [] };
          },
        },
        signalling: {
          offer: async () => ({ status: 200, body: ANSWER }),
          patch: async () => {
            mark("patch");
            return { status: 200, body: {} };
          },
        },
        selfieResponse: () => {
          mark("selfie");
          return new Response(null, { status: 404 });
        },
        mcp: {
          handle: async () => {
            mark("mcp");
            return new Response("mcp");
          },
        },
      });
      const cases: [string, "GET" | "POST" | "PATCH" | undefined, string][] = [
        ["/api/ice-servers", "GET", "ice"],
        ["/api/offer", "POST", "offer"],
        ["/api/offer", "PATCH", "patch"],
        ["/api/offer/preflight", "POST", "preflight"],
        ["/api/memories", "GET", "memories"],
        ["/api/memories/forget", "POST", "memories"],
        ["/api/selfie/:id", "GET", "selfie"],
        ["/mcp", undefined, "mcp"],
        ["/mcp/", undefined, "mcp"],
      ];
      for (const [path, method, name] of cases) {
        order.length = 0;
        const init = method === "GET" ? {} : { method: method ?? "POST", body: "{}" };
        await routeOf(parts, path, method)(request(path, init), fakeServer(order));
        expect(`${path} ${order.join(", ")}`).toBe(`${path} timeout 0, ${name}`);
      }
    });

    test("preflights and HEAD's 405 answer before the timeout is touched", async () => {
      const order: string[] = [];
      const parts = fakeParts();
      await routeOf(parts, "/mcp")(
        request("/mcp", { method: "OPTIONS", headers: PREFLIGHT }),
        fakeServer(order),
      );
      const head = await routeOf(
        parts,
        "/api/ice-servers",
        "GET",
      )(request("/api/ice-servers", { method: "HEAD" }), fakeServer(order));
      expect(head.status).toBe(405);
      expect(order).toEqual([]);
    });

    test("the MCP route resolves the client IP from the socket peer", async () => {
      const seen: string[] = [];
      const parts = fakeParts({
        mcp: {
          handle: async (_request, clientIp) => {
            seen.push(clientIp);
            return new Response("mcp");
          },
        },
      });
      await routeOf(parts, "/mcp/")(request("/mcp/", { method: "POST" }), fakeServer([]));
      expect(seen).toEqual(["ip:203.0.113.9"]);
    });
  });
});
