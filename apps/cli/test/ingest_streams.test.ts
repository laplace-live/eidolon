// The command around the library: the golden runs (packages/ingest/test/ingest_streams_golden.ts)
// replayed from their argv, the help as argparse lays it out, the defaults, the lock, --json, and
// the index path checks. Every run happens in a temporary data home.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSettings, PROJECT_ROOT, resetSettings, sourceFolder } from "@eidolon/config";
import { acquireLock, embedCachePath, indexLockKey } from "@eidolon/ingest";
import { resetEmbeddingClient } from "@eidolon/retrieval";
import {
  fakeClient,
  GOLDEN,
  materialize,
  placehold,
  readTable,
  substitute,
} from "../../../packages/ingest/test/ingest_streams_golden.ts";
import { ingestStreamsMain, parseIngestStreamsArgs } from "../src/ingest_streams.ts";
import { blockNetwork, captureIo, captureLogs, setEnv } from "./helpers.ts";

blockNetwork();

let work = "";
let home = "";
let streams = "";
let paths: Record<string, string> = {};
let logs!: ReturnType<typeof captureLogs>;
let restoreEnv: () => void = () => {};

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "cli-ingest-streams-")));
  home = join(work, "home");
  streams = materialize("streams", join(work, "streams"));
  paths = { "<STREAMS>": streams, "<TMP>": work };
  logs = captureLogs();
  restoreEnv = setEnv({
    EIDOLON_HOME: home,
    EIDOLON_PERSONA: undefined,
    LANCEDB_PATH: undefined,
    INGEST_SKIP_TYPES: undefined,
    EMBED_MODEL: undefined,
    // The golden's dimension.
    EMBED_DIM: "4",
    EMBED_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
  });
  resetSettings();
});

afterEach(() => {
  restoreEnv();
  resetSettings();
  logs.stop();
  rmSync(work, { recursive: true, force: true });
});

function events(text: string): Record<string, unknown>[] {
  return text
    .trimEnd()
    .split("\n")
    .map((line) => {
      const { v, t, ...event } = JSON.parse(line) as Record<string, unknown>;
      expect([v, typeof t]).toEqual([1, "number"]);
      return event;
    });
}

