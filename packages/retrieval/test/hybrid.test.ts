import { openRouterRerank, type RerankModel, type RerankResult } from "@eidolon/providers";
import { describe, expect, test } from "vitest";
import {
  hybridSearch,
  rrfFuse,
  type SearchRow,
  scoreOf,
  tokenizeZhQuery,
  vectorSearch,
  type ZvecTable,
} from "../src/index.ts";
import { captureLogs, FACT_ROWS, fakeFetch, isolateEnv, memoryTable, messages } from "./helpers.ts";

const records = captureLogs();
isolateEnv();

const leg = (ids: number[], key: "_distance" | "_score") =>
  ids.map((id, i) => ({ id: `r${id}`, [key]: i, _rowid: String(id) }));

describe("rrfFuse", () => {
  test("ranks from 1, sums vector then FTS, stable float32 order", () => {
    const fused = rrfFuse(leg([1, 2, 3], "_distance"), leg([3, 4, 1], "_score"));
    expect(fused.map((r) => r.id)).toEqual(["r1", "r3", "r2", "r4"]);
    expect(fused.map((r) => r._relevance_score)).toEqual([
      0.03226645663380623, 0.03226645663380623, 0.016129031777381897, 0.016129031777381897,
    ]);
    const second = rrfFuse(leg([10, 11], "_distance"), leg([12, 11], "_score"));
    expect(second.map((r) => r.id)).toEqual(["r11", "r10", "r12"]);
    expect(second.map((r) => r._relevance_score)).toEqual([
      0.032258063554763794, 0.016393441706895828, 0.016393441706895828,
    ]);
  });

  test("an empty FTS leg keeps vector order at 1/(rank + 60)", () => {
    const fused = rrfFuse(leg([5, 6, 7], "_distance"), []);
    expect(fused.map((r) => r._relevance_score)).toEqual([1 / 61, 1 / 62, 1 / 63].map(Math.fround));
  });

  test("drops the leg columns and keeps the vector-leg twin", () => {
    const vectorRows = [{ id: "v", text: "from vector", _distance: 0.1, _rowid: "1" }];
    const ftsRows = [{ id: "v", text: "from fts", _score: 9, _rowid: "1" }];
    expect(rrfFuse(vectorRows, ftsRows)).toEqual([
      { id: "v", text: "from vector", _relevance_score: Math.fround(2 / 61) },
    ]);
  });
});

test("scoreOf", () => {
  expect(scoreOf({ _relevance_score: 0, _distance: 3 })).toBe(0);
  expect(scoreOf({ _distance: 0.5 })).toBe(0.5);
  expect(scoreOf({})).toBeNull();
  expect(scoreOf({ _relevance_score: null, _distance: 1 })).toBe(1);
});

const QUERY = { vector: [1, 0, 0, 0], queryText: "坚果体重" };
const COLUMNS = ["id", "source", "date", "floor", "text", "tokens"];

function recordingReranker(
  answer: (documents: readonly unknown[]) => RerankResult[] | Promise<RerankResult[]>,
): RerankModel & { calls: { query: string; documents: readonly unknown[] }[] } {
  const calls: { query: string; documents: readonly unknown[] }[] = [];
  return {
    provider: "fake",
    model: "fake",
    calls,
    async rerank(query, documents) {
      calls.push({ query, documents });
      return answer(documents);
    },
  };
}

