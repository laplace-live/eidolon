// The golden runs (see ingest_streams_golden.ts) replayed through the library, plus what the
// golden doesn't cover: progress events, cancellation, the meta file and the skip-type settings.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleSink, installSettings, logger, pyRepr, resetSettings } from "@eidolon/config";
import { type EmbeddingClient, resetEmbeddingClient } from "@eidolon/retrieval";
import { ingestStreams, type ProgressEvent } from "../src/index.ts";
import { cancelMidRebuild } from "./forced_exit.ts";
import {
  fakeClient,
  GOLDEN,
  GOLDEN_DIM,
  GOLDEN_MODEL,
  materialize,
  placehold,
  readTable,
  substitute,
} from "./ingest_streams_golden.ts";

const DEFAULT_SKIP = ingestStreams.parseSkipTypes(ingestStreams.DEFAULT_SKIP_TYPES);
const NOW = () => new Date("2026-11-05T01:02:03.456Z");

let work = "";
let streams = "";
let paths: Record<string, string> = {};
const records: [string, string][] = [];

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "ingest-streams-")));
  streams = materialize("streams", join(work, "streams"));
  paths = { "<STREAMS>": streams, "<TMP>": work };
  records.length = 0;
  logger.setSink((record) => records.push([record.level, record.message]));
});

afterEach(() => {
  logger.setSink(consoleSink);
  rmSync(work, { recursive: true, force: true });
});

function logs(): [string, string][] {
  return records.map(([level, message]) => [level, placehold(message, paths)]);
}

/** What a golden run's argv asks of the library; a cache it never names is never opened. */
function optionsFor(argv: readonly string[]): ingestStreams.IngestStreamsOptions {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--dry-run" || arg === "--no-cache" || arg === "--clear-cache") switches.add(arg);
    else values.set(arg, substitute(argv[++i] as string, paths));
  }
  return {
    streamsDir: values.get("--streams-dir") as string,
    dbPath: values.get("--db-path") as string,
    skipTypes: ingestStreams.parseSkipTypes(
      values.get("--skip-types") ?? ingestStreams.DEFAULT_SKIP_TYPES,
    ),
    dryRun: switches.has("--dry-run"),
    cachePath: switches.has("--no-cache")
      ? null
      : (values.get("--cache-path") ?? join(work, "unused.db")),
    clearCache: switches.has("--clear-cache"),
    model: GOLDEN_MODEL,
    dim: GOLDEN_DIM,
    now: NOW,
  };
}

function options(
  extra: Partial<ingestStreams.IngestStreamsOptions> = {},
): ingestStreams.IngestStreamsOptions {
  return {
    streamsDir: streams,
    dbPath: join(work, "db"),
    skipTypes: DEFAULT_SKIP,
    cachePath: join(work, "cache", "embed_cache.db"),
    model: GOLDEN_MODEL,
    dim: GOLDEN_DIM,
    client: fakeClient([]),
    now: NOW,
    ...extra,
  };
}

describe("loadStreams", () => {
  for (const scenario of GOLDEN.load_streams) {
    test(`load_streams' rows and log lines, skip_types=${pyRepr(scenario.skip_types)}`, async () => {
      const rows = await ingestStreams.loadStreams(streams, {
        skipTypes: new Set(scenario.skip_types),
      });
      expect(rows).toStrictEqual(scenario.rows as unknown as ingestStreams.StreamRow[]);
      expect(logs()).toEqual(scenario.logs);
    });
  }
});

