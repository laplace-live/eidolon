// 奶绿's persona_facts rebuilt from her real fact files, through the command as a user runs it, and
// verified against loadFacts and her real embedding cache. EIDOLON_REAL_HOME is only read: the
// Zvec index is written into a temporary folder, and the embedding cache is cloned there, so a run
// that missed it would fail rather than pay. Skips without the data, unless
// EIDOLON_REQUIRE_PARITY=1.
import {
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { installSettings, resetSettings } from "@eidolon/config";
import { canonicalPath, ingestFacts } from "@eidolon/ingest";
import {
  closeAllReadTables,
  DEFAULT_EMBED_MODEL,
  EmbedCache,
  embeddingSelection,
  openTable,
  personaFactsSchema,
  resetEmbeddingModel,
  type ZvecTable,
} from "@eidolon/retrieval";
import { afterAll, beforeAll, expect, test } from "vitest";
import { expectVectorsClose } from "../../../packages/retrieval/test/helpers.ts";
import { ingestFactsMain } from "../src/ingest_facts.ts";
import { captureIo, captureLogs } from "./helpers.ts";

const REAL_HOME = process.env.EIDOLON_REAL_HOME ?? "";
const REAL_FACTS = join(REAL_HOME, "sources", "milky-green", "facts");
const REAL_CACHE = join(REAL_HOME, "cache", "embed_cache.db");
const REQUIRED = process.env.EIDOLON_REQUIRE_PARITY === "1";
const DIM = 3072;
const FILES = ["店长坚果设定集.txt", "明前奶绿设定集.txt", "明前奶绿事件集.txt"];
const present = REAL_HOME !== "" && existsSync(REAL_FACTS) && existsSync(REAL_CACHE);

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-ingest-facts-real-"));
});
afterAll(() => {
  closeAllReadTables();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!present && !REQUIRED)(
  "laplace-ingest-facts rebuilds persona_facts.zvec from the real fact files and cached vectors",
  async () => {
    expect(existsSync(REAL_FACTS), `no fact files at ${REAL_FACTS}`).toBe(true);
    expect(existsSync(REAL_CACHE), `no embedding cache at ${REAL_CACHE}`).toBe(true);
    const clone = join(dir, "embed_cache.db");
    copyFileSync(REAL_CACHE, clone, constants.COPYFILE_FICLONE);
    if (existsSync(`${REAL_CACHE}-wal`)) {
      copyFileSync(`${REAL_CACHE}-wal`, `${clone}-wal`, constants.COPYFILE_FICLONE);
    }
    const db = join(dir, "index");
    const saved = { model: process.env.EMBED_MODEL, dim: process.env.EMBED_DIM };
    delete process.env.EMBED_MODEL;
    delete process.env.EMBED_DIM;
    installSettings();
    resetEmbeddingModel();

    const resolvedFiles = ingestFacts.resolveFactFiles(REAL_FACTS);
    const expectedLoaded = ingestFacts.loadFacts(resolvedFiles);
    const perSource = FILES.map(
      (name) => expectedLoaded.rows.filter((row) => row.source === name).length,
    );

    const logs = captureLogs();
    const io = captureIo();
    let code: number;
    try {
      code = await ingestFactsMain(
        [
          "--persona",
          "milky-green",
          "--data-dir",
          REAL_FACTS,
          "--db-path",
          db,
          "--cache-path",
          clone,
        ],
        {
          ...io.io,
          embedding: {
            provider: "openrouter",
            model: embeddingSelection().model,
            embed: () => Promise.reject(new Error("every fact should have hit the cache")),
          },
        },
      );
    } finally {
      logs.stop();
      resetSettings();
      if (saved.model !== undefined) process.env.EMBED_MODEL = saved.model;
      if (saved.dim !== undefined) process.env.EMBED_DIM = saved.dim;
    }
    expect([code, io.stdout(), io.stderr()]).toEqual([0, "", ""]);

    const totalRows = expectedLoaded.rows.length;
    const messages = logs.records.map(([, message]) => message);
    const at = (pattern: RegExp) => messages.filter((m) => pattern.test(m));
    expect(messages[0]).toBe(`Persona milky-green's index: ${canonicalPath(db)}`);
    expect(messages[1]).toBe(`Ingesting from: ['${FILES.join("', '")}']`);
    expect(at(/^Loaded /).map((m) => m.replace(/, \d+ duplicates skipped$/, ""))).toEqual(
      FILES.map((name, i) => `Loaded ${name}: ${perSource[i]} facts kept`),
    );
    expect(at(/^Total: /)).toEqual([
      expect.stringMatching(
        new RegExp(`^Total: ${totalRows} unique facts from \\d+ raw lines across 3 file\\(s\\)$`),
      ),
    ]);
    const escaped = canonicalPath(clone).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(messages.slice(6)).toEqual([
      expect.stringMatching(new RegExp(`^Embedding cache: ${escaped} \\(\\d+ vectors on disk\\)$`)),
      `Cache: ${totalRows}/${totalRows} embeddings reused, 0 need fresh embedding`,
      "All embeddings served from cache; nothing to embed.",
      `Wrote ${totalRows} rows to ${canonicalPath(db)}/persona_facts.zvec`,
      "Built HNSW and FTS indexes for persona_facts",
      `Embedding totals: ${totalRows} facts, 0 tokens (provider did not report cost and no ` +
        "local price entry — add the model's price to the provider catalog to fix)",
    ]);

    const table = (await openTable(db, "persona_facts")) as ZvecTable;
    expect(table.columnNames).toEqual(personaFactsSchema(DIM).fields.map((f) => f.name));
    expect(table.vectorDim).toBe(DIM);
    const mine = table.readAll({ includeVectors: true });
    expect(mine.rows.length).toBe(totalRows);
    const expectedRows = expectedLoaded.rows.map(({ embed_input: _ignored, ...rest }) => rest);
    expect(isDeepStrictEqual(mine.rows, expectedRows)).toBe(true);

    const cache = new EmbedCache(clone);
    const cachedMap = cache.getMany(
      DEFAULT_EMBED_MODEL,
      DIM,
      expectedLoaded.rows.map((r) => r.embed_input),
    );
    cache.close();
    expect(cachedMap.size).toBe(totalRows);
    const expectedVectors = new Float32Array(totalRows * DIM);
    for (let i = 0; i < totalRows; i++) {
      expectedVectors.set(cachedMap.get(i) as Float32Array, i * DIM);
    }
    expectVectorsClose(mine.vectors, expectedVectors);

    const meta = JSON.parse(readFileSync(join(db, "persona_facts.meta.json"), "utf8"));
    expect(meta).toEqual({
      embedModel: "google/gemini-embedding-2-preview",
      embedDim: DIM,
      rows: totalRows,
      builtAt: expect.any(String),
      sources: FILES.map((name) => {
        const stat = statSync(join(REAL_FACTS, name));
        return { name, size: stat.size, mtime: stat.mtime.toISOString() };
      }),
      patterns: ["*设定集.txt", "*事件集.txt"],
    });
  },
  120_000,
);
