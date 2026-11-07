// POST credentials/check through a fake fetch: each provider's status table, the fields a check
// reads, where the key is sent and where it never is. Nothing here reaches a network.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { resetSettings } from "@eidolon/config";
import type { MemoryAdmin } from "@eidolon/memory";
import memoryManifest from "../../../../packages/memory/package.json" with { type: "json" };
import type { CheckProvider, CheckResult } from "../../src/local/api.ts";
import {
  type CheckDeps,
  type CheckOutcome,
  checkProvider,
  parseQdrantAddress,
  QDRANT_CLIENT_VERSION,
} from "../../src/local/checks.ts";
import type { LocalApp } from "../../src/local/router.ts";
import { credentialsRoutes } from "../../src/local/routes/credentials.ts";
import { buildStatus } from "../../src/local/status.ts";

const NOW = Date.parse("2026-11-05T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
}

type Reply = Response | (() => Response) | "network-error";

/** Answers by `<METHOD> <url>` prefix, longest first; records every request. */
function fakeFetch(replies: Record<string, Reply>) {
  const sent: Sent[] = [];
  const keys = Object.keys(replies).sort((a, b) => b.length - a.length);
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    sent.push({ method, url, authorization: headers.get("authorization") });
    const key = keys.find((k) => `${method} ${url}`.startsWith(k));
    const reply = key === undefined ? "network-error" : replies[key];
    if (reply === "network-error" || reply === undefined) throw new TypeError("fetch failed");
    return typeof reply === "function" ? reply() : reply.clone();
  }) as typeof fetch;
  return { fetch: fetchImpl, sent };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function deps(
  fetchImpl: typeof fetch,
  settings: Record<string, string> = {},
  fromEnv: readonly string[] = [],
): CheckDeps {
  return {
    fetch: fetchImpl,
    read: (name) => settings[name],
    fromEnv: (name) => fromEnv.includes(name),
    now: () => NOW,
  };
}

async function check(
  provider: CheckProvider,
  replies: Record<string, Reply>,
  settings: Record<string, string> = {},
  value?: string,
): Promise<CheckOutcome & { sent: Sent[] }> {
  const fake = fakeFetch(replies);
  const outcome = await checkProvider(provider, value, deps(fake.fetch, settings));
  return { ...outcome, sent: fake.sent };
}

const verdict = (result: CheckResult): unknown[] => [
  result.ok,
  result.code,
  result.warnings.map((warning) => warning.code),
];

const SONIOX = "GET https://api.soniox.com/v1/models";
const MODELS = json(200, {
  models: [
    { id: "stt-rt-v5", aliased_model_id: null },
    { id: "stt-rt-preview", aliased_model_id: "stt-rt-v6" },
    { id: "stt-async-v5", aliased_model_id: null },
  ],
});

