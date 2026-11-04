import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ROOT } from "@eidolon/config";
import * as lancedb from "@lancedb/lancedb";
import {
  decodeTopics,
  listTableNames,
  openTable,
  PERSONA_FACTS,
  personaFactsSearchParams,
  resolveDbPath,
  STREAM_ARCHIVE,
  scanStreamDates,
  streamArchiveSearchParams,
} from "../src/index.ts";
import { captureLogs, FACT_ROWS, isolateEnv, messages } from "./helpers.ts";

const records = captureLogs();
isolateEnv();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retrieval-tables-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openTable / listTableNames", () => {
  test("a missing directory is never connected to, so nothing is created", async () => {
    const missing = join(dir, "lancedb");
    expect(await openTable(missing, "persona_facts")).toBeNull();
    expect(await listTableNames(missing)).toEqual([]);
    expect(existsSync(missing)).toBe(false);
  });

  test("a directory without a manifest stays untouched", async () => {
    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(await openTable(empty, "persona_facts")).toBeNull();
    expect(readdirSync(empty)).toEqual([]);
  });

  test("an existing table opens; another name is null", async () => {
    const db = await lancedb.connect(dir);
    await db.createTable(
      "persona_facts",
      FACT_ROWS.map((row) => ({ ...row })),
    );
    expect(await listTableNames(dir)).toEqual(["persona_facts"]);
    expect(await (await openTable(dir, "persona_facts"))?.countRows()).toBe(5);
    expect(await openTable(dir, "stream_chunks")).toBeNull();
  });
});

test("resolveDbPath: repo-root relative, absolute as is, blank is the default", () => {
  expect(resolveDbPath()).toBe(join(PROJECT_ROOT, "data/lancedb"));
  process.env.LANCEDB_PATH = "";
  expect(resolveDbPath()).toBe(join(PROJECT_ROOT, "data/lancedb"));
  process.env.LANCEDB_PATH = "elsewhere/db";
  expect(resolveDbPath()).toBe(join(PROJECT_ROOT, "elsewhere/db"));
  process.env.LANCEDB_PATH = "/srv/lancedb";
  expect(resolveDbPath()).toBe("/srv/lancedb");
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
    const db = await lancedb.connect(dir);
    const rows = ["2026-09-08", "", "2026-09-09", "2026-09-08"].map((stream_date, i) => ({
      id: `c${i}`,
      stream_date,
    }));
    await db.createTable("stream_chunks", rows);
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
    // pydantic never validates a default_factory's output, so out-of-range values pass.
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
