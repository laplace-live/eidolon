import { describe, expect, test } from "bun:test";
import { cloudflareTurnKeyFromEnv, mintCloudflareIce } from "../src/index.ts";
import { blockNetwork, captureLogs, fakeFetch, lines, useEnv } from "./support.ts";

const KEY = { keyId: "0123abcd", apiToken: "SECRET-TOKEN" };
const URL_ =
  "https://rtc.live.cloudflare.com/v1/turn/keys/0123abcd/credentials/generate-ice-servers";
const PAYLOAD = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    {
      urls: ["turn:turn.cloudflare.com:3478?transport=tcp"],
      username: "USER-NAME",
      credential: "SECRET-CREDENTIAL",
    },
  ],
};
const PREFIX = "WARNING [WebRTC] Cloudflare TURN mint failed: ";

blockNetwork();
const logs = captureLogs();
const setEnv = useEnv();

describe("cloudflareTurnKeyFromEnv", () => {
  test("needs both the key id and the token, and reads empty as unset", () => {
    setEnv("CLOUDFLARE_TURN_KEY_ID", undefined);
    setEnv("CLOUDFLARE_TURN_KEY_API_TOKEN", "tok");
    expect(cloudflareTurnKeyFromEnv()).toBeNull();
    setEnv("CLOUDFLARE_TURN_KEY_ID", "");
    expect(cloudflareTurnKeyFromEnv()).toBeNull();
    setEnv("CLOUDFLARE_TURN_KEY_ID", "id");
    setEnv("CLOUDFLARE_TURN_KEY_API_TOKEN", "");
    expect(cloudflareTurnKeyFromEnv()).toBeNull();
    setEnv("CLOUDFLARE_TURN_KEY_API_TOKEN", "tok");
    expect(cloudflareTurnKeyFromEnv()).toEqual({ keyId: "id", apiToken: "tok" });
  });
});

describe("mintCloudflareIce", () => {
  test("POSTs the TTL with a bearer token and a timeout signal, following no redirect", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json(PAYLOAD, { status: 201 }));
    await mintCloudflareIce(KEY, 3600, { fetch });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [(typeof calls)[0]];
    expect(url).toBe(URL_);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer SECRET-TOKEN",
      "Content-Type": "application/json",
    });
    expect(init.body).toBe('{"ttl":3600}');
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("sends zero and negative TTLs as they are", async () => {
    const { fetch, calls } = fakeFetch(() => Response.json(PAYLOAD, { status: 201 }));
    await mintCloudflareIce(KEY, 0, { fetch });
    await mintCloudflareIce(KEY, -5, { fetch });
    expect(calls.map((c) => c.init.body)).toEqual(['{"ttl":0}', '{"ttl":-5}']);
  });

  test("returns the parsed object itself, unmodified", async () => {
    const payload = structuredClone(PAYLOAD);
    const { fetch } = fakeFetch(() => {
      const response = new Response("", { status: 201 });
      response.json = async () => payload;
      return response;
    });
    expect(await mintCloudflareIce(KEY, 3600, { fetch })).toBe(payload);
    expect(payload).toEqual(PAYLOAD);
    expect(logs).toEqual([]);
  });

  test("any 2xx with a JSON object succeeds", async () => {
    const { fetch } = fakeFetch(() => Response.json({ iceServers: [] }, { status: 200 }));
    expect(await mintCloudflareIce(KEY, 3600, { fetch })).toEqual({ iceServers: [] });
  });

  test("an HTTP error logs httpx's wording and returns null", async () => {
    const answers = [
      new Response("denied", { status: 401, statusText: "Unauthorized" }),
      new Response("boom", { status: 500, statusText: "Internal Server Error" }),
      new Response(null, { status: 302, statusText: "Found", headers: { location: "/x" } }),
      new Response(null, { status: 304, statusText: "Not Modified" }),
    ];
    for (const answer of answers) {
      const { fetch } = fakeFetch(() => answer);
      expect(await mintCloudflareIce(KEY, 3600, { fetch })).toBeNull();
    }
    const doc =
      "For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status";
    expect(lines(logs)).toEqual([
      `${PREFIX}Client error '401 Unauthorized' for url '${URL_}'\n${doc}/401`,
      `${PREFIX}Server error '500 Internal Server Error' for url '${URL_}'\n${doc}/500`,
      `${PREFIX}Redirect response '302 Found' for url '${URL_}'\nRedirect location: '/x'\n${doc}/302`,
      `${PREFIX}Redirect response '304 Not Modified' for url '${URL_}'\n${doc}/304`,
    ]);
  });

  test("a body that is not a JSON object fails", async () => {
    const bodies = ["not json", "", "[1, 2]", "null", '"text"', "42"];
    for (const body of bodies) {
      const { fetch } = fakeFetch(
        () => new Response(body, { status: 201, headers: { "Content-Type": "application/json" } }),
      );
      expect(await mintCloudflareIce(KEY, 3600, { fetch })).toBeNull();
    }
    const got = lines(logs);
    expect(got).toHaveLength(bodies.length);
    expect(got.every((line) => line.startsWith(PREFIX))).toBe(true);
    expect(got.slice(2)).toEqual([
      `${PREFIX}expected a JSON object, got array`,
      `${PREFIX}expected a JSON object, got null`,
      `${PREFIX}expected a JSON object, got string`,
      `${PREFIX}expected a JSON object, got number`,
    ]);
  });

  test("a fetch that rejects or throws is a failed mint, never a rejection", async () => {
    const rejecting = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const throwing = (() => {
      throw new Error("sync boom");
    }) as unknown as typeof fetch;
    expect(await mintCloudflareIce(KEY, 3600, { fetch: rejecting })).toBeNull();
    expect(await mintCloudflareIce(KEY, 3600, { fetch: throwing })).toBeNull();
    expect(lines(logs)).toEqual([`${PREFIX}TypeError: fetch failed`, `${PREFIX}Error: sync boom`]);
  });

  test("times out through the abort signal", async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const started = performance.now();
    expect(await mintCloudflareIce(KEY, 3600, { fetch: hanging, timeoutMs: 20 })).toBeNull();
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
    expect(lines(logs)).toEqual([`${PREFIX}TimeoutError: The operation timed out.`]);
  });

  test("a body that stalls past the timeout fails too", async () => {
    const { fetch } = fakeFetch(({ init }) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"iceServers":'));
          init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body, { status: 201 });
    });
    expect(await mintCloudflareIce(KEY, 3600, { fetch, timeoutMs: 20 })).toBeNull();
    expect(lines(logs)).toEqual([`${PREFIX}TimeoutError: The operation timed out.`]);
  });

  test("never logs the token or the credential", async () => {
    const answers = [
      () => Response.json(PAYLOAD, { status: 201 }),
      () => new Response("denied", { status: 403, statusText: "Forbidden" }),
      () => Response.json([PAYLOAD], { status: 201 }),
      () => new Response(JSON.stringify(PAYLOAD).slice(0, -3), { status: 201 }),
    ];
    for (const answer of answers)
      await mintCloudflareIce(KEY, 3600, { fetch: fakeFetch(answer).fetch });
    expect(logs.length).toBeGreaterThan(0);
    for (const line of lines(logs)) {
      expect(line).not.toContain("SECRET-TOKEN");
      expect(line).not.toContain("SECRET-CREDENTIAL");
    }
  });
});