describe("soniox", () => {
  test("lists models with the key; a configured model may be an id or an alias's target", async () => {
    const outcome = await check(
      "soniox",
      { [SONIOX]: MODELS },
      {
        SONIOX_API_KEY: "sk-soniox",
        SONIOX_MODEL: "stt-rt-v6",
      },
    );
    expect(verdict(outcome.result)).toEqual([true, "ok", []]);
    expect(outcome.sent).toEqual([
      { method: "GET", url: "https://api.soniox.com/v1/models", authorization: "Bearer sk-soniox" },
    ]);
  });

  test("a model Soniox doesn't list is a warning, not a failure", async () => {
    const outcome = await check(
      "soniox",
      { [SONIOX]: MODELS },
      {
        SONIOX_API_KEY: "k",
        SONIOX_ASYNC_MODEL: "stt-async-v9",
      },
    );
    expect(verdict(outcome.result)).toEqual([true, "ok", ["unknown-model"]]);
    expect(outcome.result.warnings[0]?.message).toContain("stt-async-v9 (transcription.model)");
  });

  test("401 is an invalid key, or one from a regional project", async () => {
    const outcome = await check(
      "soniox",
      { [SONIOX]: json(401, { error_type: "unauthenticated" }) },
      {
        SONIOX_API_KEY: "k",
      },
    );
    expect(verdict(outcome.result)).toEqual([false, "invalid-key", []]);
    expect(outcome.result.message).toContain("EU, JP or IN");
  });

  test("403 permission_denied is a valid key that may not list models", async () => {
    const denied = await check(
      "soniox",
      { [SONIOX]: json(403, { error_type: "permission_denied", message: "nope" }) },
      { SONIOX_API_KEY: "k" },
    );
    expect(verdict(denied.result)).toEqual([true, "ok", ["cannot-list-models"]]);
    const other = await check("soniox", { [SONIOX]: json(403, {}) }, { SONIOX_API_KEY: "k" });
    expect(verdict(other.result)).toEqual([false, "forbidden", []]);
  });

  test("the status table: 402, 429, 5xx, no answer, anything else", async () => {
    for (const [reply, code] of [
      [json(402, {}), "no-credit"],
      [json(429, {}), "rate-limited"],
      [json(503, {}), "unreachable"],
      ["network-error", "unreachable"],
      [json(418, {}), "unexpected"],
    ] as const) {
      const outcome = await check("soniox", { [SONIOX]: reply }, { SONIOX_API_KEY: "k" });
      expect([code, outcome.result.ok, outcome.result.code]).toEqual([code, false, code]);
    }
  });

  test("never shows the provider's own words", async () => {
    const outcome = await check(
      "soniox",
      { [SONIOX]: json(401, { message: "Incorrect API key sk-echoed" }) },
      { SONIOX_API_KEY: "k" },
    );
    expect(JSON.stringify(outcome.result)).not.toContain("sk-echoed");
  });

  test("a typed key is checked instead of the saved one", async () => {
    const outcome = await check(
      "soniox",
      { [SONIOX]: MODELS },
      { SONIOX_API_KEY: "saved" },
      "typed",
    );
    expect(outcome.sent[0]?.authorization).toBe("Bearer typed");
  });

  test("without a key there is nothing to check", async () => {
    const outcome = await check("soniox", {});
    expect(verdict(outcome.result)).toEqual([false, "missing", []]);
    expect(outcome.sent).toEqual([]);
  });

  test("says when an environment variable overrides the saved key", async () => {
    const fake = fakeFetch({ [SONIOX]: MODELS });
    const outcome = await checkProvider(
      "soniox",
      undefined,
      deps(fake.fetch, { SONIOX_API_KEY: "k" }, ["SONIOX_API_KEY"]),
    );
    expect(outcome.result.envOverride).toBe(true);
  });
});

const OPENROUTER_KEY = "GET https://openrouter.ai/api/v1/key";
const keyData = (data: Record<string, unknown>) =>
  json(200, { data: { label: "sk-or-v1-abc...xyz", limit: null, is_free_tier: false, ...data } });

