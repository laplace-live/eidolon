// The MCP server's tools and tiers, then the wire behavior clients see, pinned byte for byte.
import { describe, expect, test } from "bun:test";
import { SlidingWindowQuota, type UserContext } from "@eidolon/access";
import { type LogRecord, logger } from "@eidolon/config";
import { createMcpHandler } from "../../src/mcp/index.ts";
import {
  projectChunk,
  projectFact,
  searchPersonaFactsDescription,
  searchStreamsDescription,
} from "../../src/mcp/tools.ts";
import {
  ACCEPT,
  buildHandler,
  CHUNK_HIT,
  callTool,
  FACT_HIT,
  FakeRetriever,
  isolateEnv,
  resultOf,
  rpc,
  withEnv,
} from "./helpers.ts";

isolateEnv();

const LOGGED_IN: UserContext = { mid: 12345678, uname: "奶绿粉丝", face: null, isLoggedIn: true };

test("test_project_fact_keeps_text_date_score_and_drops_vector", () => {
  const out = projectFact(FACT_HIT);
  expect(out).toStrictEqual({ text: "她喜欢喝奶茶", date: "2025-05-09", score: 0.92 });
  expect("vector" in out).toBe(false);
});

test("test_project_chunk_prefers_details_and_decodes_topics", () => {
  const out = projectChunk(CHUNK_HIT);
  expect(out.stream_date).toBe("2025-05-09");
  expect(out.content).toBe("聊了新游戏");
  expect(out.topics).toEqual(["游戏", "杂谈"]);
  expect(out.score).toBe(0.81);
  expect("vector" in out).toBe(false);
});

test("test_project_chunk_falls_back_to_summary_then_text", () => {
  expect(projectChunk({ summary: "s", text: "t" }).content).toBe("s");
  expect(projectChunk({ text: "t" }).content).toBe("t");
  expect(projectChunk({ text: "t" }).topics).toEqual([]);
});

test("test_tools_list_exposes_both_search_tools", async () => {
  const handler = await buildHandler();
  const result = await resultOf(rpc(handler, "tools/list", {}));
  const names = new Set(result.tools.map((tool: { name: string }) => tool.name));
  expect(names).toEqual(new Set(["search_persona_facts", "search_streams"]));
});

test("test_bare_path_answers_without_redirect", async () => {
  const handler = await buildHandler();
  const route = (request: Request) => handler.handle(request, "testclient");
  // Bun's routes match exactly, so the app registers both paths.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: { "/mcp": route, "/mcp/": route },
    fetch: () => new Response("Not Found", { status: 404 }),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_streams", arguments: { query: "游戏" } },
      }),
    });
    expect(response.status).toBe(200);
    expect((await resultOf(response)).structuredContent.count).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("test_search_persona_facts_returns_projected_results", async () => {
  const handler = await buildHandler();
  const result = await resultOf(callTool(handler, "search_persona_facts", { query: "奶茶" }));
  expect(result.isError).toBe(false);
  expect(result.structuredContent.count).toBe(1);
  expect(result.structuredContent.results[0]).toStrictEqual({
    text: "她喜欢喝奶茶",
    date: "2025-05-09",
    score: 0.92,
  });
});

test("test_search_streams_returns_projected_chunks", async () => {
  const handler = await buildHandler();
  const result = await resultOf(callTool(handler, "search_streams", { query: "游戏" }));
  expect(result.structuredContent.count).toBe(1);
  expect(result.structuredContent.results[0].content).toBe("聊了新游戏");
  expect(result.structuredContent.results[0].topics).toEqual(["游戏", "杂谈"]);
});

test("test_missing_index_returns_note_not_error", async () => {
  const handler = await buildHandler({ facts: new FakeRetriever([], { hasTable: false }) });
  const result = await resultOf(callTool(handler, "search_persona_facts", { query: "x" }));
  expect(result.isError).toBe(false);
  expect(result.structuredContent.count).toBe(0);
  expect(result.structuredContent.note).toContain("not built");
});

