// The write side against 奶绿's real index and embedding cache in EIDOLON_REAL_HOME, which Python
// built, read only: tables are rewritten into a temporary folder and the cache is cloned there.
// Each test skips without the data, unless EIDOLON_REQUIRE_PARITY=1.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { constants, copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EMBED_MODEL,
  EmbedCache,
  embedInBatches,
  type LanceTable,
  openTable,
  personaFactsSchema,
  streamChunksSchema,
  tokenizeZhQuery,
  writeTable,
} from "../src/index.ts";
import {
  f32Bytes as bytes,
  captureLogs,
  tableIndices as indices,
  messages,
  REAL_INDEX,
  realTable,
} from "./helpers.ts";
import { describeSchema } from "./write_golden.ts";

const REQUIRED = process.env.EIDOLON_REQUIRE_PARITY === "1";
const REAL_CACHE = join(process.env.EIDOLON_REAL_HOME ?? "", "cache", "embed_cache.db");
const DIM = 3072;
const facts = await realTable("persona_facts");
const chunks = await realTable("stream_chunks");
const records = captureLogs();

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "retrieval-write-real-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A table's rows without their vectors, in scan order, and every vector in one array. */
async function load(table: LanceTable, where?: string) {
  const data = await (where === undefined ? table.query() : table.query().where(where)).toArrow();
  const names = data.schema.fields.map((f) => f.name).filter((n) => n !== "vector");
  const rows: Record<string, unknown>[] = [];
  const vectors = new Float32Array(data.numRows * DIM);
  for (const row of data) {
    vectors.set(row.vector.toArray() as Float32Array, rows.length * DIM);
    rows.push(Object.fromEntries(names.map((n) => [n, row[n]])));
  }
  return { schema: data.schema, rows, vectors };
}

const versions = async (table: LanceTable) => (await table.listVersions()).map((v) => v.version);
const manifests = (db: string, name: string) =>
  readdirSync(join(db, `${name}.lance`, "_versions")).sort();

/**
 * Every FTS hit as `score id`, best first. Each index build fixes its own order for rows that tie
 * on score (two builds of the same rows, in Python or here, disagree), so ties sort by id.
 */
async function ftsHits(table: LanceTable, query: string): Promise<string[]> {
  const hits = await table.search(query, "fts", "tokens").limit(100_000).toArray();
  return hits
    .map((h) => [h._score as number, h.id as string] as const)
    .sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([score, id]) => `${score} ${id}`);
}

test.skipIf(facts === null && !REQUIRED)(
  "persona_facts rewritten from its own rows is the same table: schema, rows, vectors, index",
  async () => {
    expect(facts, `no readable persona_facts in ${REAL_INDEX}`).not.toBeNull();
    const realTable = facts as LanceTable;
    const real = await load(realTable);
    expect(describeSchema(personaFactsSchema(DIM))).toEqual(describeSchema(real.schema));
    await writeTable(dir, "persona_facts", real.rows, personaFactsSchema(DIM), real.vectors);
    const table = (await openTable(dir, "persona_facts")) as LanceTable;
    const mine = await load(table);
    expect(describeSchema(mine.schema)).toEqual(describeSchema(real.schema));
    expect(mine.rows.length).toBe(real.rows.length);
    expect(mine.rows).toEqual(real.rows);
    expect(bytes(mine.vectors).equals(bytes(real.vectors))).toBe(true);
    expect(await indices(table)).toEqual(await indices(realTable));
    expect(await versions(table)).toEqual(await versions(realTable));
    expect((await table.stats()).fragmentStats.numFragments).toBe(
      (await realTable.stats()).fragmentStats.numFragments,
    );
    expect(manifests(dir, "persona_facts")).toEqual(manifests(REAL_INDEX, "persona_facts"));
    // Queries from the table's own tokens, so the test carries none of its text.
    for (const row of [real.rows[0], real.rows[1000], real.rows[2500]]) {
      const query = tokenizeZhQuery(String(row?.text));
      expect(await ftsHits(table, query)).toEqual(await ftsHits(realTable, query));
    }
  },
  120_000,
);

test.skipIf(chunks === null && !REQUIRED)(
  "stream_chunks has the schema streamChunksSchema builds, and a rewrite of a sample matches it",
  async () => {
    expect(chunks, `no readable stream_chunks in ${REAL_INDEX}`).not.toBeNull();
    const realTable = chunks as LanceTable;
    expect(describeSchema(streamChunksSchema(DIM))).toEqual(
      describeSchema(await realTable.schema()),
    );
    const sample = await load(realTable, "id LIKE '%7'");
    expect(sample.rows.length).toBeGreaterThan(1000);
    await writeTable(dir, "stream_chunks", sample.rows, streamChunksSchema(DIM), sample.vectors);
    const table = (await openTable(dir, "stream_chunks")) as LanceTable;
    const mine = await load(table);
    expect(describeSchema(mine.schema)).toEqual(describeSchema(sample.schema));
    expect(mine.rows).toEqual(sample.rows);
    expect(bytes(mine.vectors).equals(bytes(sample.vectors))).toBe(true);
    const details = (await indices(table)).map((i) => i.indexDetails);
    expect(details).toEqual((await indices(realTable)).map((i) => i.indexDetails));
    expect(await versions(table)).toEqual(await versions(realTable));
  },
  120_000,
);

test.skipIf((chunks === null || !existsSync(REAL_CACHE)) && !REQUIRED)(
  "the cache Python filled serves sampled chunks' vectors bit for bit, with no request",
  async () => {
    expect(existsSync(REAL_CACHE), `no embedding cache at ${REAL_CACHE}`).toBe(true);
    expect(chunks, `no readable stream_chunks in ${REAL_INDEX}`).not.toBeNull();
    const clone = join(dir, "embed_cache.db");
    copyFileSync(REAL_CACHE, clone, constants.COPYFILE_FICLONE);
    if (existsSync(`${REAL_CACHE}-wal`)) {
      copyFileSync(`${REAL_CACHE}-wal`, `${clone}-wal`, constants.COPYFILE_FICLONE);
    }
    const sample = await load(chunks as LanceTable, "id LIKE '%7'");
    // ingest_streams' embed_input, rebuilt from the stored columns.
    const inputs = sample.rows.map((row) => {
      const base = row.summary ? row.summary : row.text;
      const head = `${row.heading}.\n${base}`;
      return row.stream_date ? `On ${row.stream_date}, ${head}` : head;
    });
    const cache = new EmbedCache(clone);
    const found = cache.getMany(DEFAULT_EMBED_MODEL, DIM, inputs);
    expect(found.size).toBe(inputs.length);
    const report = await embedInBatches(inputs, {
      batchSize: 64,
      noun: "chunks",
      cache,
      model: DEFAULT_EMBED_MODEL,
      dim: DIM,
      client: {
        embedWithUsage: () => Promise.reject(new Error("every input should have hit the cache")),
      },
    });
    cache.close();
    expect([report.cacheHits, report.embedded]).toEqual([inputs.length, 0]);
    expect(bytes(report.vectors).equals(bytes(sample.vectors))).toBe(true);
    expect(messages(records, "INFO")).toEqual([
      `Cache: ${inputs.length}/${inputs.length} embeddings reused, 0 need fresh embedding`,
      "All embeddings served from cache; nothing to embed.",
    ]);
  },
  120_000,
);
