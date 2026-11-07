// packages/ingest/test/fixtures/ingest_facts/golden.json holds tools/ingest_facts.py's main() runs
// over synthetic fact files, printed by golden.py there with the embedding call stubbed. Each
// replays here through ingestFactsMain, in order, over the same files, stub and EMBED_DIM.

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dataHome,
  installSettings,
  PROJECT_ROOT,
  personaIds,
  pyJsonDumps,
  resetSettings,
  sourceFolder,
} from "@eidolon/config";
import { acquireLock, canonicalPath, embedCachePath, indexLockKey } from "@eidolon/ingest";
import {
  EmbeddingUsage,
  type LanceTable,
  openTable,
  resetEmbeddingClient,
} from "@eidolon/retrieval";
import { ingestFactsMain, parseIngestFactsArgs } from "../src/ingest_facts.ts";
import { blockNetwork, captureIo, captureLogs, placehold, substitute } from "./helpers.ts";

blockNetwork();

interface Call {
  texts: string[];
  model: string | null;
  dimensions: number | null;
}

interface Scenario {
  name: string;
  argv: string[];
  exit_code: number;
  logs: [string, string][];
  calls: Call[];
  table: string;
  state: { rows: number; rows_sha256: string; vectors_sha256: string } | null;
  cache_count: number | null;
}

const golden = (await Bun.file(
  join(PROJECT_ROOT, "packages/ingest/test/fixtures/ingest_facts/golden.json"),
).json()) as { fact_files: Record<string, string>; scenarios: Scenario[] };

const ISOLATED = [
  "FACTS_FILES",
  "FACTS_SUBJECT",
  "EMBED_MODEL",
  "EMBED_DIM",
  "EMBED_BASE_URL",
  "EMBED_API_KEY",
  "OPENROUTER_API_KEY",
  "LANCEDB_PATH",
];
const saved = new Map<string, string | undefined>();
let logs!: ReturnType<typeof captureLogs>;
beforeEach(() => {
  for (const key of ISOLATED) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.EMBED_DIM = "4";
  // milky-green's persona.yaml, from the repository's template: her fact patterns and subject.
  installSettings();
  resetEmbeddingClient();
  logs = captureLogs();
});
afterEach(() => {
  logs.stop();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSettings();
  resetEmbeddingClient();
});

/** golden.py's fake_vector and usage: a deterministic vector per text, tokens by code point. */
function fakeClient(calls: Call[]) {
  return {
    async embedWithUsage(
      texts: readonly string[],
      options: { model: string; dimensions: number; signal?: AbortSignal },
    ): Promise<[number[][], EmbeddingUsage]> {
      calls.push({ texts: [...texts], model: options.model, dimensions: options.dimensions });
      const tokens = texts.reduce((n, t) => n + [...t].length, 0);
      const vectors = texts.map((text) => {
        let sum = 0;
        for (const ch of text) sum += ch.codePointAt(0) as number;
        const base = sum % 97;
        // Python's -base is an int, so a 0 divides to 0.0, never -0.0.
        return [base / 7, (0 - base) / 3, 0.1 * base, 1 / (base + 3)];
      });
      return [
        vectors,
        new EmbeddingUsage({
          promptTokens: tokens,
          totalTokens: tokens,
          costUsd: (tokens * 0.15) / 1e6,
          costSource: "estimate",
        }),
      ];
    },
  };
}

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

/** golden.py's table_state: the row count, and digests of the rows as JSON and the vectors. */
async function tableState(dbPath: string, name: string): Promise<Scenario["state"]> {
  if (!existsSync(join(dbPath, `${name}.lance`))) return null;
  const table = (await openTable(dbPath, name)) as LanceTable;
  const data = await table.query().toArrow();
  const text = Object.fromEntries(
    ["id", "source", "date", "text", "tokens"].map((column) => [column, utf8Column(data, column)]),
  );
  const rows: Record<string, unknown>[] = [];
  const vectors = createHash("sha256");
  for (const [i, row] of [...data].entries()) {
    const at = (column: string) => text[column]?.[i];
    rows.push({
      id: at("id"),
      source: at("source"),
      date: at("date"),
      floor: row.floor,
      text: at("text"),
      tokens: at("tokens"),
    });
    const vector = row.vector.toArray() as Float32Array;
    vectors.update(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
  }
  return {
    rows: rows.length,
    rows_sha256: createHash("sha256")
      .update(pyJsonDumps(rows, { ensureAscii: false }), "utf8")
      .digest("hex"),
    vectors_sha256: vectors.digest("hex"),
  };
}

function cacheCount(path: string): number | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    return Number(db.query("SELECT COUNT(*) FROM embed_cache").values()[0]?.[0]);
  } finally {
    db.close();
  }
}

const INDEX_LINE = /^Persona milky-green's index: /;

