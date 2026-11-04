import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pyJsonDumps } from "@eidolon/config";
import type { Table } from "@lancedb/lancedb";
import {
  hybridSearch,
  OpenRouterReranker,
  type Reranker,
  type RerankResult,
  rrfFuse,
  type SearchRow,
  scoreOf,
  tokenizeZhQuery,
  vectorSearch,
} from "../src/index.ts";
import {
  captureLogs,
  FACT_ROWS,
  fakeFetch,
  fingerprint,
  isolateEnv,
  memoryTable,
  messages,
  realTable,
} from "./helpers.ts";

const records = captureLogs();
isolateEnv();

const leg = (ids: number[], key: "_distance" | "_score") =>
  ids.map((id, i) => ({ id: `r${id}`, [key]: i, _rowid: BigInt(id) }));

describe("rrfFuse", () => {
  // Printed by LanceDB 0.39's Python RRFReranker(K=60).
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
    const vectorRows = [{ id: "v", text: "from vector", _distance: 0.1, _rowid: 1n }];
    const ftsRows = [{ id: "v", text: "from fts", _score: 9, _rowid: 1n }];
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
): Reranker & { calls: { query: string; documents: readonly unknown[] }[] } {
  const calls: { query: string; documents: readonly unknown[] }[] = [];
  return {
    modelName: "fake",
    column: "text",
    calls,
    async rerank(query, documents) {
      calls.push({ query, documents });
      return answer(documents);
    },
  };
}

describe("hybridSearch on an in-memory table", () => {
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

  test("where prefilters both legs", async () => {
    const { table } = await memoryTable();
    const rows = await hybridSearch(table, {
      ...QUERY,
      candidates: 10,
      where: "date = '2026-05-09'",
      rerank: false,
    });
    expect(rows.map((r) => r.id).sort()).toEqual(["f0", "f2"]);
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
      query: () => {
        throw new Error("leg ran");
      },
    } as unknown as Table;
    await expect(
      hybridSearch(table, { ...QUERY, queryText: "", candidates: 3, rerank: false }),
    ).rejects.toThrow("Text query must be provided for hybrid search.");
  });

  test("the reranker gets the query tokens and the text column, and its order wins", async () => {
    const { table } = await memoryTable();
    const reranker = recordingReranker((documents) => [
      { index: documents.length - 1, relevanceScore: 0.7 },
      { index: 0, relevanceScore: 0.1 },
    ]);
    const rows = await hybridSearch(table, { ...QUERY, candidates: 10, finalK: 8, reranker });
    const call = reranker.calls[0];
    expect(call?.query).toBe(tokenizeZhQuery(QUERY.queryText));
    expect(call?.documents[0]).toBe("坚果体重5.5kg");
    expect([...(call?.documents ?? [])].sort()).toEqual(FACT_ROWS.map((r) => r.text).sort());
    expect(rows.map((r) => r._relevance_score)).toEqual([Math.fround(0.7), Math.fround(0.1)]);
    expect(rows[0]?.text).toBe(call?.documents.at(-1) as string);
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
});

// Written by Python's hybrid_search over stored row vectors (no embedding calls); a re-ingest
// changes the tables' fingerprints and skips these.
const parity = await Bun.file(join(import.meta.dir, "fixtures", "hybrid_parity.json")).json();
const real: Record<string, Table | null> = {
  persona_facts: await realTable("persona_facts"),
  stream_chunks: await realTable("stream_chunks"),
};
let sameData = true;
for (const [name, table] of Object.entries(real)) {
  if (table === null || (await fingerprint(table)) !== parity.fingerprints[name]) sameData = false;
}

async function anchorVector(table: Table, id: string): Promise<number[]> {
  const [row] = await table.query().where(`id = '${id}'`).select(["vector"]).limit(1).toArray();
  return Array.from(row.vector.toArray() as Float32Array);
}

const rowSha1 = (row: SearchRow) =>
  createHash("sha1")
    .update(pyJsonDumps(row, { ensureAscii: false }))
    .digest("hex");

describe("parity with Python on the committed tables", () => {
  test.skipIf(!sameData)(
    "RRF order, float32 scores, columns and row content",
    async () => {
      for (const c of parity.rrf) {
        const table = real[c.table] as Table;
        const rows = await hybridSearch(table, {
          vector: await anchorVector(table, c.anchor),
          queryText: c.text,
          candidates: c.candidates,
          where: c.where,
          finalK: c.finalK,
          rerank: false,
        });
        const label = `${c.table} ${c.text} candidates=${c.candidates} finalK=${c.finalK}`;
        expect([label, rows.map((r) => r.id)]).toEqual([label, c.ids]);
        expect(rows.map((r) => r._relevance_score)).toEqual(c.scores);
        expect(Object.keys(rows[0] ?? {})).toEqual(c.keys.filter((k: string) => k !== "vector"));
        expect(rows.map(rowSha1)).toEqual(c.hashes);
      }
    },
    120_000,
  );

  test.skipIf(!sameData)(
    "the rerank path sends Python's request and keeps the reranker's order",
    async () => {
      for (const c of parity.rerank) {
        const table = real[c.table] as Table;
        const { fetch, calls } = fakeFetch([
          (init) => {
            const n = JSON.parse(String(init.body)).documents.length;
            const order = [...Array(n).keys()].reverse().slice(0, Math.max(1, n - 2));
            return Response.json({
              results: order.map((index, rank) => ({ index, relevance_score: 1 / (rank + 3) })),
            });
          },
        ]);
        const reranker = new OpenRouterReranker({
          apiKey: "k",
          baseUrl: "https://example.invalid/v1/",
          fetch,
        });
        const rows = await hybridSearch(table, {
          vector: await anchorVector(table, c.anchor),
          queryText: c.text,
          candidates: c.candidates,
          where: c.where,
          finalK: c.finalK,
          reranker,
        });
        const body = JSON.parse(String(calls[0]?.init.body));
        expect(body.query).toBe(c.query);
        expect(body.documents.length).toBe(c.documents);
        const sha1 = createHash("sha1")
          .update(pyJsonDumps(body, { ensureAscii: false }))
          .digest("hex");
        expect(sha1).toBe(c.requestSha1);
        expect(rows.map((r) => r.id)).toEqual(c.ids);
        expect(rows.map((r) => r._relevance_score)).toEqual(c.scores);
        expect(Object.keys(rows[0] ?? {})).toEqual(c.keys.filter((k: string) => k !== "vector"));
      }
    },
    120_000,
  );
});
