// The search role's client against a local server standing in for OpenRouter's chat completions,
// answering as the billed probe of 2026-11-17 saw it answer.
import { openrouterHeaders } from "@eidolon/config";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type ServedFetch, serveFetch } from "../../config/test/http.ts";
import {
  openRouterSearcher,
  ProviderHttpError,
  type Selection,
  select,
  type UsageRecord,
} from "../src/index.ts";

interface Seen {
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
}

/** What the server answers next: a status and a JSON body, or never. */
let answer: { status: number; body: unknown } | "hang" = { status: 200, body: {} };
let seen: Seen[] = [];
let server: ServedFetch;

beforeAll(async () => {
  server = await serveFetch(async (request) => {
    if (new URL(request.url).pathname !== "/api/v1/chat/completions") {
      return new Response("not found", { status: 404 });
    }
    seen.push({
      body: (await request.json()) as Record<string, unknown>,
      headers: request.headers,
    });
    if (answer === "hang") return new Promise<Response>(() => {});
    return Response.json(answer.body, { status: answer.status });
  });
});

afterAll(() => server.stop());

beforeEach(() => {
  seen = [];
});

function selection(): Selection {
  const values: Record<string, string> = {
    ASSISTANT_SEARCH_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "or-test",
    OPENROUTER_API_BASE: `${server.url}/api/v1`,
  };
  const chosen = select("search", (name) => values[name]);
  if (chosen === null) throw new Error("no search role");
  return chosen;
}

const citation = (url: string, title: string, content: string) => ({
  type: "url_citation",
  url_citation: { url, title, start_index: 0, end_index: 0, content, uncited: true },
});

/** A reply as OpenRouter gave one: its annotations, and a usage block counting `searches`. */
function reply(
  annotations: readonly unknown[],
  searches: number,
  cost: number | null = 0.0072882385,
): unknown {
  return {
    id: "gen-1",
    model: "openai/gpt-6-luna",
    provider: "OpenAI",
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: "[a](https://a.example/)", annotations },
      },
    ],
    usage: {
      prompt_tokens: 1668,
      completion_tokens: 186,
      total_tokens: 1854,
      ...(cost === null ? {} : { cost }),
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1254 },
      completion_tokens_details: { reasoning_tokens: 0 },
      server_tool_use_details: {
        web_search_requests: searches,
        tool_calls_requested: searches,
        tool_calls_executed: searches,
      },
    },
  };
}

