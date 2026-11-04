// Behavior that needs @eidolon/retrieval's real retriever factories and search parameters.
import { expect, test } from "bun:test";
import { SlidingWindowQuota } from "@eidolon/access";
import { createMcpHandler } from "../../src/mcp/index.ts";
import {
  CHUNK_HIT,
  callTool,
  FACT_HIT,
  FakeRetriever,
  isolateEnv,
  resultOf,
  withEnv,
} from "./helpers.ts";

isolateEnv();

test("default retrievers over a missing db answer the notes", async () => {
  const handler = await createMcpHandler({
    dbPath: "/nonexistent/lancedb",
    anonQuota: new SlidingWindowQuota(5, 3600),
    authQuota: new SlidingWindowQuota(5, 3600),
  });
  const facts = await resultOf(callTool(handler, "search_persona_facts", { query: "x" }));
  expect(facts.structuredContent).toEqual({
    count: 0,
    results: [],
    note: "Persona-facts index is not built on this server.",
  });
  const streams = await resultOf(callTool(handler, "search_streams", { query: "x" }));
  expect(streams.structuredContent.note).toBe("Stream-archive index is not built on this server.");
});

test("candidate counts come from env unclamped", async () => {
  const facts = new FakeRetriever([FACT_HIT]);
  const streams = new FakeRetriever([CHUNK_HIT]);
  const handler = await withEnv(
    { PERSONA_FACTS_CANDIDATES: "0", STREAM_ARCHIVE_CANDIDATES: "500" },
    () =>
      createMcpHandler({
        personaFactsRetriever: facts,
        streamArchiveRetriever: streams,
        anonQuota: new SlidingWindowQuota(5, 3600),
        authQuota: new SlidingWindowQuota(5, 3600),
      }),
  );
  await resultOf(callTool(handler, "search_persona_facts", { query: "a" }));
  await resultOf(callTool(handler, "search_streams", { query: "b" }));
  expect(facts.calls[0]?.options).toEqual({ candidates: 0, topK: 8 });
  expect(streams.calls[0]?.options).toEqual({ candidates: 500, topK: 3 });
});
