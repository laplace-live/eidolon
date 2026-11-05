// 奶绿's persona_facts rebuilt from her real fact files, through the command as a user runs it, and
// compared with the table Python built. EIDOLON_REAL_HOME is only read: the index is written into a
// temporary folder, and the embedding cache is cloned there, so a run that missed it would fail
// rather than pay. Skips without the data, unless EIDOLON_REQUIRE_PARITY=1.
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSettings, resetSettings } from "@eidolon/config";
import { canonicalPath } from "@eidolon/ingest";
import { type LanceTable, openTable, resetEmbeddingClient } from "@eidolon/retrieval";
import {
  f32Bytes as bytes,
  tableIndices as indices,
} from "../../../packages/retrieval/test/helpers.ts";
import { ingestFactsMain } from "../src/ingest_facts.ts";
import { captureIo, captureLogs } from "./helpers.ts";

const REAL_HOME = process.env.EIDOLON_REAL_HOME ?? "";
const REAL_FACTS = join(REAL_HOME, "sources", "milky-green", "facts");
const REAL_INDEX = join(REAL_HOME, "personas", "milky-green", "index");
const REAL_CACHE = join(REAL_HOME, "cache", "embed_cache.db");
const REQUIRED = process.env.EIDOLON_REQUIRE_PARITY === "1";
const DIM = 3072;
// The order _resolve_files gave: each pattern's matches by code point (店 U+5E97 before 明 U+660E),
// then the next pattern's.
const FILES = ["店长坚果设定集.txt", "明前奶绿设定集.txt", "明前奶绿事件集.txt"];

async function realTable(): Promise<LanceTable | null> {
  try {
    const table = await openTable(REAL_INDEX, "persona_facts");
    await table?.query().limit(1).toArray();
    return table;
  } catch {
    return null;
  }
}

const real = await realTable();
const present = real !== null && existsSync(REAL_FACTS) && existsSync(REAL_CACHE);

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-ingest-facts-real-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Utf8Chunk {
  readonly length: number;
  readonly values: Uint8Array;
  readonly valueOffsets: Int32Array;
}

/** A Utf8 column's strings as stored: apache-arrow's own decoder drops a leading U+FEFF. */
function utf8Column(table: unknown, name: string): string[] {
  const column = (table as { getChild(name: string): { data: Utf8Chunk[] } }).getChild(name);
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  return column.data.flatMap((chunk) =>
    Array.from({ length: chunk.length }, (_, i) =>
      decoder.decode(
        chunk.values.subarray(chunk.valueOffsets[i] as number, chunk.valueOffsets[i + 1] as number),
      ),
    ),
  );
}

/** Every column in scan order, the strings as stored and the vectors as their float32 bytes. */
async function load(table: LanceTable) {
  const data = await table.query().toArrow();
  const columns: Record<string, unknown[]> = {};
  for (const name of ["id", "source", "date", "text", "tokens"]) {
    columns[name] = utf8Column(data, name);
  }
  columns.floor = [...data].map((row) => row.floor as number);
  const vectors = new Float32Array(data.numRows * DIM);
  for (const [i, row] of [...data].entries()) {
    vectors.set(row.vector.toArray() as Float32Array, i * DIM);
  }
  const schema = data.schema.fields.map((f) => {
    const child = (f.type as { children?: { name: string; type: unknown; nullable: boolean }[] })
      .children?.[0];
    return [f.name, String(f.type), f.nullable, child?.name, String(child?.type), child?.nullable];
  });
  return { schema, metadata: [...data.schema.metadata], columns, vectors, rows: data.numRows };
}

test.skipIf(!present && !REQUIRED)(
  "laplace-ingest-facts rebuilds the real persona_facts exactly, every vector from the cache",
  async () => {
    expect(existsSync(REAL_FACTS), `no fact files at ${REAL_FACTS}`).toBe(true);
    expect(existsSync(REAL_CACHE), `no embedding cache at ${REAL_CACHE}`).toBe(true);
    expect(real, `no readable persona_facts in ${REAL_INDEX}`).not.toBeNull();
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
    resetEmbeddingClient();
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
          client: {
            embedWithUsage: () => Promise.reject(new Error("every fact should have hit the cache")),
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

    const expected = await load(real as LanceTable);
    const perSource = FILES.map(
      (name) => expected.columns.source?.filter((source) => source === name).length,
    );
    const messages = logs.records.map(([, message]) => message);
    const at = (pattern: RegExp) => messages.filter((m) => pattern.test(m));
    expect(messages[0]).toBe(`Persona milky-green's index: ${canonicalPath(db)}`);
    expect(messages[1]).toBe(`Ingesting from: ['${FILES.join("', '")}']`);
    expect(at(/^Loaded /).map((m) => m.replace(/, \d+ duplicates skipped$/, ""))).toEqual(
      FILES.map((name, i) => `Loaded ${name}: ${perSource[i]} facts kept`),
    );
    expect(at(/^Total: /)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Total: ${expected.rows} unique facts from \\d+ raw lines across 3 file\\(s\\)$`,
        ),
      ),
    ]);
    const escaped = canonicalPath(clone).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(messages.slice(6)).toEqual([
      expect.stringMatching(new RegExp(`^Embedding cache: ${escaped} \\(\\d+ vectors on disk\\)$`)),
      `Cache: ${expected.rows}/${expected.rows} embeddings reused, 0 need fresh embedding`,
      "All embeddings served from cache; nothing to embed.",
      `Wrote ${expected.rows} rows to ${canonicalPath(db)}/persona_facts.lance`,
      "Built FTS index on 'tokens' for persona_facts",
      `Embedding totals: ${expected.rows} facts, 0 tokens (provider did not report cost and no ` +
        "local price entry — add the model to embeddings.EMBED_PRICING_USD_PER_1M to fix)",
    ]);

    const table = (await openTable(db, "persona_facts")) as LanceTable;
    const mine = await load(table);
    expect(mine.schema).toEqual(expected.schema);
    expect(mine.metadata).toEqual(expected.metadata);
    expect(mine.rows).toBe(expected.rows);
    for (const [name, values] of Object.entries(expected.columns)) {
      expect({ name, equal: Bun.deepEquals(mine.columns[name], values) }).toEqual({
        name,
        equal: true,
      });
    }
    expect(bytes(mine.vectors).equals(bytes(expected.vectors))).toBe(true);
    expect(await indices(table)).toEqual(await indices(real as LanceTable));
    const versions = async (t: LanceTable) => (await t.listVersions()).map((v) => v.version);
    expect(await versions(table)).toEqual(await versions(real as LanceTable));
    expect((await table.stats()).fragmentStats.numFragments).toBe(
      (await (real as LanceTable).stats()).fragmentStats.numFragments,
    );
    expect(readdirSync(join(db, "persona_facts.lance", "_versions")).sort()).toEqual(
      readdirSync(join(REAL_INDEX, "persona_facts.lance", "_versions")).sort(),
    );

    const meta = JSON.parse(readFileSync(join(db, "persona_facts.meta.json"), "utf8"));
    expect(meta).toEqual({
      embedModel: "google/gemini-embedding-2-preview",
      embedDim: DIM,
      rows: expected.rows,
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
