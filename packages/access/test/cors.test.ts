import { afterEach, describe, expect, test } from "bun:test";
import {
  ANONYMOUS,
  admitOffer,
  CORS_ALLOWED_METHODS,
  type CorsPolicy,
  corsPolicyFromEnv,
  corsPreflightResponse,
  SlidingWindowQuota,
  withCors,
} from "../src/index.ts";
import { EnvPatch, LogCapture } from "./helpers.ts";

// Every expected status, body and header set below was recorded from Starlette's CORSMiddleware
// configured as the Pipecat runner configures it, wrapped around the real offer middleware.
const ALL: CorsPolicy = { allowOrigins: [] };
const LISTED: CorsPolicy = { allowOrigins: ["https://laplace.live"] };
const LAPLACE = "https://laplace.live";

const PREFLIGHT_HEADERS = {
  vary:
    "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, " +
    "Access-Control-Request-Private-Network",
  "access-control-allow-methods": "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT, QUERY",
  "access-control-max-age": "600",
  "access-control-allow-credentials": "true",
  "content-type": "text/plain; charset=utf-8",
};

function preflight(path: string, headers: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, { method: "OPTIONS", headers });
}

async function dump(response: Response | null) {
  if (response === null) throw new Error("expected a preflight response");
  return {
    status: response.status,
    body: await response.text(),
    headers: Object.fromEntries(response.headers),
  };
}

// The stand-in /api/offer answer the oracle's app returned.
function answer(): Response {
  return new Response('{"sdp":"answer","type":"answer","pc_id":"pc"}', {
    headers: { "content-type": "application/json" },
  });
}

function post(origin?: string): Request {
  const headers: Record<string, string> = origin === undefined ? {} : { origin };
  return new Request("http://localhost/api/offer", { method: "POST", headers, body: "{}" });
}

describe("corsPreflightResponse, every origin allowed", () => {
  test("mirrors the origin and the requested headers", async () => {
    const request = preflight("/api/offer", {
      origin: LAPLACE,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-custom",
    });
    expect(await dump(corsPreflightResponse(request, ALL))).toEqual({
      status: 200,
      body: "OK",
      headers: {
        ...PREFLIGHT_HEADERS,
        "access-control-allow-origin": LAPLACE,
        "access-control-allow-headers": "content-type,x-custom",
      },
    });
  });

  test("answers on any path, and omits allow-headers when none were requested", async () => {
    const request = preflight("/nope", { origin: LAPLACE, "access-control-request-method": "GET" });
    expect(await dump(corsPreflightResponse(request, ALL))).toEqual({
      status: 200,
      body: "OK",
      headers: { ...PREFLIGHT_HEADERS, "access-control-allow-origin": LAPLACE },
    });
  });

  test("refuses private-network access", async () => {
    const request = preflight("/api/offer", {
      origin: LAPLACE,
      "access-control-request-method": "POST",
      "access-control-request-private-network": "true",
    });
    expect(await dump(corsPreflightResponse(request, ALL))).toEqual({
      status: 400,
      body: "Disallowed CORS private-network",
      headers: { ...PREFLIGHT_HEADERS, "access-control-allow-origin": LAPLACE },
    });
  });

  test("method names are case-sensitive", async () => {
    const request = preflight("/api/offer", {
      origin: LAPLACE,
      "access-control-request-method": "post",
    });
    expect(await dump(corsPreflightResponse(request, ALL))).toEqual({
      status: 400,
      body: "Disallowed CORS method",
      headers: { ...PREFLIGHT_HEADERS, "access-control-allow-origin": LAPLACE },
    });
  });

  test("an empty Origin is still an origin", async () => {
    const request = preflight("/api/offer", {
      origin: "",
      "access-control-request-method": "POST",
    });
    expect(await dump(corsPreflightResponse(request, ALL))).toEqual({
      status: 200,
      body: "OK",
      headers: { ...PREFLIGHT_HEADERS, "access-control-allow-origin": "" },
    });
  });

  test('"*" among listed origins allows every origin', async () => {
    const star: CorsPolicy = { allowOrigins: ["https://a.example", "*"] };
    const request = preflight("/x", {
      origin: "https://b.example",
      "access-control-request-method": "PUT",
    });
    expect(await dump(corsPreflightResponse(request, star))).toEqual({
      status: 200,
      body: "OK",
      headers: { ...PREFLIGHT_HEADERS, "access-control-allow-origin": "https://b.example" },
    });
  });

  test("anything else is not a preflight", () => {
    const cases = [
      preflight("/api/offer", { origin: LAPLACE }),
      preflight("/api/offer", { "access-control-request-method": "POST" }),
      new Request("http://localhost/api/offer", {
        method: "POST",
        headers: { origin: LAPLACE, "access-control-request-method": "POST" },
      }),
      new Request("http://localhost/api/offer"),
    ];
    for (const request of cases) expect(corsPreflightResponse(request, ALL)).toBeNull();
  });

  test("allows Starlette's ALL_METHODS", () => {
    expect(CORS_ALLOWED_METHODS).toEqual([
      "DELETE",
      "GET",
      "HEAD",
      "OPTIONS",
      "PATCH",
      "POST",
      "PUT",
      "QUERY",
    ]);
    for (const method of CORS_ALLOWED_METHODS) {
      const request = preflight("/", { origin: LAPLACE, "access-control-request-method": method });
      expect(corsPreflightResponse(request, ALL)?.status).toBe(200);
    }
  });
});