describe("ingestStreams", () => {
  test("replays main_async's runs: logs, embedding calls and the rows written", async () => {
    mkdirSync(join(work, "empty"));
    for (const run of GOLDEN.ingest) {
      records.length = 0;
      const calls: number[] = [];
      const report = await ingestStreams.ingestStreams({
        ...optionsFor(run.argv),
        client: fakeClient(calls),
      });
      expect({ run: run.name, ok: report.ok, logs: logs(), calls }).toEqual({
        run: run.name,
        ok: run.exit_code === 0,
        logs: run.logs,
        calls: run.embed_calls,
      });
      if (run.table) {
        expect(await readTable(optionsFor(run.argv).dbPath)).toEqual(run.table);
      }
    }
    // No dry run, empty folder or uncached run touches a cache or an index it wasn't given.
    expect(readdirSync(work).sort()).toEqual(["cache", "db", "db2", "db3", "empty", "streams"]);
  });

  test("source_path names the folder a symlink resolves to, as Path.resolve() did", async () => {
    const link = join(work, "linked");
    symlinkSync(streams, link);
    expect((await ingestStreams.ingestStreams(options({ streamsDir: link }))).ok).toBe(true);
    const { rows } = await readTable(join(work, "db"));
    expect(new Set(rows.map((row) => String(row.source_path).split("/")[0]))).toEqual(
      new Set(["streams"]),
    );
  });

  test("records the build beside the table: model, size, sources as read, skip types", async () => {
    const report = await ingestStreams.ingestStreams(options());
    expect(report.ok).toBe(true);
    const meta = JSON.parse(readFileSync(join(work, "db", "stream_chunks.meta.json"), "utf8"));
    const names = readdirSync(streams)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .flatMap((md) => {
        const sidecar = md.replace(/\.md$/, ".refined.json");
        return existsSync(join(streams, sidecar)) ? [md, sidecar] : [md];
      });
    expect(meta).toEqual({
      embedModel: GOLDEN_MODEL,
      embedDim: GOLDEN_DIM,
      rows: 13,
      builtAt: "2026-11-05T01:02:03.456Z",
      sources: names.map((name) => {
        const stat = statSync(join(streams, name));
        return { name, size: stat.size, mtime: stat.mtime.toISOString() };
      }),
      skipTypes: ["anime_audio", "karaoke"],
    });
    expect(readdirSync(join(work, "db")).sort()).toEqual([
      "stream_chunks.lance",
      "stream_chunks.meta.json",
    ]);
  });

  test("reports through progress events and ends with the stage's summary", async () => {
    const events: ProgressEvent[] = [];
    await ingestStreams.ingestStreams(options({ onProgress: (e) => events.push(e) }));
    const files = events.filter((e) => e.type === "progress" && e.unit === "files");
    expect(events[0]).toEqual({
      type: "stage",
      stage: "ingest-streams",
      status: "start",
      total: 11,
    });
    expect(files.map((e) => (e.type === "progress" ? [e.done, e.total] : null))).toEqual(
      Array.from({ length: 11 }, (_, i) => [i + 1, 11]),
    );
    expect(events.filter((e) => e.type === "progress" && e.unit === "chunks")).toEqual([
      { type: "progress", stage: "ingest-streams", done: 13, total: 13, unit: "chunks" },
    ]);
    expect(events.at(-2)).toEqual({ type: "stage", stage: "ingest-streams", status: "done" });
    const summary = events.at(-1) as Extract<ProgressEvent, { type: "summary" }>;
    expect({ ...summary, durationSec: 0 }).toEqual({
      type: "summary",
      stage: "ingest-streams",
      ok: true,
      counts: { rows: 13, cacheHits: 0, embedded: 13 },
      durationSec: 0,
      costUsd: 0.000001 * 13,
      costSource: "reported",
    });

    events.length = 0;
    await ingestStreams.ingestStreams(options({ onProgress: (e) => events.push(e) }));
    const warm = events.at(-1) as Extract<ProgressEvent, { type: "summary" }>;
    expect([warm.counts, warm.costUsd, warm.costSource]).toEqual([
      { rows: 13, cacheHits: 13, embedded: 0 },
      0,
      undefined,
    ]);

    events.length = 0;
    await ingestStreams.ingestStreams(options({ dryRun: true, onProgress: (e) => events.push(e) }));
    const dry = events.at(-1) as Extract<ProgressEvent, { type: "summary" }>;
    expect([dry.ok, dry.counts, "costUsd" in dry]).toEqual([
      true,
      { rows: 13, cacheHits: 0, embedded: 0 },
      false,
    ]);
  });

  test("a signal before the run starts it on nothing: no folder, a cancelled summary", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Interrupted by SIGINT", "AbortError"));
    const events: ProgressEvent[] = [];
    const report = await ingestStreams.ingestStreams(
      options({ signal: controller.signal, onProgress: (e) => events.push(e) }),
    );
    expect([report.ok, report.cancelled, report.written]).toEqual([false, true, false]);
    expect(existsSync(join(work, "db"))).toBe(false);
    expect(events.slice(-2)).toEqual([
      { type: "stage", stage: "ingest-streams", status: "cancelled", code: "cancelled" },
      {
        type: "summary",
        stage: "ingest-streams",
        ok: false,
        cancelled: true,
        counts: { rows: 0, cacheHits: 0, embedded: 0 },
        durationSec: (events.at(-1) as { durationSec: number }).durationSec,
      },
    ]);
  });

  test("a signal while embedding, or a provider failing, leaves the table and its meta", async () => {
    expect((await ingestStreams.ingestStreams(options())).ok).toBe(true);
    const db = join(work, "db");
    const before = await readTable(db);
    const meta = readFileSync(join(db, "stream_chunks.meta.json"), "utf8");

    const controller = new AbortController();
    const aborting: Pick<EmbeddingClient, "embedWithUsage"> = {
      async embedWithUsage() {
        controller.abort(new DOMException("Interrupted by SIGINT", "AbortError"));
        throw controller.signal.reason;
      },
    };
    const cancelled = await ingestStreams.ingestStreams(
      options({ cachePath: null, client: aborting, signal: controller.signal }),
    );
    expect([cancelled.ok, cancelled.cancelled, cancelled.written]).toEqual([false, true, false]);

    const events: ProgressEvent[] = [];
    records.length = 0;
    const failing: Pick<EmbeddingClient, "embedWithUsage"> = {
      embedWithUsage: () => Promise.reject(new Error("provider down")),
    };
    const failed = await ingestStreams.ingestStreams(
      options({ cachePath: null, client: failing, onProgress: (e) => events.push(e) }),
    );
    expect([failed.ok, failed.cancelled, failed.error]).toEqual([false, false, "provider down"]);
    expect(records.at(-1)).toEqual(["ERROR", "Stream ingest failed: provider down"]);
    expect(events.at(-2)).toEqual({
      type: "stage",
      stage: "ingest-streams",
      status: "failed",
      message: "provider down",
    });
    expect(events.at(-1)).toMatchObject({
      ok: false,
      counts: { rows: 13, cacheHits: 0, embedded: 0 },
      failures: [{ item: "stream_chunks", error: "provider down" }],
    });

    expect(await readTable(db)).toEqual(before);
    expect(readFileSync(join(db, "stream_chunks.meta.json"), "utf8")).toBe(meta);
    expect(readdirSync(db).sort()).toEqual(["stream_chunks.lance", "stream_chunks.meta.json"]);
  });

  test("a cancel's forced exit waits for the rebuild: table, FTS index and build record", async () => {
    expect((await ingestStreams.ingestStreams(options())).ok).toBe(true);
    const db = join(work, "db");
    const metaPath = join(db, "stream_chunks.meta.json");
    const before = await readTable(db);
    rmSync(metaPath);
    const { code, exits } = await cancelMidRebuild(
      (signal) => ingestStreams.ingestStreams(options({ signal })),
      metaPath,
    );
    expect([code, exits]).toEqual([130, [true]]);
    expect(await readTable(db)).toEqual(before);
  });

  test("a cache miss without an API key fails as missing-credential, before any request", async () => {
    const saved = [process.env.EMBED_API_KEY, process.env.OPENROUTER_API_KEY];
    delete process.env.EMBED_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    resetSettings();
    resetEmbeddingClient();
    const network = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("network disabled in tests");
    }) as unknown as typeof fetch);
    try {
      const events: ProgressEvent[] = [];
      const report = await ingestStreams.ingestStreams(
        options({ client: undefined, onProgress: (e) => events.push(e) }),
      );
      expect([report.ok, report.written]).toEqual([false, false]);
      expect(events.at(-2)).toMatchObject({ status: "failed", code: "missing-credential" });
      expect(records.at(-1)?.[1]).toStartWith("OpenRouter needs an API key");
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
      resetEmbeddingClient();
      if (saved[0] !== undefined) process.env.EMBED_API_KEY = saved[0];
      if (saved[1] !== undefined) process.env.OPENROUTER_API_KEY = saved[1];
    }
  });

  test("a fully cached run needs no key", async () => {
    expect((await ingestStreams.ingestStreams(options())).ok).toBe(true);
    const report = await ingestStreams.ingestStreams(
      options({
        client: { embedWithUsage: () => Promise.reject(new Error("no request expected")) },
      }),
    );
    expect([report.ok, report.cacheHits, report.embedded]).toEqual([true, 13, 0]);
  });
});

