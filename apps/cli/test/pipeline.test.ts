// laplace-pipeline against Python's main(): golden.json's scenarios (see packages/ingest/test/
// pipeline_helpers.ts) replayed through the TS command. Python ran its later stages as children,
// faked there by exit code; here they run in this process, so each scenario gives them inputs
// that end the same way: the fake Soniox, refine provider and embedding API, or a transcript the
// catalog rejects.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personaIds, resetSettings, sourceFolder } from "@eidolon/config";
import {
  acquireLock,
  download,
  type ProgressEvent,
  SUMMARY_COUNTS,
  sourcesLockKey,
} from "@eidolon/ingest";
import { installFakeYtDlp } from "../../../packages/ingest/test/download_helpers.ts";
import { fakeSoniox, sonioxError } from "../../../packages/ingest/test/fake_soniox.ts";
import { makeFifo, whenReading } from "../../../packages/ingest/test/fifo.ts";
import {
  fakeEmbeddings,
  fakeRefine,
  type MainGolden,
  mainCase,
  maskDurations,
  pipelineGolden,
  routeFetch,
  sonioxJob,
  transcriptText,
  writeVods,
} from "../../../packages/ingest/test/pipeline_helpers.ts";
import {
  PIPELINE_PARSER,
  type PipelineDeps,
  parsePipelineArgs,
  pipelineMain,
  STAGES,
} from "../src/pipeline.ts";
import { blockNetwork, captureIo, captureLogs, setEnv, spawnCli } from "./helpers.ts";

blockNetwork();

let work = "";
let logs!: ReturnType<typeof captureLogs>;
let restoreEnv = (): void => {};
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "pipeline-cli-"));
  logs = captureLogs();
  restoreEnv = setEnv({
    EIDOLON_HOME: process.env.EIDOLON_HOME,
    SONIOX_API_KEY: "soniox-test",
    REFINE_API_KEY: "refine-test",
    OPENROUTER_API_KEY: undefined,
    REFINE_MODEL: undefined,
    REFINE_CONCURRENCY: undefined,
    INGEST_SKIP_TYPES: undefined,
    LANCEDB_PATH: undefined,
    YT_DLP_PATH: undefined,
    YT_DLP_COOKIES_FROM_BROWSER: undefined,
    YT_DLP_COOKIES: undefined,
    EMBED_DIM: "8",
  });
});
afterEach(() => {
  logs.stop();
  restoreEnv();
  rmSync(work, { recursive: true, force: true });
});

const RULE64 = "=".repeat(64);

/** Python's summary text after the download block, from where the pipeline's own begins. */
function pipelineBlock(stdout: string): string {
  return stdout.slice(stdout.indexOf(`\n${RULE64}\nPipeline Summary`));
}

/** The lines tools/pipeline.py and the in-process download logged, as opposed to later stages'. */
function own(message: string): boolean {
  return (
    /^(Pipeline stages|URL list not found|No URLs in|Refining: |Ingesting: )/.test(message) ||
    /^\[dry-run\] |^\[\d+\/\d+\] /.test(message) ||
    /^ {2}(✗ (transcribe|yt-dlp) failed|✗ \S+: transcribe failed|abort_on_error)/.test(message)
  );
}

/** A golden log line as the port writes it: its stages run as commands, not Python modules. */
function ported(message: string, transcribeError: string): string {
  return message
    .replace("<PYTHON> -m laplace_eidolon.tools.refine", "laplace-refine")
    .replace("<PYTHON> -m laplace_eidolon.tools.ingest_streams", "laplace-ingest-streams")
    .replace("  ✗ transcribe failed (exit=1)", `  ✗ transcribe failed: ${transcribeError}`)
    .replace(
      /`tools\.transcribe (.*) --date YYYY-MM-DD`/,
      "`bun run laplace-transcribe $1 --date YYYY-MM-DD --persona milky-green`",
    );
}

const SONIOX_ERROR = "bad audio (HTTP 400, invalid_request)";

