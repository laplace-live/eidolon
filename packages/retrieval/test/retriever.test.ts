import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Table } from "@lancedb/lancedb";
import * as lancedb from "@lancedb/lancedb";
import {
  type HybridSearchOptions,
  LanceRetriever,
  type LanceRetrieverOptions,
  openPersonaFactsRetriever,
  openStreamArchiveRetriever,
  PERSONA_FACTS,
  type SearchRow,
} from "../src/index.ts";
import { captureLogs, FACT_ROWS, isolateEnv, memoryTable, messages } from "./helpers.ts";

const records = captureLogs();
isolateEnv();

const TABLE = { countRows: async () => 42 } as unknown as Table;
const HIT: SearchRow = { id: "f0", source: "a.txt", date: "2026-05-09", _relevance_score: 0.016 };
const PARAMS = { candidates: 30, topK: 8 };

interface Harness {
  retriever: LanceRetriever;
  opens: string[];
  embeds: string[][];
  searches: HybridSearchOptions[];
}

async function harness(
  overrides: Partial<LanceRetrieverOptions> & {
    tables?: (Table | null | Error)[];
    results?: (SearchRow[] | Error)[];
  } = {},
): Promise<Harness> {
  const tables = [...(overrides.tables ?? [TABLE])];
  const results = [...(overrides.results ?? [[HIT]])];
  const h: Harness = {
    retriever: undefined as unknown as LanceRetriever,
    opens: [],
    embeds: [],
    searches: [],
  };
  h.retriever = await LanceRetriever.open({
    dbPath: "/db",
    tableName: "persona_facts",
    dateColumn: "date",
    label: PERSONA_FACTS.label,
    summarize: PERSONA_FACTS.summarize,
    ingestHint: PERSONA_FACTS.ingestHint,
    open: async (dbPath, tableName) => {
      h.opens.push(`${dbPath}/${tableName}`);
      const next = tables.shift() ?? null;
      if (next instanceof Error) throw next;
      return next;
    },
    embed: async (texts) => {
      h.embeds.push(texts);
      return [[0.1, 0.2]];
    },
    search: async (_table, options) => {
      h.searches.push(options);
      const next = results.shift() ?? [];
      if (next instanceof Error) throw next;
      return next;
    },
    ...overrides,
  });
  return h;
}

