// The command around the library: the golden catalog runs (see
// packages/ingest/test/ingest_streams_golden.ts) replayed from their argv, the help, the defaults
// and the lock. Every run happens in a temporary data home.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSettings, sourceFolder } from "@eidolon/config";
import { acquireLock, indexLockKey } from "@eidolon/ingest";
import {
  GOLDEN,
  maskBuiltAt,
  materialize,
  placehold,
  substitute,
} from "../../../packages/ingest/test/ingest_streams_golden.ts";
import {
  buildStreamCatalogMain,
  parseBuildStreamCatalogArgs,
} from "../src/build_stream_catalog.ts";
import { captureIo, captureLogs, setEnv } from "./helpers.ts";

let work = "";
let home = "";
let streams = "";
let paths: Record<string, string> = {};
let logs!: ReturnType<typeof captureLogs>;
let restoreEnv: () => void = () => {};

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "cli-stream-catalog-")));
  home = join(work, "home");
  streams = materialize("streams", join(work, "streams"));
  materialize("bad_date", join(work, "bad"));
  mkdirSync(join(work, "empty"));
  paths = { "<STREAMS>": streams, "<TMP>": work };
  logs = captureLogs();
  restoreEnv = setEnv({ EIDOLON_HOME: home, EIDOLON_PERSONA: undefined, LANCEDB_PATH: undefined });
  resetSettings();
});

afterEach(() => {
  restoreEnv();
  resetSettings();
  logs.stop();
  rmSync(work, { recursive: true, force: true });
});

describe("buildStreamCatalogMain", () => {
  test("-h prints the help argparse lays out; a bad flag prints its usage and exits 2", async () => {
    const [usage, help] = GOLDEN.help.build_stream_catalog;
    const shown = captureIo();
    expect(await buildStreamCatalogMain(["-h"], shown.io)).toBe(0);
    expect([shown.stdout(), shown.stderr()]).toEqual([help, ""]);
    const bad = captureIo();
    expect(await buildStreamCatalogMain(["--table", "x"], bad.io)).toBe(2);
    expect(bad.stderr()).toBe(
      `${usage}laplace-build-stream-catalog: error: unrecognized arguments: --table x\n`,
    );
  });

  for (const run of GOLDEN.catalog) {
    test(`replays main's ${run.name} run from its argv`, async () => {
      const argv = run.argv.map((arg) => substitute(arg, paths));
      const db = argv[argv.indexOf("--db-path") + 1] as string;
      const cwd = process.cwd();
      // `--streams-dir .` is relative to the folder Python ran in.
      if (run.name === "relative_dot") process.chdir(streams);
      let code: number;
      try {
        code = await buildStreamCatalogMain(argv, captureIo().io);
      } finally {
        process.chdir(cwd);
      }
      const [first, ...rest] = logs.records.map(([level, message]) => [
        level,
        placehold(message, paths),
      ]);
      expect({ code, first, rest }).toEqual({
        code: run.exit_code,
        first: ["INFO", `Persona milky-green's index: ${placehold(db, paths)}`],
        rest: run.logs,
      });
      const file = join(db, "stream_catalog.json");
      expect(existsSync(file) ? maskBuiltAt(readFileSync(file, "utf8")) : null).toBe(
        run.text ?? null,
      );
    });
  }

  test("defaults: the persona's sources and the index the bot reads; paths as pathlib prints them", () => {
    expect(parseBuildStreamCatalogArgs([])).toEqual({
      streamsDir: sourceFolder("milky-green", "streams"),
      dbPath: join(home, "personas", "milky-green", "index"),
      persona: "milky-green",
      json: false,
    });
    const args = parseBuildStreamCatalogArgs(["--streams-dir", "./streams/", "--db-path", "db//"]);
    expect([args.streamsDir, args.dbPath]).toEqual(["streams", "db"]);
  });

  test("LANCEDB_PATH from the environment with --persona spelled out is a usage error", async () => {
    process.env.LANCEDB_PATH = join(work, "elsewhere");
    expect(parseBuildStreamCatalogArgs([]).dbPath).toBe(join(work, "elsewhere"));
    const io = captureIo();
    expect(await buildStreamCatalogMain(["--persona=milky-green"], io.io)).toBe(2);
    expect(io.stderr()).toEndWith(
      "laplace-build-stream-catalog: error: LANCEDB_PATH is set in the environment; " +
        "pass --db-path to write persona milky-green's index.\n",
    );
  });

  test("another writer on the index: exit 1, code locked under --json, and no file", async () => {
    const db = join(work, "db");
    const release = acquireLock(indexLockKey(db), "laplace-ingest-streams");
    try {
      const io = captureIo();
      const argv = ["--json", "--streams-dir", streams, "--db-path", db];
      expect(await buildStreamCatalogMain(argv, io.io)).toBe(1);
      const message = `Another laplace-ingest-streams is running for ${db} (pid ${process.pid}).`;
      const lines = io
        .stdout()
        .trimEnd()
        .split("\n")
        .map((line) => {
          const { v, t, ...event } = JSON.parse(line) as Record<string, unknown>;
          expect([v, typeof t]).toEqual([1, "number"]);
          return event;
        });
      expect(lines).toEqual([
        { type: "stage", stage: "catalog", status: "failed", code: "locked", message },
        {
          type: "summary",
          stage: "catalog",
          ok: false,
          counts: { broadcasts: 0, parts: 0 },
          durationSec: 0,
          failures: [{ item: "stream_catalog.json", error: message }],
        },
      ]);
    } finally {
      release();
    }
    expect(existsSync(db)).toBe(false);
  });
});