interface Run {
  readonly golden: MainGolden;
  readonly dir: string;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly logs: [string, string][];
}

/**
 * Replays the golden scenario `name`: its list, audio and transcripts, its argv (plus `extra`),
 * with fake-yt-dlp.sh as yt-dlp, and a data home of its own, as golden.py gave Python.
 */
async function scenario(
  name: string,
  options: {
    readonly deps?: PipelineDeps;
    readonly setup?: (dir: string) => void;
    readonly extra?: readonly string[];
  } = {},
): Promise<Run> {
  const golden = mainCase(name);
  const dir = join(work, `main-${name}`);
  mkdirSync(dir);
  // Its own embedding cache and locks, so no other scenario's vectors are served from cache.
  process.env.EIDOLON_HOME = join(dir, "home");
  const list = join(dir, "urls.txt");
  if (golden.list !== undefined) writeFileSync(list, golden.list);
  if (golden.vods) writeVods(join(dir, "vods"), golden.vods);
  if (golden.streams) {
    mkdirSync(join(dir, "streams"));
    for (const [file, text] of Object.entries(golden.streams)) {
      writeFileSync(join(dir, "streams", file), text);
    }
  }
  options.setup?.(dir);
  const argv = golden.argv.map((arg) => arg.replaceAll("<WORK>", dir).replaceAll("<LIST>", list));
  process.env.FAKE_YTDLP_LOG = join(dir, "argv.log");
  const io = captureIo();
  const code = await pipelineMain([...argv, ...(options.extra ?? [])], {
    ...io.io,
    ytDlp: { path: installFakeYtDlp(dir), source: "setting" },
    sleep: async () => {},
    retryDelaysMs: [],
    ffprobe: null,
    ffmpeg: null,
    embeddingClient: fakeEmbeddings(),
    ...options.deps,
  });
  return {
    golden,
    dir,
    code,
    stdout: maskDurations(io.stdout()).replaceAll(dir, "<WORK>"),
    stderr: io.stderr(),
    logs: logs.records.map(([level, message]) => [level, message.replaceAll(dir, "<WORK>")]),
  };
}

/** The scenario's logs as Python logged them, the port's differences applied. */
function expectOwnLogs(run: Run): void {
  const expected = run.golden.logs.map(([level, message]) => [
    level,
    ported(message, SONIOX_ERROR),
  ]);
  expect(run.logs.filter(([, message]) => own(message))).toEqual(expected as [string, string][]);
}

const indexOf = (dir: string) => ["--db-path", join(dir, "index")];