describe("openrouter", () => {
  test("a regular key is accepted, never called ready, with its limit as credit", async () => {
    const outcome = await check(
      "openrouter",
      { [OPENROUTER_KEY]: keyData({ limit_remaining: 12.5 }) },
      {
        OPENROUTER_API_KEY: "sk-or",
      },
    );
    expect(verdict(outcome.result)).toEqual([true, "ok", []]);
    expect([outcome.result.message, outcome.result.credit]).toEqual(["Key accepted", 12.5]);
    expect(outcome.sent[0]?.authorization).toBe("Bearer sk-or");
  });

  test("401 is invalid, and a management key can't run the bot", async () => {
    const invalid = await check(
      "openrouter",
      { [OPENROUTER_KEY]: json(401, {}) },
      {
        OPENROUTER_API_KEY: "k",
      },
    );
    expect(verdict(invalid.result)).toEqual([false, "invalid-key", []]);
    const management = await check(
      "openrouter",
      { [OPENROUTER_KEY]: keyData({ is_management_key: true }) },
      { OPENROUTER_API_KEY: "k" },
    );
    expect(verdict(management.result)).toEqual([false, "management-key", []]);
  });

  test("warns on free tier, spent limits and budgets, and expiry past or near", async () => {
    const outcome = await check(
      "openrouter",
      {
        [OPENROUTER_KEY]: keyData({
          is_free_tier: true,
          limit_remaining: 0,
          effective_budget: { remaining_usd: -1 },
          expires_at: new Date(NOW - DAY).toISOString(),
        }),
      },
      { OPENROUTER_API_KEY: "k" },
    );
    expect(verdict(outcome.result)).toEqual([
      true,
      "ok",
      ["free-tier", "key-limit-reached", "budget-exhausted", "key-expired"],
    ]);
    const soon = await check(
      "openrouter",
      { [OPENROUTER_KEY]: keyData({ expires_at: new Date(NOW + 3 * DAY).toISOString() }) },
      { OPENROUTER_API_KEY: "k" },
    );
    expect(verdict(soon.result)).toEqual([true, "ok", ["key-expiring"]]);
    const later = await check(
      "openrouter",
      { [OPENROUTER_KEY]: keyData({ expires_at: new Date(NOW + 60 * DAY).toISOString() }) },
      { OPENROUTER_API_KEY: "k" },
    );
    expect(verdict(later.result)).toEqual([true, "ok", []]);
  });

  test("another API base is checked by its model listing", async () => {
    const outcome = await check(
      "openrouter",
      { "GET https://llm.example/v1/models": json(200, { data: [] }) },
      { OPENROUTER_API_KEY: "k", OPENROUTER_API_BASE: "https://llm.example/v1/" },
    );
    expect(verdict(outcome.result)).toEqual([true, "ok", []]);
  });
});

const FISH_CREDIT = "GET https://api.fish.audio/wallet/self/api-credit";
const VOICE = "0123456789abcdef0123456789abcdef";
const FISH_VOICE = `GET https://api.fish.audio/model/${VOICE}`;