test("test_anonymous_rate_limit_blocks_after_quota", async () => {
  const handler = await buildHandler({ anonMax: 2 });
  const first = await resultOf(callTool(handler, "search_streams", { query: "a" }, { id: 1 }));
  expect(first.isError).toBe(false);
  const second = await resultOf(callTool(handler, "search_streams", { query: "b" }, { id: 2 }));
  expect(second.isError).toBe(false);
  const blocked = await resultOf(callTool(handler, "search_streams", { query: "c" }, { id: 3 }));
  expect(blocked.isError).toBe(true);
  expect(blocked.content[0].text).toContain("Rate limit exceeded for anonymous");
});

test("test_valid_token_uses_higher_authenticated_tier", async () => {
  const handler = await buildHandler({
    anonMax: 2,
    authMax: 50,
    resolveUser: async () => LOGGED_IN,
  });
  for (let i = 0; i < 5; i++) {
    const response = callTool(
      handler,
      "search_streams",
      { query: `q${i}` },
      { token: "good-token", id: i + 1 },
    );
    expect((await resultOf(response)).isError).toBe(false);
  }
});

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

describe("golden surface", () => {
  test("tools/list is the Python server's result, byte for byte", async () => {
    const handler = await buildHandler();
    const result = await resultOf(rpc(handler, "tools/list"));
    expect(JSON.stringify(result)).toBe(
      '{"tools":[{"description":"Search hand-compiled facts about the streamer 明前奶绿 — biography,\\ncharacter settings, preferences, recurring bits. Returns the most\\nrelevant facts with their source dates. Use for stable facts about who\\nshe is, not for recalling specific stream moments.","inputSchema":{"properties":{"query":{"title":"Query","type":"string"}},"required":["query"],"type":"object","title":"search_persona_factsArguments"},"name":"search_persona_facts","outputSchema":{"type":"object","additionalProperties":true,"title":"search_persona_factsDictOutput"}},{"description":"Search transcripts of 明前奶绿\'s past live streams. Returns the most\\nrelevant ~5-minute stream segments with their broadcast dates and\\ntopics. Use to recall what she said or did on a stream.","inputSchema":{"properties":{"query":{"title":"Query","type":"string"}},"required":["query"],"type":"object","title":"search_streamsArguments"},"name":"search_streams","outputSchema":{"type":"object","additionalProperties":true,"title":"search_streamsDictOutput"}}]}',
    );
  });

  test("descriptions and instructions hash to the shipped bytes", async () => {
    expect(sha256(searchPersonaFactsDescription("明前奶绿"))).toBe(
      "079a32c66e555f0d4327e15b0598fc9063c4f8be1766941df2c7589c690de19a",
    );
    expect(sha256(searchStreamsDescription("明前奶绿"))).toBe(
      "afa38eee3883231c463840beb91c406cd89aa138876377061bab5e3049b5fdbb",
    );
    const handler = await buildHandler();
    const init = await resultOf(
      rpc(handler, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      }),
    );
    expect(sha256(init.instructions)).toBe(
      "9997c351f1338b501a74c6f121289b36f8cfa580833d205ed5f8ab635a515fe0",
    );
  });

  test("initialize echoes a supported version and answers the latest otherwise", async () => {
    const handler = await buildHandler();
    const initialize = (protocolVersion: string) =>
      resultOf(
        rpc(handler, "initialize", {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        }),
      );
    expect(await initialize("2025-06-18")).toEqual({
      capabilities: {
        experimental: {},
        prompts: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
        tools: { listChanged: false },
      },
      instructions:
        "Retrieval over the streamer 明前奶绿's hand-compiled persona facts and past live-stream transcripts. Read-only.",
      protocolVersion: "2025-06-18",
      serverInfo: { name: "laplace-eidolon", version: "" },
    });
    expect((await initialize("2025-03-26")).protocolVersion).toBe("2025-03-26");
    expect((await initialize("1999-01-01")).protocolVersion).toBe("2025-11-25");
  });

  test("ping, the empty listings and a notification", async () => {
    const handler = await buildHandler();
    expect(await resultOf(rpc(handler, "ping"))).toEqual({});
    expect(await resultOf(rpc(handler, "ping", { x: 1 }))).toEqual({});
    expect(await resultOf(rpc(handler, "resources/list", {}))).toEqual({ resources: [] });
    expect(await resultOf(rpc(handler, "resources/templates/list", {}))).toEqual({
      resourceTemplates: [],
    });
    expect(await resultOf(rpc(handler, "prompts/list", {}))).toEqual({ prompts: [] });
    const notified = await rpc(handler, "notifications/initialized", undefined, { id: null });
    expect(notified.status).toBe(202);
    expect(await notified.text()).toBe("");
    const clientResult = await handler.handle(
      new Request("http://localhost/mcp/", {
        method: "POST",
        headers: { "content-type": "application/json", accept: ACCEPT },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} }),
      }),
      "testclient",
    );
    expect(clientResult.status).toBe(202);
  });

  test("content text is pydantic's indent-2 JSON", async () => {
    const handler = await buildHandler();
    const facts = await resultOf(callTool(handler, "search_persona_facts", { query: "奶茶" }));
    expect(facts.content).toEqual([
      {
        type: "text",
        text: '{\n  "count": 1,\n  "results": [\n    {\n      "text": "她喜欢喝奶茶",\n      "date": "2025-05-09",\n      "score": 0.92\n    }\n  ]\n}',
      },
    ]);
    const streams = await resultOf(callTool(handler, "search_streams", { query: "游戏" }));
    expect(streams.content[0].text).toBe(
      '{\n  "count": 1,\n  "results": [\n    {\n      "stream_date": "2025-05-09",\n      "content": "聊了新游戏",\n      "topics": [\n        "游戏",\n        "杂谈"\n      ],\n      "score": 0.81\n    }\n  ]\n}',
    );
  });

  test("scores print as Python floats in the text, undated facts as null", async () => {
    const facts = new FakeRetriever([
      { text: "  无日期  ", date: "", _distance: 1 },
      { text: "tiny", date: "2025-01-01", _relevance_score: 5.2e-6 },
      { text: "none", date: "2025-01-02" },
    ]);
    const handler = await buildHandler({ facts });
    const result = await resultOf(callTool(handler, "search_persona_facts", { query: "q" }));
    expect(result.structuredContent.results).toEqual([
      { text: "无日期", date: null, score: 1 },
      { text: "tiny", date: "2025-01-01", score: 5.2e-6 },
      { text: "none", date: "2025-01-02", score: null },
    ]);
    expect(result.content[0].text).toBe(
      '{\n  "count": 3,\n  "results": [\n    {\n      "text": "无日期",\n      "date": null,\n      "score": 1.0\n    },\n    {\n      "text": "tiny",\n      "date": "2025-01-01",\n      "score": 5.2e-6\n    },\n    {\n      "text": "none",\n      "date": "2025-01-02",\n      "score": null\n    }\n  ]\n}',
    );
  });

  test("missing-index notes, keyed count, results, note", async () => {
    const handler = await buildHandler({
      facts: new FakeRetriever([], { hasTable: false }),
      streams: new FakeRetriever([], { hasTable: false }),
    });
    const facts = await resultOf(callTool(handler, "search_persona_facts", { query: "x" }));
    expect(JSON.stringify(facts.structuredContent)).toBe(
      '{"count":0,"results":[],"note":"Persona-facts index is not built on this server."}',
    );
    expect(facts.content[0].text).toBe(
      '{\n  "count": 0,\n  "results": [],\n  "note": "Persona-facts index is not built on this server."\n}',
    );
    const streams = await resultOf(callTool(handler, "search_streams", { query: "x" }));
    expect(streams.structuredContent.note).toBe(
      "Stream-archive index is not built on this server.",
    );
  });
});