describe("argparse", () => {
  test("-h is argparse's help for the port's flags", async () => {
    const io = captureIo();
    expect(await pipelineMain(["-h"], io.io)).toBe(0);
    expect(io.stdout()).toBe(pipelineGolden.help[1]);
    expect(PIPELINE_PARSER.usage).toBe(pipelineGolden.help[0]);
  });

  test("--stages reads each value as _parse_stages does", () => {
    for (const { raw, stages, error } of pipelineGolden.stages) {
      if (error === undefined) {
        expect([raw, STAGES.parse(raw) as string[]]).toEqual([raw, stages as string[]]);
      } else expect(() => STAGES.parse(raw), raw).toThrow(error);
    }
  });

  test("usage errors exit 2 with argparse's message", async () => {
    const cases: [string[], string][] = [
      [["x.txt", "--stages", "Refine, foo,ALL"], mainCase("bad-stages").stderr[0] as string],
      // whisper is gone, so it is no longer one of the choices.
      [
        ["x.txt", "--provider", "whisperx"],
        (mainCase("bad-provider").stderr[0] as string).replace(", whisper)", ")"),
      ],
      [[], "laplace-pipeline: error: the following arguments are required: url_list"],
      [
        ["x.txt", "--refine-concurrency", "0"],
        "laplace-pipeline: error: argument --refine-concurrency: must be at least 1, not 0",
      ],
      [
        ["x.txt", "--persona", "nobody"],
        "laplace-pipeline: error: argument --persona: write --persona nobody in full",
      ],
    ];
    for (const [argv, message] of cases) {
      const io = captureIo();
      expect(await pipelineMain(argv, io.io), argv.join(" ")).toBe(2);
      expect(io.stderr()).toBe(`${PIPELINE_PARSER.usage}${message}\n`);
    }
  });

  test("url_list is optional once no download stage would read it", async () => {
    expect(parsePipelineArgs(["--stages", "transcribe,refine,ingest"]).urlList).toBeNull();
    const io = captureIo();
    expect(await pipelineMain(["--stages", "refine,download"], io.io)).toBe(2);
    expect(io.stderr()).toBe(
      `${PIPELINE_PARSER.usage}laplace-pipeline: error: the following arguments are required: url_list\n`,
    );
  });

  test("a persona with no folder is a usage error, before anything is read or written", async () => {
    // As load-env.ts installs `--persona nobody`.
    const restore = setEnv({ EIDOLON_PERSONA: "nobody" });
    resetSettings();
    try {
      const list = join(work, "urls.txt");
      writeFileSync(list, "https://www.bilibili.com/video/BV1aaaaaaaa1\n");
      const io = captureIo();
      const argv = [list, "--persona", "nobody", "--stages", "download", "--dry-run"];
      expect(await pipelineMain(argv, io.io)).toBe(2);
      expect(io.stderr()).toBe(
        `${PIPELINE_PARSER.usage}laplace-pipeline: error: argument --persona: unknown persona ` +
          `'nobody' (choose from ${personaIds().join(", ")})\n`,
      );
      expect(logs.records).toEqual([]);
    } finally {
      restore();
      resetSettings();
    }
  });

  test("REFINE_CONCURRENCY below 1 is a usage error when refine runs", async () => {
    process.env.REFINE_CONCURRENCY = "0";
    const io = captureIo();
    expect(await pipelineMain(["x.txt"], io.io)).toBe(2);
    expect(io.stderr()).toEndWith(
      "laplace-pipeline: error: REFINE_CONCURRENCY must be at least 1, not 0\n",
    );
    expect(await pipelineMain(["x.txt", "--stages", "ingest", "--dry-run"], captureIo().io)).toBe(
      1,
    );
  });

  test("LANCEDB_PATH in the environment needs --db-path once --persona is spelled out", async () => {
    process.env.LANCEDB_PATH = join(work, "elsewhere");
    const io = captureIo();
    expect(await pipelineMain(["x.txt", "--persona", "milky-green"], io.io)).toBe(2);
    expect(io.stderr()).toEndWith(
      "laplace-pipeline: error: LANCEDB_PATH is set in the environment; pass --db-path to write " +
        "persona milky-green's index.\n",
    );
    // Without the ingest stage there is no index to write.
    const list = join(work, "urls.txt");
    writeFileSync(list, "");
    expect(
      await pipelineMain([list, "--persona", "milky-green", "--stages", "refine", "--dry-run"], {
        ...captureIo().io,
      }),
    ).toBe(0);
  });
});