describe("corsPreflightResponse, an allowlist", () => {
  test("an allowed origin", async () => {
    const request = preflight("/api/offer", {
      origin: LAPLACE,
      "access-control-request-method": "POST",
    });
    expect(await dump(corsPreflightResponse(request, LISTED))).toEqual({
      status: 200,
      body: "OK",
      headers: { ...PREFLIGHT_HEADERS, "access-control-allow-origin": LAPLACE },
    });
  });

  test("another origin, or the same one in another case, is refused without allow-origin", async () => {
    for (const origin of ["https://evil.example", "https://LAPLACE.live"]) {
      const request = preflight("/api/offer", { origin, "access-control-request-method": "POST" });
      expect(await dump(corsPreflightResponse(request, LISTED))).toEqual({
        status: 400,
        body: "Disallowed CORS origin",
        headers: PREFLIGHT_HEADERS,
      });
    }
  });

  test("failures are listed in Starlette's order", async () => {
    const request = preflight("/api/offer", {
      origin: "https://evil.example",
      "access-control-request-method": "TRACE",
      "access-control-request-private-network": "true",
      "access-control-request-headers": "x-a",
    });
    expect(await dump(corsPreflightResponse(request, LISTED))).toEqual({
      status: 400,
      body: "Disallowed CORS origin, method, private-network",
      headers: { ...PREFLIGHT_HEADERS, "access-control-allow-headers": "x-a" },
    });
  });
});