describe("fish", () => {
  test("reads the API credit with the key, and the persona's voice with it too", async () => {
    const outcome = await check(
      "fish",
      { [FISH_CREDIT]: json(200, { credit: "3.50" }), [FISH_VOICE]: json(200, { _id: VOICE }) },
      { FISH_API_KEY: "fk", FISH_VOICE_ID: VOICE },
    );
    expect(verdict(outcome.result)).toEqual([true, "ok", []]);
    expect(outcome.result.credit).toBe(3.5);
    expect(outcome.voice).toEqual({ id: VOICE, ok: true });
    expect(outcome.sent.map((s) => s.authorization)).toEqual(["Bearer fk", "Bearer fk"]);
  });

  test("no credit warns only while the model bills", async () => {
    const replies = { [FISH_CREDIT]: json(200, { credit: "0" }) };
    const paid = await check("fish", replies, { FISH_API_KEY: "k" });
    expect(verdict(paid.result)).toEqual([true, "ok", ["no-credit"]]);
    expect(paid.result.warnings[0]?.message).toContain(
      "https://fish.audio/app/developers/billing/",
    );
    const free = await check("fish", replies, { FISH_API_KEY: "k", FISH_MODEL: "s2.1-pro-free" });
    expect(verdict(free.result)).toEqual([true, "ok", []]);
  });

  test("the model must be one Fish has; s1 is on its way out", async () => {
    const replies = { [FISH_CREDIT]: json(200, { credit: "1" }) };
    const unknown = await check("fish", replies, { FISH_API_KEY: "k", FISH_MODEL: "drama3" });
    expect(verdict(unknown.result)).toEqual([true, "ok", ["unknown-model"]]);
    const old = await check("fish", replies, { FISH_API_KEY: "k", FISH_MODEL: "s1" });
    expect(verdict(old.result)).toEqual([true, "ok", ["deprecated-model"]]);
  });

  test("a voice Fish doesn't know, or someone else's, warns", async () => {
    for (const [status, code] of [
      [404, "voice-unknown"],
      [403, "voice-private"],
    ] as const) {
      const outcome = await check(
        "fish",
        { [FISH_CREDIT]: json(200, { credit: "1" }), [FISH_VOICE]: json(status, {}) },
        { FISH_API_KEY: "k", FISH_VOICE_ID: VOICE },
      );
      expect(verdict(outcome.result)).toEqual([true, "ok", [code]]);
      expect(outcome.result.warnings[0]?.message).toStartWith("The persona's voice ");
      expect(outcome.voice).toEqual({ id: VOICE, ok: false });
    }
    const unsure = await check(
      "fish",
      { [FISH_CREDIT]: json(200, { credit: "1" }), [FISH_VOICE]: json(500, {}) },
      { FISH_API_KEY: "k", FISH_VOICE_ID: VOICE },
    );
    expect(unsure.voice).toEqual({ id: VOICE, ok: null });
  });

  test("a voice she inherits from the environment says so", async () => {
    for (const [status, code, message] of [
      [404, "voice-unknown", "The voice she inherits from FISH_VOICE_ID isn't one Fish has"],
      [
        403,
        "voice-private",
        "The voice she inherits from FISH_VOICE_ID belongs to another Fish account",
      ],
    ] as const) {
      const fake = fakeFetch({
        [FISH_CREDIT]: json(200, { credit: "1" }),
        [FISH_VOICE]: json(status, {}),
      });
      const settings = { FISH_API_KEY: "k", FISH_VOICE_ID: VOICE };
      const outcome = await checkProvider(
        "fish",
        undefined,
        deps(fake.fetch, settings, ["FISH_VOICE_ID"]),
      );
      expect(outcome.result.warnings).toEqual([{ code, message }]);
    }
  });

  test("401 is an invalid key", async () => {
    const outcome = await check("fish", { [FISH_CREDIT]: json(401, {}) }, { FISH_API_KEY: "k" });
    expect(verdict(outcome.result)).toEqual([false, "invalid-key", []]);
  });
});

const EMBED_MODELS = "GET https://openrouter.ai/api/v1/embeddings/models";