describe("main() scenarios", () => {
  test("missing-list: logged, exit 1", async () => {
    const run = await scenario("missing-list");
    expect(run.code).toBe(run.golden.code as number);
    expectOwnLogs(run);
    expect(run.stdout).toBe(run.golden.stdout);
  });

  test("no-stages: an empty --stages runs nothing and succeeds", async () => {
    const run = await scenario("no-stages");
    expect(run.code).toBe(0);
    expectOwnLogs(run);
    expect(run.stdout).toBe(run.golden.stdout);
  });

  test("shlex: an unbalanced quote in --yt-dlp-args throws, as Python's traceback", async () => {
    await expect(scenario("shlex")).rejects.toThrow("No closing quotation");
    expect(mainCase("shlex").raises).toBe("ValueError: No closing quotation");
  });

  test("dry-run: each stage says what it would do; nothing is written or locked", async () => {
    let lock = (): void => {};
    try {
      const run = await scenario("dry-run", {
        extra: indexOf(join(work, "main-dry-run")),
        setup: () => {
          lock = acquireLock(sourcesLockKey("milky-green"), "test");
        },
      });
      expect(run.code).toBe(0);
      expectOwnLogs(run);
      expect(run.stdout).toEndWith(run.golden.stdout);
      expect(run.stdout).toContain("2026-08-02-BV1zzzzzzzz1.md: 1 chunks × 2 passes");
      expect(readdirSync(join(run.dir, "vods")).sort()).toEqual(run.golden.files as string[]);
      expect(existsSync(join(run.dir, "index"))).toBe(false);
    } finally {
      lock();
    }
  });

  test("run: every stage in this process; a failed URL and a failed file fail the run", async () => {
    const soniox = fakeSoniox([sonioxJob(1), sonioxJob(2)], (request) =>
      request.method === "POST" &&
      request.path === "/transcriptions" &&
      request.json?.includes("BV1aaaaaaaa2")
        ? sonioxError(400, "invalid_request", "bad audio")
        : undefined,
    );
    const provider = fakeRefine();
    const run = await scenario("run", {
      deps: { fetch: routeFetch(soniox.fetch, provider.fetch) },
      extra: indexOf(join(work, "main-run")),
    });
    expect(run.code).toBe(1);
    expectOwnLogs(run);
    const at = run.golden.stdout.indexOf(`\n${RULE64}\nPipeline Summary`);
    expect(run.stdout).toStartWith(run.golden.stdout.slice(0, at));
    expect(run.stdout).toEndWith(pipelineBlock(run.golden.stdout));
    expect(run.stdout).toContain("Refinement Summary");
    expect(provider.calls()).toBe(4);
    expect(readdirSync(join(run.dir, "vods")).sort()).toEqual(run.golden.files as string[]);
    expect(existsSync(join(run.dir, "index", "stream_catalog.json"))).toBe(true);
  });

  test("abort-download: --abort-on-error stops after the download stage", async () => {
    const run = await scenario("abort-download");
    expect(run.code).toBe(1);
    expectOwnLogs(run);
    expect(run.stdout).toBe(run.golden.stdout);
  });

  test("abort-transcribe: the first failure starts no other file and no later stage", async () => {
    const soniox = fakeSoniox([1, 2, 3].map(sonioxJob), (request) =>
      request.method === "POST" && request.path === "/transcriptions"
        ? sonioxError(400, "invalid_request", "bad audio")
        : undefined,
    );
    const run = await scenario("abort-transcribe", { deps: { fetch: soniox.fetch } });
    expect(run.code).toBe(1);
    expectOwnLogs(run);
    expect(run.stdout).toBe(run.golden.stdout);
  });

  const unrefined = (dir: string): void => {
    mkdirSync(join(dir, "streams"), { recursive: true });
    const id = "2026-08-01-BV1aaaaaaaa1";
    writeFileSync(join(dir, "streams", `${id}.md`), transcriptText(id, "2026-08-01", 1));
  };

  test("refine-fails: refine's failure fails the run, and ingest still runs", async () => {
    const run = await scenario("refine-fails", {
      setup: unrefined,
      deps: { fetch: fakeRefine(400).fetch },
      extra: indexOf(join(work, "main-refine-fails")),
    });
    expect(run.code).toBe(1);
    expectOwnLogs(run);
    expect(run.stdout).toEndWith(pipelineBlock(run.golden.stdout));
    expect(existsSync(join(run.dir, "index", "stream_catalog.json"))).toBe(true);
  });

  test("refine-aborts: with --abort-on-error, ingest doesn't start", async () => {
    const run = await scenario("refine-aborts", {
      setup: unrefined,
      deps: { fetch: fakeRefine(400).fetch },
      extra: indexOf(join(work, "main-refine-aborts")),
    });
    expect(run.code).toBe(1);
    expectOwnLogs(run);
    expect(run.stdout).toEndWith(pipelineBlock(run.golden.stdout));
  });

  test("ingest-fails: no catalog after a failed ingest", async () => {
    const run = await scenario("ingest-fails", {
      setup: unrefined,
      deps: { embeddingClient: fakeEmbeddings(true) },
      extra: indexOf(join(work, "main-ingest-fails")),
    });
    expect(run.code).toBe(1);
    expectOwnLogs(run);
    expect(run.stdout).toBe(run.golden.stdout);
    expect(existsSync(join(run.dir, "index", "stream_catalog.json"))).toBe(false);
  });

  test("catalog-fails: the catalog's failure is the ingest stage's", async () => {
    const run = await scenario("catalog-fails", {
      // The table keeps a date as written; the catalog parses it.
      setup: (dir) => {
        mkdirSync(join(dir, "streams"));
        const id = "2021-07-02-BV1aaaaaaaa1";
        writeFileSync(join(dir, "streams", `${id}.md`), transcriptText(id, "2021-7-2", 1));
      },
      extra: indexOf(join(work, "main-catalog-fails")),
    });
    expect(run.code).toBe(1);
    expectOwnLogs(run);
    expect(run.stdout).toBe(run.golden.stdout);
  });

  test("empty-list: the download stage still runs, over no URL", async () => {
    const run = await scenario("empty-list");
    expect(run.code).toBe(0);
    expectOwnLogs(run);
    expect(run.stdout).toBe(run.golden.stdout);
    expect(readdirSync(join(run.dir, "vods"))).toEqual(run.golden.files as string[]);
  });

  test("flags: each reaches its stage as Python forwarded it", async () => {
    const soniox = fakeSoniox([sonioxJob(1)]);
    const provider = fakeRefine();
    const run = await scenario("flags", {
      deps: { fetch: routeFetch(soniox.fetch, provider.fetch) },
      extra: indexOf(join(work, "main-flags")),
    });
    expect(run.code).toBe(0);
    expectOwnLogs(run);
    expect(run.stdout).toEndWith(pipelineBlock(run.golden.stdout));
    // --soniox-model stt-x, --language '' (no hint), --no-context over --context-file.
    const created = soniox.requests.find(
      (r) => r.path === "/transcriptions" && r.method === "POST",
    );
    expect(JSON.parse(created?.json as string)).toEqual({
      model: "stt-x",
      file_id: "file-1",
      client_reference_id: "laplace-eidolon:BV1aaaaaaaa1.m4a",
    });
    // --keep-soniox-files.
    expect(soniox.requests.filter((r) => r.method === "DELETE")).toEqual([]);
    // --refine-force over a fresh transcript: both chunks, both passes.
    expect(provider.calls()).toBe(4);
  });

  test("no-auto-slice: an empty --refine-model is no model; the run succeeds", async () => {
    const soniox = fakeSoniox([sonioxJob(1)]);
    const run = await scenario("no-auto-slice", { deps: { fetch: soniox.fetch } });
    expect(run.code).toBe(0);
    expectOwnLogs(run);
    expect(run.stdout).toBe(run.golden.stdout);
  });
});

