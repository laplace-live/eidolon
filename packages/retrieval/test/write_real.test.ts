// The Zvec write side against 奶绿's real 3,072-dim embedding cache in EIDOLON_REAL_HOME, read
// only: the SQLite cache is cloned into a temporary folder, real 3,072-dim vectors are written
// into both Zvec schemas, read back bit-for-bit, searched via HNSW and FTS, and re-verified
// through embedInBatches with zero network calls. Skips without the cache, unless
// EIDOLON_REQUIRE_PARITY=1.
import { constants, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  closeAllReadTables,
  DEFAULT_EMBED_MODEL,
  EmbedCache,
  embedInBatches,
  hybridSearch,
  openTable,
  personaFactsSchema,
  streamChunksSchema,
  tokenizeZh,
  tokenizeZhQuery,
  vectorSearch,
  writeTable,
  type ZvecTable,
} from "../src/index.ts";
import { f32Bytes as bytes, captureLogs, expectVectorsClose, messages } from "./helpers.ts";

const REQUIRED = process.env.EIDOLON_REQUIRE_PARITY === "1";
const REAL_HOME = process.env.EIDOLON_REAL_HOME ?? "";
const REAL_CACHE = join(REAL_HOME, "cache", "embed_cache.db");
const REAL_FACTS = join(REAL_HOME, "sources", "milky-green", "facts");
const DIM = 3072;
const SAMPLE_SIZE = 600;
const records = captureLogs();

let dir = "";
let clone = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "retrieval-write-real-"));
  if (existsSync(REAL_CACHE)) {
    clone = join(dir, "embed_cache.db");
    copyFileSync(REAL_CACHE, clone, constants.COPYFILE_FICLONE);
    if (existsSync(`${REAL_CACHE}-wal`)) {
      copyFileSync(`${REAL_CACHE}-wal`, `${clone}-wal`, constants.COPYFILE_FICLONE);
    }
  }
}, 60_000);
afterAll(() => {
  closeAllReadTables();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

interface CachedRow {
  readonly text: string;
  readonly vector: Float32Array;
}

function readCachedSample(limit: number): CachedRow[] {
  const texts: string[] = [];
  const seen = new Set<string>();
  for (const name of ["店长坚果设定集.txt", "明前奶绿设定集.txt", "明前奶绿事件集.txt"]) {
    const file = join(REAL_FACTS, name);
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const text = raw.replace(/^\uFEFF/, "").trim();
      if (text.length < 6 || seen.has(text)) continue;
      seen.add(text);
      texts.push(text);
      if (texts.length >= limit) break;
    }
    if (texts.length >= limit) break;
  }
  const db = new DatabaseSync(clone, { readOnly: true });
  try {
    const blobs = db
      .prepare("SELECT vector FROM embed_cache WHERE length(vector) = ? ORDER BY key LIMIT ?")
      .all(DIM * 4, texts.length) as { vector: Uint8Array }[];
    return blobs.map((row, i) => {
      const aligned = new Float32Array(DIM);
      const view = new DataView(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
      for (let j = 0; j < DIM; j++) aligned[j] = view.getFloat32(j * 4, true);
      return { text: texts[i] as string, vector: aligned };
    });
  } finally {
    db.close();
  }
}

test.skipIf((!existsSync(REAL_CACHE) || !existsSync(REAL_FACTS)) && !REQUIRED)(
  "persona_facts and stream_chunks preserve real 3,072-dim vectors and serve HNSW + FTS",
  async () => {
    expect(existsSync(REAL_CACHE), `no embedding cache at ${REAL_CACHE}`).toBe(true);
    expect(existsSync(REAL_FACTS), `no fact files at ${REAL_FACTS}`).toBe(true);
    const sample = readCachedSample(SAMPLE_SIZE);
    expect(sample.length).toBe(SAMPLE_SIZE);

    const vectors = new Float32Array(sample.length * DIM);
    for (const [i, entry] of sample.entries()) vectors.set(entry.vector, i * DIM);

    const factRows = sample.map((entry, i) => ({
      id: `fact_${i}`,
      source: "设定集.txt",
      date: i % 3 === 0 ? "2026-05-09" : "",
      floor: i,
      text: entry.text,
      tokens: tokenizeZh(entry.text),
    }));
    await writeTable(dir, "persona_facts", factRows, personaFactsSchema(DIM), vectors);
    const factsTable = (await openTable(dir, "persona_facts")) as ZvecTable;
    const factsBack = factsTable.readAll({ includeVectors: true });
    expect(factsBack.rows).toEqual(factRows);
    expectVectorsClose(factsBack.vectors, vectors);

    const probe = sample[42] as CachedRow;
    const vecHits = await vectorSearch(factsTable, { vector: probe.vector, limit: 5 });
    expect(vecHits[0]?.id).toBe("fact_42");
    const queryText = tokenizeZhQuery(probe.text) || probe.text;
    const hybHits = await hybridSearch(factsTable, {
      vector: probe.vector,
      queryText,
      candidates: 30,
      finalK: 8,
      rerank: false,
    });
    expect(hybHits.map((r) => r.id)).toContain("fact_42");

    const chunkRows = sample.map((entry, i) => ({
      id: `2026-09-08-BV1xx::${String(i).padStart(4, "0")}`,
      stream_id: "2026-09-08-BV1xx",
      stream_date: "2026-09-08",
      heading: `片段 ${i}`,
      text: entry.text,
      summary: entry.text,
      details: "",
      chunk_type: "commentary",
      topics: "[]",
      mentions: "[]",
      extras_json: "{}",
      refined: true,
      tokens: tokenizeZh(entry.text),
      source_path: "streams/2026-09-08-BV1xx.md",
    }));
    await writeTable(dir, "stream_chunks", chunkRows, streamChunksSchema(DIM), vectors);
    const chunksTable = (await openTable(dir, "stream_chunks")) as ZvecTable;
    const chunksBack = chunksTable.readAll({ includeVectors: true });
    expect(chunksBack.rows).toEqual(chunkRows);
    expectVectorsClose(chunksBack.vectors, vectors);

    records.length = 0;
    const inputs = sample.map((entry) => entry.text);
    const cache = new EmbedCache(join(dir, "batch_cache.db"));
    cache.putMany(
      DEFAULT_EMBED_MODEL,
      DIM,
      sample.map((entry) => [entry.text, entry.vector] as const),
    );
    const report = await embedInBatches(inputs, {
      batchSize: 64,
      noun: "chunks",
      cache,
      dim: DIM,
      embedding: {
        provider: "openrouter",
        model: DEFAULT_EMBED_MODEL,
        embed: () => Promise.reject(new Error("every input should have hit the cache")),
      },
    });
    cache.close();
    expect([report.cacheHits, report.embedded]).toEqual([inputs.length, 0]);
    expect(bytes(report.vectors).equals(bytes(vectors))).toBe(true);
    expect(messages(records, "INFO")).toEqual([
      `Cache: ${inputs.length}/${inputs.length} embeddings reused, 0 need fresh embedding`,
      "All embeddings served from cache; nothing to embed.",
    ]);
  },
  120_000,
);