describe("embeddings, rerank and refine", () => {
  test("on OpenRouter: the key it falls back to, then the model in the listing", async () => {
    const outcome = await check(
      "embeddings",
      { [OPENROUTER_KEY]: keyData({}), [EMBED_MODELS]: json(200, { data: [{ id: "a/b" }] }) },
      { OPENROUTER_API_KEY: "sk-or" },
    );
    expect(verdict(outcome.result)).toEqual([true, "ok", ["unknown-model"]]);
    expect(outcome.result.warnings[0]?.message).toContain("google/gemini-embedding-2-preview");
    expect(outcome.sent.map((s) => [s.url, s.authorization])).toEqual([
      ["https://openrouter.ai/api/v1/key", "Bearer sk-or"],
      ["https://openrouter.ai/api/v1/embeddings/models", null],
    ]);
    const listed = await check(
      "embeddings",
      { [OPENROUTER_KEY]: keyData({}), [EMBED_MODELS]: json(200, { data: [{ id: "x/emb" }] }) },
      { EMBED_API_KEY: "sk-embed", EMBED_MODEL: "x/emb" },
    );
    expect(verdict(listed.result)).toEqual([true, "ok", []]);
    expect(listed.sent[0]?.authorization).toBe("Bearer sk-embed");
  });

  test("another base: 2xx passes, 401 and 403 fail, 404 and 405 can't tell", async () => {
    for (const [status, expected] of [
      [200, [true, "ok", []]],
      [401, [false, "invalid-key", []]],
      [403, [false, "invalid-key", []]],
      [404, [true, "ok", ["cannot-verify"]]],
      [405, [true, "ok", ["cannot-verify"]]],
      [500, [false, "unreachable", []]],
    ] as const) {
      const outcome = await check(
        "embeddings",
        { "GET https://api.siliconflow.cn/v1/models": json(status, {}) },
        { EMBED_API_KEY: "k", EMBED_BASE_URL: "https://api.siliconflow.cn/v1" },
      );
      expect([status, ...verdict(outcome.result)]).toEqual([status, ...expected]);
    }
  });

  test("rerank on Cohere asks Cohere's own key check", async () => {
    const settings = { RERANK_API_KEY: "co", RERANK_BASE_URL: "https://api.cohere.com/v2" };
    const cohere = "POST https://api.cohere.com/v1/check-api-key";
    const valid = await check("rerank", { [cohere]: json(200, { valid: true }) }, settings);
    expect(verdict(valid.result)).toEqual([true, "ok", []]);
    expect(valid.sent[0]).toMatchObject({ method: "POST", authorization: "Bearer co" });
    const invalid = await check("rerank", { [cohere]: json(200, { valid: false }) }, settings);
    expect(verdict(invalid.result)).toEqual([false, "invalid-key", []]);
    const unknown = await check("rerank", { [cohere]: json(498, {}) }, settings);
    expect(verdict(unknown.result)).toEqual([false, "invalid-key", []]);
  });

  test("refine on OpenRouter looks its model up among the text models", async () => {
    const outcome = await check(
      "refine",
      {
        [OPENROUTER_KEY]: keyData({}),
        "GET https://openrouter.ai/api/v1/models": json(200, {
          data: [{ id: "~google/gemini-pro-latest" }],
        }),
      },
      { OPENROUTER_API_KEY: "k" },
    );
    expect(verdict(outcome.result)).toEqual([true, "ok", []]);
  });
});

const ROOT = "GET http://127.0.0.1:6333/";
const COLLECTIONS = "GET http://127.0.0.1:6333/collections";
const qdrantRoot = (version: string, title = "qdrant - vector search engine") =>
  json(200, { title, version, commit: "abc" });

describe("qdrant", () => {
  test("names itself at /, then lists collections without a key", async () => {
    const outcome = await check(
      "qdrant",
      { [ROOT]: qdrantRoot("1.19.1"), [COLLECTIONS]: json(200, { result: { collections: [] } }) },
      {},
      "127.0.0.1:6333",
    );
    expect(verdict(outcome.result)).toEqual([true, "ok", []]);
    expect(outcome.qdrant).toEqual({ host: "127.0.0.1", port: 6333, ok: true });
    expect(outcome.sent.every((s) => s.authorization === null)).toBe(true);
  });

  test("reads the saved host and port when nothing is typed, and needs a host", async () => {
    const outcome = await check(
      "qdrant",
      {
        "GET http://localhost:6334/": qdrantRoot("1.19.1"),
        "GET http://localhost:6334/collections": json(200, {}),
      },
      { MEM0_QDRANT_HOST: " localhost ", MEM0_QDRANT_PORT: "6334" },
    );
    expect(verdict(outcome.result)).toEqual([true, "ok", []]);
    const missing = await check("qdrant", {});
    expect(verdict(missing.result)).toEqual([false, "missing", []]);
  });

  test("a version more than one minor from the client warns", async () => {
    const outcome = await check(
      "qdrant",
      { [ROOT]: qdrantRoot("1.22.0"), [COLLECTIONS]: json(200, {}) },
      {},
      "127.0.0.1",
    );
    expect(verdict(outcome.result)).toEqual([true, "ok", ["version-mismatch"]]);
  });

  test("not Qdrant, still starting, wanting a key, or nothing there", async () => {
    for (const [replies, code] of [
      [{ [ROOT]: qdrantRoot("1.19.1", "something else") }, "not-qdrant"],
      [{ [ROOT]: json(404, {}) }, "not-qdrant"],
      [{ [ROOT]: json(503, {}) }, "starting"],
      [{ [ROOT]: qdrantRoot("1.19.1"), [COLLECTIONS]: json(401, {}) }, "needs-api-key"],
      [{ [ROOT]: qdrantRoot("1.19.1"), [COLLECTIONS]: json(403, {}) }, "needs-api-key"],
      [{ [ROOT]: qdrantRoot("1.19.1"), [COLLECTIONS]: json(503, {}) }, "starting"],
      [{}, "unreachable"],
    ] as const) {
      const outcome = await check("qdrant", replies, {}, "127.0.0.1:6333");
      expect([code, outcome.result.ok, outcome.result.code]).toEqual([code, false, code]);
    }
  });

  test("a typed address must be a host or host:port", async () => {
    const outcome = await check("qdrant", {}, {}, "http://127.0.0.1:6333/path");
    expect(verdict(outcome.result)).toEqual([false, "unexpected", []]);
    expect(parseQdrantAddress("[::1]:7000", 6333)).toEqual({ host: "::1", port: 7000 });
    expect(parseQdrantAddress("qdrant", 6333)).toEqual({ host: "qdrant", port: 6333 });
    expect(parseQdrantAddress("x:70000", 6333)).toBeNull();
  });

  test("the client version matches the one packages/memory pins", () => {
    expect(memoryManifest.dependencies["@qdrant/js-client-rest"]).toBe(QDRANT_CLIENT_VERSION);
  });
});