describe("slicing", () => {
  function longAudio(): string {
    const list = join(work, "urls.txt");
    writeFileSync(list, "");
    writeVods(join(work, "vods"), {
      "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801", "duration": 20000}',
    });
    return list;
  }

  test("audio over Soniox's cap is sliced by default and fails with --no-auto-slice", async () => {
    const list = longAudio();
    const argv = [list, "--stages", "transcribe", "--vods-dir", join(work, "vods")];
    const ffmpeg = join(work, "ffmpeg");
    writeFileSync(ffmpeg, '#!/bin/sh\nfor a; do last="$a"; done\nprintf part > "$last"\n', {
      mode: 0o755,
    });
    const deps = { ...captureIo().io, sleep: async () => {}, ffprobe: null, ffmpeg };
    const refused = await pipelineMain(
      [...argv, "--no-auto-slice", "--streams-dir", join(work, "a")],
      { ...deps, fetch: fakeSoniox([]).fetch },
    );
    expect(refused).toBe(1);
    expect(logs.records).toContainEqual([
      "ERROR",
      "  ✗ transcribe failed: Audio is 333.3 min — Soniox caps async jobs at 300 min per file. " +
        "Re-run with --auto-slice to chunk it via ffmpeg.",
    ]);
    const sliced = fakeSoniox([sonioxJob(1), sonioxJob(2)]);
    const code = await pipelineMain(
      [...argv, "--slice-max-min", "200", "--streams-dir", join(work, "b")],
      { ...deps, fetch: sliced.fetch },
    );
    expect(code).toBe(0);
    expect(sliced.requests.filter((r) => r.path === "/files" && r.method === "POST")).toHaveLength(
      2,
    );
  });
});

