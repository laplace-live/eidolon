// GET voices/search and accounts/:id/voices through a fake fetch: Fish's public search, sent without
// the key, and an account's own voices, listed with its key; results mapped to absolute https URLs
// with anything a call couldn't use left out.
import "../../../../packages/config/test/isolated-guard.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome, installSettings, resetSettings } from "@eidolon/config";
import type { MemoryAdmin } from "@eidolon/memory";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AccountVoicesResponse, VoiceSearchResponse } from "../../src/local/api.ts";
import { createLocalRouter, type LocalApp } from "../../src/local/router.ts";
import { PAGE_SIZE, voiceOf, voicesRoutes } from "../../src/local/routes/voices.ts";
import type { RouteRequest } from "../../src/routing.ts";

const app = {
  port: () => 7860,
  activeCalls: () => 0,
  restart: () => {},
  onStop: () => {},
  memoryAdmin: (): MemoryAdmin | null => null,
} satisfies LocalApp;

const ID = "0123456789abcdef0123456789abcdef";
const OWN_ID = "fedcba9876543210fedcba9876543210";

const ITEM = {
  _id: ID,
  type: "tts",
  title: "温柔女声",
  description: "soft",
  cover_image: `coverimage/${ID}`,
  languages: ["zh"],
  tags: ["female", 3],
  samples: [
    { title: "a", text: "你好", audio: "https://platform.r2.fish.audio/task/abc.mp3" },
    { title: "b", text: "x", audio: "http://platform.r2.fish.audio/task/plain.mp3" },
    { title: "c", text: "x", audio: "javascript:alert(1)" },
  ],
  author: { _id: "u", nickname: "作者", avatar: "" },
  like_count: 12,
  task_count: 3400,
  state: "trained",
  visibility: "public",
  created_at: "2026-05-15T10:37:55.785000Z",
};

/** One of the account's own, as Fish lists it under self=true: private, without a sample. */
const OWN_ITEM = {
  ...ITEM,
  _id: OWN_ID,
  title: "MG4",
  description: "",
  cover_image: `coverimage/${OWN_ID}`,
  samples: [],
  author: { _id: "me", nickname: "我", avatar: "" },
  like_count: 0,
  task_count: 94,
  visibility: "private",
  created_at: "2026-11-02T08:05:32.771000Z",
};

interface Sent {
  readonly url: URL;
  readonly headers: Headers;
}