describe("POST credentials/check", () => {
  const app = {
    port: () => 7860,
    activeCalls: () => 0,
    restart: () => {},
    onStop: () => {},
    memoryAdmin: (): MemoryAdmin | null => null,
  } satisfies LocalApp;
  const touched: string[] = [];

  afterEach(() => {
    for (const name of touched.splice(0)) delete process.env[name];
    resetSettings();
  });

  function route(fetchImpl: typeof fetch) {
    const spec = credentialsRoutes(app, { check: { fetch: fetchImpl, now: () => NOW } }).find(
      (s) => s.route === "POST /api/local/credentials/check",
    );
    if (spec === undefined) throw new Error("no check route");
    return (body: string) => {
      const url = new URL("http://127.0.0.1:7860/api/local/credentials/check");
      const request = new Request(url, { method: "POST", body });
      return spec.handler(request, {
        url,
        params: {},
        server: undefined as never,
        caller: "bearer",
      });
    };
  }

  test("refuses an unknown provider or a value that isn't one line", async () => {
    const post = route(fakeFetch({}).fetch);
    for (const body of [
      "{}",
      '{"provider":"nope"}',
      '{"provider":"soniox","value":5}',
      '{"provider":"soniox","value":"a\\nb"}',
    ]) {
      const response = await post(body);
      expect([body, response.status]).toEqual([body, 400]);
    }
  });

  test("what a check of the saved key learns of the voice, GET status reports", async () => {
    for (const [name, value] of [
      ["FISH_API_KEY", "fk"],
      ["FISH_VOICE_ID", VOICE],
    ]) {
      touched.push(name as string);
      process.env[name as string] = value;
    }
    const fake = fakeFetch({
      [FISH_CREDIT]: json(200, { credit: "1" }),
      [FISH_VOICE]: json(404, {}),
    });
    const response = await route(fake.fetch)('{"provider":"fish"}');
    expect(response.status).toBe(200);
    const status = buildStatus(app, { fetch: fake.fetch, now: Date.now });
    expect(status.persona.voice).toEqual({ id: VOICE, source: "env", ok: false });
    // The answer is that key's: a key saved since hasn't been asked yet.
    process.env.FISH_API_KEY = "fk-saved-since";
    expect(buildStatus(app, { fetch: fake.fetch, now: Date.now }).persona.voice.ok).toBeNull();
  });
});