describe("--json and locks", () => {
  test("stdout carries only events, the pipeline's summary last; the text goes to stderr", async () => {
    const run = await scenario("abort-download", { extra: ["--json"] });
    expect(run.code).toBe(1);
    const events = run.stdout
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as ProgressEvent & { v: number });
    expect(events.every((event) => event.v === 1)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "summary",
      stage: "pipeline",
      ok: false,
      counts: { stages: 4, failed: 1, aborted: 1 },
    });
    const summaries = events.filter((event) => event.type === "summary").map((e) => e.stage);
    expect(summaries).toEqual(["download", "pipeline"]);
    expect(maskDurations(run.stderr).replaceAll(run.dir, "<WORK>")).toBe(run.golden.stdout);
  });

  test("--dry-run --json: one plan event per video, then the plan's totals", async () => {
    const list = join(work, "urls.txt");
    writeFileSync(list, "https://www.bilibili.com/video/BV1aaaaaaaa1\nBV1bbbbbbbb1\n");
    writeVods(join(work, "vods"), {
      "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801", "duration": 3600}',
    });
    const io = captureIo();
    const lock = acquireLock(sourcesLockKey("milky-green"), "test");
    let code: number;
    try {
      code = await pipelineMain(
        [list, "--dry-run", "--json", "--vods-dir", join(work, "vods"), "--streams-dir", work],
        io.io,
      );
    } finally {
      lock();
    }
    expect(code).toBe(0);
    const events = io
      .stdout()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as ProgressEvent);
    expect(events.map((event) => event.type)).toEqual(["plan", "plan", "summary"]);
    expect(events[0]).toMatchObject({
      type: "plan",
      video: {
        id: "BV1aaaaaaaa1",
        url: "https://www.bilibili.com/video/BV1aaaaaaaa1",
        uploadDate: "2026-08-01",
        durationSec: 3600,
        download: "done",
        transcribe: "pending",
        refine: null,
        indexed: false,
        estimate: { transcribeUsd: 0.1 },
      },
    });
    expect(events[2]).toMatchObject({
      type: "summary",
      stage: "plan",
      ok: true,
      counts: { videos: 2, downloadPending: 1, transcribePending: 2 },
      costSource: "unpriced",
    });
    expect(io.stderr()).toBe("");
  });

  test("--dry-run --json ends in a plan summary when cancelled or refused too", async () => {
    const zero = Object.fromEntries(SUMMARY_COUNTS.plan.map((key) => [key, 0]));
    const streams = join(work, "streams");
    mkdirSync(streams);
    const id = "2026-08-01-BV1aaaaaaaa1";
    writeFileSync(join(streams, `${id}.md`), transcriptText(id, "2026-08-01", 1));
    const controller = new AbortController();
    controller.abort(new DOMException("Interrupted by SIGINT", "AbortError"));
    const cancelled = captureIo();
    const argv = ["--dry-run", "--json", "--streams-dir", streams];
    expect(await pipelineMain(argv, { ...cancelled.io, signal: controller.signal })).toBe(1);
    const [summary, ...rest] = cancelled
      .stdout()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as ProgressEvent);
    expect(rest).toEqual([]);
    expect(summary).toMatchObject({
      type: "summary",
      stage: "plan",
      ok: false,
      cancelled: true,
      counts: zero,
    });

    const missing = join(work, "missing.txt");
    const refused = captureIo();
    expect(await pipelineMain([missing, "--dry-run", "--json"], refused.io)).toBe(1);
    const events = refused
      .stdout()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as ProgressEvent);
    expect(events.map((e) => [e.type, "stage" in e ? e.stage : null])).toEqual([
      ["stage", "setup"],
      ["summary", "plan"],
    ]);
    expect(events[1]).toMatchObject({ ok: false, counts: zero });
  });

  /** A persona's sources: two lists, one batch, one audio file and its transcript. */
  function sources(): void {
    process.env.EIDOLON_HOME = join(work, "home");
    const lists = sourceFolder("milky-green", "lists");
    mkdirSync(lists, { recursive: true });
    writeFileSync(
      join(lists, "video-full.txt"),
      "https://www.bilibili.com/video/BV1aaaaaaaa1\nhttps://www.bilibili.com/video/BV1bbbbbbbb1\n",
    );
    download.writeBatch(lists, ["BV1cccccccc1", "BV1aaaaaaaa1"], ["x"], new Date(2026, 0, 2));
    writeVods(sourceFolder("milky-green", "vods"), {
      "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801", "duration": 600}',
    });
    const streams = sourceFolder("milky-green", "streams");
    mkdirSync(streams, { recursive: true });
    const id = "2026-08-01-BV1aaaaaaaa1";
    writeFileSync(join(streams, `${id}.md`), transcriptText(id, "2026-08-01", 2));
  }

  test("--dry-run --json without a URL list plans every video the persona's sources know, unlocked", async () => {
    sources();
    const io = captureIo();
    const lock = acquireLock(sourcesLockKey("milky-green"), "laplace-refine");
    try {
      expect(await pipelineMain(["--dry-run", "--json"], io.io)).toBe(0);
    } finally {
      lock();
    }
    const events = io
      .stdout()
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as ProgressEvent);
    const plans = events.flatMap((event) => (event.type === "plan" ? [event.video] : []));
    expect(plans.map((video) => [video.id, video.batch ?? null, video.download])).toEqual([
      ["BV1aaaaaaaa1", "videos-2026-01-02-000000", "done"],
      ["BV1bbbbbbbb1", null, "pending"],
      ["BV1cccccccc1", "videos-2026-01-02-000000", "pending"],
    ]);
    expect(plans[0]).toMatchObject({ transcribe: "done", refine: { chunks: 2, done: 0 } });
    expect(events.at(-1)).toMatchObject({
      type: "summary",
      stage: "plan",
      ok: true,
      counts: { videos: 3, downloadPending: 2, transcribePending: 2, refinePending: 2 },
    });
    expect(logs.records).toContainEqual([
      "INFO",
      "Pipeline stages: download, transcribe, refine, ingest (url_list=None)",
    ]);
  });

  test("--dry-run without a URL list counts every list's videos as the download it would do", async () => {
    sources();
    expect(await pipelineMain(["--dry-run", "--stages", "download"], captureIo().io)).toBe(0);
    expect(logs.records).toContainEqual([
      "INFO",
      `[dry-run] would download 3 URL(s) → ${sourceFolder("milky-green", "vods")}/ ` +
        "(format='bestaudio[ext=m4a]')",
    ]);
  });

  test("a dry run needs no --db-path beside LANCEDB_PATH: it writes nothing", async () => {
    sources();
    process.env.LANCEDB_PATH = join(work, "elsewhere");
    const io = captureIo();
    expect(await pipelineMain(["--dry-run", "--json", "--persona", "milky-green"], io.io)).toBe(0);
    expect(io.stdout()).toContain('"type":"plan"');
    expect(existsSync(join(work, "elsewhere"))).toBe(false);
  });

  test("a real SIGTERM while refine reads the transcripts: exit 143, the stage and the run cancelled", async () => {
    const streams = join(work, "streams");
    mkdirSync(streams);
    const [first, blocked, last] = [
      "2026-08-01-BV1aaaaaaaa1",
      "2026-08-02-BV1bbbbbbbb1",
      "2026-08-03-BV1cccccccc1",
    ];
    writeFileSync(join(streams, `${first}.md`), transcriptText(first, "2026-08-01", 1));
    writeFileSync(join(streams, `${last}.md`), transcriptText(last, "2026-08-03", 1));
    // Read second; the read blocks until the test writes it.
    const fifo = join(streams, `${blocked}.md`);
    makeFifo(fifo);
    const child = spawnCli([
      "pipeline",
      "--dry-run",
      "--stages",
      "refine",
      "--streams-dir",
      streams,
    ]);
    try {
      const release = await whenReading(fifo, child);
      child.kill("SIGTERM");
      await Bun.sleep(50);
      release(transcriptText(blocked, "2026-08-02", 1));
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(143);
      expect(stdout).toContain("\n  refine:     cancelled (");
      expect(stdout).toContain("⚠  Pipeline cancelled — re-run the same command to resume.");
      expect(stdout).not.toContain("Dry run — model:");
      expect(stderr).toContain("Stopping; send SIGTERM again to quit now.\n");
    } finally {
      child.kill("SIGKILL");
    }
  }, 20_000);

  test("another run for the persona: exit 1, or a locked setup stage under --json", async () => {
    const list = join(work, "urls.txt");
    writeFileSync(list, "");
    const lock = acquireLock(sourcesLockKey("milky-green"), "laplace-refine");
    try {
      const human = captureIo();
      expect(await pipelineMain([list, "--stages", "refine"], human.io)).toBe(1);
      expect(logs.records.at(-1)).toEqual([
        "ERROR",
        `Another laplace-refine is running for milky-green (pid ${process.pid}).`,
      ]);
      const json = captureIo();
      expect(await pipelineMain([list, "--stages", "refine", "--json"], json.io)).toBe(1);
      const events = json
        .stdout()
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as ProgressEvent);
      expect(events.map((e) => [e.type, "stage" in e ? e.stage : null])).toEqual([
        ["stage", "setup"],
        ["summary", "pipeline"],
      ]);
      expect(events[0]).toMatchObject({ status: "failed", code: "locked" });
    } finally {
      lock();
    }
  });

  test("a run without the download stage takes no URL list, and reads none", async () => {
    process.env.EIDOLON_HOME = join(work, "home");
    const lists = sourceFolder("milky-green", "lists");
    mkdirSync(lists, { recursive: true });
    const unreadable = join(lists, "mine.txt");
    writeFileSync(unreadable, "https://www.bilibili.com/video/BV1aaaaaaaa1\n");
    chmodSync(unreadable, 0o000);
    try {
      expect(await pipelineMain(["--stages", "refine"], captureIo().io)).toBe(0);
    } finally {
      chmodSync(unreadable, 0o600);
    }
    expect(logs.records).toContainEqual(["INFO", "Pipeline stages: refine (url_list=None)"]);
  });

  test("the folders default to the persona's sources in the data home", async () => {
    const list = join(work, "urls.txt");
    writeFileSync(list, "https://www.bilibili.com/video/BV1aaaaaaaa1\n");
    expect(await pipelineMain([list, "--dry-run", "--stages", "download"], captureIo().io)).toBe(0);
    expect(logs.records).toContainEqual([
      "INFO",
      `[dry-run] would download 1 URL(s) → ${sourceFolder("milky-green", "vods")}/ ` +
        "(format='bestaudio[ext=m4a]')",
    ]);
  });
});
