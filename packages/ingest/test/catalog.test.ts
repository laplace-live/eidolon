// The golden catalog runs (see ingest_streams_golden.ts) replayed through writeStreamCatalog, plus
// its events, built_at, and what a failed or cancelled build leaves behind.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleSink, logger } from "@eidolon/config";
import { catalog, type ProgressEvent } from "../src/index.ts";
import {
  GOLDEN,
  maskBuiltAt,
  materialize,
  placehold,
  substitute,
} from "./ingest_streams_golden.ts";

let work = "";
let streams = "";
let paths: Record<string, string> = {};
const records: [string, string][] = [];

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "stream-catalog-")));
  streams = materialize("streams", join(work, "streams"));
  materialize("bad_date", join(work, "bad"));
  mkdirSync(join(work, "empty"));
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

function argValue(argv: readonly string[], flag: string): string {
  return substitute(argv[argv.indexOf(flag) + 1] as string, paths);
}

describe("writeStreamCatalog", () => {
  for (const run of GOLDEN.catalog) {
    test(`replays main's ${run.name} run: exit code, log lines and file`, async () => {
      const dbPath = argValue(run.argv, "--db-path");
      const cwd = process.cwd();
      // `--streams-dir .` is relative to the folder Python ran in.
      if (run.name === "relative_dot") process.chdir(streams);
      let report: catalog.StreamCatalogReport;
      try {
        report = await catalog.writeStreamCatalog({
          streamsDir: argValue(run.argv, "--streams-dir"),
          dbPath,
        });
      } finally {
        process.chdir(cwd);
      }
      expect([report.ok, logs()]).toEqual([run.exit_code === 0, run.logs]);
      const written = readdirSync(work).includes(dbPath.slice(work.length + 1));
      expect(
        written ? maskBuiltAt(readFileSync(join(dbPath, "stream_catalog.json"), "utf8")) : null,
      ).toBe(run.text ?? null);
    });
  }

  test("built_at is datetime.now(timezone.utc).isoformat() at microseconds", async () => {
    const db = join(work, "db");
    const clock = () => 1_762_300_923_000_123;
    expect((await catalog.writeStreamCatalog({ streamsDir: streams, dbPath: db, clock })).ok).toBe(
      true,
    );
    const text = readFileSync(join(db, "stream_catalog.json"), "utf8");
    expect(text.slice(0, text.indexOf(', "broadcasts"'))).toBe(
      '{"schema_version": 1, "built_at": "2025-11-05T00:02:03.000123+00:00", "source_parts": 11',
    );
  });

  test("reports through progress events and ends with the stage's summary", async () => {
    const events: ProgressEvent[] = [];
    await catalog.writeStreamCatalog({
      streamsDir: streams,
      dbPath: join(work, "db"),
      onProgress: (e) => events.push(e),
    });
    expect(events[0]).toEqual({ type: "stage", stage: "catalog", status: "start", total: 11 });
    expect(events.filter((e) => e.type === "progress")).toHaveLength(11);
    expect(events.at(-2)).toEqual({ type: "stage", stage: "catalog", status: "done" });
    expect({ ...events.at(-1), durationSec: 0 }).toEqual({
      type: "summary",
      stage: "catalog",
      ok: true,
      counts: { broadcasts: 9, parts: 11 },
      durationSec: 0,
    });
  });

  test("a failed or cancelled build leaves the old file, and no temporary one", async () => {
    const db = join(work, "db");
    await catalog.writeStreamCatalog({ streamsDir: streams, dbPath: db });
    const before = readFileSync(join(db, "stream_catalog.json"), "utf8");

    const events: ProgressEvent[] = [];
    const failed = await catalog.writeStreamCatalog({
      streamsDir: join(work, "bad"),
      dbPath: db,
      onProgress: (e) => events.push(e),
    });
    expect([failed.ok, failed.error]).toEqual([false, "Invalid isoformat string: '2021-7-2'"]);
    expect(events.slice(-2)).toEqual([
      {
        type: "stage",
        stage: "catalog",
        status: "failed",
        message: "Invalid isoformat string: '2021-7-2'",
      },
      {
        type: "summary",
        stage: "catalog",
        ok: false,
        counts: { broadcasts: 0, parts: 0 },
        durationSec: (events.at(-1) as { durationSec: number }).durationSec,
        failures: [{ item: "stream_catalog.json", error: "Invalid isoformat string: '2021-7-2'" }],
      },
    ]);

    const controller = new AbortController();
    const cancelled = await catalog.writeStreamCatalog({
      streamsDir: streams,
      dbPath: db,
      signal: controller.signal,
      onProgress: (e) => {
        if (e.type === "progress" && e.done === 3) {
          controller.abort(new DOMException("Interrupted by SIGINT", "AbortError"));
        }
      },
    });
    expect([cancelled.ok, cancelled.cancelled]).toEqual([false, true]);

    expect(readFileSync(join(db, "stream_catalog.json"), "utf8")).toBe(before);
    expect(readdirSync(db)).toEqual(["stream_catalog.json"]);
  });
});

describe("broadcastId", () => {
  test("a BV id joins its date; otherwise the id without its part suffix", () => {
    expect(
      [
        ["2021-07-02-BV1RL411p72W_p1", "2021-07-02"],
        ["BV1RL411p72W_p2", "2021-07-02"],
        ["compact-BV1cmp9", "2026-09-06"],
        ["2026-09-07-live_p2", "2026-09-07"],
        ["live_p2", "2026-09-07"],
        ["nofm", ""],
        ["x_p1\n", ""],
        ["-dash", ""],
      ].map(([id, date]) => catalog.broadcastId(id as string, date as string)),
    ).toEqual([
      "2021-07-02-BV1RL411p72W",
      "2021-07-02-BV1RL411p72W",
      "2026-09-06-BV1cmp9",
      "2026-09-07-live",
      "2026-09-07-live",
      "nofm",
      "x\n",
      "-dash",
    ]);
  });
});
