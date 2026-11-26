// The stream ingest and catalog against 奶绿's real transcripts and embedding cache in
// EIDOLON_REAL_HOME, read only: both are rebuilt into a temporary folder through a clone of the
// real embedding cache, and any embedding request fails the run. Each test skips without the
// data, unless EIDOLON_REQUIRE_PARITY=1.
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
import {
  closeAllReadTables,
  DEFAULT_EMBED_MODEL,
  EmbedCache,
  hybridSearch,
  openTable,
  streamChunksSchema,
  vectorSearch,
  type ZvecTable,
} from "@eidolon/retrieval";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expectVectorsClose } from "../../retrieval/test/helpers.ts";
import { canonicalPath, catalog, ingestStreams } from "../src/index.ts";
import { maskBuiltAt } from "./ingest_streams_golden.ts";

const HOME = process.env.EIDOLON_REAL_HOME ?? "";
const REQUIRED = process.env.EIDOLON_REQUIRE_PARITY === "1";
const STREAMS = join(HOME, "sources", "milky-green", "streams");
const INDEX = join(HOME, "personas", "milky-green", "index");
const CACHE = join(HOME, "cache", "embed_cache.db");
const CATALOG = join(INDEX, "stream_catalog.json");
const DIM = 3072;

const haveStreams = HOME !== "" && existsSync(STREAMS);

let dir = "";
const messages: string[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ingest-streams-real-"));
  logger.setSink((record) => messages.push(record.message));
});
afterAll(() => {
  closeAllReadTables();
  logger.setSink(consoleSink);
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf((!haveStreams || !existsSync(CACHE)) && !REQUIRED)(
  "rebuilds stream_chunks.zvec from the real transcripts: every row, column, cached vector and index",
  async () => {
    expect(haveStreams, `no transcripts at ${STREAMS}`).toBe(true);
    expect(existsSync(CACHE), `no embedding cache at ${CACHE}`).toBe(true);
    const clone = join(dir, "embed_cache.db");
    copyFileSync(CACHE, clone, constants.COPYFILE_FICLONE);
    if (existsSync(`${CACHE}-wal`)) {
      copyFileSync(`${CACHE}-wal`, `${clone}-wal`, constants.COPYFILE_FICLONE);
    }

    const skipTypes = ingestStreams.parseSkipTypes(ingestStreams.DEFAULT_SKIP_TYPES);
    const expectedRows = await ingestStreams.loadStreams(canonicalPath(STREAMS), { skipTypes });
    expect(expectedRows.length).toBeGreaterThan(10_000);

    const db = join(dir, "index");
    const report = await ingestStreams.ingestStreams({
      streamsDir: STREAMS,
      dbPath: db,
      skipTypes,
      cachePath: clone,
      dim: DIM,
      embedding: {
        provider: "openrouter",
        model: DEFAULT_EMBED_MODEL,
        embed: () => Promise.reject(new Error("a cache miss would call the API")),
      },
    });
    expect([report.ok, report.error, report.embedded, report.cacheHits]).toEqual([
      true,
      null,
      0,
      expectedRows.length,
    ]);
    expect(messages).toContain("All embeddings served from cache; nothing to embed.");

    const mine = (await openTable(db, "stream_chunks")) as ZvecTable;
    expect(mine.columnNames).toEqual(streamChunksSchema(DIM).fields.map((f) => f.name));
    expect(mine.vectorDim).toBe(DIM);
    expect(await mine.countRows()).toBe(expectedRows.length);

    const got = mine.readAll({ includeVectors: true });
    expect(got.rows.length).toBe(expectedRows.length);
    const diffs: string[] = [];
    expectedRows.forEach((row, i) => {
      const { embed_input: _ignored, ...stored } = row;
      for (const [column, value] of Object.entries(stored)) {
        if (got.rows[i]?.[column] !== value) diffs.push(`${row.id} ${column}`);
      }
    });
    expect(diffs.slice(0, 10), `${diffs.length} cells differ`).toEqual([]);

    const cache = new EmbedCache(clone);
    const cachedMap = cache.getMany(
      DEFAULT_EMBED_MODEL,
      DIM,
      expectedRows.slice(0, 256).map((r) => r.embed_input),
    );
    cache.close();
    const expectedSampleVecs = new Float32Array(256 * DIM);
    for (let i = 0; i < 256; i++) {
      expectedSampleVecs.set(cachedMap.get(i) as Float32Array, i * DIM);
    }
    expectVectorsClose(got.vectors.subarray(0, 256 * DIM), expectedSampleVecs);

    const probeVec = got.vectors.subarray(0, DIM);
    const vecHits = await vectorSearch(mine, { vector: probeVec, limit: 5 });
    expect(vecHits[0]?.id).toBe(expectedRows[0]?.id);
    const hybHits = await hybridSearch(mine, {
      vector: probeVec,
      queryText: expectedRows[0]?.heading || "直播",
      candidates: 15,
      finalK: 3,
      rerank: false,
    });
    expect(hybHits.length).toBeGreaterThan(0);

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
      expectedRows.length,
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
    expect(maskBuiltAt(mine).length).toBe(maskBuiltAt(expected).length);
    expect(maskBuiltAt(mine) === maskBuiltAt(expected)).toBe(true);
  },
  600_000,
);
