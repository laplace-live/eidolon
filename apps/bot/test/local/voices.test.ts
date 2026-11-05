// GET voices/search through a fake fetch: Fish's public search, sent without the key, and its
// results mapped to absolute https URLs with anything a call couldn't use left out.
import "../../../../packages/config/test/isolated-guard.ts";
import { describe, expect, test } from "bun:test";
import type { MemoryAdmin } from "@eidolon/memory";
import type { VoiceSearchResponse } from "../../src/local/api.ts";
import type { LocalApp } from "../../src/local/router.ts";
import { PAGE_SIZE, voiceOf, voicesRoutes } from "../../src/local/routes/voices.ts";

const app = {
  port: () => 7860,
  activeCalls: () => 0,
  restart: () => {},
  onStop: () => {},
  memoryAdmin: (): MemoryAdmin | null => null,
} satisfies LocalApp;

const ID = "0123456789abcdef0123456789abcdef";

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
};

interface Sent {
  readonly url: URL;
  readonly headers: Headers;
}

function search(reply: Response | "network-error") {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    sent.push({ url: new URL(String(input)), headers: new Headers(init.headers) });
    if (reply === "network-error") throw new TypeError("fetch failed");
    return reply.clone();
  }) as typeof fetch;
  const [spec] = voicesRoutes(app, { fetch: fetchImpl });
  return {
    sent,
    async get(query: string) {
      const url = new URL(`http://127.0.0.1:7860/api/local/voices/search${query}`);
      const response = await (spec?.handler(new Request(url), {
        url,
        params: {},
        server: undefined as never,
        caller: "cookie",
      }) as Promise<Response>);
      return { status: response.status, body: await response.json() };
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("voices/search", () => {
  test("asks Fish's public search, with no key, by title, language and page", async () => {
    const fish = search(
      json(200, { total: 1, items: [ITEM], has_more: false, total_is_exact: true }),
    );
    const { status, body } = await fish.get("?q=%20温柔%20&language=zh&page=2");
    expect(status).toBe(200);
    expect(fish.sent).toHaveLength(1);
    const sent = fish.sent[0] as Sent;
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
      },
    ]);
  });

  test("without a query or language, searches the whole library from page 1", async () => {
    const fish = search(json(200, { total: 0, items: [], has_more: false }));
    await fish.get("");
    expect(Object.fromEntries((fish.sent[0] as Sent).url.searchParams)).toEqual({
      page_size: String(PAGE_SIZE),
      page_number: "1",
    });
  });

  test("a capped count says so, and paging stops where Fish stops answering", async () => {
    const capped = search(
      json(200, { total: 1000, items: [], has_more: true, total_is_exact: false }),
    );
    expect((await capped.get("?page=1")).body).toMatchObject({
      total: 1000,
      totalIsExact: false,
      hasMore: true,
    });
    expect((await capped.get(`?page=${1000 / PAGE_SIZE}`)).body.hasMore).toBe(false);
    expect((await capped.get(`?page=${1000 / PAGE_SIZE + 1}`)).status).toBe(400);
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

  test("refuses a query, language or page it can't send", async () => {
    const fish = search(json(200, { total: 0, items: [] }));
    for (const query of [
      `?q=${"x".repeat(101)}`,
      "?q=a%0Ab",
      "?language=zh-CN",
      "?language=fr",
      "?page=0",
      "?page=-1",
      "?page=abc",
    ]) {
      const { status, body } = await fish.get(query);
      expect([query, status, body.error.code]).toEqual([query, 400, "bad-request"]);
    }
    expect(fish.sent).toEqual([]);
  });

  test("Fish failing is 502, and no answer at all 503", async () => {
    const failing = search(json(500, { message: "down" }));
    expect((await failing.get("")).status).toBe(502);
    const silent = search("network-error");
    const { status, body } = await silent.get("");
    expect([status, body.error.code]).toEqual([503, "unavailable"]);
  });
});
