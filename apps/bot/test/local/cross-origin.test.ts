// EIDOLON_LOCAL_ALLOWED_ORIGINS: a listed site's pages call the bot's API as a deployment serves
// it, with CORS headers, while /api/local and the local viewer stay the app's own pages'.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LOCAL_VIEWER_MID } from "@eidolon/context";
import type { MemoryAdmin } from "@eidolon/memory";
import { PROOF_HEADER as PROOF } from "../../src/local/api.ts";
import { listedOrigin, parseListedOrigins } from "../../src/local/guard.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import { type Booted, bootFixture, cleanUpBoot, type RawResponse, raw } from "./harness.ts";

const SITE = "http://localhost:3000";
const OFFER = '{"sdp":"v=0","type":"offer","requestData":{"audioQuality":"low"}}';

let booted: Booted;
let logs: CapturedLogs;
let memoryCalls = 0;

beforeAll(async () => {
  logs = captureLogs();
  process.env.EIDOLON_LOCAL_ALLOWED_ORIGINS = `${SITE}, https://laplace.live/, null, localhost:5173`;
  try {
    booted = await bootFixture();
  } finally {
    delete process.env.EIDOLON_LOCAL_ALLOWED_ORIGINS;
  }
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

function send(
  method: string,
  path: string,
  headers: Record<string, string | undefined>,
  body?: string,
): Promise<RawResponse> {
  const lines = [`${method} ${path} HTTP/1.1`];
  const all: Record<string, string | undefined> = {
    Host: `localhost:${booted.port}`,
    "Content-Type": body === undefined ? undefined : "application/json",
    "Content-Length": body === undefined ? undefined : String(Buffer.byteLength(body)),
    ...headers,
  };
  for (const [name, value] of Object.entries(all))
    if (value !== undefined) lines.push(`${name}: ${value}`);
  return raw(booted.port, lines.join("\n"), body ?? "");
}

/** What a page on `origin` sends: the browser adds Eidolon's cookie, since cookies ignore ports. */
function from(origin: string, site = "same-site"): Record<string, string> {
  return { Origin: origin, "Sec-Fetch-Site": site, Cookie: booted.cookie };
}

function cors(response: RawResponse): [string | undefined, string | undefined] {
  return [
    response.headers.get("access-control-allow-origin"),
    response.headers.get("access-control-allow-credentials"),
  ];
}

function expectNoCors(response: RawResponse, label: string): void {
  const names = [...response.headers.keys()].filter((name) => name.startsWith("access-control-"));
  expect([label, names]).toEqual([label, []]);
}

test("the list keeps each entry's origin and warns about one that names none", () => {
  const parsed = parseListedOrigins(" http://LOCALHOST:3000/ai ,, https://laplace.live/, null, *");
  expect([...parsed.origins]).toEqual(["http://localhost:3000", "https://laplace.live"]);
  expect(parsed.rejected).toEqual(["null", "*"]);
  expect(parseListedOrigins(undefined).origins.size).toBe(0);
  const warnings = logs.lines().filter((line) => line.startsWith("WARNING"));
  expect(warnings.filter((line) => line.includes("EIDOLON_LOCAL_ALLOWED_ORIGINS"))).toEqual([
    "WARNING EIDOLON_LOCAL_ALLOWED_ORIGINS: 'null' is not an origin such as http://localhost:3000; ignoring it",
    "WARNING EIDOLON_LOCAL_ALLOWED_ORIGINS: 'localhost:5173' is not an origin such as http://localhost:3000; ignoring it",
  ]);
});

test("the app's own origin stays its own, listed or not", () => {
  const own = "http://localhost:7860";
  const request = new Request(`${own}/api/offer`, {
    headers: { Host: "localhost:7860", Origin: own },
  });
  expect(listedOrigin(request, new Set([own]))).toBeNull();
  const site = new Request(`${own}/api/offer`, {
    headers: { Host: "localhost:7860", Origin: SITE },
  });
  expect(listedOrigin(site, new Set([SITE]))).toBe(SITE);
});

describe("a listed origin", () => {
  test("reads the bot's public routes with CORS headers, from another port or another site", async () => {
    for (const [origin, site] of [
      [SITE, "same-site"],
      ["https://laplace.live", "cross-site"],
    ] as const) {
      const response = await send("GET", "/api/ice-servers", from(origin, site));
      expect([origin, response.status, ...cors(response)]).toEqual([origin, 200, origin, "true"]);
      expect(response.headers.get("vary")).toContain("Origin");
    }
    const mcp = await send("POST", "/mcp", from(SITE), "{}");
    expect([mcp.status, mcp.body, ...cors(mcp)]).toEqual([200, "mcp", SITE, "true"]);
    const unknown = await send("GET", "/api/nope", from(SITE));
    expect([unknown.status, ...cors(unknown)]).toEqual([404, SITE, "true"]);
  });

  test("gets its preflight answered on the bot's routes only", async () => {
    for (const path of ["/api/offer", "/api/memories", "/mcp"]) {
      const response = await send("OPTIONS", path, {
        ...from(SITE),
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, authorization",
      });
      expect([path, response.status, response.headers.get("access-control-allow-origin")]).toEqual([
        path,
        200,
        SITE,
      ]);
      expect(response.headers.get("access-control-allow-headers")).toBe(
        "content-type, authorization",
      );
    }
    for (const [path, origin] of [
      ["/api/local/status", SITE],
      ["/api/offer", "http://localhost:3001"],
      ["/api/offer", "null"],
    ] as const) {
      const response = await send("OPTIONS", path, {
        ...from(origin),
        "Access-Control-Request-Method": "POST",
      });
      expect([path, origin, response.status]).toEqual([path, origin, 405]);
      expectNoCors(response, `${path} ${origin}`);
    }
  });

  test("offers as a stranger would on a deployment, through the anonymous quota", async () => {
    const admitted = booted.fakes.admitted.length;
    const response = await send(
      "POST",
      "/api/offer",
      { ...from(SITE), [PROOF]: booted.proof },
      OFFER,
    );
    expect([response.status, ...cors(response)]).toEqual([200, SITE, "true"]);
    expect(booted.fakes.admitted).toHaveLength(admitted + 1);
    const admission = booted.fakes.offers.at(-1)?.admission;
    expect([admission?.user.isLoggedIn, admission?.quota === null]).toEqual([false, false]);
    const patch = await send("PATCH", "/api/offer", from(SITE), "{}");
    expect([patch.status, ...cors(patch)]).toEqual([200, SITE, "true"]);
  });

  test("never reaches the local viewer's memories, even carrying the session", async () => {
    const calls = memoryCalls;
    const session = { ...from(SITE), [PROOF]: booted.proof };
    const listed = await send("GET", "/api/memories", session);
    const forgot = await send("POST", "/api/memories/forget", session, "{}");
    expect([listed.status, ...cors(listed)]).toEqual([401, SITE, "true"]);
    expect([forgot.status, ...cors(forgot)]).toEqual([401, SITE, "true"]);
    expect(memoryCalls).toBe(calls);
  });

  test("is refused /api/local, signed in or not, with no CORS header", async () => {
    for (const path of ["/api/local/status", "/api/offer/../local/status"]) {
      const response = await send("GET", path, { ...from(SITE), [PROOF]: booted.proof });
      expect([path, response.status]).toEqual([path, 403]);
      expectNoCors(response, path);
    }
  });
});

describe("everyone else", () => {
  test("another origin is still 403 on the API, with no CORS header", async () => {
    for (const origin of ["http://localhost:3001", "null", "http://localhost:5173"]) {
      const response = await send("GET", "/api/ice-servers", from(origin));
      expect([origin, response.status]).toEqual([origin, 403]);
      expectNoCors(response, origin);
    }
  });

  test("the app's own pages still offer as the local viewer", async () => {
    const admitted = booted.fakes.admitted.length;
    const own = `http://localhost:${booted.port}`;
    const response = await send(
      "POST",
      "/api/offer",
      { ...from(own, "same-origin"), [PROOF]: booted.proof },
      OFFER,
    );
    expect(response.status).toBe(200);
    expectNoCors(response, "own page");
    expect(booted.fakes.admitted).toHaveLength(admitted);
    expect(booted.fakes.offers.at(-1)?.admission.user.mid).toBe(LOCAL_VIEWER_MID);
  });

  test("an <img> of a selfie loads from any page; the rest of the API still needs its own", async () => {
    const img = { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Dest": "image" };
    const selfie = await send("GET", "/api/selfie/abc.png", img);
    expect(selfie.status).toBe(404);
    expectNoCors(selfie, "selfie");
    const ice = await send("GET", "/api/ice-servers", img);
    expect(ice.status).toBe(403);
  });
});