describe("tool errors", () => {
  test("an unknown tool is an error result and costs no quota", async () => {
    const handler = await buildHandler({ anonMax: 1 });
    const unknown = await resultOf(callTool(handler, "nope", { query: "x" }));
    expect(unknown).toEqual({
      content: [{ type: "text", text: "Unknown tool: nope" }],
      isError: true,
    });
    expect((await resultOf(callTool(handler, "search_streams", { query: "x" }))).isError).toBe(
      false,
    );
  });

  test("invalid arguments get pydantic's text and cost no quota", async () => {
    const handler = await buildHandler({ anonMax: 1 });
    const text = async (args: Record<string, unknown>) =>
      (await resultOf(callTool(handler, "search_streams", args))).content[0].text;
    const prefix =
      "Error executing tool search_streams: 1 validation error for search_streamsArguments\nquery\n  ";
    expect(await text({})).toBe(
      `${prefix}Field required [type=missing, input_value={}, input_type=dict]\n    For further information visit https://errors.pydantic.dev/2.13/v/missing`,
    );
    expect(await text({ extra: 1, b: [1, 2] })).toBe(
      `${prefix}Field required [type=missing, input_value={'extra': 1, 'b': [1, 2]}, input_type=dict]\n    For further information visit https://errors.pydantic.dev/2.13/v/missing`,
    );
    const stringType = (shown: string) =>
      `${prefix}Input should be a valid string [type=string_type, ${shown}]\n    For further information visit https://errors.pydantic.dev/2.13/v/string_type`;
    expect(await text({ query: 5 })).toBe(stringType("input_value=5, input_type=int"));
    expect(await text({ query: 5.5 })).toBe(stringType("input_value=5.5, input_type=float"));
    expect(await text({ query: true })).toBe(stringType("input_value=True, input_type=bool"));
    expect(await text({ query: null })).toBe(stringType("input_value=None, input_type=NoneType"));
    expect(await text({ query: [1, "x"] })).toBe(
      stringType("input_value=[1, 'x'], input_type=list"),
    );
    expect(await text({ query: { a: 1 } })).toBe(
      stringType("input_value={'a': 1}, input_type=dict"),
    );
    expect(await text({ query: ["x".repeat(80)] })).toBe(
      stringType(
        "input_value=['xxxxxxxxxxxxxxxxxxxxxxx...xxxxxxxxxxxxxxxxxxxxxx'], input_type=list",
      ),
    );
    expect(await text({ query: ["奶茶", "é", "\n"] })).toBe(
      stringType("input_value=['奶茶', 'é', '\\n'], input_type=list"),
    );
    expect((await resultOf(callTool(handler, "search_streams", { query: "ok" }))).isError).toBe(
      false,
    );
  });

  test("arguments: null and a missing arguments key read as {}", async () => {
    const handler = await buildHandler();
    for (const params of [
      { name: "search_streams", arguments: null },
      { name: "search_streams" },
    ]) {
      const result = await resultOf(rpc(handler, "tools/call", params));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Field required [type=missing, input_value={}");
    }
  });

  test("malformed tools/call params are -32602 Invalid request parameters", async () => {
    const handler = await buildHandler();
    for (const params of [
      { name: 5, arguments: {} },
      { name: "search_streams", arguments: [1] },
      { name: "search_streams", arguments: "x" },
      undefined,
    ]) {
      const response = await rpc(handler, "tools/call", params);
      expect(response.status).toBe(200);
      expect((await response.json()).error).toEqual({
        code: -32602,
        message: "Invalid request parameters",
        data: "",
      });
    }
  });

  test("extra arguments are ignored and an empty query is searched", async () => {
    const streams = new FakeRetriever([CHUNK_HIT]);
    const handler = await buildHandler({ streams });
    const extra = await resultOf(callTool(handler, "search_streams", { query: " x ", extra: 1 }));
    expect(extra.isError).toBe(false);
    expect((await resultOf(callTool(handler, "search_streams", { query: "" }))).isError).toBe(
      false,
    );
    expect(streams.calls.map((call) => call.query)).toEqual([" x ", ""]);
  });

  test("an unexpected exception reaches the client only as the generic text", async () => {
    const streams = new FakeRetriever([], {
      search: () => Promise.reject(new Error("secret internals")),
    });
    const handler = await buildHandler({ streams });
    const result = await resultOf(callTool(handler, "search_streams", { query: "x" }));
    expect(result).toEqual({
      content: [{ type: "text", text: "Error executing tool search_streams" }],
      isError: true,
    });
  });

  test("the rate-limit texts, per tier", async () => {
    const anon = await buildHandler({ anonMax: 0 });
    expect((await resultOf(callTool(anon, "search_streams", { query: "x" }))).content[0].text).toBe(
      "Error executing tool search_streams: Rate limit exceeded for anonymous access. Retry after 3600 seconds.",
    );
    const auth = await buildHandler({ authMax: 0, resolveUser: async () => LOGGED_IN });
    const call = callTool(auth, "search_persona_facts", { query: "x" }, { token: "good" });
    expect((await resultOf(call)).content[0].text).toBe(
      "Error executing tool search_persona_facts: Rate limit exceeded for authenticated access. Retry after 3600 seconds.",
    );
  });

  test("the first denial in a fresh window says 3599 seconds", async () => {
    let now = 100;
    const handler = await createMcpHandler({
      personaFactsRetriever: new FakeRetriever([FACT_HIT]),
      streamArchiveRetriever: new FakeRetriever([CHUNK_HIT]),
      anonQuota: new SlidingWindowQuota(1, 3600, () => now),
      authQuota: new SlidingWindowQuota(1, 3600, () => now),
    });
    expect((await resultOf(callTool(handler, "search_streams", { query: "a" }))).isError).toBe(
      false,
    );
    now += 0.25;
    const denied = await resultOf(callTool(handler, "search_streams", { query: "b" }));
    expect(denied.content[0].text).toEndWith("Retry after 3599 seconds.");
  });

  test("an unknown method is -32601 carrying the method", async () => {
    const handler = await buildHandler();
    for (const method of ["foo/bar", "logging/setLevel", "tasks/list"]) {
      const body = await (await rpc(handler, method, {})).json();
      expect(body.error).toEqual({ code: -32601, message: "Method not found", data: method });
    }
  });
});

describe("tiers and quotas", () => {
  test("a missing index still spends the slot", async () => {
    const handler = await buildHandler({
      anonMax: 1,
      facts: new FakeRetriever([], { hasTable: false }),
    });
    expect(
      (await resultOf(callTool(handler, "search_persona_facts", { query: "x" }))).isError,
    ).toBe(false);
    const limited = await resultOf(callTool(handler, "search_streams", { query: "x" }));
    expect(limited.content[0].text).toContain("Rate limit exceeded for anonymous access");
  });

  test("the handshake and listings are free", async () => {
    const handler = await buildHandler({ anonMax: 1 });
    await resultOf(
      rpc(handler, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      }),
    );
    await resultOf(rpc(handler, "tools/list", {}));
    await resultOf(rpc(handler, "ping"));
    expect((await resultOf(callTool(handler, "search_streams", { query: "x" }))).isError).toBe(
      false,
    );
  });

  test("a bad token shares its IP's anonymous bucket", async () => {
    const handler = await buildHandler({
      anonMax: 1,
      resolveUser: async () => ({ mid: null, uname: null, face: null, isLoggedIn: false }),
    });
    const tokened = await resultOf(
      callTool(handler, "search_streams", { query: "a" }, { token: "bad" }),
    );
    expect(tokened.isError).toBe(false);
    const plain = await resultOf(callTool(handler, "search_streams", { query: "b" }));
    expect(plain.content[0].text).toContain("Rate limit exceeded for anonymous access");
    const elsewhere = callTool(handler, "search_streams", { query: "c" }, { clientIp: "10.0.0.2" });
    expect((await resultOf(elsewhere)).isError).toBe(false);
  });

  test("only a well-formed bearer token is validated", async () => {
    const seen: string[] = [];
    const handler = await buildHandler({
      resolveUser: async (token) => {
        seen.push(token);
        return LOGGED_IN;
      },
    });
    for (const authorization of ["Basic Zm9v", "Bearer", "Bearer   ", "bearer   good  "]) {
      const call = callTool(
        handler,
        "search_streams",
        { query: "x" },
        { headers: { authorization } },
      );
      expect((await resultOf(call)).isError).toBe(false);
    }
    expect(seen).toEqual(["good"]);
  });

  test("the authenticated tier keys by mid and never falls back to anonymous", async () => {
    const handler = await buildHandler({
      anonMax: 1,
      authMax: 1,
      resolveUser: async (token) => (token === "a" ? LOGGED_IN : { ...LOGGED_IN, mid: 99 }),
    });
    const call = (token?: string) =>
      resultOf(callTool(handler, "search_streams", { query: "q" }, token ? { token } : {}));
    expect((await call("a")).isError).toBe(false);
    expect((await call("a")).content[0].text).toContain("for authenticated access");
    expect((await call("b")).isError).toBe(false);
    expect((await call()).isError).toBe(false);
    expect((await call()).content[0].text).toContain("for anonymous access");
  });

  test("search params are captured at startup and passed to search", async () => {
    const facts = new FakeRetriever([FACT_HIT]);
    const streams = new FakeRetriever([CHUNK_HIT]);
    const handler = await buildHandler({ facts, streams });
    await withEnv({ PERSONA_FACTS_CANDIDATES: "7" }, async () => {
      await resultOf(callTool(handler, "search_persona_facts", { query: "a" }));
    });
    await resultOf(callTool(handler, "search_streams", { query: "b" }));
    expect(facts.calls).toEqual([{ query: "a", options: { candidates: 30, topK: 8 } }]);
    expect(streams.calls).toEqual([{ query: "b", options: { candidates: 15, topK: 3 } }]);
  });

  test("quotas come from env, clamped, and the startup line reports them", async () => {
    const lines: string[] = [];
    const removeSink = logger.addSink((record: LogRecord) => {
      if (record.message.startsWith("[mcp] Streamable")) lines.push(record.message);
    });
    const build = () =>
      createMcpHandler({
        personaFactsRetriever: new FakeRetriever([]),
        streamArchiveRetriever: new FakeRetriever([]),
      });
    try {
      await withEnv(
        {
          EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR: "",
          EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR: "",
          EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC: "",
        },
        build,
      );
      await withEnv(
        {
          EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR: "-5",
          EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR: "abc",
          EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC: "0",
        },
        build,
      );
    } finally {
      removeSink();
    }
    expect(lines).toEqual([
      "[mcp] Streamable HTTP server mounted at /mcp/ (anon 20/3600s, auth 120/3600s)",
      "[mcp] Streamable HTTP server mounted at /mcp/ (anon 0/1s, auth 120/1s)",
    ]);
  });

  test("with WORKERS_BASE_URL unset, a token is anonymous by IP", async () => {
    const handler = await createMcpHandler({
      personaFactsRetriever: new FakeRetriever([FACT_HIT]),
      streamArchiveRetriever: new FakeRetriever([CHUNK_HIT]),
      anonQuota: new SlidingWindowQuota(1, 3600),
      authQuota: new SlidingWindowQuota(50, 3600),
    });
    const tokened = await resultOf(
      callTool(handler, "search_streams", { query: "a" }, { token: "t" }),
    );
    expect(tokened.isError).toBe(false);
    const plain = await resultOf(callTool(handler, "search_streams", { query: "b" }));
    expect(plain.content[0].text).toContain("Rate limit exceeded for anonymous access");
  });
});
