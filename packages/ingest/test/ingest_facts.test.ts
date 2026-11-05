// fixtures/ingest_facts/golden.json is what fixtures/ingest_facts/golden.py printed through
// tools/ingest_facts.py: line parsing, the prefix strip, pathlib's glob, load_facts. The CLI's
// tests replay its main() runs; these cover the library alone, and what Python never had.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  consoleSink,
  installSettings,
  type LogRecord,
  logger,
  resetSettings,
  sortedPy,
} from "@eidolon/config";
import {
  EmbeddingClient,
  EmbeddingUsage,
  type LanceTable,
  openTable,
  resetEmbeddingClient,
  tokenizeZh,
} from "@eidolon/retrieval";
import { ingestFacts, type ProgressEvent } from "../src/index.ts";

const {
  factPatterns,
  factPrefixPattern,
  factSubject,
  ingestFactFiles,
  indexMetaPath,
  loadFacts,
  namePattern,
  parseFactLine,
  resolveFactFiles,
  stripFactPrefix,
} = ingestFacts;

interface ParseCase {
  raw: string;
  date: string;
  floor: number;
  text: string;
  stripped: string;
  id: string;
  tokens: string;
}

const golden = (await Bun.file(
  join(import.meta.dir, "fixtures/ingest_facts/golden.json"),
).json()) as {
  printed_by: string;
  fact_files: Record<string, string>;
  parse: ParseCase[];
  load: { files: string[]; rows: Record<string, unknown>[]; logs: [string, string][] };
  glob: { names: string[]; matches: Record<string, string[] | { error: string }> };
};

const MILKY_GREEN = { patterns: ["*设定集.txt", "*事件集.txt"], subject: "明前奶[绿黑]" };

// Variables a developer's shell may carry that these tests set themselves, or must not see.
const ISOLATED = [
  "FACTS_FILES",
  "FACTS_SUBJECT",
  "EMBED_MODEL",
  "EMBED_DIM",
  "EMBED_BASE_URL",
  "EMBED_API_KEY",
  "OPENROUTER_API_KEY",
  "EIDOLON_PERSONA",
];

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`unexpected network call in a test: ${String(input)}`);
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

let work = "";
let records: LogRecord[] = [];
const saved = new Map<string, string | undefined>();
beforeEach(() => {
  for (const key of ISOLATED) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  resetSettings();
  resetEmbeddingClient();
  work = mkdtempSync(join(tmpdir(), "ingest-facts-"));
  records = [];
  logger.setSink((record) => records.push(record));
});
afterEach(() => {
  logger.setSink(consoleSink);
  rmSync(work, { recursive: true, force: true });
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSettings();
  resetEmbeddingClient();
});

const logLines = (): [string, string][] => records.map((r) => [r.level, r.message]);

function writeFiles(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, "utf8");
}

/** Python's fake_vector, as float64 values the cache and the table round to float32. */
function fakeVector(text: string): number[] {
  let sum = 0;
  for (const ch of text) sum += ch.codePointAt(0) as number;
  const base = sum % 97;
  // Python's -base is an int, so a 0 divides to 0.0, never -0.0.
  return [base / 7, (0 - base) / 3, 0.1 * base, 1 / (base + 3)];
}

function fakeClient(calls: string[][] = []) {
  return {
    async embedWithUsage(texts: readonly string[]) {
      calls.push([...texts]);
      const tokens = texts.reduce((n, t) => n + [...t].length, 0);
      return [
        texts.map(fakeVector),
        new EmbeddingUsage({
          promptTokens: tokens,
          totalTokens: tokens,
          costUsd: (tokens * 0.15) / 1e6,
          costSource: "estimate",
        }),
      ] as [number[][], EmbeddingUsage];
    },
  };
}

describe("parsing, against Python", () => {
  test(`${golden.parse.length} lines parse, strip and hash as _parse_line did`, () => {
    const prefix = factPrefixPattern(MILKY_GREEN.subject);
    for (const c of golden.parse) {
      const [date, floor, text] = parseFactLine(c.raw);
      expect({ raw: c.raw, date, floor, text }).toEqual({
        raw: c.raw,
        date: c.date,
        floor: c.floor,
        text: c.text,
      });
      expect(stripFactPrefix(text, prefix)).toBe(c.stripped);
      expect(createHash("sha1").update(text, "utf8").digest("hex").slice(0, 16)).toBe(c.id);
      expect(tokenizeZh(text)).toBe(c.tokens);
    }
  });

  test("load_facts' rows and log lines over the synthetic files", () => {
    const dir = join(work, "facts");
    writeFiles(dir, golden.fact_files);
    const files = resolveFactFiles(dir, MILKY_GREEN.patterns);
    expect(files.map((f) => basename(f))).toEqual(golden.load.files);
    const { rows, sources } = loadFacts(files, { subject: MILKY_GREEN.subject });
    expect(rows).toEqual(golden.load.rows as never);
    expect(logLines()).toEqual(golden.load.logs);
    expect(sources.map((s) => [s.name, s.kept, s.duplicates])).toEqual([
      [".备份设定集.txt", 1, 0],
      ["乙设定集.txt", 20, 1],
      ["甲设定集.txt", 2, 2],
      ["丙事件集.txt", 110, 0],
    ]);
  });
});

