import { describe, expect, test } from "bun:test";
import {
  browserIcePayload,
  type IcePayload,
  isUsableTurnUrl,
  preferTurnUrl,
  type StaticIceEnv,
  serverIcePlan,
  staticIceFromEnv,
} from "../src/index.ts";
import { useEnv } from "./support.ts";

const NO_STATIC: StaticIceEnv = {
  stunUrl: undefined,
  turnUrl: undefined,
  turnUsername: undefined,
  turnCredential: undefined,
};
const CLOUDFLARE_DOCUMENTED: IcePayload = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:443?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turn:turn.cloudflare.com:80?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "<USERNAME>",
      credential: "<CREDENTIAL>",
    },
  ],
};
const stun = (urls: string) => ({ urls, username: null, credential: null });
const relay = (urls: string, username: string, credential: string) => ({
  iceServers: [{ urls, username, credential }],
  relayOnly: true,
  turnUrl: urls,
});

const setEnv = useEnv();

describe("preferTurnUrl", () => {
  test.each<[string, string, boolean]>([
    ["turn:h:3478?transport=tcp", "turn:h:3478?transport=udp", true],
    ["turn:h:3478?transport=udp", "turn:h:3478?transport=tcp", false],
    ["turn:h:80?transport=tcp", "turn:h:3478?transport=tcp", false],
    ["turns:h:443?transport=tcp", "turn:h:3478?transport=tcp", false],
    ["turn:h:3478?transport=tcp", "turn:h:3478", true],
    ["turn:h:3478", "turn:h:3478?transport=udp", false],
    ["turn:h:3478?transport=TCP", "turn:h:3478?transport=udp", false],
  ])("%s over %s → %p", (candidate, current, expected) => {
    expect(preferTurnUrl(candidate, current)).toBe(expected);
  });
});

describe("isUsableTurnUrl", () => {
  test.each([
    "turn:h",
    "turn:h:3478?transport=udp",
    "TURN:h:3478?transport=tcp",
    "turns:h:443?transport=tcp",
    "turns:h",
    "turn:[::1]:3478",
    " turn:h ",
    "turn://h:3478",
    "turn:h?x=1&transport=tcp",
  ])("%p is usable", (url) => {
    expect(isUsableTurnUrl(url)).toBe(true);
  });

  test.each([
    "turns:h?transport=udp",
    "turn:h?transport=sctp",
    "turn:h?transport=TCP",
    "turn:",
    "turn:?transport=tcp",
    "turn://",
    "turn:[::1",
    "stun:h",
    "stuns:h",
    "http://h",
    "turn:h\nx",
  ])("%p is not", (url) => {
    expect(isUsableTurnUrl(url)).toBe(false);
  });
});