describe("skip types", () => {
  test("parseSkipTypes splits on commas, strips each and drops blanks; '' drops nothing", () => {
    expect(ingestStreams.parseSkipTypes(" anime_audio , karaoke,, x ")).toEqual(
      new Set(["anime_audio", "karaoke", "x"]),
    );
    expect(ingestStreams.parseSkipTypes("")).toEqual(new Set());
  });

  test("INGEST_SKIP_TYPES: unset or blank is the default, none drops nothing", () => {
    const saved = process.env.INGEST_SKIP_TYPES;
    try {
      for (const [value, expected] of [
        [undefined, "anime_audio,karaoke"],
        ["", "anime_audio,karaoke"],
        ["none", ""],
        ["karaoke", "karaoke"],
      ] as const) {
        if (value === undefined) delete process.env.INGEST_SKIP_TYPES;
        else process.env.INGEST_SKIP_TYPES = value;
        expect([value, ingestStreams.defaultSkipTypes()]).toEqual([value, expected]);
      }
    } finally {
      if (saved === undefined) delete process.env.INGEST_SKIP_TYPES;
      else process.env.INGEST_SKIP_TYPES = saved;
    }
  });

  test("knowledge.archive.skipTypes: [] is the default, none drops nothing", () => {
    const savedHome = process.env.EIDOLON_HOME;
    const savedPersona = process.env.EIDOLON_PERSONA;
    const savedTypes = process.env.INGEST_SKIP_TYPES;
    process.env.EIDOLON_HOME = join(work, "home");
    delete process.env.EIDOLON_PERSONA;
    delete process.env.INGEST_SKIP_TYPES;
    const persona = join(work, "home", "personas", "milky-green");
    mkdirSync(persona, { recursive: true });
    try {
      for (const [value, expected] of [
        ["[]", "anime_audio,karaoke"],
        ["none", ""],
        ["[karaoke, mixed]", "karaoke,mixed"],
      ] as const) {
        writeFileSync(
          join(persona, "persona.yaml"),
          `knowledge:\n  archive:\n    skipTypes: ${value}\n`,
        );
        installSettings();
        expect([value, ingestStreams.defaultSkipTypes()]).toEqual([value, expected]);
      }
    } finally {
      resetSettings();
      if (savedHome === undefined) delete process.env.EIDOLON_HOME;
      else process.env.EIDOLON_HOME = savedHome;
      if (savedPersona !== undefined) process.env.EIDOLON_PERSONA = savedPersona;
      if (savedTypes !== undefined) process.env.INGEST_SKIP_TYPES = savedTypes;
    }
  });
});
