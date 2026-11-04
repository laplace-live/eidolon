import { beforeEach, describe, expect, test } from "bun:test";
import { createIceService, type IcePayload, iceServiceFromEnv } from "../src/index.ts";
import { blockNetwork, captureLogs, fakeFetch, lines, NETWORK_BLOCKED, useEnv } from "./support.ts";

const ENV_NAMES = [
  "CLOUDFLARE_TURN_KEY_ID",
  "CLOUDFLARE_TURN_KEY_API_TOKEN",
  "CLOUDFLARE_TURN_TTL_SEC",
  "WEBRTC_STUN_URL",
  "WEBRTC_TURN_URL",
  "WEBRTC_TURN_USERNAME",
  "WEBRTC_TURN_CREDENTIAL",
];
const CF_PAYLOAD = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
      ],
      username: "user",
      credential: "cred",
    },
  ],
};
blockNetwork();
const logs = captureLogs();
const setEnv = useEnv();
beforeEach(() => {
  for (const name of ENV_NAMES) setEnv(name, undefined);
});

describe("iceServiceFromEnv", () => {
  test("reads the env once, when called", async () => {
    setEnv("CLOUDFLARE_TURN_KEY_ID", "key-1");
    setEnv("CLOUDFLARE_TURN_KEY_API_TOKEN", "token-1");
    setEnv("CLOUDFLARE_TURN_TTL_SEC", "600");
    setEnv("WEBRTC_STUN_URL", "stun:first");
    const { fetch, calls } = fakeFetch(() => new Response("", { status: 500 }));
    const ice = iceServiceFromEnv({ fetch });
    setEnv("CLOUDFLARE_TURN_KEY_ID", "key-2");
    setEnv("CLOUDFLARE_TURN_KEY_API_TOKEN", "token-2");
    setEnv("CLOUDFLARE_TURN_TTL_SEC", "900");
    setEnv("WEBRTC_STUN_URL", "stun:second");
    expect(await ice.browserPayload()).toEqual({ iceServers: [{ urls: ["stun:first"] }] });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [(typeof calls)[0]];
    expect(url).toContain("/keys/key-1/");
    expect(init.headers).toMatchObject({ Authorization: "Bearer token-1" });
    expect(init.body).toBe('{"ttl":600}');
  });

  test("the browser payload and the bot's plan share one credential mint", async () => {
    setEnv("CLOUDFLARE_TURN_KEY_ID", "key");
    setEnv("CLOUDFLARE_TURN_KEY_API_TOKEN", "token");
    setEnv("WEBRTC_STUN_URL", "stun:ignored");
    let clock = 100;
    const { fetch, calls } = fakeFetch(() => Response.json(CF_PAYLOAD, { status: 201 }));
    const ice = iceServiceFromEnv({ fetch, now: () => clock });
    expect(await ice.browserPayload()).toEqual(CF_PAYLOAD);
    clock = 3399;
    expect(await ice.serverPlan()).toEqual({
      iceServers: [
        {
          urls: "turn:turn.cloudflare.com:3478?transport=tcp",
          username: "user",
          credential: "cred",
        },
      ],
      relayOnly: true,
      turnUrl: "turn:turn.cloudflare.com:3478?transport=tcp",
    });
    expect(calls).toHaveLength(1);
    clock = 3400;
    await ice.serverPlan();
    expect(calls).toHaveLength(2);
    expect(lines(logs)).toEqual([
      "INFO [WebRTC] Minted fresh Cloudflare TURN credentials (TTL 3600s, refresh in 3300s)",
      "INFO [WebRTC] Minted fresh Cloudflare TURN credentials (TTL 3600s, refresh in 3300s)",
    ]);
  });

  test("without a Cloudflare key it never fetches and serves the static env", async () => {
    setEnv("CLOUDFLARE_TURN_KEY_ID", "key");
    setEnv("CLOUDFLARE_TURN_KEY_API_TOKEN", "");
    setEnv("WEBRTC_STUN_URL", "stun:s");
    const { fetch, calls } = fakeFetch(() => Response.json(CF_PAYLOAD, { status: 201 }));
    const ice = iceServiceFromEnv({ fetch });
    expect(await ice.browserPayload()).toEqual({ iceServers: [{ urls: ["stun:s"] }] });
    expect(await ice.serverPlan()).toEqual({
      iceServers: [{ urls: "stun:s", username: null, credential: null }],
      relayOnly: false,
      turnUrl: null,
    });
    expect(calls).toHaveLength(0);
  });

  test("a failing mint falls back to the static env and never rejects", async () => {
    setEnv("CLOUDFLARE_TURN_KEY_ID", "key");
    setEnv("CLOUDFLARE_TURN_KEY_API_TOKEN", "token");
    setEnv("WEBRTC_TURN_URL", "turn:t:3478?transport=tcp");
    setEnv("WEBRTC_TURN_USERNAME", "u");
    setEnv("WEBRTC_TURN_CREDENTIAL", "c");
    const rejecting = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const ice = iceServiceFromEnv({ fetch: rejecting });
    expect(await ice.browserPayload()).toEqual({
      iceServers: [{ urls: ["turn:t:3478?transport=tcp"], username: "u", credential: "c" }],
    });
    expect(await ice.serverPlan()).toEqual({
      iceServers: [{ urls: "turn:t:3478?transport=tcp", username: "u", credential: "c" }],
      relayOnly: true,
      turnUrl: "turn:t:3478?transport=tcp",
    });
    expect(lines(logs)).toEqual([
      "WARNING [WebRTC] Cloudflare TURN mint failed: TypeError: fetch failed",
      "WARNING [WebRTC] Cloudflare TURN mint failed: TypeError: fetch failed",
    ]);
  });

  test("nothing configured: an empty list, no warning", async () => {
    const ice = iceServiceFromEnv();
    expect(await ice.browserPayload()).toEqual({ iceServers: [] });
    expect(await ice.serverPlan()).toEqual({ iceServers: [], relayOnly: false, turnUrl: null });
    expect(logs).toEqual([]);
  });

  test("without an injected fetch it mints through the global one", async () => {
    setEnv("CLOUDFLARE_TURN_KEY_ID", "key");
    setEnv("CLOUDFLARE_TURN_KEY_API_TOKEN", "token");
    expect(await iceServiceFromEnv().browserPayload()).toEqual({ iceServers: [] });
    expect(lines(logs)).toEqual([
      `WARNING [WebRTC] Cloudflare TURN mint failed: Error: ${NETWORK_BLOCKED}`,
    ]);
  });

  test("an invalid TTL falls back to 3600 with config's warning", async () => {
    setEnv("CLOUDFLARE_TURN_KEY_ID", "key");
    setEnv("CLOUDFLARE_TURN_KEY_API_TOKEN", "token");
    setEnv("CLOUDFLARE_TURN_TTL_SEC", "1h");
    const { fetch, calls } = fakeFetch(() => Response.json(CF_PAYLOAD, { status: 201 }));
    const ice = iceServiceFromEnv({ fetch });
    await ice.browserPayload();
    expect(calls[0]?.init.body).toBe('{"ttl":3600}');
    expect(lines(logs)[0]).toStartWith("WARNING CLOUDFLARE_TURN_TTL_SEC=");
  });
});

describe("createIceService", () => {
  const staticIce = {
    stunUrl: "stun:s",
    turnUrl: "turn:t:3478",
    turnUsername: "u",
    turnCredential: undefined,
  };

  test("a TURN server without credentials is not relay, and the plan logs nothing", async () => {
    const ice = createIceService({ cache: { get: async () => null }, staticIce });
    expect(await ice.serverPlan()).toEqual({
      iceServers: [
        { urls: "stun:s", username: null, credential: null },
        { urls: "turn:t:3478", username: "u", credential: null },
      ],
      relayOnly: false,
      turnUrl: "turn:t:3478",
    });
    await ice.serverPlan();
    expect(logs).toEqual([]);
  });

  test("both answers come from whatever the cache returns", async () => {
    const payload: IcePayload = {
      iceServers: [{ urls: "turn:cf", username: "a", credential: "b" }],
    };
    const ice = createIceService({ cache: { get: async () => payload }, staticIce });
    expect(await ice.browserPayload()).toBe(payload);
    expect(await ice.serverPlan()).toEqual({
      iceServers: [{ urls: "turn:cf", username: "a", credential: "b" }],
      relayOnly: true,
      turnUrl: "turn:cf",
    });
  });
});