describe("serverIcePlan from Cloudflare", () => {
  test("the documented payload: TCP TURN on 3478 only, relay", () => {
    expect(serverIcePlan(CLOUDFLARE_DOCUMENTED, NO_STATIC)).toEqual(
      relay("turn:turn.cloudflare.com:3478?transport=tcp", "<USERNAME>", "<CREDENTIAL>"),
    );
  });

  test("a bare-string urls, and STUN listed after TURN", () => {
    const payload = {
      iceServers: [
        { urls: "turn:t:3478?transport=udp", username: "u", credential: "c" },
        { urls: ["stun:s"] },
      ],
    };
    expect(serverIcePlan(payload, NO_STATIC)).toEqual(relay("turn:t:3478?transport=udp", "u", "c"));
  });

  test("credentials come from the entry holding the winning URL", () => {
    const payload = {
      iceServers: [
        { urls: ["turn:a:3478?transport=udp"], username: "ua", credential: "ca" },
        { urls: ["turn:b:3478?transport=tcp"], username: "ub", credential: "cb" },
        { urls: ["turn:c:3478?transport=tcp"], username: "uc", credential: "cc" },
      ],
    };
    expect(serverIcePlan(payload, NO_STATIC)).toEqual(
      relay("turn:b:3478?transport=tcp", "ub", "cb"),
    );
  });

  test("only UDP TURN: the first one, relay", () => {
    const payload = {
      iceServers: [
        {
          urls: ["turn:a:3478?transport=udp", "turn:a:443?transport=udp"],
          username: "u",
          credential: "c",
        },
      ],
    };
    expect(serverIcePlan(payload, NO_STATIC)).toEqual(relay("turn:a:3478?transport=udp", "u", "c"));
  });

  test("STUN only: kept, not relay", () => {
    expect(serverIcePlan({ iceServers: [{ urls: ["stun:only"] }] }, NO_STATIC)).toEqual({
      iceServers: [stun("stun:only")],
      relayOnly: false,
      turnUrl: null,
    });
  });

  test("the first stun: URL wins; stuns: and case variants are not chosen", () => {
    const payload = {
      iceServers: [
        { urls: ["stuns:c", "stun:b", "stun:a", "STUN:x"] },
        { urls: ["TURN:t?transport=tcp"], username: "u", credential: "c" },
      ],
    };
    expect(serverIcePlan(payload, NO_STATIC)).toEqual({
      iceServers: [stun("stun:b")],
      relayOnly: false,
      turnUrl: null,
    });
  });

  test("a stun: URL never becomes the TURN server", () => {
    const payload = {
      iceServers: [{ urls: ["stun:a", "stun:b"], username: "u", credential: "c" }],
    };
    expect(serverIcePlan(payload, NO_STATIC).turnUrl).toBeNull();
  });

  test("TURN without credentials: STUN and TURN, not relay", () => {
    for (const creds of [
      {},
      { username: "", credential: "" },
      { username: "u" },
      { credential: 7 },
    ]) {
      const payload = { iceServers: [{ urls: ["stun:s", "turn:t?transport=tcp"], ...creds }] };
      const plan = serverIcePlan(payload, NO_STATIC);
      expect(plan.relayOnly).toBe(false);
      expect(plan.iceServers.map((s) => s.urls)).toEqual(["stun:s", "turn:t?transport=tcp"]);
      expect(plan.turnUrl).toBe("turn:t?transport=tcp");
    }
  });

  test("a TURN URL werift cannot use is passed on, but not as relay", () => {
    const payload = {
      iceServers: [{ urls: ["turns:t?transport=udp"], username: "u", credential: "c" }],
    };
    expect(serverIcePlan(payload, NO_STATIC)).toEqual({
      iceServers: [{ urls: "turns:t?transport=udp", username: "u", credential: "c" }],
      relayOnly: false,
      turnUrl: "turns:t?transport=udp",
    });
  });

  test("malformed payloads give an empty plan instead of crashing", () => {
    const empty = { iceServers: [], relayOnly: false, turnUrl: null };
    for (const payload of [
      {},
      { other: 1 },
      { iceServers: [] },
      { iceServers: null },
      { iceServers: "turn:t" },
      { iceServers: { urls: ["turn:t"] } },
      { iceServers: ["turn:t", null, 3, [["turn:t"]]] },
      { iceServers: [{ urls: null }, { urls: 5 }, { urls: [1, null, { u: "turn:t" }] }] },
    ]) {
      expect(serverIcePlan(payload, NO_STATIC)).toEqual(empty);
    }
  });

  test("ignores the static env whenever Cloudflare answered", () => {
    const staticIce = {
      stunUrl: "stun:static",
      turnUrl: "turn:static",
      turnUsername: "u",
      turnCredential: "c",
    };
    expect(serverIcePlan({}, staticIce)).toEqual({
      iceServers: [],
      relayOnly: false,
      turnUrl: null,
    });
    expect(serverIcePlan(CLOUDFLARE_DOCUMENTED, staticIce).turnUrl).toBe(
      "turn:turn.cloudflare.com:3478?transport=tcp",
    );
  });
});

