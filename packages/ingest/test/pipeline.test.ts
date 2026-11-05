// The pipeline library against Python's tools/pipeline.py: the summary text, the transcribe
// stage's planning and runs, the plan, and batches. fixtures/pipeline/golden.json holds Python's
// side (pipeline_helpers.ts says how it was made); Soniox, the refine provider and the embedding
// API are fakes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EmbeddingClient,
  STREAM_CHUNKS_TABLE,
  streamChunksSchema,
  writeTable,
} from "@eidolon/retrieval";
import {
  download,
  LockedError,
  type PlanVideo,
  type ProgressEvent,
  pipeline,
  SUMMARY_COUNTS,
  sourceFolder,
} from "../src/index.ts";
import { fakeSoniox, sonioxError } from "./fake_soniox.ts";
import {
  captureLogs,
  fakeEmbeddings,
  fakeRefine,
  pipelineGolden,
  sidecarText,
  sonioxJob,
  transcriptText,
  writeVods,
} from "./pipeline_helpers.ts";

let work = "";
let logs!: ReturnType<typeof captureLogs>;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "pipeline-"));
  logs = captureLogs();
  saved = {};
  for (const name of [
    "SONIOX_API_KEY",
    "TRANSCRIBE_LANGUAGE",
    "REFINE_API_KEY",
    "OPENROUTER_API_KEY",
    "EMBED_DIM",
    "YT_DLP_PATH",
  ]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.SONIOX_API_KEY = "soniox-test";
});
afterEach(() => {
  logs.stop();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(work, { recursive: true, force: true });
});

/** The options every run in this file shares: its folders, no glossary, and no waiting. */
function base(overrides: Partial<pipeline.PipelineOptions> = {}): pipeline.PipelineOptions {
  return {
    stages: ["transcribe"],
    urlList: null,
    urls: [],
    vodsDir: join(work, "vods"),
    streamsDir: join(work, "streams"),
    dbPath: join(work, "index"),
    cachePath: null,
    contextFile: null,
    ffprobe: null,
    ffmpeg: null,
    sleep: async () => {},
    retryDelaysMs: [],
    ...overrides,
  };
}

/** Python's no-date hint names its module; the port names the command that runs it. */
function portHint(message: string): string {
  return message.replace(
    /`tools\.transcribe (.*) --date YYYY-MM-DD`/,
    "`bun run laplace-transcribe $1 --date YYYY-MM-DD --persona milky-green`",
  );
}

describe("pipelineSummaryText", () => {
  test("prints print_pipeline_summary's text for each golden summary", () => {
    for (const golden of pipelineGolden.summaries) {
      const download: download.DownloadReport | null = golden.download
        ? {
            requestedUrls: golden.download[0],
            succeededUrls: golden.download[1],
            failedUrls: Array.from({ length: golden.download[2] }, (_, i) => ({
              url: `u${i}`,
              error: `exit=1: e${i}`,
            })),
            newFiles: Array.from({ length: golden.download[3] }, (_, i) => `vods/n${i}.m4a`),
            durationSec: golden.download[4],
            cancelled: false,
            error: null,
          }
        : null;
      const t = golden.transcribe;
      const transcribe: pipeline.TranscribeStageReport | null = t
        ? {
            total: t[0],
            skipped: t[1],
            skippedNoDate: t[2],
            succeeded: t[3],
            noSpeech: 0,
            failed: t[4].map((audio) => ({ audio, error: "exit=1" })),
            durationSec: t[5],
            cancelled: false,
            cost: null,
          }
        : null;
      const stage = (result?: [number, number]): pipeline.StageResult | null =>
        result ? { rc: result[0], durationSec: result[1], cancelled: false, cost: null } : null;
      const refine = stage(golden.refine);
      const ingest = stage(golden.ingest);
      const aborted = golden.aborted ?? false;
      const ok =
        !aborted &&
        (download?.failedUrls.length ?? 0) === 0 &&
        (transcribe?.failed.length ?? 0) === 0 &&
        (refine?.rc ?? 0) === 0 &&
        (ingest?.rc ?? 0) === 0;
      const report: pipeline.PipelineReport = {
        stages: golden.stages as pipeline.PipelineStage[],
        download,
        transcribe,
        refine,
        ingest,
        durationSec: golden.duration,
        aborted,
        cancelled: false,
        ok,
        batchDone: null,
      };
      expect(pipeline.pipelineSummaryText(report, golden.vods_dir)).toBe(golden.text);
    }
  });

  test("adds what Python had no line for: no speech, a cancelled stage, a missing yt-dlp", () => {
    const report: pipeline.PipelineReport = {
      stages: ["download", "transcribe", "refine", "ingest"],
      download: {
        ...download.emptyDownloadReport(2),
        durationSec: 0.04,
        error: "yt-dlp isn't installed",
      },
      transcribe: {
        total: 4,
        skipped: 1,
        skippedNoDate: 0,
        succeeded: 1,
        noSpeech: 1,
        failed: [],
        durationSec: 2,
        cancelled: true,
        cost: null,
      },
      refine: { rc: 1, durationSec: 0.25, cancelled: true, cost: null },
      ingest: null,
      durationSec: 3,
      aborted: false,
      cancelled: true,
      ok: false,
      batchDone: null,
    };
    expect(pipeline.pipelineSummaryText(report, "vods")).toBe(
      [
        "",
        "=".repeat(64),
        "Pipeline Summary",
        "=".repeat(64),
        "Stages run: download, transcribe, refine, ingest",
        "Duration:   3.0s",
        "",
        "  download:   0/2 URLs ok, 0 failed, 0 new files (0.0s)  ⚠ yt-dlp couldn't run; see the error above",
        "  transcribe: 1 new, 1 no speech, 1 already done, 0 no-date, 0 failed of 4 audio files in vods/ (2.0s)  ⚠ cancelled",
        "  refine:     cancelled (0.2s)",
        "",
        "⚠  Pipeline cancelled — re-run the same command to resume.",
        "=".repeat(64),
        "",
      ].join("\n"),
    );
  });
});

/** The golden's vods folder: every kind of audio and info.json the planning has to read. */
function goldenVods(): void {
  writeVods(join(work, "vods"), pipelineGolden.plan.vods);
  mkdirSync(join(work, "vods", "sub.m4a"));
  mkdirSync(join(work, "streams"));
  for (const name of pipelineGolden.plan.streams) {
    writeFileSync(join(work, "streams", name), "---\nstream_id: x\n---\n\n## 00:00 — a\n\nb\n");
  }
}

