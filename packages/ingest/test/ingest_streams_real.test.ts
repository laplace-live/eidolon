// The ingest and the catalog against 奶绿's real transcripts in EIDOLON_REAL_HOME, from which
// Python's tools built the index there. Everything real is read only: both are rebuilt into a
// temporary folder, through a clone of the real embedding cache, and any embedding request fails
// the run. Each test skips without the data, unless EIDOLON_REQUIRE_PARITY=1.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleSink, logger } from "@eidolon/config";
import { DEFAULT_EMBED_MODEL, type LanceTable, openTable } from "@eidolon/retrieval";
import { f32Bytes as bytes, tableIndices as indices } from "../../retrieval/test/helpers.ts";
import { catalog, ingestStreams } from "../src/index.ts";
import { maskBuiltAt } from "./ingest_streams_golden.ts";

const HOME = process.env.EIDOLON_REAL_HOME ?? "";
const REQUIRED = process.env.EIDOLON_REQUIRE_PARITY === "1";
const STREAMS = join(HOME, "sources", "milky-green", "streams");
const INDEX = join(HOME, "personas", "milky-green", "index");
const CACHE = join(HOME, "cache", "embed_cache.db");
const CATALOG = join(INDEX, "stream_catalog.json");
const DIM = 3072;

async function realChunks(): Promise<LanceTable | null> {
  if (!HOME) return null;
  try {
    return await openTable(INDEX, "stream_chunks");
  } catch {
    return null;
  }
}

const real = await realChunks();
const haveStreams = HOME !== "" && existsSync(STREAMS);

let dir = "";
const messages: string[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ingest-streams-real-"));
  logger.setSink((record) => messages.push(record.message));
});
afterAll(() => {
  logger.setSink(consoleSink);
  rmSync(dir, { recursive: true, force: true });
});

/** A table's rows without their vectors, in scan order, and every vector in one array. */
async function load(table: LanceTable) {
  const data = await table.query().toArrow();
  const names = data.schema.fields.map((f) => f.name).filter((n) => n !== "vector");
  const rows: Record<string, unknown>[] = [];
  const vectors = new Float32Array(data.numRows * DIM);
  for (const row of data) {
    vectors.set(row.vector.toArray() as Float32Array, rows.length * DIM);
    rows.push(Object.fromEntries(names.map((n) => [n, row[n]])));
  }
  const fields = data.schema.fields.map((f) => [f.name, String(f.type), f.nullable]);
  return { fields, rows, vectors };
}

test.skipIf((real === null || !haveStreams || !existsSync(CACHE)) && !REQUIRED)(
  "rebuilds the real stream_chunks from the real transcripts: every row, column, vector and index",
  async () => {
    expect(haveStreams, `no transcripts at ${STREAMS}`).toBe(true);
    expect(existsSync(CACHE), `no embedding cache at ${CACHE}`).toBe(true);
    expect(real, `no readable stream_chunks in ${INDEX}`).not.toBeNull();
    const clone = join(dir, "embed_cache.db");
    copyFileSync(CACHE, clone, constants.COPYFILE_FICLONE);
    if (existsSync(`${CACHE}-wal`)) {
      copyFileSync(`${CACHE}-wal`, `${clone}-wal`, constants.COPYFILE_FICLONE);
    }
    const db = join(dir, "index");
    const report = await ingestStreams.ingestStreams({
      streamsDir: STREAMS,
      dbPath: db,
      skipTypes: ingestStreams.parseSkipTypes(ingestStreams.DEFAULT_SKIP_TYPES),
      cachePath: clone,
      model: DEFAULT_EMBED_MODEL,
      dim: DIM,
      client: {
        embedWithUsage: () => Promise.reject(new Error("a cache miss would call the API")),
      },
    });
    expect([report.ok, report.error, report.embedded]).toEqual([true, null, 0]);
    expect(messages).toContain("All embeddings served from cache; nothing to embed.");

    const realTable = real as LanceTable;
    const mine = (await openTable(db, "stream_chunks")) as LanceTable;
    const expected = await load(realTable);
    const got = await load(mine);
    expect(got.fields).toEqual(expected.fields);
    expect(got.rows.length).toBe(expected.rows.length);
    expect(report.cacheHits).toBe(expected.rows.length);
    const diffs: string[] = [];
    expected.rows.forEach((row, i) => {
      for (const [column, value] of Object.entries(row)) {
        if (got.rows[i]?.[column] !== value) diffs.push(`${String(row.id)} ${column}`);
      }
    });
    expect(diffs.slice(0, 10), `${diffs.length} cells differ`).toEqual([]);
    expect(bytes(got.vectors).equals(bytes(expected.vectors))).toBe(true);
    expect(await indices(mine)).toEqual(await indices(realTable));
    expect((await mine.listVersions()).map((v) => v.version)).toEqual(
      (await realTable.listVersions()).map((v) => v.version),
    );
    expect((await mine.stats()).fragmentStats.numFragments).toBe(
      (await realTable.stats()).fragmentStats.numFragments,
    );
    const manifests = (index: string) =>
      readdirSync(join(index, "stream_chunks.lance", "_versions")).sort();
    expect(manifests(db)).toEqual(manifests(INDEX));

    const meta = JSON.parse(readFileSync(join(db, "stream_chunks.meta.json"), "utf8"));
    const read = readdirSync(STREAMS).filter(
      (n) => n.endsWith(".md") || n.endsWith(".refined.json"),
    );
    expect([
      meta.embedModel,
      meta.embedDim,
      meta.rows,
      meta.skipTypes,
      meta.sources.length,
    ]).toEqual([
      DEFAULT_EMBED_MODEL,
      DIM,
      expected.rows.length,
      ["anime_audio", "karaoke"],
      read.length,
    ]);
  },
  600_000,
);

test.skipIf((!haveStreams || !existsSync(CATALOG)) && !REQUIRED)(
  "rebuilds the real stream_catalog.json byte for byte, but for built_at",
  async () => {
    expect(haveStreams, `no transcripts at ${STREAMS}`).toBe(true);
    expect(existsSync(CATALOG), `no catalog at ${CATALOG}`).toBe(true);
    const db = join(dir, "catalog");
    const report = await catalog.writeStreamCatalog({ streamsDir: STREAMS, dbPath: db });
    expect([report.ok, report.error]).toEqual([true, null]);
    const mine = readFileSync(join(db, "stream_catalog.json"), "utf8");
    const expected = readFileSync(CATALOG, "utf8");
    expect(mine.length).toBe(expected.length);
    expect(maskBuiltAt(mine) === maskBuiltAt(expected)).toBe(true);
  },
  600_000,
);
