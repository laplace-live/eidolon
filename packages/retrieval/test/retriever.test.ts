import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  closeAllReadTables,
  type HybridSearchOptions,
  ingestHint,
  openPersonaFactsRetriever,
  openStreamArchiveRetriever,
  PERSONA_FACTS,
  personaFactsSchema,
  type SearchRow,
  writeTable,
  ZvecRetriever,
  type ZvecRetrieverOptions,
  type ZvecTable,
} from "../src/index.ts";
import { captureLogs, FACT_ROWS, isolateEnv, messages } from "./helpers.ts";

const records = captureLogs();
isolateEnv();

const TABLE = { countRows: async () => 42 } as unknown as ZvecTable;
const HIT: SearchRow = { id: "f0", source: "a.txt", date: "2026-05-09", _relevance_score: 0.016 };
const PARAMS = { candidates: 30, topK: 8 };

interface Harness {
  retriever: ZvecRetriever;
  opens: string[];
  embeds: string[][];
  searches: HybridSearchOptions[];
}

async function harness(
  overrides: Partial<ZvecRetrieverOptions> & {
    tables?: (ZvecTable | null | Error)[];
    results?: (SearchRow[] | Error)[];
  } = {},
): Promise<Harness> {
  const tables = [...(overrides.tables ?? [TABLE])];
  const results = [...(overrides.results ?? [[HIT]])];
  const h: Harness = {
    retriever: undefined as unknown as ZvecRetriever,
    opens: [],
    embeds: [],
    searches: [],
  };
  h.retriever = await ZvecRetriever.open({
    dbPath: "/db",
    tableName: "persona_facts",
    dateColumn: "date",
    label: PERSONA_FACTS.label,
    summarize: PERSONA_FACTS.summarize,
    ingestHint: ingestHint(PERSONA_FACTS.ingestCommand),
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

describe("ZvecRetriever", () => {
  test("an absent table logs once, then every search is skipped without embedding", async () => {
    const h = await harness({ tables: [null] });
    expect(h.retriever.hasTable).toBe(false);
    expect(await h.retriever.rowCount()).toBe(0);
    expect(await h.retriever.search("坚果", PARAMS)).toEqual([]);
    expect(h.embeds).toEqual([]);
    expect(messages(records, "WARNING")).toEqual([
      "Persona facts: no Zvec table at /db/persona_facts.zvec — retrieval will be a no-op. " +
        "Run `pnpm laplace-ingest-facts --persona milky-green` to build it.",
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
    const fresh = { countRows: async () => 7 } as unknown as ZvecTable;
    const h = await harness({
      tables: [TABLE, fresh],
      results: [new Error("Not found: segment"), [HIT]],
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
      "Persona facts re-open: no table at /db/persona_facts.zvec",
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
    const h = await harness({ results: [new Error("Invalid filter: stream_date")] });
    expect(await h.retriever.search("q", PARAMS)).toEqual([]);
    expect(h.opens.length).toBe(1);
    expect(messages(records, "ERROR")).toEqual([
      "Persona facts search failed for query='q': Invalid filter: stream_date",
    ]);
  });

  test("an open error propagates", async () => {
    await expect(harness({ tables: [new Error("corrupt index")] })).rejects.toThrow(
      "corrupt index",
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

  test("a live re-ingest on disk updates CURRENT and the next search reopens the new build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "retrieval-reopen-"));
    try {
      const schema = personaFactsSchema(4);
      await writeTable(
        dir,
        "persona_facts",
        FACT_ROWS,
        schema,
        Float32Array.from(FACT_ROWS.flatMap((r) => r.vector)),
      );
      const retriever = await ZvecRetriever.open({
        dbPath: dir,
        tableName: "persona_facts",
        dateColumn: "date",
        label: "Persona facts",
        embed: async () => [[1, 0, 0, 0]],
      });
      expect(await retriever.rowCount()).toBe(5);
      records.length = 0;

      const subset = FACT_ROWS.slice(0, 2);
      await writeTable(
        dir,
        "persona_facts",
        subset,
        schema,
        Float32Array.from(subset.flatMap((r) => r.vector)),
      );
      records.length = 0;

      const rows = await retriever.search("坚果体重", { candidates: 5, topK: 3 });
      expect(rows.map((r) => r.id)).toEqual(["f0", "f1"]);
      expect(await retriever.rowCount()).toBe(2);
      expect(messages(records, "WARNING")[0]).toStartWith("Persona facts hit stale table");
      expect(messages(records, "INFO")).toContain("Persona facts re-opened table (2 rows)");
    } finally {
      closeAllReadTables();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps serving the previous build while rsync --delay-updates stages a new CURRENT, and rotates sibling retrievers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "retrieval-rsync-"));
    const stagedSrc = mkdtempSync(join(tmpdir(), "retrieval-rsync-src-"));
    try {
      const schema = personaFactsSchema(4);
      await writeTable(
        dir,
        "persona_facts",
        FACT_ROWS,
        schema,
        Float32Array.from(FACT_ROWS.flatMap((r) => r.vector)),
      );
      const primary = await ZvecRetriever.open({
        dbPath: dir,
        tableName: "persona_facts",
        dateColumn: "date",
        label: "Persona facts",
        embed: async () => [[1, 0, 0, 0]],
      });
      const sibling = await ZvecRetriever.open({
        dbPath: dir,
        tableName: "persona_facts",
        dateColumn: "date",
        label: "Persona facts",
        embed: async () => [[1, 0, 0, 0]],
      });

      // Simulate rsync renaming CURRENT before moving `<newBuildId>/.~tmp~/*`.
      const tableRoot = join(dir, "persona_facts.zvec");
      const stagingPath = join(tableRoot, "staging-build");
      mkdirSync(stagingPath);
      writeFileSync(join(tableRoot, "CURRENT"), "staging-build\n");
      records.length = 0;

      // A pre-aborted signal rejects before attempting to reopen CURRENT.
      const preAborted = new AbortController();
      const abortReason = new Error("caller-cancelled");
      preAborted.abort(abortReason);
      await expect(
        primary.search("坚果体重", { candidates: 5, topK: 3, signal: preAborted.signal }),
      ).rejects.toBe(abortReason);
      expect(records).toEqual([]);

      const duringStage = await primary.search("坚果体重", { candidates: 5, topK: 3 });
      expect(duringStage.length).toBe(3);
      expect(primary.hasTable).toBe(true);

      // Build the 2-row index in a separate directory and populate `staging-build` directly so
      // `writeTable` never touches `dir`'s in-process handles and CURRENT stays `staging-build`.
      const subset = FACT_ROWS.slice(0, 2);
      await writeTable(
        stagedSrc,
        "persona_facts",
        subset,
        schema,
        Float32Array.from(subset.flatMap((r) => r.vector)),
      );
      const srcRoot = join(stagedSrc, "persona_facts.zvec");
      const srcBuild = readdirSync(srcRoot).find((entry) => entry !== "CURRENT") as string;
      for (const entry of readdirSync(join(srcRoot, srcBuild))) {
        cpSync(join(srcRoot, srcBuild, entry), join(stagingPath, entry), { recursive: true });
      }
      expect(
        (await primary.search("坚果体重", { candidates: 5, topK: 3 })).map((r) => r.id),
      ).toEqual(["f0", "f1"]);
      expect(await sibling.rowCount()).toBe(2);
      expect(
        (await sibling.search("坚果体重", { candidates: 5, topK: 3 })).map((r) => r.id),
      ).toEqual(["f0", "f1"]);
    } finally {
      closeAllReadTables();
      rmSync(dir, { recursive: true, force: true });
      rmSync(stagedSrc, { recursive: true, force: true });
    }
  });
});

describe("factories", () => {
  test("open the presets over a real directory, or warn with the ingest hint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "retrieval-zvec-factories-"));
    try {
      await writeTable(
        dir,
        "persona_facts",
        FACT_ROWS,
        personaFactsSchema(4),
        Float32Array.from(FACT_ROWS.flatMap((r) => r.vector)),
      );
      records.length = 0;
      expect((await openPersonaFactsRetriever(dir)).hasTable).toBe(true);
      expect((await openPersonaFactsRetriever(dir, { tableName: "nope" })).hasTable).toBe(false);
      expect((await openStreamArchiveRetriever(dir)).hasTable).toBe(false);
      expect(messages(records, "WARNING")).toEqual([
        `Persona facts: no Zvec table at ${dir}/nope.zvec — retrieval will be a no-op. Run \`pnpm laplace-ingest-facts --persona milky-green\` to build it.`,
        `Archive: no Zvec table at ${dir}/stream_chunks.zvec — retrieval will be a no-op. Run \`pnpm laplace-ingest-streams --persona milky-green\` to build it.`,
      ]);
    } finally {
      closeAllReadTables();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