describe("openRouterSearcher", () => {
  test("asks a carrier with reasoning off for one forced search, with the engine, count, excerpt size and sites", async () => {
    answer = { status: 200, body: reply([], 1) };
    const search = openRouterSearcher(selection());
    await search(
      { query: "Bun 1.3 release notes", count: 3, domains: ["bun.com"] },
      AbortSignal.timeout(5000),
    );
    await search({ query: "Bun 最新版本", count: 5, domains: [] }, AbortSignal.timeout(5000));
    const [first, second] = seen;
    expect(first?.body).toEqual({
      usage: { include: true },
      model: "openai/gpt-6-luna",
      reasoning: { effort: "none" },
      max_tokens: 1024,
      max_tool_calls: 1,
      tool_choice: "required",
      stream: false,
      tools: [
        {
          type: "openrouter:web_search",
          parameters: {
            engine: "exa",
            max_results: 3,
            max_total_results: 3,
            max_uses: 1,
            max_characters: 1000,
            allowed_domains: ["bun.com"],
          },
        },
      ],
      messages: [
        {
          role: "system",
          content:
            "Search the web once for the user's message with the web search tool. Then list every result you got, one per line, as [title](url), and nothing else.",
        },
        { role: "user", content: "Bun 1.3 release notes" },
      ],
    });
    expect(first?.headers.get("authorization")).toBe("Bearer or-test");
    // Attributed as the bot's own requests are.
    for (const [name, value] of Object.entries(openrouterHeaders())) {
      expect(first?.headers.get(name)).toBe(value);
    }
    // Any site: no allowed_domains at all.
    const tools = second?.body.tools as { parameters: Record<string, unknown> }[];
    expect(tools[0]?.parameters).not.toHaveProperty("allowed_domains");
    expect(tools[0]?.parameters.max_total_results).toBe(5);
  });

  test("reads the url_citation annotations as results, in order, once per URL", async () => {
    answer = {
      status: 200,
      body: reply(
        [
          citation("https://bun.com/blog/bun-v1.3", "Bun 1.3 | Bun Blog", "Bun 1.3 turns Bun"),
          { type: "file_citation", file_citation: { file_id: "f" } },
          citation("https://github.com/oven-sh/bun/releases", "Releases", ""),
          // Cited twice: the first title stays, and the longer excerpt.
          citation("https://bun.com/blog/bun-v1.3", "Bun 1.3", "Bun 1.3 turns Bun into a runtime"),
          citation("", "No URL", "dropped"),
        ],
        1,
      ),
    };
    const outcome = await openRouterSearcher(selection())(
      { query: "bun", count: 5, domains: [] },
      AbortSignal.timeout(5000),
    );
    expect(outcome).toEqual({
      engine: "exa",
      searches: 1,
      results: [
        {
          title: "Bun 1.3 | Bun Blog",
          url: "https://bun.com/blog/bun-v1.3",
          excerpt: "Bun 1.3 turns Bun into a runtime",
        },
        { title: "Releases", url: "https://github.com/oven-sh/bun/releases", excerpt: "" },
      ],
    });
  });

  test("reports one record to its tap: the search role, the engine as model, one search and the carrier's tokens, at OpenRouter's cost", async () => {
    answer = { status: 200, body: reply([citation("https://a.example/", "A", "a")], 1) };
    const records: UsageRecord[] = [];
    await openRouterSearcher(selection(), { tap: (record) => records.push(record) })(
      { query: "a", count: 5, domains: [] },
      AbortSignal.timeout(5000),
    );
    expect(records).toEqual([
      expect.objectContaining({
        role: "search",
        category: "search",
        provider: "openrouter",
        model: "exa",
        units: {
          inputTokens: 414,
          cachedTokens: 0,
          cacheWriteTokens: 1254,
          outputTokens: 186,
          searches: 1,
        },
        costUsd: 0.0072882385,
        costSource: "reported",
      }),
    ]);
  });

  test("counts a request whose carrier asked for three searches as the one it was billed for", async () => {
    answer = { status: 200, body: reply([citation("https://a.example/", "A", "a")], 3, 0.00727) };
    const records: UsageRecord[] = [];
    const outcome = await openRouterSearcher(selection(), { tap: (r) => records.push(r) })(
      { query: "Bun, Deno and Node", count: 5, domains: [] },
      AbortSignal.timeout(5000),
    );
    expect(outcome.searches).toBe(1);
    expect(records.map((record) => [record.units.searches, record.costUsd])).toEqual([
      [1, 0.00727],
    ]);
  });

  test("with no cost in the reply, estimates the search at Exa's $7 per 1,000", async () => {
    answer = { status: 200, body: reply([citation("https://a.example/", "A", "a")], 1, null) };
    const records: UsageRecord[] = [];
    await openRouterSearcher(selection(), { tap: (r) => records.push(r) })(
      { query: "a", count: 5, domains: [] },
      AbortSignal.timeout(5000),
    );
    expect(records.map((record) => [record.costSource, record.costUsd])).toEqual([
      ["estimated", 0.007],
    ]);
  });

  test("a reply in which no search ran is an error, and what its carrier used is still reported", async () => {
    answer = { status: 200, body: reply([], 0, 0.00029) };
    const records: UsageRecord[] = [];
    const search = openRouterSearcher(selection(), { tap: (r) => records.push(r) });
    await expect(
      search({ query: "a", count: 5, domains: [] }, AbortSignal.timeout(5000)),
    ).rejects.toThrow("The search didn't run");
    expect(records.map((record) => [record.units.searches, record.costUsd])).toEqual([
      [0, 0.00029],
    ]);
  });

  test("a refusal throws the provider's status and message, and reports nothing", async () => {
    answer = { status: 402, body: { error: { code: 402, message: "Insufficient credits" } } };
    const records: UsageRecord[] = [];
    const search = openRouterSearcher(selection(), { tap: (r) => records.push(r) });
    const failure = await search(
      { query: "a", count: 5, domains: [] },
      AbortSignal.timeout(5000),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderHttpError);
    expect((failure as Error).message).toBe("OpenRouter answered 402: Insufficient credits");
    expect(records).toEqual([]);
  });

  test("stops at its signal", async () => {
    answer = "hang";
    const controller = new AbortController();
    const search = openRouterSearcher(selection());
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    await expect(
      search({ query: "a", count: 5, domains: [] }, controller.signal),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
