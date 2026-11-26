import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataHome, PROJECT_ROOT } from "@eidolon/config";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  closeAllReadTables,
  decodeTopics,
  hybridSearch,
  listTableNames,
  openTable,
  PERSONA_FACTS,
  personaFactsSchema,
  personaFactsSearchParams,
  resolveDbPath,
  STREAM_ARCHIVE,
  scanStreamDates,
  streamArchiveSearchParams,
  streamChunksSchema,
  writeTable,
} from "../src/index.ts";
import { captureLogs, FACT_ROWS, isolateEnv, messages } from "./helpers.ts";

const records = captureLogs();
isolateEnv();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrieval-tables-"));
});
afterEach(() => {
  closeAllReadTables();
  rmSync(dir, { recursive: true, force: true });
});

describe("openTable / listTableNames", () => {
  test("a missing directory is never opened, so nothing is created", async () => {
    const missing = join(dir, "index");
    expect(await openTable(missing, "persona_facts")).toBeNull();
    expect(await listTableNames(missing)).toEqual([]);
    expect(existsSync(missing)).toBe(false);
  });

  test("a directory without a table stays untouched", async () => {
    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(await openTable(empty, "persona_facts")).toBeNull();
    expect(readdirSync(empty)).toEqual([]);
  });

  test("an existing table opens; another name is null", async () => {
    const vectors = Float32Array.from(FACT_ROWS.flatMap((row) => row.vector));
    await writeTable(dir, "persona_facts", FACT_ROWS, personaFactsSchema(4), vectors);
    expect(await listTableNames(dir)).toEqual(["persona_facts"]);
    expect(await (await openTable(dir, "persona_facts"))?.countRows()).toBe(5);
    expect(await openTable(dir, "stream_chunks")).toBeNull();
  });

  test("a read-only index tree opens and searches without mutating dbPath", async () => {
    const setModes = (root: string, dirMode: number, fileMode: number): void => {
      if (dirMode >= 0o700) chmodSync(root, dirMode);
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const full = join(root, entry.name);
        if (entry.isDirectory()) setModes(full, dirMode, fileMode);
        else chmodSync(full, fileMode);
      }
      if (dirMode < 0o700) chmodSync(root, dirMode);
    };

    const vectors = Float32Array.from(FACT_ROWS.flatMap((row) => row.vector));
    await writeTable(dir, "persona_facts", FACT_ROWS, personaFactsSchema(4), vectors);
    closeAllReadTables();
    setModes(dir, 0o555, 0o444);
    try {
      const table = await openTable(dir, "persona_facts");
      expect(table).not.toBeNull();
      expect(await table!.countRows()).toBe(5);
      const hits = await hybridSearch(table!, {
        vector: FACT_ROWS[0]!.vector,
        queryText: FACT_ROWS[0]!.text,
        candidates: 5,
        finalK: 3,
        rerank: false,
      });
      expect(hits[0]?.id).toBe(FACT_ROWS[0]!.id);
    } finally {
      closeAllReadTables();
      setModes(dir, 0o755, 0o644);
    }
  });
});

test("resolveDbPath: the persona's index by default, else INDEX_PATH or legacy LANCEDB_PATH", () => {
  const personaIndex = join(dataHome(), "personas", "milky-green", "index");
  expect(resolveDbPath()).toBe(personaIndex);
  process.env.INDEX_PATH = "";
  process.env.LANCEDB_PATH = "";
  expect(resolveDbPath()).toBe(personaIndex);
  process.env.LANCEDB_PATH = "elsewhere/legacy";
  expect(resolveDbPath()).toBe(join(PROJECT_ROOT, "elsewhere/legacy"));
  process.env.INDEX_PATH = "elsewhere/db";
  expect(resolveDbPath()).toBe(join(PROJECT_ROOT, "elsewhere/db"));
  process.env.INDEX_PATH = "/srv/index";
  expect(resolveDbPath()).toBe("/srv/index");
});

test.each([
  ["", []],
  ["[]", []],
  ["x", []],
  ["{}", []],
  ['["a",1]', ["a", "1"]],
  ["[null,true]", ["None", "True"]],
  ['["深夜","ASMR"]', ["深夜", "ASMR"]],
])("decodeTopics(%p)", (topics, expected) => {
  expect(decodeTopics({ topics })).toEqual(expected);
});

test("decodeTopics of a missing or null column", () => {
  expect(decodeTopics({})).toEqual([]);
  expect(decodeTopics({ topics: null })).toEqual([]);
});

describe("scanStreamDates", () => {
  test("raw non-empty values, duplicates kept; null without the table", async () => {
    expect(await scanStreamDates(dir)).toBeNull();
    const rows = ["2026-09-08", "", "2026-09-09", "2026-09-08"].map((stream_date, i) => ({
      id: `c${i}`,
      stream_id: `s${i}`,
      stream_date,
      heading: "",
      text: "",
      summary: "",
      details: "",
      chunk_type: "",
      topics: "[]",
      mentions: "[]",
      extras_json: "{}",
      refined: false,
      tokens: "",
      source_path: "",
    }));
    await writeTable(
      dir,
      "stream_chunks",
      rows,
      streamChunksSchema(4),
      new Float32Array(rows.length * 4),
    );
    expect((await scanStreamDates(dir))?.sort()).toEqual([
      "2026-09-08",
      "2026-09-08",
      "2026-09-09",
    ]);
  });
});

describe("search params", () => {
  test("defaults", () => {
    expect(personaFactsSearchParams()).toEqual({ candidates: 30, topK: 8 });
    expect(streamArchiveSearchParams()).toEqual({ candidates: 15, topK: 3 });
  });

  test.each([
    ["", 30, 15],
    ["50", 50, 50],
    // Out-of-range values pass unvalidated.
    ["0", 0, 0],
    ["500", 500, 500],
  ])("CANDIDATES=%p", (value, facts, archive) => {
    process.env.PERSONA_FACTS_CANDIDATES = value;
    process.env.STREAM_ARCHIVE_CANDIDATES = value;
    expect(personaFactsSearchParams().candidates).toBe(facts);
    expect(streamArchiveSearchParams().candidates).toBe(archive);
  });

  test("an invalid value warns and keeps the default", () => {
    process.env.STREAM_ARCHIVE_CANDIDATES = "abc";
    expect(streamArchiveSearchParams().candidates).toBe(15);
    expect(messages(records, "WARNING").length).toBe(1);
  });
});

describe("presets", () => {
  test("persona facts summary", () => {
    const hits = [
      { source: "b.txt", date: "2026-05-09" },
      { source: "a.txt", date: "" },
      { source: "b.txt", date: "2026-05-10" },
      { date: "" },
    ];
    expect(PERSONA_FACTS.summarize(hits)).toBe("sources=['?', 'a.txt', 'b.txt'], dated=2/4");
  });

  test("stream archive summary", () => {
    const hits = [
      { stream_date: "2026-09-08", refined: true, chunk_type: "karaoke" },
      { stream_date: "2026-09-07", refined: false, chunk_type: "" },
      { refined: true, chunk_type: "commentary" },
    ];
    expect(STREAM_ARCHIVE.summarize(hits)).toBe(
      "dates=['2026-09-07', '2026-09-08', '?'], refined=2/3, types=['commentary', 'karaoke', 'raw']",
    );
  });
});
