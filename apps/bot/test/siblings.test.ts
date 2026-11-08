// The app with real sibling pieces: @eidolon/access's CORS layer and offer guard, and
// @eidolon/imagegen's selfie store. Expected headers are Starlette CORSMiddleware's, allow-all.
import { afterEach, describe, expect, test } from "bun:test";
import * as access from "@eidolon/access";
import * as imagegen from "@eidolon/imagegen";
import { type BotAccess, type BotAppParts, createBotApp } from "../src/app.ts";
import {
  captureLogs,
  fakeAccess,
  fakeParts,
  ORIGIN,
  refusedOffer,
  type Served,
  serve,
} from "./fakes.ts";

const POLICY: access.CorsPolicy = { allowOrigins: [] };

let served: Served | null = null;
afterEach(async () => {
  await served?.stop();
  served = null;
});

function start(overrides: Partial<BotAppParts> = {}): string {
  served = serve(createBotApp(fakeParts({ cors: POLICY, ...overrides })));
  return served.url;
}

function withRealCors(overrides: Partial<BotAccess> = {}): BotAccess {
  return fakeAccess({
    corsPreflightResponse: access.corsPreflightResponse,
    withCors: access.withCors,
    ...overrides,
  });
}

const PREFLIGHT_HEADERS = {
  vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network",
  "access-control-allow-methods": "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT, QUERY",
  "access-control-max-age": "600",
  "access-control-allow-credentials": "true",
  "access-control-allow-origin": ORIGIN,
  "content-type": "text/plain; charset=utf-8",
};

describe("with @eidolon/access CORS", () => {
  async function preflight(path: string, headers: Record<string, string>) {
    const response = await fetch(`${start({ access: withRealCors() })}${path}`, {
      method: "OPTIONS",
      headers: { Origin: ORIGIN, ...headers },
    });
    return { response, body: await response.text() };
  }

  function expectHeaders(response: Response, expected: Record<string, string | null>): void {
    for (const [name, value] of Object.entries(expected)) {
      expect(`${name}: ${response.headers.get(name)}`).toBe(`${name}: ${value}`);
    }
  }

  test("a preflight for the offer POST is Starlette's 200 OK", async () => {
    const { response, body } = await preflight("/api/offer", {
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    });
    expect(response.status).toBe(200);
    expect(body).toBe("OK");
    expectHeaders(response, {
      ...PREFLIGHT_HEADERS,
      "access-control-allow-headers": "content-type",
    });
  });

  test("PATCH and the forget POST with authorization pass their preflights", async () => {
    const patch = await preflight("/api/offer", {
      "Access-Control-Request-Method": "PATCH",
      "Access-Control-Request-Headers": "content-type",
    });
    expect(patch.response.status).toBe(200);
    const forget = await preflight("/api/memories/forget", {
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization",
    });
    expect(forget.response.status).toBe(200);
    expectHeaders(forget.response, { "access-control-allow-headers": "authorization" });
  });

  test("preflights are answered on the function route and on unknown paths", async () => {
    for (const path of ["/mcp", "/nope"]) {
      const { response, body } = await preflight(path, { "Access-Control-Request-Method": "GET" });
      expect(response.status).toBe(200);
      expect(body).toBe("OK");
      expectHeaders(response, { ...PREFLIGHT_HEADERS, "access-control-allow-headers": null });
    }
  });

  test("a private-network preflight is refused", async () => {
    const { response, body } = await preflight("/api/offer", {
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Private-Network": "true",
    });
    expect(response.status).toBe(400);
    expect(body).toBe("Disallowed CORS private-network");
    expectHeaders(response, PREFLIGHT_HEADERS);
  });

  test("a simple response echoes Origin with credentials, and varies on Origin either way", async () => {
    const url = start({ access: withRealCors() });
    const withOrigin = await fetch(`${url}/api/ice-servers`, { headers: { Origin: ORIGIN } });
    expectHeaders(withOrigin, {
      "access-control-allow-origin": ORIGIN,
      "access-control-allow-credentials": "true",
      vary: "Origin",
    });
    const without = await fetch(`${url}/api/ice-servers`);
    expectHeaders(without, {
      "access-control-allow-origin": null,
      "access-control-allow-credentials": null,
      vary: "Origin",
    });
  });

  test("the offer 429 keeps Retry-After and gains CORS, so the browser can read it", async () => {
    const url = start({
      access: withRealCors({ admitOffer: async (input) => refusedOffer(input) }),
    });
    const response = await fetch(`${url}/api/offer`, {
      method: "POST",
      headers: { Origin: ORIGIN },
      body: "{}",
    });
    expect(response.status).toBe(429);
    expectHeaders(response, {
      "retry-after": "3412",
      "access-control-allow-origin": ORIGIN,
      "access-control-allow-credentials": "true",
    });
    expect(await response.text()).toBe(
      '{"error": "匿名用户每小时通话次数已达上限，请登录后再试", "retry_after": 3412}',
    );
  });

  test("404s, 405s and 500s carry CORS too", async () => {
    const logs = captureLogs();
    try {
      const url = start({
        access: withRealCors(),
        ice: {
          browserPayload: async () => {
            throw new Error("boom");
          },
        },
      });
      for (const [method, path, status] of [
        ["GET", "/", 404],
        ["GET", "/nope", 404],
        ["PUT", "/api/offer", 405],
        ["GET", "/api/ice-servers", 500],
      ] as const) {
        const response = await fetch(`${url}${path}`, { method, headers: { Origin: ORIGIN } });
        expect(response.status).toBe(status);
        expectHeaders(response, {
          "access-control-allow-origin": ORIGIN,
          "access-control-allow-credentials": "true",
        });
      }
    } finally {
      logs.restore();
    }
  });
});

