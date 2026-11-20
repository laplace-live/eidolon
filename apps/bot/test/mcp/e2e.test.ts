// The SDK's own client against the handler behind the bot's routing, mounted as the app mounts it.
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vitest";
import { serveRoutes } from "../serve.ts";
import { buildHandler, isolateEnv } from "./helpers.ts";

isolateEnv();

test("an SDK client connects, lists and calls; the GET 405 raises nothing", async () => {
  const handler = await buildHandler();
  const route = (request: Request) => handler.handle(request, "127.0.0.1");
  const server = await serveRoutes(
    { "/mcp": route, "/mcp/": route },
    () => new Response("Not Found", { status: 404 }),
  );
  // The client opens its GET stream in the background after notifications/initialized.
  const getAnswered = Promise.withResolvers<number>();
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method === "GET") getAnswered.resolve(response.status);
      return response;
    },
  });
  const errors: unknown[] = [];
  const client = new Client({ name: "e2e", version: "0" });
  client.onerror = (error) => errors.push(error);
  try {
    await client.connect(transport);
    expect(client.getServerVersion()).toEqual({ name: "laplace-eidolon", version: "" });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["search_persona_facts", "search_streams"]);
    const result = await client.callTool({ name: "search_streams", arguments: { query: "游戏" } });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      count: 1,
      results: [
        { stream_date: "2025-05-09", content: "聊了新游戏", topics: ["游戏", "杂谈"], score: 0.81 },
      ],
    });
    expect(await getAnswered.promise).toBe(405);
    await delay(0);
  } finally {
    await client.close();
    await server.stop();
  }
  expect(errors).toEqual([]);
});