function placehold(records: readonly [string, string][]): [string, string][] {
  return records.map(([level, message]) => [level, message.replaceAll(work, "<WORK>")]);
}

describe("the transcribe stage", () => {
  test("a dry run plans every audio file as _plan_transcribe_jobs does, and writes nothing", async () => {
    goldenVods();
    rmSync(join(work, "streams"), { recursive: true });
    mkdirSync(join(work, "streams"));
    for (const name of pipelineGolden.plan.streams) {
      writeFileSync(join(work, "streams", name), "x");
    }
    const events: ProgressEvent[] = [];
    const report = await pipeline.runPipeline(
      base({ dryRun: true, onProgress: (event) => events.push(event) }),
    );
    const expected = pipelineGolden.plan.logs.map(([level, message]) => [level, portHint(message)]);
    expect(placehold(logs.records)).toEqual(expected as [string, string][]);
    const t = report.transcribe as pipeline.TranscribeStageReport;
    const counts = pipelineGolden.plan.counts;
    expect([t.total, t.skipped, t.skippedNoDate, t.succeeded, t.failed.length]).toEqual([
      counts.total,
      counts.skipped,
      counts.skipped_no_date,
      counts.succeeded,
      counts.failed,
    ]);
    expect(report.ok).toBe(true);
    const summary = events.find((e) => e.type === "summary" && e.stage === "transcribe");
    expect(summary).toMatchObject({
      ok: true,
      counts: { total: 13, skipped: 1, skippedNoDate: 5, succeeded: 0, failed: 0, noSpeech: 0 },
    });
    const skipped = events.filter((e) => e.type === "item" && e.status === "skipped");
    expect(skipped.map((e) => (e.type === "item" ? [e.item, e.code ?? null] : null))).toEqual([
      ["BV1aaaaaaaa1_p2.m4a", null],
      ["BV1bbbbbbbb1.m4a", "no-upload-date"],
      ["BV1ccccccccc.mp3", "no-upload-date"],
      ["BV1eeeeeeee1.webm", "no-upload-date"],
      ["BV1ffffffff1.m4a", "no-upload-date"],
      ["BV1iiiiiiii1.wav", "no-upload-date"],
    ]);
  });

  test("a dry run creates no streams folder, where Python made one", async () => {
    writeVods(join(work, "vods"), { "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}' });
    await pipeline.runPipeline(base({ dryRun: true }));
    expect(existsSync(join(work, "streams"))).toBe(false);
  });

  test("no audio: Python's warning, and the stage is skipped, not failed", async () => {
    const events: ProgressEvent[] = [];
    const report = await pipeline.runPipeline(
      base({
        vodsDir: join(work, "empty"),
        streamsDir: join(work, "never"),
        onProgress: (event) => events.push(event),
      }),
    );
    expect(placehold(logs.records)).toEqual(pipelineGolden.plan.empty_logs);
    expect(existsSync(join(work, "never"))).toBe(pipelineGolden.plan.never_created === false);
    expect(report.ok).toBe(true);
    expect(events.slice(0, 1)).toEqual([{ type: "stage", stage: "transcribe", status: "skipped" }]);
  });

  test("runs the jobs Python planned, in its order and with its labels", async () => {
    goldenVods();
    const soniox = fakeSoniox(Array.from({ length: 7 }, (_, i) => sonioxJob(i + 1)));
    const report = await pipeline.runPipeline(base({ fetch: soniox.fetch }));
    const started = logs.records
      .filter(([, message]) => / transcribing /.test(message))
      .map(([, message]) => message);
    expect(started).toEqual(
      pipelineGolden.plan.jobs.map(
        ([label, name, date]) => `${label} transcribing ${name} (date=${date}, provider=soniox)`,
      ),
    );
    const t = report.transcribe as pipeline.TranscribeStageReport;
    expect([t.succeeded, t.skipped, t.skippedNoDate, t.failed.length]).toEqual([7, 1, 5, 0]);
    expect(existsSync(join(work, "streams", "2026-08-14-BV1aaaaaaaa1_p1.md"))).toBe(true);
    expect(t.cost?.source).toBe("estimated");
  });

  test("a failed file is recorded and the rest still run; --abort-on-error stops the rest", async () => {
    writeVods(join(work, "vods"), {
      "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}',
      "BV1aaaaaaaa2.m4a": '{"upload_date": "20260802"}',
      "BV1aaaaaaaa3.m4a": '{"upload_date": "20260803"}',
    });
    const failFirst = (request: { method: string; path: string; json?: string }) =>
      request.method === "POST" &&
      request.path === "/transcriptions" &&
      request.json?.includes("BV1aaaaaaaa1")
        ? sonioxError(400, "invalid_request", "bad audio")
        : undefined;
    const soniox = fakeSoniox([1, 2, 3].map(sonioxJob), failFirst);
    const report = await pipeline.runPipeline(base({ fetch: soniox.fetch }));
    const t = report.transcribe as pipeline.TranscribeStageReport;
    expect([t.succeeded, t.failed.length]).toEqual([2, 1]);
    expect(t.failed[0]?.audio).toEndWith("BV1aaaaaaaa1.m4a");
    expect(logs.records).toContainEqual([
      "ERROR",
      "  ✗ transcribe failed: bad audio (HTTP 400, invalid_request)",
    ]);
    expect(report.ok).toBe(false);

    rmSync(join(work, "streams"), { recursive: true });
    const again = fakeSoniox([1, 2, 3].map(sonioxJob), failFirst);
    const aborted = await pipeline.runPipeline(
      base({ fetch: again.fetch, abortOnError: true, stages: ["transcribe", "refine"] }),
    );
    expect(aborted.aborted).toBe(true);
    expect(aborted.refine).toBeNull();
    expect(again.requests.filter((r) => r.path === "/files" && r.method === "POST")).toHaveLength(
      1,
    );
  });

  test("in parallel, --abort-on-error lets the running job finish and starts no other", async () => {
    writeVods(join(work, "vods"), {
      "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}',
      "BV1aaaaaaaa2.m4a": '{"upload_date": "20260802"}',
      "BV1aaaaaaaa3.m4a": '{"upload_date": "20260803"}',
      "BV1aaaaaaaa4.m4a": '{"upload_date": "20260804"}',
    });
    const soniox = fakeSoniox([1, 2, 3, 4].map(sonioxJob), (request) =>
      request.method === "POST" &&
      request.path === "/transcriptions" &&
      request.json?.includes("BV1aaaaaaaa1")
        ? sonioxError(400, "invalid_request", "bad audio")
        : undefined,
    );
    const report = await pipeline.runPipeline(
      base({ fetch: soniox.fetch, transcribeConcurrency: 2, abortOnError: true }),
    );
    const t = report.transcribe as pipeline.TranscribeStageReport;
    expect([t.succeeded, t.failed.length]).toEqual([1, 1]);
    expect(soniox.requests.filter((r) => r.path === "/files" && r.method === "POST")).toHaveLength(
      2,
    );
    const messages = logs.records.map(([, message]) => message);
    expect(messages).toContain("Running 4 transcribe job(s) in parallel (concurrency=2)");
    expect(messages).toContain(
      "  ✗ BV1aaaaaaaa1.m4a: transcribe failed: bad audio (HTTP 400, invalid_request)",
    );
    expect(messages).toContain(
      "  abort_on_error: cancelling pending transcribes (in-flight ones will finish naturally)",
    );
    expect(messages).toContain("  ✓ BV1aaaaaaaa2.m4a");
    expect(report.aborted).toBe(true);
  });

  test("a cancel stops the job in flight, starts no other, and ends the run cancelled", async () => {
    writeVods(join(work, "vods"), {
      "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}',
      "BV1aaaaaaaa2.m4a": '{"upload_date": "20260802"}',
      "BV1aaaaaaaa3.m4a": '{"upload_date": "20260803"}',
    });
    const controller = new AbortController();
    let uploads = 0;
    const soniox = fakeSoniox([1, 2, 3].map(sonioxJob), (request) => {
      if (request.path !== "/files" || request.method !== "POST") return undefined;
      uploads++;
      if (uploads < 2) return undefined;
      controller.abort(new DOMException("Interrupted by SIGINT", "AbortError"));
      return "hang";
    });
    const events: ProgressEvent[] = [];
    const report = await pipeline.runPipeline(
      base({
        fetch: soniox.fetch,
        signal: controller.signal,
        stages: ["transcribe", "refine"],
        onProgress: (event) => events.push(event),
      }),
    );
    expect(report.cancelled).toBe(true);
    expect(report.refine).toBeNull();
    const t = report.transcribe as pipeline.TranscribeStageReport;
    expect([t.succeeded, t.failed.length, t.cancelled]).toEqual([1, 0, true]);
    expect(uploads).toBe(2);
    const last = events.at(-1) as Extract<ProgressEvent, { type: "summary" }>;
    expect(last).toMatchObject({ type: "summary", stage: "pipeline", cancelled: true });
    expect(Object.keys(last.counts)).toEqual([...SUMMARY_COUNTS.pipeline]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "item", item: "BV1aaaaaaaa2.m4a", status: "cancelled" }),
    );
    expect(pipeline.pipelineSummaryText(report, "vods")).toContain(
      "⚠  Pipeline cancelled — re-run the same command to resume.",
    );
  });

  test("a cancel while refine reads the transcripts ends its stage, and the run, cancelled", async () => {
    mkdirSync(join(work, "streams"));
    const id = "2026-08-01-BV1aaaaaaaa1";
    writeFileSync(join(work, "streams", `${id}.md`), transcriptText(id, "2026-08-01", 1));
    const controller = new AbortController();
    controller.abort(new DOMException("Interrupted by SIGTERM", "AbortError"));
    for (const dryRun of [true, false]) {
      const events: ProgressEvent[] = [];
      const printed: string[] = [];
      const report = await pipeline.runPipeline(
        base({
          stages: ["refine"],
          dryRun,
          signal: controller.signal,
          onProgress: (event) => events.push(event),
          print: (text) => printed.push(text),
        }),
      );
      expect([dryRun, report.refine?.cancelled, report.cancelled]).toEqual([dryRun, true, true]);
      expect(events).toEqual([
        { type: "stage", stage: "refine", status: "cancelled" },
        {
          type: "summary",
          stage: "refine",
          ok: false,
          cancelled: true,
          counts: {
            streams: 0,
            chunksNew: 0,
            chunksSkipped: 0,
            chunksFailed: 0,
            tokensIn: 0,
            tokensOut: 0,
          },
          durationSec: expect.any(Number),
        },
        expect.objectContaining({ type: "summary", stage: "pipeline", cancelled: true }),
      ]);
      expect(printed).toEqual([]);
      expect(pipeline.pipelineSummaryText(report, "vods")).toContain("  refine:     cancelled (");
    }
  });

  test("a key Soniox rejects fails every file, and the stage, with code auth-failed", async () => {
    writeVods(join(work, "vods"), {
      "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}',
      "BV1aaaaaaaa2.m4a": '{"upload_date": "20260802"}',
    });
    const rejected = fakeSoniox([1, 2].map(sonioxJob), () =>
      sonioxError(401, "unauthenticated", "Invalid API key"),
    );
    const events: ProgressEvent[] = [];
    const report = await pipeline.runPipeline(
      base({ fetch: rejected.fetch, onProgress: (event) => events.push(event) }),
    );
    expect(report.transcribe?.failed).toHaveLength(2);
    const failed = events.filter((e) => e.type === "item" && e.status === "failed");
    expect(failed).toHaveLength(2);
    for (const event of failed) {
      expect(event).toMatchObject({ code: "auth-failed", provider: "soniox" });
    }
    expect(events.find((e) => e.type === "stage" && e.status === "failed")).toMatchObject({
      stage: "transcribe",
      code: "auth-failed",
      provider: "soniox",
    });
  });

  test("audio over Soniox's cap without ffmpeg fails with code ffmpeg-unavailable", async () => {
    writeVods(join(work, "vods"), {
      "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801", "duration": 20000}',
    });
    const soniox = fakeSoniox([sonioxJob(1)]);
    const events: ProgressEvent[] = [];
    const report = await pipeline.runPipeline(
      base({ fetch: soniox.fetch, ffmpeg: null, onProgress: (event) => events.push(event) }),
    );
    expect(report.transcribe?.failed).toHaveLength(1);
    expect(soniox.requests).toEqual([]);
    expect(events.find((e) => e.type === "item" && e.status === "failed")).toMatchObject({
      code: "ffmpeg-unavailable",
    });
    expect(events.find((e) => e.type === "stage" && e.status === "failed")).toMatchObject({
      code: "ffmpeg-unavailable",
    });
  });

  test("the language hint is transcription.language's, else zh", async () => {
    writeVods(join(work, "vods"), { "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}' });
    process.env.TRANSCRIBE_LANGUAGE = "ja";
    try {
      const soniox = fakeSoniox([sonioxJob(1)]);
      await pipeline.runPipeline(base({ fetch: soniox.fetch }));
      const created = soniox.requests.find((r) => r.path === "/transcriptions");
      expect(JSON.parse(created?.json as string).language_hints).toEqual(["ja"]);
    } finally {
      delete process.env.TRANSCRIBE_LANGUAGE;
    }
  });

  test("without SONIOX_API_KEY each file fails once, with code missing-credential", async () => {
    writeVods(join(work, "vods"), {
      "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}',
      "BV1aaaaaaaa2.m4a": '{"upload_date": "20260802"}',
    });
    delete process.env.SONIOX_API_KEY;
    const events: ProgressEvent[] = [];
    const report = await pipeline.runPipeline(base({ onProgress: (event) => events.push(event) }));
    expect((report.transcribe as pipeline.TranscribeStageReport).failed).toHaveLength(2);
    const failed = events.filter((e) => e.type === "item" && e.status === "failed");
    expect(failed.map((e) => (e.type === "item" ? e.code : null))).toEqual([
      "missing-credential",
      "missing-credential",
    ]);
    expect(logs.records.filter(([level]) => level === "ERROR")).toHaveLength(1);
  });

  test("a payload that records no speech counts as done, as transcribe's skip rule says", async () => {
    writeVods(join(work, "vods"), { "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}' });
    mkdirSync(join(work, "streams"));
    writeFileSync(
      join(work, "streams", "2026-08-01-BV1aaaaaaaa1.soniox.json"),
      JSON.stringify({ provider: "soniox", transcript: { id: "t", text: "", tokens: [] } }),
    );
    const report = await pipeline.runPipeline(base());
    expect(report.transcribe?.skipped).toBe(1);
    expect(logs.records).toContainEqual([
      "INFO",
      "[1/1] BV1aaaaaaaa1.m4a: already transcribed, no speech → 2026-08-01-BV1aaaaaaaa1.soniox.json",
    ]);
  });

  test("audio Soniox hears nothing in is no speech: no transcript, and not a failure", async () => {
    writeVods(join(work, "vods"), { "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}' });
    const job = sonioxJob(1);
    const silent = { ...job, transcript: { ...job.transcript, text: "", tokens: [] } };
    const report = await pipeline.runPipeline(base({ fetch: fakeSoniox([silent]).fetch }));
    const t = report.transcribe as pipeline.TranscribeStageReport;
    expect([t.succeeded, t.noSpeech, t.failed.length]).toEqual([0, 1, 0]);
    expect(report.ok).toBe(true);
    expect(existsSync(join(work, "streams", "2026-08-01-BV1aaaaaaaa1.md"))).toBe(false);
  });

  test("an info.json that isn't UTF-8 fails its file, where it crashed Python's run", async () => {
    writeVods(join(work, "vods"), {
      "._BV1aaaaaaaa1.m4a": null,
      "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}',
    });
    writeFileSync(join(work, "vods", "._BV1aaaaaaaa1.info.json"), Buffer.from([0, 5, 0x96, 0xff]));
    const report = await pipeline.runPipeline(base({ dryRun: true }));
    const t = report.transcribe as pipeline.TranscribeStageReport;
    expect(t.failed.map((f) => f.audio)).toEqual([join(work, "vods", "._BV1aaaaaaaa1.m4a")]);
    expect(t.failed[0]?.error).toStartWith("can't read ._BV1aaaaaaaa1.info.json: ");
    expect(logs.records).toContainEqual([
      "INFO",
      "[2/2] [dry-run] would transcribe BV1aaaaaaaa1.m4a (date=2026-08-01) → 2026-08-01-BV1aaaaaaaa1.md",
    ]);
  });
});

describe("refine and ingest", () => {
  function streams(files: Readonly<Record<string, string>>): void {
    mkdirSync(join(work, "streams"), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(work, "streams", name), text);
    }
  }

  test("refine runs in this process, logging the command a user would run for it", async () => {
    streams({
      "2026-08-01-BV1aaaaaaaa1.md": transcriptText("2026-08-01-BV1aaaaaaaa1", "2026-08-01", 2),
    });
    process.env.REFINE_API_KEY = "refine-test";
    const provider = fakeRefine();
    const printed: string[] = [];
    const report = await pipeline.runPipeline(
      base({
        stages: ["refine"],
        refineModel: "m",
        refineConcurrency: 3,
        refineForce: true,
        fetch: provider.fetch,
        print: (text) => printed.push(text),
      }),
    );
    expect(logs.records[0]).toEqual([
      "INFO",
      `Refining: laplace-refine --streams-dir ${join(work, "streams")} --model m --concurrency 3 --force`,
    ]);
    expect(report.refine?.rc).toBe(0);
    expect(provider.calls()).toBe(4);
    expect(printed.join("")).toContain("Refinement Summary");
    expect(report.refine?.cost).toEqual({ usd: 0.004, source: "reported" });
  });

  test("refine without an API key fails the stage with Python's message", async () => {
    streams({
      "2026-08-01-BV1aaaaaaaa1.md": transcriptText("2026-08-01-BV1aaaaaaaa1", "2026-08-01", 1),
    });
    const events: ProgressEvent[] = [];
    const report = await pipeline.runPipeline(
      base({ stages: ["refine"], onProgress: (event) => events.push(event) }),
    );
    expect(report.refine?.rc).toBe(1);
    expect(events[0]).toMatchObject({
      type: "stage",
      stage: "refine",
      status: "failed",
      code: "missing-credential",
    });
  });

  test("ingest rebuilds the table and then the catalog, under the index lock", async () => {
    streams({
      "2026-08-01-BV1aaaaaaaa1.md": transcriptText("2026-08-01-BV1aaaaaaaa1", "2026-08-01", 2),
      "2026-08-01-BV1aaaaaaaa1.refined.json": sidecarText("2026-08-01-BV1aaaaaaaa1", 2),
    });
    process.env.EMBED_DIM = "8";
    const held: string[] = [];
    const events: ProgressEvent[] = [];
    const report = await pipeline.runPipeline(
      base({
        stages: ["ingest"],
        skipTypes: "",
        embeddingClient: fakeEmbeddings(),
        holdIndex: () => {
          held.push("taken");
          return () => held.push("released");
        },
        onProgress: (event) => events.push(event),
      }),
    );
    expect(report.ingest?.rc).toBe(0);
    expect(held).toEqual(["taken", "released"]);
    expect(logs.records[0]).toEqual([
      "INFO",
      `Ingesting: laplace-ingest-streams --streams-dir ${join(work, "streams")} --skip-types `,
    ]);
    const catalog = JSON.parse(readFileSync(join(work, "index", "stream_catalog.json"), "utf8"));
    expect(catalog.broadcasts[0].source_paths).toEqual(["streams/2026-08-01-BV1aaaaaaaa1.md"]);
    const stages = events.filter((e) => e.type === "summary").map((e) => e.stage);
    expect(stages).toEqual(["ingest-streams", "catalog", "pipeline"]);
  });

  test("an embedding key the provider rejects fails the ingest with code auth-failed", async () => {
    streams({
      "2026-08-01-BV1aaaaaaaa1.md": transcriptText("2026-08-01-BV1aaaaaaaa1", "2026-08-01", 1),
    });
    process.env.EMBED_DIM = "8";
    const rejected = new EmbeddingClient({
      baseUrl: "https://x.invalid/v1",
      apiKey: "k",
      fetch: (async () =>
        Response.json(
          { error: { message: "User not found.", code: 401 } },
          { status: 401 },
        )) as unknown as typeof fetch,
      maxRetries: 0,
    });
    const events: ProgressEvent[] = [];
    const report = await pipeline.runPipeline(
      base({
        stages: ["ingest"],
        embeddingClient: rejected,
        onProgress: (event) => events.push(event),
      }),
    );
    expect(report.ingest?.rc).toBe(1);
    expect(events.find((e) => e.type === "stage" && e.status === "failed")).toMatchObject({
      stage: "ingest-streams",
      code: "auth-failed",
      provider: "embeddings",
    });
    // No catalog after a failed ingest.
    expect(events.some((e) => e.type === "stage" && e.stage === "catalog")).toBe(false);
  });

  test("the ingest records its sources, so the plan sees a transcript refined since", async () => {
    const id = "2026-08-01-BV1aaaaaaaa1";
    writeVods(join(work, "vods"), { "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}' });
    streams({
      [`${id}.md`]: transcriptText(id, "2026-08-01", 2),
      [`${id}.refined.json`]: sidecarText(id, 2),
    });
    process.env.EMBED_DIM = "8";
    const report = await pipeline.runPipeline(
      base({ stages: ["ingest"], skipTypes: "", embeddingClient: fakeEmbeddings() }),
    );
    expect(report.ingest?.rc).toBe(0);
    const meta = JSON.parse(readFileSync(join(work, "index", "stream_chunks.meta.json"), "utf8"));
    expect(meta.sources).toEqual(
      [`${id}.md`, `${id}.refined.json`].map((name) => {
        const stat = statSync(join(work, "streams", name));
        return { name, size: stat.size, mtime: stat.mtime.toISOString() };
      }),
    );
    // The build record decides, not the catalog.
    rmSync(join(work, "index", "stream_catalog.json"));
    const indexed = async () =>
      (
        await pipeline.planPipeline("milky-green", {
          vodsDir: join(work, "vods"),
          streamsDir: join(work, "streams"),
          listsDir: join(work, "lists"),
          dbPath: join(work, "index"),
        })
      ).videos.map((video) => [video.id, video.indexed]);
    expect(await indexed()).toEqual([["BV1aaaaaaaa1", true]]);
    utimesSync(
      join(work, "streams", `${id}.refined.json`),
      new Date(),
      new Date(Date.now() + 60_000),
    );
    expect(await indexed()).toEqual([["BV1aaaaaaaa1", false]]);
  });

  test("a held index lock fails the ingest stage with code locked", async () => {
    const events: ProgressEvent[] = [];
    const report = await pipeline.runPipeline(
      base({
        stages: ["ingest"],
        holdIndex: () => {
          throw new LockedError("laplace-ingest-facts", "x", 7);
        },
        onProgress: (event) => events.push(event),
      }),
    );
    expect(report.ingest?.rc).toBe(1);
    expect(events[0]).toMatchObject({ stage: "ingest-streams", status: "failed", code: "locked" });
  });

  test("a dry run takes no lock and builds no catalog", async () => {
    streams({
      "2026-08-01-BV1aaaaaaaa1.md": transcriptText("2026-08-01-BV1aaaaaaaa1", "2026-08-01", 1),
    });
    const report = await pipeline.runPipeline(
      base({
        stages: ["ingest"],
        dryRun: true,
        holdIndex: () => {
          throw new Error("a dry run took the lock");
        },
      }),
    );
    expect(report.ingest?.rc).toBe(0);
    expect(existsSync(join(work, "index"))).toBe(false);
  });
});

describe("a run over a batch", () => {
  function batchSetup(): { lists: string; batch: string } {
    const lists = join(work, "lists");
    const batch = download.writeBatch(
      lists,
      ["BV1aaaaaaaa1"],
      ["Captured: x"],
      new Date(2026, 0, 2, 3, 4, 5),
    );
    writeVods(join(work, "vods"), {
      "BV1aaaaaaaa1_p1.m4a": '{"upload_date": "20260801", "n_entries": 2}',
      "BV1aaaaaaaa1_p2.m4a": '{"upload_date": "20260801", "n_entries": 2}',
    });
    mkdirSync(join(work, "streams"));
    for (const part of ["p1", "p2"]) {
      const id = `2026-08-01-BV1aaaaaaaa1_${part}`;
      writeFileSync(join(work, "streams", `${id}.md`), transcriptText(id, "2026-08-01", 1));
      writeFileSync(join(work, "streams", `${id}.refined.json`), sidecarText(id, 1));
    }
    return { lists, batch };
  }

  async function runOver(
    batch: string,
    lists: string,
    overrides: Partial<pipeline.PipelineOptions> = {},
  ): Promise<pipeline.PipelineReport> {
    process.env.REFINE_API_KEY = "refine-test";
    process.env.EMBED_DIM = "8";
    const yt = join(work, "yt-dlp");
    writeFileSync(yt, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return pipeline.runPipeline(
      base({
        stages: [...pipeline.ALL_STAGES],
        urlList: batch,
        urls: download.readUrlList(batch),
        listsDir: lists,
        ytDlp: { path: yt, source: "setting" },
        embeddingClient: fakeEmbeddings(),
        now: () => new Date("2026-01-02T03:04:05Z"),
        ...overrides,
      }),
    );
  }

  test("a clean run over all four stages marks the batch done", async () => {
    const { lists, batch } = batchSetup();
    const report = await runOver(batch, lists);
    expect(report.ok).toBe(true);
    const done = join(lists, "batches", "videos-2026-01-02-030405.done.json");
    expect(report.batchDone).toBe(done);
    expect(JSON.parse(readFileSync(done, "utf8"))).toEqual({
      finishedAt: "2026-01-02T03:04:05.000Z",
      ids: ["BV1aaaaaaaa1"],
      parts: ["BV1aaaaaaaa1_p1", "BV1aaaaaaaa1_p2"],
      exitCode: 0,
    });
    expect(download.pendingBatches(lists)).toEqual([]);
  });

  test("no mark for some stages, a dry run, a part without a date, or a missing part", async () => {
    const { lists, batch } = batchSetup();
    expect((await runOver(batch, lists, { stages: ["download", "transcribe"] })).batchDone).toBe(
      null,
    );
    expect((await runOver(batch, lists, { dryRun: true })).batchDone).toBe(null);
    writeFileSync(join(work, "vods", "BV1aaaaaaaa1_p2.info.json"), '{"n_entries": 3}');
    expect((await runOver(batch, lists)).batchDone).toBe(null);
    writeFileSync(
      join(work, "vods", "BV1aaaaaaaa1_p2.info.json"),
      '{"upload_date": "20260801", "n_entries": 3}',
    );
    const missingPart = await runOver(batch, lists);
    expect([missingPart.ok, missingPart.batchDone]).toEqual([true, null]);
    expect(download.pendingBatches(lists)).toEqual([batch]);
  });

  test("a list that isn't one of the persona's batches is never marked", async () => {
    const { lists, batch } = batchSetup();
    const copy = join(work, "copy.txt");
    writeFileSync(copy, readFileSync(batch));
    expect((await runOver(copy, lists)).batchDone).toBe(null);
    expect(existsSync(join(work, "copy.done.json"))).toBe(false);
  });
});

/** A file as the build record lists it. */
function sourceRecord(path: string): { name: string; size: number; mtime: string } {
  const stat = statSync(path);
  return {
    name: path.slice(path.lastIndexOf("/") + 1),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

/** A one-row stream_chunks table in `dbPath`; the plan reads only that it exists. */
async function chunksTable(dbPath: string): Promise<void> {
  const schema = streamChunksSchema(2);
  const row = Object.fromEntries(schema.fields.map((field) => [field.name, null]));
  await writeTable(dbPath, STREAM_CHUNKS_TABLE, [row], schema, new Float32Array(2));
}

describe("planPipeline", () => {
  const lists = () => join(work, "lists");

  function plannedById(plan: pipeline.Plan): Map<string, PlanVideo> {
    return new Map(plan.videos.map((video) => [video.id, video]));
  }

  test("every video of every list, by part, with each stage's state", async () => {
    mkdirSync(join(lists(), "batches"), { recursive: true });
    writeFileSync(
      join(lists(), "video-full.txt"),
      [
        "https://www.bilibili.com/video/BV1aaaaaaaa1",
        "https://www.bilibili.com/video/BV1bbbbbbbb1/",
        "BV1cccccccc1",
        "https://www.youtube.com/watch?v=yt1",
        "https://www.bilibili.com/video/BV1dddddddd1",
        "",
      ].join("\n"),
    );
    download.writeBatch(lists(), ["BV1eeeeeeee1", "BV1aaaaaaaa1"], ["x"], new Date(2026, 0, 2));
    writeVods(join(work, "vods"), {
      "BV1aaaaaaaa1_p1.m4a":
        '{"upload_date": "20260801", "n_entries": 3, "title": "a p1", "duration": 7200.5}',
      "BV1aaaaaaaa1_p2.m4a": '{"upload_date": "20260801", "n_entries": 3}',
      "BV1cccccccc1.m4a": '{"upload_date": "20260803", "duration": 600}',
      "yt1.webm":
        '{"upload_date": "20260804", "webpage_url": "https://www.youtube.com/watch?v=yt1"}',
      "BV1dddddddd1.m4a": null,
      "BV1fffffffff.m4a": '{"upload_date": "20260806", "duration": 900}',
    });
    mkdirSync(join(work, "streams"));
    const md = (id: string, scenes: number) =>
      writeFileSync(join(work, "streams", `${id}.md`), transcriptText(id, id.slice(0, 10), scenes));
    md("2026-08-01-BV1aaaaaaaa1_p1", 3);
    writeFileSync(
      join(work, "streams", "2026-08-01-BV1aaaaaaaa1_p1.refined.json"),
      sidecarText("2026-08-01-BV1aaaaaaaa1_p1", 2),
    );
    md("2026-08-01-BV1aaaaaaaa1_p2", 1);
    md("2026-07-01-BV1dddddddd1", 1);
    md("2026-07-02-BV1gggggggg1", 2);
    writeFileSync(
      join(work, "streams", "2026-08-03-BV1cccccccc1.soniox.json"),
      JSON.stringify({ provider: "soniox", transcript: { id: "t", text: "", tokens: [] } }),
    );
    const events: ProgressEvent[] = [];
    const plan = await pipeline.planPipeline("milky-green", {
      vodsDir: join(work, "vods"),
      streamsDir: join(work, "streams"),
      listsDir: lists(),
      dbPath: null,
      transcribeModel: "stt-async-v5",
      refineModel: "~google/gemini-flash-latest",
      onProgress: (event) => events.push(event),
    });
    expect(plan.videos.map((video) => video.id)).toEqual([
      "BV1aaaaaaaa1_p1",
      "BV1aaaaaaaa1_p2",
      "BV1aaaaaaaa1_p3",
      "BV1bbbbbbbb1",
      "BV1cccccccc1",
      "yt1",
      "BV1dddddddd1",
      "BV1eeeeeeee1",
      "BV1fffffffff",
      "BV1gggggggg1",
    ]);
    expect(events.map((event) => (event.type === "plan" ? event.video : null))).toEqual(
      plan.videos as PlanVideo[],
    );
    const byId = plannedById(plan);
    expect(byId.get("BV1aaaaaaaa1_p1")).toMatchObject({
      url: "https://www.bilibili.com/video/BV1aaaaaaaa1",
      batch: "videos-2026-01-02-000000",
      title: "a p1",
      uploadDate: "2026-08-01",
      durationSec: 7200.5,
      download: "done",
      transcribe: "done",
      refine: { chunks: 3, done: 2 },
      indexed: false,
      estimate: { transcribeUsd: 0, basis: "price-table" },
    });
    expect(byId.get("BV1aaaaaaaa1_p1")?.estimate.refineUsd).toBeGreaterThan(0);
    expect(byId.get("BV1aaaaaaaa1_p3")).toMatchObject({
      download: "pending",
      transcribe: "pending",
      refine: null,
      estimate: { basis: "unpriced" },
    });
    expect(byId.get("BV1bbbbbbbb1")).toMatchObject({
      url: "https://www.bilibili.com/video/BV1bbbbbbbb1/",
      download: "pending",
    });
    // Nothing to index, so not indexed, and never counted as left to index.
    expect(byId.get("BV1cccccccc1")).toMatchObject({
      url: "BV1cccccccc1",
      transcribe: "no-speech",
      refine: null,
      indexed: false,
      estimate: { transcribeUsd: 0, refineUsd: 0, basis: "price-table" },
    });
    expect(byId.get("yt1")).toMatchObject({
      url: "https://www.youtube.com/watch?v=yt1",
      download: "done",
      transcribe: "pending",
    });
    expect(byId.get("BV1dddddddd1")).toMatchObject({
      download: "done",
      transcribe: "no-date",
      refine: { chunks: 1, done: 0 },
    });
    expect(byId.get("BV1eeeeeeee1")).toMatchObject({
      batch: "videos-2026-01-02-000000",
      download: "pending",
    });
    const unlisted = byId.get("BV1fffffffff") as PlanVideo;
    expect(unlisted).toMatchObject({ uploadDate: "2026-08-06", transcribe: "pending" });
    expect(unlisted.url).toBeUndefined();
    expect(unlisted.estimate.transcribeUsd).toBeCloseTo((900 / 3600) * 0.1, 12);
    // 900 s is three scenes at most, priced by the flash model's table.
    expect(unlisted.estimate.basis).toBe("price-table");
    expect(byId.get("BV1gggggggg1")).toMatchObject({
      download: "pending",
      transcribe: "done",
      refine: { chunks: 2, done: 0 },
    });

    const summary = pipeline.planSummaryEvent(plan, 1.5);
    expect(summary).toMatchObject({
      stage: "plan",
      counts: {
        videos: 10,
        downloadPending: 4,
        transcribePending: 5,
        noDate: 1,
        refinePending: 1 + 1 + 1 + 2,
        unindexed: 9,
      },
      costSource: "unpriced",
    });
    expect(Object.keys(summary.counts)).toEqual([...SUMMARY_COUNTS.plan]);
  });

  test("a URL list plans its own videos and every audio file, a batch named by its id", async () => {
    const batch = download.writeBatch(lists(), ["BV1aaaaaaaa1"], ["x"], new Date(2026, 0, 2));
    writeVods(join(work, "vods"), { "BV1bbbbbbbb1.m4a": '{"upload_date": "20260802"}' });
    const plan = await pipeline.planPipeline("milky-green", {
      urlList: batch,
      vodsDir: join(work, "vods"),
      streamsDir: join(work, "streams"),
      listsDir: lists(),
      dbPath: null,
    });
    expect(plan.videos.map((video) => [video.id, video.batch ?? null])).toEqual([
      ["BV1aaaaaaaa1", "videos-2026-01-02-000000"],
      ["BV1bbbbbbbb1", null],
    ]);
  });

  test("indexed: the build record's files as they are now, else the catalog's stream ids", async () => {
    const id = "2026-08-01-BV1aaaaaaaa1";
    writeVods(join(work, "vods"), {
      "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}',
      "BV1bbbbbbbb1.m4a": '{"upload_date": "20260802"}',
    });
    mkdirSync(join(work, "streams"));
    const mdPath = join(work, "streams", `${id}.md`);
    const sidecar = join(work, "streams", `${id}.refined.json`);
    writeFileSync(mdPath, transcriptText(id, "2026-08-01", 1));
    writeFileSync(sidecar, sidecarText(id, 1));
    const other = "2026-08-02-BV1bbbbbbbb1";
    writeFileSync(join(work, "streams", `${other}.md`), transcriptText(other, "2026-08-02", 1));
    const index = join(work, "index");
    mkdirSync(index);
    writeFileSync(
      join(index, "stream_catalog.json"),
      JSON.stringify({ broadcasts: [{ stream_ids: [id] }] }),
    );
    const plan = () =>
      pipeline.planPipeline("milky-green", {
        vodsDir: join(work, "vods"),
        streamsDir: join(work, "streams"),
        listsDir: lists(),
        dbPath: index,
      });
    const indexed = async () => (await plan()).videos.map((video) => [video.id, video.indexed]);
    await chunksTable(index);
    expect(await indexed()).toEqual([
      ["BV1aaaaaaaa1", true],
      ["BV1bbbbbbbb1", false],
    ]);

    writeFileSync(
      join(index, "stream_chunks.meta.json"),
      JSON.stringify({ sources: [sourceRecord(mdPath), sourceRecord(sidecar)] }),
    );
    expect(await indexed()).toEqual([
      ["BV1aaaaaaaa1", true],
      ["BV1bbbbbbbb1", false],
    ]);
    // Refined again after the build: the index no longer holds what the sidecar says.
    utimesSync(sidecar, new Date(), new Date(Date.now() + 60_000));
    expect(await indexed()).toEqual([
      ["BV1aaaaaaaa1", false],
      ["BV1bbbbbbbb1", false],
    ]);
  });

  test("indexed: never without the stream_chunks table, whatever the catalog and build record say", async () => {
    const id = "2026-08-01-BV1aaaaaaaa1";
    writeVods(join(work, "vods"), { "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}' });
    mkdirSync(join(work, "streams"));
    const mdPath = join(work, "streams", `${id}.md`);
    const sidecar = join(work, "streams", `${id}.refined.json`);
    writeFileSync(mdPath, transcriptText(id, "2026-08-01", 1));
    writeFileSync(sidecar, sidecarText(id, 1));
    const index = join(work, "index");
    mkdirSync(index);
    writeFileSync(
      join(index, "stream_catalog.json"),
      JSON.stringify({ broadcasts: [{ stream_ids: [id] }] }),
    );
    const indexed = async (dbPath = index) =>
      (
        await pipeline.planPipeline("milky-green", {
          vodsDir: join(work, "vods"),
          streamsDir: join(work, "streams"),
          listsDir: lists(),
          dbPath,
        })
      ).videos.map((video) => [video.id, video.indexed]);
    expect(await indexed()).toEqual([["BV1aaaaaaaa1", false]]);
    writeFileSync(
      join(index, "stream_chunks.meta.json"),
      JSON.stringify({ sources: [sourceRecord(mdPath), sourceRecord(sidecar)] }),
    );
    expect(await indexed()).toEqual([["BV1aaaaaaaa1", false]]);
    // A path LanceDB can't list holds no table either.
    expect(await indexed(join(index, "stream_catalog.json"))).toEqual([["BV1aaaaaaaa1", false]]);
    await chunksTable(index);
    expect(await indexed()).toEqual([["BV1aaaaaaaa1", true]]);
  });

  test("a signal that lands while the index is read cancels the plan", async () => {
    writeVods(join(work, "vods"), { "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}' });
    mkdirSync(join(work, "streams"));
    const index = join(work, "index");
    mkdirSync(index);
    await chunksTable(index);
    const controller = new AbortController();
    // No transcripts: the index read is the plan's first await, so this abort lands inside it.
    const plan = pipeline.planPipeline("milky-green", {
      vodsDir: join(work, "vods"),
      streamsDir: join(work, "streams"),
      listsDir: lists(),
      dbPath: index,
      signal: controller.signal,
    });
    controller.abort();
    await expect(plan).rejects.toThrow();
  });

  test("refine's estimate prices by this persona's history for the same model", async () => {
    const id = "2026-08-01-BV1aaaaaaaa1";
    writeVods(join(work, "vods"), {
      "BV1aaaaaaaa1.m4a": '{"upload_date": "20260801"}',
      "BV1bbbbbbbb1.m4a": '{"upload_date": "20260802", "duration": 650}',
    });
    mkdirSync(join(work, "streams"));
    writeFileSync(join(work, "streams", `${id}.md`), transcriptText(id, "2026-08-01", 4));
    const sidecar = JSON.parse(sidecarText(id, 2));
    sidecar.stats = { model: "m", cost_usd: 0.5, chunks_refined: 2, cost_source: "openrouter" };
    writeFileSync(join(work, "streams", `${id}.refined.json`), JSON.stringify(sidecar));
    const plan = await pipeline.planPipeline("milky-green", {
      vodsDir: join(work, "vods"),
      streamsDir: join(work, "streams"),
      listsDir: lists(),
      dbPath: null,
      refineModel: "m",
    });
    const [refined, fresh] = plan.videos as [PlanVideo, PlanVideo];
    expect(refined.estimate).toEqual({ transcribeUsd: 0, refineUsd: 0.5, basis: "history" });
    // 650 s spans three scenes at most, at $0.25 each.
    expect(fresh.estimate.refineUsd).toBe(0.75);
    expect(fresh.estimate.basis).toBe("history");
    expect(fresh.estimate.transcribeUsd).toBeCloseTo((650 / 3600) * 0.1, 12);
  });

  test("a transcript that doesn't parse is planned unpriced, with a warning", async () => {
    mkdirSync(join(work, "streams"));
    writeFileSync(join(work, "streams", "2026-08-01-BV1aaaaaaaa1.md"), Buffer.from([0xff, 0xfe]));
    const plan = await pipeline.planPipeline("milky-green", {
      vodsDir: join(work, "vods"),
      streamsDir: join(work, "streams"),
      listsDir: lists(),
      dbPath: null,
    });
    expect(plan.videos).toEqual([
      {
        id: "BV1aaaaaaaa1",
        download: "pending",
        transcribe: "done",
        refine: null,
        indexed: false,
        estimate: { transcribeUsd: 0, basis: "unpriced" },
      },
    ]);
    expect(logs.records[0]?.[1]).toStartWith("Can't plan 2026-08-01-BV1aaaaaaaa1.md: ");
  });

  test("the folders default to the persona's sources", async () => {
    const plan = await pipeline.planPipeline("milky-green");
    expect(plan.videos).toEqual([]);
    expect(sourceFolder("milky-green", "vods")).toContain("sources/milky-green/vods");
  });
});

describe("download and the rest", () => {
  test("the download stage's summary prints before the next stage starts", async () => {
    const yt = join(work, "yt-dlp");
    writeFileSync(
      yt,
      '#!/bin/sh\nfor a; do last="$a"; done\n' +
        `printf '{"upload_date": "20260801"}' > '${join(work, "vods")}/BV1aaaaaaaa1.info.json'\n` +
        `printf audio > '${join(work, "vods")}/BV1aaaaaaaa1.m4a'\n`,
      { mode: 0o755 },
    );
    delete process.env.SONIOX_API_KEY;
    const order: string[] = [];
    const report = await pipeline.runPipeline(
      base({
        stages: ["download", "transcribe"],
        urls: ["https://www.bilibili.com/video/BV1aaaaaaaa1"],
        ytDlp: { path: yt, source: "setting" },
        dryRun: false,
        print: (text) => order.push(text.includes("Download Summary") ? "summary" : text),
        onProgress: (event) => {
          if (event.type === "stage" && event.stage === "transcribe") order.push(event.status);
        },
      }),
    );
    expect(order.slice(0, 2)).toEqual(["summary", "start"]);
    expect(report.download?.succeededUrls).toBe(1);
    expect(report.download?.newFiles).toEqual([join(work, "vods", "BV1aaaaaaaa1.m4a")]);
  });

  test("with no yt-dlp the download stage fails and the rest still run", async () => {
    process.env.YT_DLP_PATH = join(work, "missing-yt-dlp");
    const report = await pipeline.runPipeline(
      base({
        stages: ["download", "transcribe"],
        urls: ["https://www.bilibili.com/video/BV1aaaaaaaa1"],
        vodsDir: join(work, "nothing"),
      }),
    );
    expect(report.download?.error).toBe(
      `yt-dlp not found at ${join(work, "missing-yt-dlp")} (YT_DLP_PATH)`,
    );
    expect(report.transcribe).not.toBeNull();
    expect(report.ok).toBe(false);
    expect(pipeline.pipelineSummaryText(report, "vods")).toContain(
      "  download:   0/1 URLs ok, 0 failed, 0 new files (0.0s)  ⚠ yt-dlp couldn't run; see the error above",
    );
  });
});