describe("resolveFactFiles", () => {
  test("each pattern's matches by code point, in pattern order, never one combined sort", () => {
    const dir = join(work, "facts");
    writeFiles(dir, golden.fact_files);
    const names = resolveFactFiles(dir, MILKY_GREEN.patterns).map((f) => basename(f));
    // 丙 (U+4E19) sorts before 乙 and 甲, but its pattern comes second.
    expect(names).toEqual([".备份设定集.txt", "乙设定集.txt", "甲设定集.txt", "丙事件集.txt"]);
    expect(sortedPy(names)).not.toEqual(names);
    // A file two patterns match is listed once, where the first one put it.
    expect(resolveFactFiles(dir, ["*事件集.txt", "*.txt"]).map((f) => basename(f))).toEqual([
      "丙事件集.txt",
      ".备份设定集.txt",
      "short.txt",
      "video-full.txt",
      "乙设定集.txt",
      "甲设定集.txt",
    ]);
    expect(resolveFactFiles(join(work, "nowhere"), ["*.txt"])).toEqual([]);
  });

  test("the persona's patterns by default, else *.txt", () => {
    const dir = join(work, "facts");
    writeFiles(dir, golden.fact_files);
    expect(factPatterns()).toEqual(["*.txt"]);
    installSettings();
    expect(resolveFactFiles(dir).map((f) => basename(f))).toEqual(golden.load.files);
  });

  test(`${Object.keys(golden.glob.matches).length} patterns match the names pathlib's glob matched`, () => {
    const dir = join(work, "glob");
    mkdirSync(dir);
    for (const name of golden.glob.names) writeFileSync(join(dir, name), "");
    for (const [pattern, expected] of Object.entries(golden.glob.matches)) {
      if (!Array.isArray(expected)) {
        expect(() => namePattern(pattern), pattern).toThrow();
        continue;
      }
      const got = resolveFactFiles(dir, [pattern]).map((f) => basename(f));
      expect({ pattern, got }).toEqual({ pattern, got: expected });
    }
  });
});