describe("with the @eidolon/access offer guard", () => {
  const REAL_IP_HEADER = process.env.EIDOLON_REAL_IP_HEADER;
  afterEach(() => {
    if (REAL_IP_HEADER === undefined) delete process.env.EIDOLON_REAL_IP_HEADER;
    else process.env.EIDOLON_REAL_IP_HEADER = REAL_IP_HEADER;
  });

  test("offer and preflight share one anonymous quota: junk spends it, preflight only peeks", async () => {
    // A header of its own gives this test a fresh bucket in the process-wide quota.
    process.env.EIDOLON_REAL_IP_HEADER = "x-test-client-ip";
    const headers = { "x-test-client-ip": "198.51.100.77", Origin: ORIGIN };
    const max = access.anonOfferQuota().maxPerWindow;
    const admitted: access.OfferAdmission[] = [];
    const logs = captureLogs();
    try {
      const url = start({
        access,
        signalling: {
          offer: async (admission) => {
            admitted.push(admission);
            return {
              status: 400,
              body: { detail: "Invalid WebRTC request: expected a JSON object" },
            };
          },
          patch: async () => ({ status: 200, body: {} }),
        },
      });
      const post = async (path: string) => {
        const response = await fetch(`${url}${path}`, {
          method: "POST",
          headers,
          body: "not json",
        });
        return { response, body: await response.text() };
      };
      for (let i = 0; i < 2; i++) {
        const { response, body } = await post("/api/offer/preflight");
        expect(response.status).toBe(200);
        expect(body).toBe(`{"ok":true,"anonymous":true,"remaining":${max}}`);
      }
      for (let i = 0; i < max; i++) {
        expect((await post("/api/offer")).response.status).toBe(400);
      }
      expect(admitted.map((admission) => [admission.clientIp, admission.allowed])).toEqual(
        Array.from({ length: max }, () => ["198.51.100.77", true]),
      );

      const refused = await post("/api/offer");
      expect(refused.response.status).toBe(429);
      expect(refused.response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(refused.response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      const retry = refused.response.headers.get("retry-after");
      expect(Number(retry)).toBeGreaterThanOrEqual(1);
      expect(refused.body).toBe(
        `{"error": "匿名用户每小时通话次数已达上限，请登录后再试", "retry_after": ${retry}}`,
      );

      const peeked = await post("/api/offer/preflight");
      expect(peeked.response.status).toBe(429);
      expect(peeked.response.headers.get("retry-after")).toBe(retry);
      expect(peeked.body).toBe(
        `{"ok":false,"anonymous":true,"error":"匿名用户每小时通话次数已达上限，请登录后再试","retry_after":${retry}}`,
      );
      expect(admitted).toHaveLength(max);
    } finally {
      logs.restore();
    }
  });
});

describe("with the @eidolon/imagegen selfie store", () => {
  test("a published selfie is served under any suffix until it is gone", async () => {
    const store = new imagegen.SelfieStore();
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const path = store.publish({ data, mediaType: "image/png" }, 600);
    expect(path).toMatch(/^\/api\/selfie\/[A-Za-z0-9_-]{22}\.png$/);
    const url = start({ selfieResponse: (segment) => imagegen.selfieResponse(segment, store) });
    const id = path.slice("/api/selfie/".length, -".png".length);
    for (const segment of [`${id}.png`, id, `${id}.jpg`]) {
      const response = await fetch(`${url}/api/selfie/${segment}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(data);
    }
    const missing = await fetch(`${url}/api/selfie/v-sFAsHadyrW6qUtt4GrHA.png`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("");
    expect(missing.headers.get("content-type")).toBeNull();
    const head = await fetch(`${url}${path}`, { method: "HEAD" });
    expect(head.status).toBe(405);
  });
});