describe("withCors", () => {
  test("every origin: the request's origin is echoed with credentials", async () => {
    expect(await dump(withCors(post(LAPLACE), answer(), ALL))).toEqual({
      status: 200,
      body: '{"sdp":"answer","type":"answer","pc_id":"pc"}',
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": LAPLACE,
        "access-control-allow-credentials": "true",
        vary: "Origin",
      },
    });
  });

  test("no Origin: only Vary", async () => {
    expect((await dump(withCors(post(), answer(), ALL))).headers).toEqual({
      "content-type": "application/json",
      vary: "Origin",
    });
  });

  test("an empty Origin is echoed as empty", async () => {
    expect((await dump(withCors(post(""), answer(), ALL))).headers).toEqual({
      "content-type": "application/json",
      "access-control-allow-origin": "",
      "access-control-allow-credentials": "true",
      vary: "Origin",
    });
  });

  test("an error status is decorated the same way", async () => {
    const notFound = new Response('{"detail":"Not Found"}', {
      status: 404,
      headers: { "content-type": "application/json" },
    });
    const got = await dump(withCors(post(LAPLACE), notFound, ALL));
    expect(got.status).toBe(404);
    expect(got.headers["access-control-allow-origin"]).toBe(LAPLACE);
    expect(got.headers.vary).toBe("Origin");
  });

  test("the allowlist echoes only allowed origins; credentials go to every origin", async () => {
    expect((await dump(withCors(post("https://evil.example"), answer(), LISTED))).headers).toEqual({
      "content-type": "application/json",
      "access-control-allow-credentials": "true",
      vary: "Origin",
    });
    expect((await dump(withCors(post(LAPLACE), answer(), LISTED))).headers).toEqual({
      "content-type": "application/json",
      "access-control-allow-credentials": "true",
      "access-control-allow-origin": LAPLACE,
      vary: "Origin",
    });
    expect((await dump(withCors(post(), answer(), LISTED))).headers).toEqual({
      "content-type": "application/json",
      vary: "Origin",
    });
  });

  test('"*" among listed origins echoes any origin', async () => {
    const star: CorsPolicy = { allowOrigins: ["https://a.example", "*"] };
    const headers = (await dump(withCors(post("https://b.example"), answer(), star))).headers;
    expect(headers["access-control-allow-origin"]).toBe("https://b.example");
  });

  test("an existing Vary is appended to, and an app's own allow-origin survives a refusal", async () => {
    const own = () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          vary: "Accept-Encoding",
          "access-control-allow-origin": "https://pre.example",
        },
      });
    const get = (origin?: string) =>
      new Request("http://localhost/vary", { headers: origin === undefined ? {} : { origin } });
    expect((await dump(withCors(get("https://evil.example"), own(), LISTED))).headers).toEqual({
      vary: "Accept-Encoding, Origin",
      "access-control-allow-origin": "https://pre.example",
      "content-type": "application/json",
      "access-control-allow-credentials": "true",
    });
    expect((await dump(withCors(get(LAPLACE), own(), LISTED))).headers).toEqual({
      vary: "Accept-Encoding, Origin",
      "access-control-allow-origin": LAPLACE,
      "content-type": "application/json",
      "access-control-allow-credentials": "true",
    });
    expect((await dump(withCors(get(), own(), LISTED))).headers).toEqual({
      vary: "Accept-Encoding, Origin",
      "access-control-allow-origin": "https://pre.example",
      "content-type": "application/json",
    });
  });

  test("returns a new Response with the status, status text and body intact", async () => {
    const original = new Response("teapot", {
      status: 418,
      statusText: "I'm a teapot",
      headers: { "x-extra": "1" },
    });
    const decorated = withCors(post(LAPLACE), original, ALL);
    expect(decorated).not.toBe(original);
    expect(decorated.status).toBe(418);
    expect(decorated.statusText).toBe("I'm a teapot");
    expect(decorated.headers.get("x-extra")).toBe("1");
    expect(original.headers.get("vary")).toBeNull();
    expect(await decorated.text()).toBe("teapot");
  });

  test("the offer guard's 429 carries CORS, and a disallowed origin still gets its 429", async () => {
    const logs = new LogCapture();
    const refusal = async () => {
      const admission = await admitOffer(
        { bodyText: "{}", clientIp: "198.51.100.9" },
        { quota: new SlidingWindowQuota(0, 3600), resolveUser: async () => ANONYMOUS },
      );
      if (admission.allowed) throw new Error("expected a refusal");
      return admission.response;
    };
    const body = '{"error": "匿名用户每小时通话次数已达上限，请登录后再试", "retry_after": 3600}';
    try {
      expect(await dump(withCors(post(LAPLACE), await refusal(), ALL))).toEqual({
        status: 429,
        body,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "retry-after": "3600",
          "access-control-allow-origin": LAPLACE,
          "access-control-allow-credentials": "true",
          vary: "Origin",
        },
      });
      expect(await dump(withCors(post("https://evil.example"), await refusal(), LISTED))).toEqual({
        status: 429,
        body,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "retry-after": "3600",
          "access-control-allow-credentials": "true",
          vary: "Origin",
        },
      });
    } finally {
      logs.restore();
    }
  });
});

describe("corsPolicyFromEnv", () => {
  const env = new EnvPatch();
  afterEach(() => env.restore());

  // Each row is what the Pipecat runner parsed from PIPECAT_ALLOWED_ORIGINS.
  const rows: [string | undefined, string[]][] = [
    [undefined, []],
    ["", []],
    [" https://a.example , ,https://b.example ", ["https://a.example", "https://b.example"]],
    ["*", ["*"]],
    [" https://c.example　", ["https://c.example"]],
    [",", []],
  ];

  test.each(rows)("%p", (raw, origins) => {
    env.set("PIPECAT_ALLOWED_ORIGINS", raw);
    expect(corsPolicyFromEnv().allowOrigins).toEqual(origins);
  });

  test("is read on every call", () => {
    env.set("PIPECAT_ALLOWED_ORIGINS", "https://a.example");
    const first = corsPolicyFromEnv();
    env.set("PIPECAT_ALLOWED_ORIGINS", "https://b.example");
    expect(first.allowOrigins).toEqual(["https://a.example"]);
    expect(corsPolicyFromEnv().allowOrigins).toEqual(["https://b.example"]);
    expect(Object.isFrozen(first.allowOrigins)).toBe(true);
  });
});