describe("serverIcePlan from the static env", () => {
  test("STUN, TURN and both credentials: TURN only, URL as given, relay", () => {
    const staticIce = {
      stunUrl: "stun:s",
      turnUrl: "turn:t:3478?transport=udp",
      turnUsername: "u",
      turnCredential: "c",
    };
    expect(serverIcePlan(null, staticIce)).toEqual(relay("turn:t:3478?transport=udp", "u", "c"));
  });

  test("TURN missing a credential: STUN and TURN, not relay", () => {
    const staticIce = { ...NO_STATIC, stunUrl: "stun:s", turnUrl: "turn:t", turnUsername: "u" };
    expect(serverIcePlan(null, staticIce)).toEqual({
      iceServers: [stun("stun:s"), { urls: "turn:t", username: "u", credential: null }],
      relayOnly: false,
      turnUrl: "turn:t",
    });
  });

  test("an unusable TURN URL is not relay", () => {
    const staticIce = {
      stunUrl: undefined,
      turnUrl: "turns:t?transport=udp",
      turnUsername: "u",
      turnCredential: "c",
    };
    expect(serverIcePlan(null, staticIce).relayOnly).toBe(false);
  });

  test("STUN only, and nothing at all", () => {
    expect(serverIcePlan(null, { ...NO_STATIC, stunUrl: "stun:s" })).toEqual({
      iceServers: [stun("stun:s")],
      relayOnly: false,
      turnUrl: null,
    });
    expect(serverIcePlan(null, NO_STATIC)).toEqual({
      iceServers: [],
      relayOnly: false,
      turnUrl: null,
    });
    const blank = { stunUrl: "", turnUrl: "", turnUsername: "", turnCredential: "" };
    expect(serverIcePlan(null, blank)).toEqual({ iceServers: [], relayOnly: false, turnUrl: null });
  });
});

describe("browserIcePayload", () => {
  test("Cloudflare's payload is returned as the same object", () => {
    expect(browserIcePayload(CLOUDFLARE_DOCUMENTED, NO_STATIC)).toBe(CLOUDFLARE_DOCUMENTED);
    const empty = {};
    expect(browserIcePayload(empty, { ...NO_STATIC, stunUrl: "stun:s" })).toBe(empty);
  });

  test("the static env, serialized as bot.py's route did", () => {
    const json = (staticIce: StaticIceEnv) => JSON.stringify(browserIcePayload(null, staticIce));
    expect(json(NO_STATIC)).toBe('{"iceServers":[]}');
    expect(json({ ...NO_STATIC, stunUrl: "stun:s:3478" })).toBe(
      '{"iceServers":[{"urls":["stun:s:3478"]}]}',
    );
    expect(json({ ...NO_STATIC, turnUrl: "turn:t:3478?transport=udp" })).toBe(
      '{"iceServers":[{"urls":["turn:t:3478?transport=udp"],"username":"","credential":""}]}',
    );
    expect(
      json({ stunUrl: "stun:s", turnUrl: "turn:t", turnUsername: "u", turnCredential: undefined }),
    ).toBe(
      '{"iceServers":[{"urls":["stun:s"]},{"urls":["turn:t"],"username":"u","credential":""}]}',
    );
    expect(json({ stunUrl: "", turnUrl: "turn:t", turnUsername: "", turnCredential: "" })).toBe(
      '{"iceServers":[{"urls":["turn:t"],"username":"","credential":""}]}',
    );
  });
});

describe("staticIceFromEnv", () => {
  test("reads the four variables, empty as unset", () => {
    setEnv("WEBRTC_STUN_URL", "stun:s");
    setEnv("WEBRTC_TURN_URL", "turn:t");
    setEnv("WEBRTC_TURN_USERNAME", "");
    setEnv("WEBRTC_TURN_CREDENTIAL", undefined);
    expect(staticIceFromEnv()).toEqual({
      stunUrl: "stun:s",
      turnUrl: "turn:t",
      turnUsername: undefined,
      turnCredential: undefined,
    });
  });
});