/** The routes, behind the local router, over a fetch that answers `reply`. */
function fish(reply: Response | "network-error") {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    sent.push({ url: new URL(String(input)), headers: new Headers(init.headers) });
    if (reply === "network-error") throw new TypeError("fetch failed");
    return reply.clone();
  }) as typeof fetch;
  const router = createLocalRouter(voicesRoutes(app, { fetch: fetchImpl }), () => "bearer");
  return {
    sent,
    async get(path: string) {
      const request = new Request(`http://127.0.0.1:7860/api/local${path}`) as RouteRequest;
      const response = await router(request, { requestIP: () => null });
      return { status: response.status, body: await response.json() };
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const touched: string[] = [];

function setEnv(name: string, value: string): void {
  touched.push(name);
  process.env[name] = value;
}

function writeCredentials(value: unknown): void {
  mkdirSync(dataHome(), { recursive: true });
  writeFileSync(join(dataHome(), "credentials.json"), JSON.stringify(value));
}

beforeEach(() => {
  resetSettings();
  installSettings();
});

afterEach(() => {
  for (const name of touched.splice(0)) delete process.env[name];
  resetSettings();
  rmSync(dataHome(), { recursive: true, force: true });
});

describe("voices/search", () => {
  test("asks Fish's public search, with no key, by title, language and page", async () => {
    const api = fish(json(200, { total: 1, items: [ITEM], has_more: false, total_is_exact: true }));
    const { status, body } = await api.get("/voices/search?q=%20温柔%20&language=zh&page=2");
    expect(status).toBe(200);
    expect(api.sent).toHaveLength(1);
    const sent = api.sent[0] as Sent;
    expect(sent.headers.get("authorization")).toBeNull();
    expect(`${sent.url.origin}${sent.url.pathname}`).toBe("https://api.fish.audio/model");
    expect(Object.fromEntries(sent.url.searchParams)).toEqual({
      page_size: String(PAGE_SIZE),
      page_number: "2",
      title: "温柔",
      language: "zh",
    });
    const answer = body as VoiceSearchResponse;
    expect(answer).toMatchObject({ total: 1, totalIsExact: true, hasMore: false });
    expect(answer.items).toEqual([
      {
        id: ID,
        title: "温柔女声",
        description: "soft",
        coverUrl: `https://public-platform.r2.fish.audio/coverimage/${ID}`,
        languages: ["zh"],
        tags: ["female"],
        samples: [
          { title: "a", text: "你好", audioUrl: "https://platform.r2.fish.audio/task/abc.mp3" },
        ],
        author: "作者",
        likeCount: 12,
        taskCount: 3400,
        visibility: "public",
        createdAt: "2026-05-15T10:37:55.785000Z",
      },
    ]);
  });

  test("without a query or language, searches the whole library from page 1", async () => {
    const api = fish(json(200, { total: 0, items: [], has_more: false }));
    await api.get("/voices/search");
    expect(Object.fromEntries((api.sent[0] as Sent).url.searchParams)).toEqual({
      page_size: String(PAGE_SIZE),
      page_number: "1",
    });
  });

  test("a capped count says so, and paging stops where Fish stops answering", async () => {
    const capped = fish(
      json(200, { total: 1000, items: [], has_more: true, total_is_exact: false }),
    );
    expect((await capped.get("/voices/search?page=1")).body).toMatchObject({
      total: 1000,
      totalIsExact: false,
      hasMore: true,
    });
    expect((await capped.get(`/voices/search?page=${1000 / PAGE_SIZE}`)).body.hasMore).toBe(false);
    expect((await capped.get(`/voices/search?page=${1000 / PAGE_SIZE + 1}`)).status).toBe(400);
  });

  test("leaves out voices a call can't use, and covers that aren't a key", () => {
    expect(voiceOf({ ...ITEM, type: "svc" })).toBeNull();
    expect(voiceOf({ ...ITEM, dmca_taken_down: true })).toBeNull();
    expect(voiceOf({ ...ITEM, _id: "../model" })).toBeNull();
    expect(voiceOf("nope")).toBeNull();
    expect(voiceOf({ ...ITEM, cover_image: "" })?.coverUrl).toBeNull();
    expect(voiceOf({ ...ITEM, cover_image: "../../x" })?.coverUrl).toBeNull();
    expect(voiceOf({ ...ITEM, cover_image: "https://evil.example/x" })?.coverUrl).toBeNull();
    expect(voiceOf({ ...ITEM, samples: [] })?.samples).toEqual([]);
  });

  test("a voice's visibility is one Fish names, and its date one that parses", () => {
    expect(voiceOf({ ...ITEM, visibility: "unlist" })?.visibility).toBe("unlist");
    expect(voiceOf({ ...ITEM, visibility: "secret" })?.visibility).toBe("public");
    expect(voiceOf({ ...ITEM, visibility: undefined })?.visibility).toBe("public");
    expect(voiceOf({ ...ITEM, created_at: "yesterday" })?.createdAt).toBeNull();
    expect(voiceOf({ ...ITEM, created_at: undefined })?.createdAt).toBeNull();
  });

  test("refuses a query, language or page it can't send", async () => {
    const api = fish(json(200, { total: 0, items: [] }));
    for (const query of [
      `?q=${"x".repeat(101)}`,
      "?q=a%0Ab",
      "?language=zh-CN",
      "?language=fr",
      "?page=0",
      "?page=-1",
      "?page=abc",
    ]) {
      const { status, body } = await api.get(`/voices/search${query}`);
      expect([query, status, body.error.code]).toEqual([query, 400, "bad-request"]);
    }
    expect(api.sent).toEqual([]);
  });

  test("Fish failing is 502, and no answer at all 503", async () => {
    const failing = fish(json(500, { message: "down" }));
    expect((await failing.get("/voices/search")).status).toBe(502);
    const silent = fish("network-error");
    const { status, body } = await silent.get("/voices/search");
    expect([status, body.error.code]).toEqual([503, "unavailable"]);
  });
});

describe("accounts/:id/voices", () => {
  const own = (body: unknown = { total: 1, items: [OWN_ITEM], has_more: false }) =>
    fish(json(200, body));

  test("lists the account's own voices with its key, newest first, by title, visibility and page", async () => {
    setEnv("FISH_API_KEY", "fk-default");
    installSettings();
    const api = own();
    const { status, body } = await api.get(
      "/accounts/fish/voices?q=%20MG%20&visibility=private&page=2",
    );
    expect(status).toBe(200);
    const sent = api.sent[0] as Sent;
    expect(sent.headers.get("authorization")).toBe("Bearer fk-default");
    expect(`${sent.url.origin}${sent.url.pathname}`).toBe("https://api.fish.audio/model");
    expect(Object.fromEntries(sent.url.searchParams)).toEqual({
      page_size: String(PAGE_SIZE),
      page_number: "2",
      title: "MG",
      self: "true",
      sort_by: "created_at",
      visibility: "private",
    });
    const answer = body as AccountVoicesResponse;
    expect(answer).toMatchObject({ status: "ok", total: 1, totalIsExact: true, hasMore: false });
    expect(answer.items).toEqual([
      {
        id: OWN_ID,
        title: "MG4",
        description: "",
        coverUrl: `https://public-platform.r2.fish.audio/coverimage/${OWN_ID}`,
        languages: ["zh"],
        tags: ["female"],
        samples: [],
        author: "我",
        likeCount: 0,
        taskCount: 94,
        visibility: "private",
        createdAt: "2026-11-02T08:05:32.771000Z",
      },
    ]);
  });

  test("without a search or visibility, lists every one from page 1", async () => {
    setEnv("FISH_API_KEY", "fk-default");
    installSettings();
    const api = own();
    await api.get("/accounts/fish/voices");
    expect(Object.fromEntries((api.sent[0] as Sent).url.searchParams)).toEqual({
      page_size: String(PAGE_SIZE),
      page_number: "1",
      self: "true",
      sort_by: "created_at",
    });
  });

  test("an added Fish account lists with its own key", async () => {
    writeCredentials({ accounts: { "fish-2": { provider: "fish", apiKey: "fk-second" } } });
    installSettings();
    const api = own();
    expect((await api.get("/accounts/fish-2/voices")).body.status).toBe("ok");
    expect((api.sent[0] as Sent).headers.get("authorization")).toBe("Bearer fk-second");
  });

  test("an account without a key lists nothing, and asks Fish nothing", async () => {
    const api = own();
    expect((await api.get("/accounts/fish/voices")).body).toEqual({
      status: "no-key",
      total: 0,
      totalIsExact: true,
      hasMore: false,
      items: [],
    });
    expect(api.sent).toEqual([]);
  });

  test("a key Fish refuses says so", async () => {
    setEnv("FISH_API_KEY", "fk-revoked");
    installSettings();
    const refused = fish(
      new Response("No permission -- see authorization schemes", { status: 401 }),
    );
    expect((await refused.get("/accounts/fish/voices")).body).toMatchObject({
      status: "refused",
      items: [],
    });
  });

  test("Fish failing is 502, and no answer at all 503", async () => {
    setEnv("FISH_API_KEY", "fk-default");
    installSettings();
    expect((await fish(json(500, {})).get("/accounts/fish/voices")).status).toBe(502);
    const { status, body } = await fish("network-error").get("/accounts/fish/voices");
    expect([status, body.error.code]).toEqual([503, "unavailable"]);
  });

  test("pages to Fish's 10,000th voice of an account", async () => {
    setEnv("FISH_API_KEY", "fk-default");
    installSettings();
    const api = own({ total: 20_000, items: [], has_more: true });
    expect(
      (await api.get(`/accounts/fish/voices?page=${10_000 / PAGE_SIZE - 1}`)).body.hasMore,
    ).toBe(true);
    expect((await api.get(`/accounts/fish/voices?page=${10_000 / PAGE_SIZE}`)).body.hasMore).toBe(
      false,
    );
    expect((await api.get(`/accounts/fish/voices?page=${10_000 / PAGE_SIZE + 1}`)).status).toBe(
      400,
    );
  });

  test("refuses an account that isn't Fish's, or a query it can't send, before asking Fish", async () => {
    setEnv("FISH_API_KEY", "fk-default");
    installSettings();
    const api = own();
    const unknown = await api.get("/accounts/ghost/voices");
    expect([unknown.status, unknown.body.error.code]).toEqual([404, "unknown-account"]);
    for (const path of [
      "/accounts/openai/voices",
      "/accounts/fish/voices?visibility=unlisted",
      `/accounts/fish/voices?q=${"x".repeat(101)}`,
      "/accounts/fish/voices?page=0",
    ]) {
      const { status, body } = await api.get(path);
      expect([path, status, body.error.code]).toEqual([path, 400, "bad-request"]);
    }
    expect(api.sent).toEqual([]);
  });
});
