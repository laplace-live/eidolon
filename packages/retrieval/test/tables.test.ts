import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataHome, PROJECT_ROOT } from "@eidolon/config";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  closeAllReadTables,
  closeReadTablesUnder,
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
import { CURRENT_FILE, readCurrentBuildId } from "../src/tables.ts";
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

  test("reopening a newer build retires the superseded handle, waits for in-flight reads, and prunes shadows", async () => {
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
      const first = (await openTable(dir, "persona_facts"))!;
      let releaseRead!: () => void;
      const gate = new Promise<void>((resolveGate) => {
        releaseRead = resolveGate;
      });
      const inFlight = first.run(async (col) => {
        await gate;
        const fetched = col.fetchSync({ ids: ["4"], outputFields: ["id", "text"] });
        const queried = await col.query({
          fieldName: "vector",
          vector: Float32Array.from(FACT_ROWS[4]!.vector),
          topk: 2,
          outputFields: ["id"],
        });
        return {
          docCount: col.stats.docCount,
          fetchedId: fetched["4"]?.fields.id,
          fetchedText: fetched["4"]?.fields.text,
          topHitId: queried[0]?.fields.id,
        };
      });

      setModes(dir, 0o755, 0o644);
      const subset = FACT_ROWS.slice(0, 2);
      await writeTable(
        dir,
        "persona_facts",
        subset,
        personaFactsSchema(4),
        Float32Array.from(subset.flatMap((row) => row.vector)),
      );
      setModes(dir, 0o555, 0o444);

      const second = (await openTable(dir, "persona_facts"))!;
      expect(first.isClosed).toBe(true);
      expect(second.buildId).not.toBe(first.buildId);
      // Still usable by the already-running read until it settles, even after the old build is gone.
      releaseRead();
      expect(await inFlight).toEqual({
        docCount: 5,
        fetchedId: "f4",
        fetchedText: FACT_ROWS[4]!.text,
        topHitId: "f4",
      });
      expect(await second.countRows()).toBe(2);

      const uid = process.getuid?.() ?? "user";
      const shadowRoot = join(tmpdir(), `eidolon-zvec-ro-${uid}`, String(process.pid));
      const buckets = readdirSync(shadowRoot).filter((name) => name.endsWith("-persona_facts"));
      for (const b of buckets) {
        expect(readdirSync(join(shadowRoot, b))).not.toContain(first.buildId);
      }
    } finally {
      closeAllReadTables();
      setModes(dir, 0o755, 0o644);
    }
  });

  test("rejects path-traversal CURRENT pointers and closes handles opened across symlinks", async () => {
    const vectors = Float32Array.from(FACT_ROWS.flatMap((row) => row.vector));
    await writeTable(dir, "persona_facts", FACT_ROWS, personaFactsSchema(4), vectors);
    const linkParent = mkdtempSync(join(tmpdir(), "retrieval-link-"));
    try {
      const link = join(linkParent, "alias");
      symlinkSync(dir, link, "dir");
      const viaLink = (await openTable(link, "persona_facts"))!;
      expect(viaLink.isClosed).toBe(false);
      closeReadTablesUnder(dir);
      expect(viaLink.isClosed).toBe(true);

      writeFileSync(join(dir, "persona_facts.zvec", CURRENT_FILE), "../../escape\n");
      expect(readCurrentBuildId(dir, "persona_facts")).toBeNull();
      expect(await openTable(dir, "persona_facts")).toBeNull();
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
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

  test("scans across multiple SCAN_CHUNK slices while yielding to the event loop", async () => {
    const rows = Array.from({ length: 2_100 }, (_, i) => ({
      id: `c${i}`,
      stream_id: `s${i}`,
      stream_date: i % 2 === 0 ? "2026-09-10" : "",
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
    expect((await scanStreamDates(dir))?.length).toBe(1_050);
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