describe("settings", () => {
  test("FACTS_FILES is a comma-separated list; blank means the default", () => {
    process.env.FACTS_FILES = " a.txt, b*.txt ,, ";
    expect(factPatterns()).toEqual(["a.txt", "b*.txt"]);
    process.env.FACTS_FILES = "";
    expect(factPatterns()).toEqual(["*.txt"]);
  });

  test("the subject is FACTS_SUBJECT, else the persona's name matched literally", () => {
    const home = process.env.EIDOLON_HOME as string;
    const dir = join(home, "personas", "dotted");
    writeFiles(dir, { "persona.yaml": 'identity:\n  name: "A.B (x)+"\n' });
    process.env.EIDOLON_PERSONA = "dotted";
    resetSettings();
    try {
      expect(factSubject()).toBe(String.raw`A\.B\ \(x\)\+`);
      const prefix = factPrefixPattern(factSubject());
      expect(stripFactPrefix("A.B (x)+说过你好", prefix)).toBe("你好");
      expect(stripFactPrefix("AxB (x)+说过你好", prefix)).toBe("AxB (x)+说过你好");
      process.env.FACTS_SUBJECT = "";
      expect(factSubject()).toBe(String.raw`A\.B\ \(x\)\+`);
      process.env.FACTS_SUBJECT = "小[绿黑]";
      expect(factSubject()).toBe("小[绿黑]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("milky-green's persona.yaml sets both, keeping her embed_input as it was", () => {
    installSettings();
    expect(factPatterns()).toEqual(MILKY_GREEN.patterns);
    expect(factSubject()).toBe(MILKY_GREEN.subject);
  });

  test("an alternation in the subject stays inside it", () => {
    const prefix = factPrefixPattern("甲|乙");
    expect(stripFactPrefix("乙说你好", prefix)).toBe("你好");
    expect(stripFactPrefix("丙乙说你好", prefix)).toBe("丙乙说你好");
  });

  test("a subject that isn't a regex names the setting", () => {
    expect(() => factPrefixPattern("明前[")).toThrow(
      "knowledge.facts.subject (FACTS_SUBJECT) '明前[' is not a valid regex",
    );
  });
});

/** Rows and float32 vectors of a table, in scan order. */
async function tableState(dbPath: string, name: string) {
  const table = (await openTable(dbPath, name)) as LanceTable;
  const data = await table.query().toArrow();
  const rows: Record<string, unknown>[] = [];
  const vectors: number[][] = [];
  for (const row of data) {
    const { vector, ...rest } = row.toJSON() as Record<string, unknown>;
    rows.push(rest);
    vectors.push([...(vector as { toArray(): Float32Array }).toArray()]);
  }
  return { rows, vectors };
}

describe("ingestFactFiles", () => {
  let facts = "";
  beforeEach(() => {
    process.env.EMBED_DIM = "4";
    facts = join(work, "facts");
    writeFiles(facts, golden.fact_files);
  });

  function run(extra: Partial<Parameters<typeof ingestFactFiles>[0]> = {}) {
    const events: ProgressEvent[] = [];
    const report = ingestFactFiles({
      factsDir: facts,
      dbPath: join(work, "index"),
      cachePath: join(work, "cache", "embed_cache.db"),
      ...MILKY_GREEN,
      onProgress: (event) => events.push(event),
      ...extra,
    });
    return { events, report };
  }

  test("reports each file, the embedding's progress and a summary, and records the build", async () => {
    const calls: string[][] = [];
    const { events, report } = run({
      client: fakeClient(calls),
      now: () => new Date("2026-11-05T01:02:03.004Z"),
    });
    const done = await report;
    expect(done).toMatchObject({
      ok: true,
      cancelled: false,
      rows: 133,
      cacheHits: 0,
      embedded: 133,
    });
    expect(calls.map((c) => c.length)).toEqual([96, 37]);
    const summary = events.at(-1) as Extract<ProgressEvent, { type: "summary" }>;
    expect(
      events.map((e) => [e.type, "status" in e ? e.status : "done" in e ? e.done : null]),
    ).toEqual([
      ["stage", "start"],
      ["item", "done"],
      ["item", "done"],
      ["item", "done"],
      ["item", "done"],
      ["progress", 96],
      ["progress", 133],
      ["stage", "done"],
      ["summary", null],
    ]);
    expect(events[1]).toEqual({
      type: "item",
      stage: "ingest-facts",
      item: ".备份设定集.txt",
      status: "done",
      message: "1 facts kept, 0 duplicates skipped",
      index: 1,
      total: 4,
    });
    expect(events[5]).toEqual({
      type: "progress",
      stage: "ingest-facts",
      done: 96,
      total: 133,
      unit: "rows",
    });
    expect(summary).toMatchObject({
      type: "summary",
      stage: "ingest-facts",
      ok: true,
      counts: { files: 4, rows: 133, cacheHits: 0, embedded: 133 },
      costSource: "estimated",
    });
    expect(summary.costUsd).toBeCloseTo((4234 * 0.15) / 1e6, 12);

    const meta = JSON.parse(
      readFileSync(indexMetaPath(join(work, "index"), "persona_facts"), "utf8"),
    );
    expect(meta).toEqual({
      embedModel: "google/gemini-embedding-2-preview",
      embedDim: 4,
      rows: 133,
      builtAt: "2026-11-05T01:02:03.004Z",
      sources: golden.load.files.map((name) => {
        const stat = statSync(join(facts, name));
        return { name, size: stat.size, mtime: stat.mtime.toISOString() };
      }),
      patterns: MILKY_GREEN.patterns,
    });
    expect(readdirSync(join(work, "index")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("a fully cached run needs no key, and costs nothing", async () => {
    await run({ client: fakeClient() }).report;
    const { events, report } = run();
    expect(await report).toMatchObject({ ok: true, cacheHits: 133, embedded: 0 });
    expect(events.at(-1)).toMatchObject({ type: "summary", ok: true, costUsd: 0 });
    expect(events.at(-1)).not.toHaveProperty("costSource");
  });

  test("a cache miss without a key fails as missing-credential, and the old table stays", async () => {
    await run({ client: fakeClient(), cachePath: null }).report;
    const before = await tableState(join(work, "index"), "persona_facts");
    const { events, report } = run({ cachePath: null });
    expect(await report).toMatchObject({ ok: false, code: "missing-credential", written: false });
    expect(events.at(-2)).toMatchObject({
      type: "stage",
      status: "failed",
      code: "missing-credential",
      message: expect.stringContaining("Embeddings need an API key"),
    });
    expect(events.at(-1)).toMatchObject({ type: "summary", ok: false });
    expect(await tableState(join(work, "index"), "persona_facts")).toEqual(before);
  });

  test("a provider that rejects the key fails the run with code auth-failed", async () => {
    const rejected = new EmbeddingClient({
      baseUrl: "https://x.invalid/v1",
      apiKey: "k",
      fetch: (async () =>
        Response.json(
          { error: { message: "No auth credentials found", code: 401 } },
          {
            status: 401,
          },
        )) as unknown as typeof fetch,
      maxRetries: 0,
    });
    const { events, report } = run({ client: rejected, cachePath: null });
    expect(await report).toMatchObject({ ok: false, written: false });
    expect(events.at(-2)).toMatchObject({
      type: "stage",
      status: "failed",
      code: "auth-failed",
      provider: "embeddings",
    });
  });

  test("an abort while embedding cancels the run and keeps the old table and its record", async () => {
    await run({ client: fakeClient() }).report;
    const before = await tableState(join(work, "index"), "persona_facts");
    const metaBefore = readFileSync(indexMetaPath(join(work, "index"), "persona_facts"), "utf8");
    const controller = new AbortController();
    const client = {
      async embedWithUsage(_texts: readonly string[], options: { signal?: AbortSignal }) {
        controller.abort(new DOMException("Interrupted by SIGINT", "AbortError"));
        options.signal?.throwIfAborted();
        throw new Error("the signal should have been passed");
      },
    };
    const { events, report } = run({ client, cachePath: null, signal: controller.signal });
    expect(await report).toMatchObject({ ok: false, cancelled: true, written: false });
    expect(events.at(-2)).toEqual({
      type: "stage",
      stage: "ingest-facts",
      status: "cancelled",
      code: "cancelled",
    });
    expect(events.at(-1)).toMatchObject({ type: "summary", ok: false, cancelled: true });
    expect(events.at(-1)).not.toHaveProperty("failures");
    expect(await tableState(join(work, "index"), "persona_facts")).toEqual(before);
    expect(readFileSync(indexMetaPath(join(work, "index"), "persona_facts"), "utf8")).toBe(
      metaBefore,
    );
  });

  test("an abort before the run starts reads nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const { events, report } = run({ client: fakeClient(), signal: controller.signal });
    expect(await report).toMatchObject({ ok: false, cancelled: true, rows: 0 });
    expect(events.map((e) => e.type)).toEqual(["stage", "summary"]);
    expect(existsSync(join(work, "index"))).toBe(false);
  });

  test("a file that isn't UTF-8 fails the run, naming it", async () => {
    writeFileSync(join(facts, "坏设定集.txt"), Buffer.from([0x61, 0xff, 0x0a]));
    const { events, report } = run({ client: fakeClient() });
    const done = await report;
    expect(done).toMatchObject({ ok: false, written: false });
    expect(done.error).toEndWith("坏设定集.txt is not valid UTF-8");
    expect(events.at(-1)).toMatchObject({
      type: "summary",
      ok: false,
      failures: [{ item: "persona_facts", error: done.error }],
    });
    expect(existsSync(join(work, "index", "persona_facts.lance"))).toBe(false);
  });

  test("explicit files record no patterns; a missing one is reported skipped", async () => {
    const { events, report } = run({
      client: fakeClient(),
      files: [join(facts, "甲设定集.txt"), join(facts, "missing.txt")],
    });
    expect(await report).toMatchObject({ ok: true, rows: 3 });
    expect(events.filter((e) => e.type === "item")).toEqual([
      expect.objectContaining({ item: "甲设定集.txt", status: "done", index: 1, total: 2 }),
      expect.objectContaining({ item: "missing.txt", status: "skipped", index: 2, total: 2 }),
    ]);
    const meta = JSON.parse(
      readFileSync(indexMetaPath(join(work, "index"), "persona_facts"), "utf8"),
    );
    expect(meta.patterns).toBeNull();
    expect(meta.sources.map((s: { name: string }) => s.name)).toEqual(["甲设定集.txt"]);
  });

  test("nothing to read is skipped, not failed", async () => {
    const empty = run({ client: fakeClient(), factsDir: join(work, "nowhere") });
    expect(await empty.report).toMatchObject({ ok: true, rows: 0 });
    expect(empty.events).toEqual([
      expect.objectContaining({ type: "stage", status: "skipped" }),
      expect.objectContaining({
        type: "summary",
        ok: true,
        counts: { files: 0, rows: 0, cacheHits: 0, embedded: 0 },
      }),
    ]);
    expect(empty.events.at(-1)).not.toHaveProperty("failures");
  });
});