describe("replays ingest_facts.py's main() over the synthetic fact files", () => {
  let work = "";
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "cli-ingest-facts-"));
    mkdirSync(join(work, "facts"));
    for (const [name, text] of Object.entries(golden.fact_files)) {
      writeFileSync(join(work, "facts", name), text, "utf8");
    }
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  for (const scenario of golden.scenarios) {
    test(scenario.name, async () => {
      const calls: Call[] = [];
      const io = captureIo();
      const argv = scenario.argv.map((arg) => substitute(arg, { "<TMP>": work }));
      const code = await ingestFactsMain(argv, { ...io.io, client: fakeClient(calls) });
      const paths = { "<TMP>": canonicalPath(work) };
      const records = logs.records.map(([level, message]) => [level, placehold(message, paths)]);
      expect(records.filter(([, message]) => !INDEX_LINE.test(message as string))).toEqual(
        scenario.logs,
      );
      expect(records.filter(([, message]) => INDEX_LINE.test(message as string))).toEqual([
        ["INFO", "Persona milky-green's index: <TMP>/index"],
      ]);
      expect(calls).toEqual(scenario.calls);
      expect(await tableState(join(work, "index"), scenario.table)).toEqual(scenario.state);
      expect(cacheCount(join(work, "cache", "embed_cache.db"))).toBe(scenario.cache_count);
      expect(io.stdout()).toBe("");
      expect(io.stderr()).toBe("");
      expect(code).toBe(scenario.exit_code);
    });
  }
});

describe("arguments", () => {
  test("-h prints the help, with the persona and --json flags", async () => {
    const io = captureIo();
    expect(await ingestFactsMain(["-h"], io.io)).toBe(0);
    expect(io.stdout()).toStartWith(
      "usage: laplace-ingest-facts [-h] [--data-dir DATA_DIR] [--files [FILES ...]]\n",
    );
    expect(io.stdout()).toContain("\n  --persona PERSONA     Persona whose facts to ingest");
    expect(io.stdout()).toContain("\n  --clear-cache         Delete every cached vector, of every");
    // ingest-streams' words, since both default to the index the bot reads.
    expect(io.stdout()).toContain(
      "\n  --db-path DB_PATH     LanceDB directory (default: the index the bot reads:\n" +
        "                        knowledge.index or $LANCEDB_PATH, else the persona's\n" +
        "                        index/ in the data home)\n",
    );
  });

  test("the folders default to the persona's, in the data home; explicit paths resolve", () => {
    const args = parseIngestFactsArgs(["--persona", "milky-green"]);
    expect(args).toMatchObject({
      persona: "milky-green",
      dataDir: canonicalPath(sourceFolder("milky-green", "facts")),
      files: null,
      dbPath: canonicalPath(join(dataHome(), "personas", "milky-green", "index")),
      table: "persona_facts",
      minChars: 4,
      stripPrefix: true,
      cachePath: canonicalPath(embedCachePath()),
    });
    const explicit = parseIngestFactsArgs([
      "--data-dir",
      "a/./b/",
      "--db-path",
      "idx",
      "--files",
      "f.txt",
      "--no-cache",
      "--no-strip-prefix",
    ]);
    expect(explicit).toMatchObject({
      dataDir: join(canonicalPath(process.cwd()), "a", "b"),
      dbPath: join(canonicalPath(process.cwd()), "idx"),
      files: [join(canonicalPath(process.cwd()), "f.txt")],
      cachePath: null,
      stripPrefix: false,
    });
    expect(parseIngestFactsArgs(["--files"]).files).toEqual([]);
  });

  test("--persona other than the installed one is a usage error", async () => {
    const io = captureIo();
    expect(await ingestFactsMain(["--persona", "someone-else", "--dry-run"], io.io)).toBe(2);
    expect(io.stderr()).toEndWith(
      "laplace-ingest-facts: error: argument --persona: write --persona someone-else in full\n",
    );
  });

  test("a persona with no folder is a usage error, before any fact or index is touched", async () => {
    // As load-env.ts installs `--persona nobody`.
    const saved = process.env.EIDOLON_PERSONA;
    process.env.EIDOLON_PERSONA = "nobody";
    installSettings();
    try {
      const io = captureIo();
      expect(await ingestFactsMain(["--persona", "nobody", "--dry-run"], io.io)).toBe(2);
      expect(io.stderr()).toEndWith(
        "laplace-ingest-facts: error: argument --persona: unknown persona 'nobody' " +
          `(choose from ${personaIds().join(", ")})\n`,
      );
      expect(logs.records).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.EIDOLON_PERSONA;
      else process.env.EIDOLON_PERSONA = saved;
      installSettings();
    }
  });

  test("--min-chars takes an int", async () => {
    const io = captureIo();
    expect(await ingestFactsMain(["--min-chars", "x"], io.io)).toBe(2);
    expect(io.stderr()).toEndWith("error: argument --min-chars: invalid int value: 'x'\n");
  });
});