describe("hybridSearch on a Zvec table", () => {
  test("one candidate per leg fuses to the shared top row", async () => {
    const { table } = await memoryTable();
    const rows = await hybridSearch(table, { ...QUERY, candidates: 1, rerank: false });
    const { vector: _, ...columns } = FACT_ROWS[0] as (typeof FACT_ROWS)[0];
    expect(rows).toEqual([{ ...columns, _relevance_score: Math.fround(2 / 61) }]);
  });

  test("rows carry the schema's columns minus vector, then the score", async () => {
    const { table } = await memoryTable();
    const rows = await hybridSearch(table, { ...QUERY, candidates: 10, rerank: false });
    expect(rows.length).toBe(5);
    expect(rows[0]?.id).toBe("f0");
    for (const row of rows) expect(Object.keys(row)).toEqual([...COLUMNS, "_relevance_score"]);
  });

  test("where prefilters both legs across equality, range, LIKE and IN clauses", async () => {
    const { table } = await memoryTable([
      ...FACT_ROWS,
      {
        id: "f5",
        source: "o'brien.txt",
        date: "2026-05-15",
        floor: 5,
        text: "坚果零食",
        tokens: "坚果 零食",
        vector: [0.8, 0.2, 0, 0],
      },
    ]);
    const exact = await hybridSearch(table, {
      ...QUERY,
      candidates: 10,
      where: "date = '2026-05-09'",
      rerank: false,
    });
    expect(exact.map((r) => r.id).sort()).toEqual(["f0", "f2"]);

    const range = await hybridSearch(table, {
      ...QUERY,
      candidates: 10,
      where: "date >= '2026-05-01' AND date < '2026-06-01'",
      rerank: false,
    });
    expect(range.map((r) => r.id).sort()).toEqual(["f0", "f2", "f5"]);

    const like = await hybridSearch(table, {
      ...QUERY,
      candidates: 10,
      where: "date LIKE '%-05-09'",
      rerank: false,
    });
    expect(like.map((r) => r.id).sort()).toEqual(["f0", "f2"]);

    const inList = await hybridSearch(table, {
      ...QUERY,
      candidates: 10,
      where: String.raw`source IN ('b.txt', 'o\'brien.txt')`,
      rerank: false,
    });
    expect(inList.map((r) => r.id).sort()).toEqual(["f1", "f5"]);
  });

  test("two empty legs return [] without reranking", async () => {
    const { table } = await memoryTable();
    const reranker = recordingReranker(() => []);
    const rows = await hybridSearch(table, {
      ...QUERY,
      candidates: 10,
      where: "date = '1999-01-01'",
      reranker,
    });
    expect(rows).toEqual([]);
    expect(reranker.calls.length).toBe(0);
  });

  test("finalK is capped at candidates; 0 returns nothing; candidates 0 returns nothing", async () => {
    const { table } = await memoryTable();
    expect(
      (await hybridSearch(table, { ...QUERY, candidates: 2, finalK: 5, rerank: false })).length,
    ).toBe(2);
    expect(
      await hybridSearch(table, { ...QUERY, candidates: 2, finalK: 0, rerank: false }),
    ).toEqual([]);
    expect(await hybridSearch(table, { ...QUERY, candidates: 0, rerank: false })).toEqual([]);
  });

  test("an empty query text raises before either leg runs", async () => {
    const table = {
      collection: {
        query: () => {
          throw new Error("leg ran");
        },
      },
    } as unknown as ZvecTable;
    await expect(
      hybridSearch(table, { ...QUERY, queryText: "", candidates: 3, rerank: false }),
    ).rejects.toThrow("Text query must be provided for hybrid search.");
  });

  test("the reranker gets the query tokens and the text column, and its order wins", async () => {
    const { table } = await memoryTable();
    const { fetch, calls } = fakeFetch([
      (init) => {
        const n = JSON.parse(String(init.body)).documents.length;
        return Response.json({
          results: [
            { index: n - 1, relevance_score: 0.7 },
            { index: 0, relevance_score: 0.1 },
          ],
        });
      },
    ]);
    const reranker = openRouterRerank({
      apiKey: "k",
      model: "cohere/rerank-4-fast",
      baseUrl: "https://example.invalid/v1/",
      fetch,
    });
    const rows = await hybridSearch(table, { ...QUERY, candidates: 10, finalK: 8, reranker });
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      query: string;
      documents: string[];
    };
    expect(body.query).toBe(tokenizeZhQuery(QUERY.queryText));
    expect(body.documents[0]).toBe("坚果体重5.5kg");
    expect([...body.documents].sort()).toEqual(FACT_ROWS.map((r) => r.text).sort());
    expect(rows.map((r) => r._relevance_score)).toEqual([Math.fround(0.7), Math.fround(0.1)]);
    expect(rows[0]?.text).toBe(body.documents.at(-1) as string);
    expect(Object.keys(rows[0] as SearchRow)).toEqual([...COLUMNS, "_relevance_score"]);
  });

  test("a failed rerank logs and falls back to RRF over the same legs", async () => {
    const { table } = await memoryTable();
    const fused = await hybridSearch(table, { ...QUERY, candidates: 10, rerank: false });
    const failing = recordingReranker(() => {
      throw new Error("boom");
    });
    expect(await hybridSearch(table, { ...QUERY, candidates: 10, reranker: failing })).toEqual(
      fused,
    );
    expect(messages(records, "WARNING")).toEqual([
      "Rerank failed (boom); falling back to RRF fusion",
    ]);
  });

  test("rerank: true without a configured reranker is RRF", async () => {
    const { table } = await memoryTable();
    const fused = await hybridSearch(table, { ...QUERY, candidates: 10, rerank: false });
    expect(await hybridSearch(table, { ...QUERY, candidates: 10 })).toEqual(fused);
  });

  test("an abort rejects with the signal's reason and logs nothing", async () => {
    const { table } = await memoryTable();
    records.length = 0;
    const reason = new Error("interrupted");
    const before = new AbortController();
    before.abort(reason);
    await expect(
      hybridSearch(table, { ...QUERY, candidates: 3, rerank: false, signal: before.signal }),
    ).rejects.toBe(reason);
    const during = new AbortController();
    const reranker = recordingReranker(() => {
      during.abort(reason);
      throw new Error("aborted fetch");
    });
    await expect(
      hybridSearch(table, { ...QUERY, candidates: 3, reranker, signal: during.signal }),
    ).rejects.toBe(reason);
    expect(records).toEqual([]);
  });

  test("vectorSearch returns _distance rows and refuses a non-positive limit", async () => {
    const { table } = await memoryTable();
    const rows = await vectorSearch(table, {
      vector: [1, 0, 0, 0],
      limit: 2,
      where: "source = 'b.txt'",
    });
    expect(rows.map((r) => r.id)).toEqual(["f1"]);
    expect(Object.keys(rows[0] as SearchRow)).toEqual([...COLUMNS, "_distance"]);
    await expect(vectorSearch(table, { vector: [1, 0, 0, 0], limit: 0 })).rejects.toThrow(
      "Limit is required for ANN/KNN queries",
    );
  });

  test("clamps HNSW ef at 2048 when candidates or limit exceeds 512, and matches unescaped backslashes in IN", async () => {
    const { table } = await memoryTable([
      ...FACT_ROWS,
      {
        id: "f-slash",
        source: String.raw`dir\file'1.txt`,
        date: "2026-05-16",
        floor: 6,
        text: "坚果日常",
        tokens: "坚果 日常",
        vector: [0.9, 0.1, 0, 0],
      },
    ]);
    const hybrid = await hybridSearch(table, {
      ...QUERY,
      candidates: 600,
      finalK: 10,
      rerank: false,
    });
    expect(hybrid.length).toBe(6);
    const vec = await vectorSearch(table, { vector: [1, 0, 0, 0], limit: 600 });
    expect(vec.length).toBe(6);

    const matched = await hybridSearch(table, {
      ...QUERY,
      candidates: 10,
      where: String.raw`source IN ('dir\file\'1.txt')`,
      rerank: false,
    });
    expect(matched.map((r) => r.id)).toEqual(["f-slash"]);
  });
});
