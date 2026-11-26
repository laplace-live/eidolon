// The Zvec write side against 奶绿's real 3,072-dim embedding cache in EIDOLON_REAL_HOME, read
// only: the SQLite cache is cloned into a temporary folder, real 3,072-dim vectors are written
// into both Zvec schemas, read back bit-for-bit, searched via HNSW and FTS, and re-verified
// through embedInBatches with zero network calls. Skips without the cache, unless
// EIDOLON_REQUIRE_PARITY=1.
import { constants, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pyLstrip, pyStrip } from "@eidolon/config";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  closeAllReadTables,
  DEFAULT_EMBED_MODEL,
  EmbedCache,
  embedInBatches,
  hybridSearch,
  openTable,
  PyPattern,
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
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "retrieval-write-real-"));
});
afterAll(() => {
  closeAllReadTables();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

interface CachedRow {
  readonly text: string;
  readonly embedInput: string;
  readonly vector: Float32Array;
}

const FLOOR_RE = new PyPattern(String.raw`^\s*第(\d+)楼\s*[:：]\s*`);
const BV_RE = new PyPattern(String.raw`^\s*BV[0-9A-Za-z]+\s*[/、,，]\s*`);
const DATE_RE = new PyPattern(
  String.raw`^\s*(?:(\d{4})年(\d{1,2})月(\d{1,2})日|(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?(?=\D|$))\s*[/、,，]?\s*`,
);
const SUBJECT_PREFIX = new PyPattern(
  "^(?:明前奶[绿黑])(?:声称是|声称|声明|强调|认为|觉得|说过|说|解释|讨论|吐槽|抱怨|提到|表示|回应|喜欢|讨厌|希望|担心|模仿|询问|评价|介绍|分享|多次)?[，。、,.;；:：\\s]*",
);

function parseFactEmbedInput(raw: string): { text: string; embedInput: string } | null {
  let line = pyStrip(raw);
  if (!line) return null;
  const floor = FLOOR_RE.match(line);
  if (floor) line = pyLstrip(line.slice(floor.index + floor[0].length));
  line = BV_RE.sub("", line, { count: 1 });
  let isoDate = "";
  const date = DATE_RE.match(line);
  if (date) {
    const [year, month, day] = (date[1] !== undefined ? date.slice(1, 4) : date.slice(4, 7)).map(
      (digits) => Number(digits),
    ) as [number, number, number];
    isoDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    line = pyLstrip(line.slice(date.index + date[0].length));
  }
  if (line.length < 4) return null;
  const body = SUBJECT_PREFIX.sub("", line, { count: 1 }) || line;
  const embedInput = isoDate ? `${isoDate}：${body}` : body;
  return { text: line, embedInput };
}

function readCachedSample(clonePath: string, limit: number): CachedRow[] {
  const candidates: { text: string; embedInput: string }[] = [];
  const seen = new Set<string>();
  for (const name of ["店长坚果设定集.txt", "明前奶绿设定集.txt", "明前奶绿事件集.txt"]) {
    const file = join(REAL_FACTS, name);
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const parsed = parseFactEmbedInput(raw);
      if (!parsed || seen.has(parsed.text)) continue;
      seen.add(parsed.text);
      candidates.push(parsed);
      if (candidates.length >= limit * 2) break;
    }
    if (candidates.length >= limit * 2) break;
  }
  const cache = new EmbedCache(clonePath);
  try {
    const cachedMap = cache.getMany(
      DEFAULT_EMBED_MODEL,
      DIM,
      candidates.map((c) => c.embedInput),
    );
    const out: CachedRow[] = [];
    for (const [i, candidate] of candidates.entries()) {
      const vector = cachedMap.get(i);
      if (!vector) continue;
      out.push({ text: candidate.text, embedInput: candidate.embedInput, vector });
      if (out.length >= limit) break;
    }
    return out;
  } finally {
    cache.close();
  }
}

test.skipIf((!existsSync(REAL_CACHE) || !existsSync(REAL_FACTS)) && !REQUIRED)(
  "persona_facts and stream_chunks preserve real 3,072-dim vectors and serve HNSW + FTS",
  async () => {
    expect(existsSync(REAL_CACHE), `no embedding cache at ${REAL_CACHE}`).toBe(true);
    expect(existsSync(REAL_FACTS), `no fact files at ${REAL_FACTS}`).toBe(true);
    const clone = join(dir, "embed_cache.db");
    copyFileSync(REAL_CACHE, clone, constants.COPYFILE_FICLONE);
    if (existsSync(`${REAL_CACHE}-wal`)) {
      copyFileSync(`${REAL_CACHE}-wal`, `${clone}-wal`, constants.COPYFILE_FICLONE);
    }
    const sample = readCachedSample(clone, SAMPLE_SIZE);
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
    const inputs = sample.map((entry) => entry.embedInput);
    const cache = new EmbedCache(clone);
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
  300_000,
);