describe("the index it writes", () => {
  let work = "";
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "cli-ingest-facts-"));
    mkdirSync(join(work, "facts"));
    writeFileSync(join(work, "facts", "甲设定集.txt"), "明前奶绿喜欢喝奶茶\n", "utf8");
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  test("LANCEDB_PATH from the environment with an explicit --persona needs --db-path", async () => {
    process.env.LANCEDB_PATH = join(work, "elsewhere");
    const io = captureIo();
    const argv = ["--persona", "milky-green", "--data-dir", join(work, "facts"), "--dry-run"];
    expect(await ingestFactsMain(argv, io.io)).toBe(2);
    expect(io.stderr()).toEndWith(
      "laplace-ingest-facts: error: LANCEDB_PATH is set in the environment; pass --db-path or " +
        "set her knowledge.index to write persona milky-green's index.\n",
    );
    const db = captureIo();
    expect(await ingestFactsMain([...argv, "--db-path", join(work, "index")], db.io)).toBe(0);
    // Without --persona the environment's index is the one meant.
    const plain = captureIo();
    expect(await ingestFactsMain(["--data-dir", join(work, "facts"), "--dry-run"], plain.io)).toBe(
      0,
    );
    expect(logs.records).toContainEqual([
      "INFO",
      `Persona milky-green's index: ${canonicalPath(join(work, "elsewhere"))}`,
    ]);
  });

  test("an index inside the persona templates is a usage error, as for ingest-streams", async () => {
    process.env.LANCEDB_PATH = "personas/milky-green/index";
    const io = captureIo();
    const code = await ingestFactsMain(["--data-dir", join(work, "facts"), "--json"], io.io);
    expect(code).toBe(2);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain(
      "laplace-ingest-facts: error: Refusing to write persona milky-green's index into the " +
        `template folder ${join(PROJECT_ROOT, "personas/milky-green/index")}`,
    );
    expect(logs.records).toEqual([]);
  });

  test("a second writer on the same index exits 1 naming the first; a dry run doesn't wait", async () => {
    const db = join(work, "index");
    const release = acquireLock(indexLockKey(db), "laplace-ingest-streams");
    try {
      const io = captureIo();
      const argv = ["--data-dir", join(work, "facts"), "--db-path", db];
      expect(await ingestFactsMain([...argv, "--json"], io.io)).toBe(1);
      const events = io
        .stdout()
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const message = `Another laplace-ingest-streams is running for ${canonicalPath(db)} (pid ${process.pid}).`;
      expect(events).toEqual([
        expect.objectContaining({ type: "stage", status: "failed", code: "locked", message }),
        expect.objectContaining({ type: "summary", ok: false }),
      ]);
      expect(logs.records).toContainEqual(["ERROR", message]);
      const dry = captureIo();
      expect(await ingestFactsMain([...argv, "--dry-run"], dry.io)).toBe(0);
    } finally {
      release();
    }
  });

  test("SIGINT's signal cancels the run, which releases the index lock", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Interrupted by SIGINT", "AbortError"));
    const io = captureIo();
    const db = join(work, "index");
    const code = await ingestFactsMain(
      ["--json", "--data-dir", join(work, "facts"), "--db-path", db],
      { ...io.io, signal: controller.signal, client: fakeClient([]) },
    );
    expect(code).toBe(1);
    const events = io
      .stdout()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ type: "summary", ok: false, cancelled: true });
    expect(existsSync(join(db, "persona_facts.lance"))).toBe(false);
    acquireLock(indexLockKey(db), "test")();
  });

  test("--json writes only events to stdout, ending in the summary, and records the build", async () => {
    const io = captureIo();
    const calls: Call[] = [];
    const db = join(work, "index");
    const code = await ingestFactsMain(
      ["--json", "--data-dir", join(work, "facts"), "--db-path", db, "--no-cache"],
      { ...io.io, client: fakeClient(calls), now: () => new Date("2026-11-05T00:00:00Z") },
    );
    expect(code).toBe(0);
    const events = io
      .stdout()
      .trimEnd()
      .split("\n")
      .map((line) => {
        const { v, t, ...event } = JSON.parse(line) as Record<string, unknown>;
        expect([v, typeof t]).toEqual([1, "number"]);
        return event;
      });
    expect(events.map((e) => [e.type, e.status ?? null])).toEqual([
      ["stage", "start"],
      ["item", "done"],
      ["progress", null],
      ["stage", "done"],
      ["summary", null],
    ]);
    expect(events.at(-1)).toMatchObject({
      stage: "ingest-facts",
      ok: true,
      counts: { files: 1, rows: 1, cacheHits: 0, embedded: 1 },
      costSource: "estimated",
    });
    const meta = JSON.parse(readFileSync(join(db, "persona_facts.meta.json"), "utf8"));
    expect(meta).toMatchObject({
      embedModel: "google/gemini-embedding-2-preview",
      embedDim: 4,
      rows: 1,
      builtAt: "2026-11-05T00:00:00.000Z",
      sources: [{ name: "甲设定集.txt", size: 28 }],
      patterns: ["*设定集.txt", "*事件集.txt"],
    });
  });
});