describe("LanceRetriever", () => {
  test("an absent table logs once, then every search is skipped without embedding", async () => {
    const h = await harness({ tables: [null] });
    expect(h.retriever.hasTable).toBe(false);
    expect(await h.retriever.rowCount()).toBe(0);
    expect(await h.retriever.search("坚果", PARAMS)).toEqual([]);
    expect(h.embeds).toEqual([]);
    expect(messages(records, "WARNING")).toEqual([
      "Persona facts: no LanceDB table at /db/persona_facts.lance — retrieval will be a no-op. " +
        "Run `uv run laplace-ingest-facts` to build it.",
      "Persona facts search skipped: no table loaded",
    ]);
  });

  test("a hit is logged with the preset's summary", async () => {
    const h = await harness({ results: [[HIT, { ...HIT, id: "f1", source: "b.txt", date: "" }]] });
    expect(h.retriever.hasTable).toBe(true);
    expect(await h.retriever.rowCount()).toBe(42);
    expect((await h.retriever.search("坚果体重", PARAMS)).length).toBe(2);
    expect(h.searches[0]).toMatchObject({
      vector: [0.1, 0.2],
      queryText: "坚果体重",
      candidates: 30,
      finalK: 8,
      rerank: true,
      where: null,
    });
    expect(messages(records, "INFO")).toEqual([
      "Persona facts hit: query='坚果体重' → 2 rows (top_score=0.016, sources=['a.txt', 'b.txt'], dated=1/2)",
    ]);
  });

  test("a miss is logged", async () => {
    const h = await harness({ results: [[]] });
    expect(await h.retriever.search("q", PARAMS)).toEqual([]);
    expect(messages(records, "INFO")).toEqual(["Persona facts miss: query='q' returned 0 rows"]);
  });

  test("an embedding failure returns [] before searching", async () => {
    const h = await harness({
      embed: async () => {
        throw new Error("Embeddings need an API key.");
      },
    });
    expect(await h.retriever.search("q", PARAMS)).toEqual([]);
    expect(h.searches).toEqual([]);
    expect(messages(records, "ERROR")).toEqual([
      "Persona facts embed failed for query='q': Embeddings need an API key.",
    ]);
  });

  test("no vectors, no search", async () => {
    const h = await harness({ embed: async () => [] });
    expect(await h.retriever.search("q", PARAMS)).toEqual([]);
    expect(h.searches).toEqual([]);
  });

  test("the date pre-filter: derived, overridden, disabled, or blank", async () => {
    const h = await harness({ results: [[], [], [], []] });
    await h.retriever.search("你2026年5月9号说了什么", PARAMS);
    await h.retriever.search("你2026年5月9号说了什么", { ...PARAMS, where: "stream_id IN ('x')" });
    await h.retriever.search("你2026年5月9号说了什么", { ...PARAMS, datePrefilter: false });
    await h.retriever.search("你2026年5月9号说了什么", { ...PARAMS, where: "" });
    expect(h.searches.map((s) => s.where)).toEqual([
      "date = '2026-05-09'",
      "stream_id IN ('x')",
      null,
      "",
    ]);
    expect(messages(records, "INFO").filter((m) => m.includes("pre-filter"))).toEqual([
      `Persona facts date pre-filter: "date = '2026-05-09'"`,
      `Persona facts date pre-filter: "stream_id IN ('x')"`,
    ]);
  });

  test("a stale handle is reopened and the search retried with the same vector", async () => {
    const fresh = { countRows: async () => 7 } as unknown as Table;
    const h = await harness({
      tables: [TABLE, fresh],
      results: [new Error("lance error: LanceError(IO): Not found: t.lance/data/x.lance"), [HIT]],
    });
    expect(await h.retriever.search("q", PARAMS)).toEqual([HIT]);
    expect(h.opens.length).toBe(2);
    expect(h.embeds.length).toBe(1);
    expect(h.searches[1]?.vector).toBe(h.searches[0]?.vector as number[]);
    expect(h.retriever.table).toBe(fresh);
    expect(messages(records, "WARNING")).toEqual([
      "Persona facts hit stale table (likely re-ingested while bot was running); re-opening and retrying once.",
    ]);
    expect(messages(records, "INFO")[0]).toBe("Persona facts re-opened table (7 rows)");
  });

  test("a second Not found gives up", async () => {
    const stale = new Error("Not found: x");
    const h = await harness({ tables: [TABLE, TABLE], results: [stale, stale] });
    expect(await h.retriever.search("q", PARAMS)).toEqual([]);
    expect(messages(records, "ERROR")).toEqual([
      "Persona facts search failed for query='q': Not found: x",
    ]);
  });

  test("a table gone on reopen disables the retriever for good", async () => {
    const h = await harness({ tables: [TABLE, null], results: [new Error("Not found")] });
    expect(await h.retriever.search("q", PARAMS)).toEqual([]);
    expect(h.retriever.hasTable).toBe(false);
    expect(await h.retriever.search("q", PARAMS)).toEqual([]);
    expect(h.searches.length).toBe(1);
    expect(messages(records, "WARNING").slice(1)).toEqual([
      "Persona facts re-open: no table at /db/persona_facts.lance",
      "Persona facts search skipped: no table loaded",
    ]);
  });

  test("a failed reopen disables the retriever", async () => {
    const h = await harness({
      tables: [TABLE, new Error("disk")],
      results: [new Error("Not found")],
    });
    expect(await h.retriever.search("q", PARAMS)).toEqual([]);
    expect(h.retriever.hasTable).toBe(false);
    expect(messages(records, "ERROR")).toEqual(["Persona facts re-open failed: disk"]);
  });

  test("any other search error returns [] without a reopen", async () => {
    const h = await harness({ results: [new Error("Schema error: No field named stream_date")] });
    expect(await h.retriever.search("q", PARAMS)).toEqual([]);
    expect(h.opens.length).toBe(1);
    expect(messages(records, "ERROR")).toEqual([
      "Persona facts search failed for query='q': Schema error: No field named stream_date",
    ]);
  });

  test("an open error propagates, as Python's constructor raises", async () => {
    await expect(harness({ tables: [new Error("corrupt manifest")] })).rejects.toThrow(
      "corrupt manifest",
    );
  });

  test("an abort rejects with the signal's reason and logs nothing", async () => {
    const reason = new Error("interrupted");
    for (const at of ["embed", "search"] as const) {
      const controller = new AbortController();
      const fail = async () => {
        controller.abort(reason);
        throw new Error("aborted");
      };
      const h = await harness(at === "embed" ? { embed: fail } : { search: fail });
      await expect(h.retriever.search("q", { ...PARAMS, signal: controller.signal })).rejects.toBe(
        reason,
      );
    }
    expect(records).toEqual([]);
  });

  test("a real stale handle on memory:// recovers after a reopen", async () => {
    const { db } = await memoryTable();
    const retriever = await LanceRetriever.open({
      dbPath: "memory://",
      tableName: "persona_facts",
      dateColumn: "date",
      label: "Persona facts",
      open: async (_dbPath, name) => db.openTable(name),
      embed: async () => [[1, 0, 0, 0]],
    });
    await db.dropTable("persona_facts");
    await db.createTable(
      "persona_facts",
      FACT_ROWS.slice(0, 2).map((row) => ({ ...row })),
    );
    // The handle opened before the drop still answers countRows from its cached manifest.
    expect(await retriever.rowCount()).toBe(5);
    const fresh = await db.openTable("persona_facts");
    await fresh.createIndex("tokens", {
      config: lancedb.Index.fts({ baseTokenizer: "whitespace" }),
    });
    const rows = await retriever.search("坚果体重", { candidates: 5, topK: 3 });
    expect(rows.map((r) => r.id)).toEqual(["f0", "f1"]);
    expect(messages(records, "WARNING")[0]).toStartWith("Persona facts hit stale table");
    expect(messages(records, "INFO")).toContain("Persona facts re-opened table (2 rows)");
  });
});

describe("factories", () => {
  test("open the presets over a real directory, or warn with the ingest hint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "retrieval-lance-"));
    try {
      const db = await lancedb.connect(dir);
      await db.createTable(
        "persona_facts",
        FACT_ROWS.map((row) => ({ ...row })),
      );
      expect((await openPersonaFactsRetriever(dir)).hasTable).toBe(true);
      expect((await openPersonaFactsRetriever(dir, { tableName: "nope" })).hasTable).toBe(false);
      expect((await openStreamArchiveRetriever(dir)).hasTable).toBe(false);
      expect(messages(records, "WARNING")).toEqual([
        `Persona facts: no LanceDB table at ${dir}/nope.lance — retrieval will be a no-op. Run \`uv run laplace-ingest-facts\` to build it.`,
        `Archive: no LanceDB table at ${dir}/stream_chunks.lance — retrieval will be a no-op. Run \`uv run laplace-ingest-streams\` to build it.`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