describe("ingestStreamsMain", () => {
  test("-h prints the help argparse lays out; a bad flag prints its usage and exits 2", async () => {
    const [usage, help] = GOLDEN.help.ingest_streams;
    const shown = captureIo();
    expect(await ingestStreamsMain(["-h"], shown.io)).toBe(0);
    expect([shown.stdout(), shown.stderr()]).toEqual([help, ""]);
    const bad = captureIo();
    expect(await ingestStreamsMain(["--bogus"], bad.io)).toBe(2);
    expect(bad.stderr()).toBe(
      `${usage}laplace-ingest-streams: error: unrecognized arguments: --bogus\n`,
    );
  });

  test("replays the golden runs from their argv: exit codes, logs, requests, rows", async () => {
    mkdirSync(join(work, "empty"));
    for (const run of GOLDEN.ingest) {
      logs.records.length = 0;
      const calls: number[] = [];
      const argv = run.argv.map((arg) => substitute(arg, paths));
      const code = await ingestStreamsMain(argv, {
        ...captureIo().io,
        embeddingClient: fakeClient(calls),
      });
      const [first, ...rest] = logs.records.map(([level, message]) => [
        level,
        placehold(message, paths),
      ]);
      const db = substitute(run.argv[run.argv.indexOf("--db-path") + 1] as string, paths);
      expect({ run: run.name, code, first, rest, calls }).toEqual({
        run: run.name,
        code: run.exit_code,
        first: ["INFO", `Persona milky-green's index: ${placehold(db, paths)}`],
        rest: run.logs,
        calls: run.embed_calls,
      });
      if (run.table) expect(await readTable(db)).toEqual(run.table);
    }
    // The default cache was never needed: every run named one, or used none.
    expect(existsSync(embedCachePath())).toBe(false);
  });

  test("defaults: the persona's sources, the index the bot reads, the shared cache", () => {
    const args = parseIngestStreamsArgs([]);
    expect(args).toEqual({
      streamsDir: sourceFolder("milky-green", "streams"),
      dbPath: join(home, "personas", "milky-green", "index"),
      table: "stream_chunks",
      skipTypes: new Set(["anime_audio", "karaoke"]),
      dryRun: false,
      cachePath: join(home, "cache", "embed_cache.db"),
      clearCache: false,
      persona: "milky-green",
      json: false,
    });
    expect(parseIngestStreamsArgs(["--no-cache", "--cache-path", "x.db"]).cachePath).toBeNull();
    expect(parseIngestStreamsArgs(["--cache-path", "x.db"]).cachePath).toBe("x.db");
  });

  test("--skip-types '' drops nothing; INGEST_SKIP_TYPES=none too, and blank is the default", () => {
    expect(parseIngestStreamsArgs(["--skip-types", ""]).skipTypes).toEqual(new Set());
    expect(parseIngestStreamsArgs(["--skip-types", "karaoke"]).skipTypes).toEqual(
      new Set(["karaoke"]),
    );
    process.env.INGEST_SKIP_TYPES = "none";
    expect(parseIngestStreamsArgs([]).skipTypes).toEqual(new Set());
    process.env.INGEST_SKIP_TYPES = "";
    expect(parseIngestStreamsArgs([]).skipTypes).toEqual(new Set(["anime_audio", "karaoke"]));
  });

  test("LANCEDB_PATH from the environment names the index, unless --persona is spelled out", async () => {
    process.env.LANCEDB_PATH = join(work, "elsewhere");
    expect(parseIngestStreamsArgs([]).dbPath).toBe(join(work, "elsewhere"));
    expect(parseIngestStreamsArgs(["--persona", "milky-green", "--db-path", "d"]).dbPath).toBe("d");
    const io = captureIo();
    expect(await ingestStreamsMain(["--persona", "milky-green"], io.io)).toBe(2);
    expect(io.stderr()).toEndWith(
      "laplace-ingest-streams: error: LANCEDB_PATH is set in the environment; " +
        "pass --db-path or set her knowledge.index to write persona milky-green's index.\n",
    );
    process.env.LANCEDB_PATH = "personas/milky-green/index";
    const template = captureIo();
    expect(await ingestStreamsMain([], template.io)).toBe(2);
    expect(template.stderr()).toContain(
      "error: Refusing to write persona milky-green's index into the template folder " +
        `${join(PROJECT_ROOT, "personas/milky-green/index")}`,
    );
  });

  test("her own knowledge.index wins over LANCEDB_PATH, with --persona spelled out too", () => {
    process.env.LANCEDB_PATH = join(work, "elsewhere");
    const folder = join(home, "personas", "milky-green");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "persona.yaml"), "knowledge:\n  index: own-index\n");
    // As load-env.ts does before a command runs.
    installSettings();
    expect(parseIngestStreamsArgs([]).dbPath).toBe(join(folder, "own-index"));
    expect(parseIngestStreamsArgs(["--persona", "milky-green"]).dbPath).toBe(
      join(folder, "own-index"),
    );
  });

  test("--db-path into a persona template is refused too", async () => {
    const index = join(PROJECT_ROOT, "personas/milky-green/index");
    const io = captureIo();
    expect(await ingestStreamsMain(["--db-path", index], io.io)).toBe(2);
    expect(io.stderr()).toEndWith(
      `error: Refusing to write persona milky-green's index into the template folder ${index}; ` +
        "point --db-path into the data home\n",
    );
    expect(existsSync(index)).toBe(false);
  });

  test("another writer on the index: exit 1, code locked under --json; a dry run goes on", async () => {
    const db = join(work, "db");
    const release = acquireLock(indexLockKey(db), "laplace-ingest-streams");
    try {
      const io = captureIo();
      const argv = ["--json", "--streams-dir", streams, "--db-path", db, "--no-cache"];
      expect(await ingestStreamsMain(argv, io.io)).toBe(1);
      const message = `Another laplace-ingest-streams is running for ${db} (pid ${process.pid}).`;
      expect(logs.records.at(-1)).toEqual(["ERROR", message]);
      expect(events(io.stdout())).toEqual([
        { type: "stage", stage: "ingest-streams", status: "failed", code: "locked", message },
        {
          type: "summary",
          stage: "ingest-streams",
          ok: false,
          counts: { rows: 0, cacheHits: 0, embedded: 0 },
          durationSec: 0,
          failures: [{ item: "stream_chunks", error: message }],
        },
      ]);
      const dry = ["--dry-run", "--streams-dir", streams, "--db-path", db];
      expect(await ingestStreamsMain(dry, captureIo().io)).toBe(0);
    } finally {
      release();
    }
    expect(existsSync(db)).toBe(false);
  });

  test("--json writes only events to stdout, ending in the summary", async () => {
    const io = captureIo();
    const db = join(work, "db");
    const argv = ["--json", "--streams-dir", streams, "--db-path", db, "--no-cache"];
    expect(await ingestStreamsMain(argv, { ...io.io, embeddingClient: fakeClient([]) })).toBe(0);
    const lines = events(io.stdout());
    expect(lines[0]).toEqual({
      type: "stage",
      stage: "ingest-streams",
      status: "start",
      total: 11,
    });
    const summary: Record<string, unknown> = { ...lines.at(-1), durationSec: 0 };
    expect(summary).toEqual({
      type: "summary",
      stage: "ingest-streams",
      ok: true,
      counts: { rows: 13, cacheHits: 0, embedded: 13 },
      durationSec: 0,
      costUsd: 0.000001 * 13,
      costSource: "reported",
    });
    expect(io.stderr()).toBe("");
    expect(readdirSync(db).sort()).toEqual(["stream_chunks.lance", "stream_chunks.meta.json"]);
  });

  test("a cache miss without a key: exit 1, code missing-credential", async () => {
    resetEmbeddingClient();
    const io = captureIo();
    const argv = ["--json", "--streams-dir", streams, "--db-path", join(work, "db"), "--no-cache"];
    expect(await ingestStreamsMain(argv, io.io)).toBe(1);
    expect(events(io.stdout()).at(-2)).toMatchObject({
      type: "stage",
      status: "failed",
      code: "missing-credential",
    });
    expect(existsSync(join(work, "db", "stream_chunks.lance"))).toBe(false);
  });
});
