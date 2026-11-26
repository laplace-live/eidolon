// packages/ingest/test/fixtures/ingest_facts/golden.json holds laplace-ingest-facts' runs over
// synthetic fact files, with the embedding call stubbed. Each replays here through
// ingestFactsMain, in order, over the same files, stub and EMBED_DIM.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  dataHome,
  installSettings,
  PROJECT_ROOT,
  personaIds,
  pyJsonDumps,
  resetSettings,
  sourceFolder,
} from "@eidolon/config";
import {
  acquireLock,
  canonicalPath,
  embedCachePath,
  indexLockKey,
  ingestFacts,
} from "@eidolon/ingest";
import { type EmbeddingModel, EmbeddingUsage } from "@eidolon/providers";
import {
  closeAllReadTables,
  DEFAULT_EMBED_MODEL,
  openTable,
  resetEmbeddingModel,
  tableExists,
  type ZvecTable,
} from "@eidolon/retrieval";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { portIngestLogs } from "../../../packages/ingest/test/ingest_streams_golden.ts";
import { expectVectorsClose } from "../../../packages/retrieval/test/helpers.ts";
import { fakeVector } from "../../../packages/retrieval/test/write_golden.ts";
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

const golden = JSON.parse(
  await readFile(
    join(PROJECT_ROOT, "packages/ingest/test/fixtures/ingest_facts/golden.json"),
    "utf8",
  ),
) as { fact_files: Record<string, string>; scenarios: Scenario[] };

const ISOLATED = [
  "FACTS_FILES",
  "FACTS_SUBJECT",
  "EMBED_MODEL",
  "EMBED_DIM",
  "EMBED_BASE_URL",
  "EMBED_API_KEY",
  "OPENROUTER_API_KEY",
  "INDEX_PATH",
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
  resetEmbeddingModel();
  logs = captureLogs();
});
afterEach(() => {
  closeAllReadTables();
  logs.stop();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSettings();
  resetEmbeddingModel();
});

/** The golden's embedding stub: a deterministic vector per text, tokens by code point. */
function fakeModel(calls: Call[]): EmbeddingModel {
  return {
    provider: "openrouter",
    model: DEFAULT_EMBED_MODEL,
    async embed(texts, dimensions) {
      calls.push({ texts: [...texts], model: DEFAULT_EMBED_MODEL, dimensions });
      const tokens = texts.reduce((n, t) => n + [...t].length, 0);
      const vectors = texts.map(fakeVector);
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

/** The golden's table state: the row count, row JSON digest, raw vectors, and Zvec vector digest. */
async function tableState(
  dbPath: string,
  name: string,
): Promise<(NonNullable<Scenario["state"]> & { vectors: Float32Array }) | null> {
  if (!tableExists(dbPath, name)) return null;
  const table = (await openTable(dbPath, name)) as ZvecTable;
  const back = table.readAll({ includeVectors: true });
  const vectors = createHash("sha256");
  vectors.update(
    new Uint8Array(back.vectors.buffer, back.vectors.byteOffset, back.vectors.byteLength),
  );
  return {
    rows: back.rows.length,
    rows_sha256: createHash("sha256")
      .update(pyJsonDumps(back.rows, { ensureAscii: false }), "utf8")
      .digest("hex"),
    vectors_sha256: vectors.digest("hex"),
    vectors: back.vectors,
  };
}

function cacheCount(path: string): number | null {
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM embed_cache").get()?.n);
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

  let coldVectorsSha = "";
  for (const scenario of golden.scenarios) {
    test(scenario.name, async () => {
      const calls: Call[] = [];
      const io = captureIo();
      const argv = scenario.argv.map((arg) => substitute(arg, { "<TMP>": work }));
      const code = await ingestFactsMain(argv, { ...io.io, embedding: fakeModel(calls) });
      const paths = { "<TMP>": canonicalPath(work) };
      const records = logs.records.map(([level, message]) => [level, placehold(message, paths)]);
      expect(records.filter(([, message]) => !INDEX_LINE.test(message as string))).toEqual(
        portIngestLogs(scenario.logs),
      );
      expect(records.filter(([, message]) => INDEX_LINE.test(message as string))).toEqual([
        ["INFO", "Persona milky-green's index: <TMP>/index"],
      ]);
      expect(calls).toEqual(scenario.calls);
      const state = await tableState(join(work, "index"), scenario.table);
      if (scenario.state === null) {
        expect(state).toBeNull();
      } else {
        expect(state).not.toBeNull();
        expect({ rows: state?.rows, rows_sha256: state?.rows_sha256 }).toEqual({
          rows: scenario.state.rows,
          rows_sha256: scenario.state.rows_sha256,
        });
        const loaded = ingestFacts.loadFacts(ingestFacts.resolveFactFiles(join(work, "facts")), {
          minChars: scenario.name === "partial" ? 2 : 4,
          stripPrefix: scenario.name !== "unstripped",
        });
        const expectedVecs = Float32Array.from(
          loaded.rows.flatMap((row) => fakeVector(row.embed_input)),
        );
        expectVectorsClose(state?.vectors as Float32Array, expectedVecs);
        if (scenario.name === "cold") coldVectorsSha = state?.vectors_sha256 as string;
        else if (scenario.name === "unstripped" || scenario.name === "partial") {
          expect(state?.vectors_sha256).not.toBe(coldVectorsSha);
        } else {
          expect(state?.vectors_sha256).toBe(coldVectorsSha);
        }
      }
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
      "\n  --db-path DB_PATH     Zvec index directory (default: the index the bot reads:\n" +
        "                        knowledge.index or $INDEX_PATH, else the persona's\n" +
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
      { ...io.io, signal: controller.signal, embedding: fakeModel([]) },
    );
    expect(code).toBe(1);
    const events = io
      .stdout()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ type: "summary", ok: false, cancelled: true });
    expect(existsSync(join(db, "persona_facts.zvec"))).toBe(false);
    acquireLock(indexLockKey(db), "test")();
  });

  test("--json writes only events to stdout, ending in the summary, and records the build", async () => {
    const io = captureIo();
    const calls: Call[] = [];
    const db = join(work, "index");
    const code = await ingestFactsMain(
      ["--json", "--data-dir", join(work, "facts"), "--db-path", db, "--no-cache"],
      { ...io.io, embedding: fakeModel(calls), now: () => new Date("2026-11-05T00:00:00Z") },
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
