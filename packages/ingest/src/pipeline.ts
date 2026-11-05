// laplace-pipeline's library: one run through download, transcribe, refine and ingest (the stream
// catalog after it), in this process, and the plan of every video a persona's sources know.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  activePersona,
  cpLen,
  errorText,
  isPlainObject,
  logger,
  pyFixed,
  pyPath,
  pyPathName,
  pyPathStem,
  pyRepr,
  sortedPy,
  sourceFolder,
} from "@eidolon/config";
import {
  CATALOG_FILENAME,
  type EmbeddingClient,
  ingestHint,
  listTableNames,
  STREAM_CHUNKS_TABLE,
} from "@eidolon/retrieval";
import { writeStreamCatalog } from "./catalog.ts";
import * as download from "./download/index.ts";
import { type Failure, failureOf, sharedFailure } from "./failure.ts";
import { indexMetaPath } from "./index_build.ts";
import { defaultSkipTypes, ingestStreams, parseSkipTypes } from "./ingest_streams.ts";
import { createLimiter } from "./limit.ts";
import { canonicalPath, embedCachePath, indexWritePath, LockedError, lockedOut } from "./paths.ts";
import {
  COST_SOURCES,
  estimatedCost,
  noProgress,
  type PlanVideo,
  type ProgressEvent,
  type RunOptions,
  zeroCounts,
} from "./progress.ts";
import * as refine from "./refine/index.ts";
import {
  AUDIO_EXTENSIONS,
  infoJsonPath,
  loadSidecar,
  nextTranscript,
  type ParsedStream,
  parseStream,
  readUploadDate,
  transcriptPaths,
} from "./streams.ts";
import * as transcribe from "./transcribe/index.ts";

/** The stages, in the order a run takes them whatever order they were asked in. */
export const ALL_STAGES = ["download", "transcribe", "refine", "ingest"] as const;
export type PipelineStage = (typeof ALL_STAGES)[number];

type SummaryEvent = Extract<ProgressEvent, { type: "summary" }>;
type CostSource = NonNullable<SummaryEvent["costSource"]>;

/** What a stage spent. */
export interface StageCost {
  readonly usd: number;
  readonly source: CostSource;
}

/** A summary's cost fields: nothing spent is $0, and one unpriced part leaves the total unpriced. */
function summaryCost(
  costs: readonly (StageCost | null)[],
): Pick<SummaryEvent, "costUsd" | "costSource"> {
  const spent = costs.filter((cost): cost is StageCost => cost !== null);
  if (spent.length === 0) return { costUsd: 0 };
  if (spent.some((cost) => cost.source === "unpriced")) return { costSource: "unpriced" };
  return {
    costUsd: spent.reduce((sum, cost) => sum + cost.usd, 0),
    costSource: spent.every((cost) => cost.source === "reported") ? "reported" : "estimated",
  };
}

/** The transcribe stage, over every audio file in the vods folder. */
export interface TranscribeStageReport {
  readonly total: number;
  /** Audio already transcribed, or already found to hold no speech. */
  readonly skipped: number;
  readonly skippedNoDate: number;
  readonly succeeded: number;
  /** Audio this run found no speech in: its payload was written, and no transcript. */
  readonly noSpeech: number;
  readonly failed: readonly { readonly audio: string; readonly error: string }[];
  readonly durationSec: number;
  readonly cancelled: boolean;
  /** What Soniox's price list says this run's transcriptions cost; null when none ran. */
  readonly cost: StageCost | null;
}

/** A stage that ends in an exit code, as refine's and ingest's child processes did. */
export interface StageResult {
  readonly rc: number;
  readonly durationSec: number;
  readonly cancelled: boolean;
  /** What the stage's LLM or embedding requests cost; null when none ran. */
  readonly cost: StageCost | null;
}

export interface PipelineReport {
  /** The stages asked for, in run order; Python's summary lists these, run or not. */
  readonly stages: readonly PipelineStage[];
  readonly download: download.DownloadReport | null;
  readonly transcribe: TranscribeStageReport | null;
  readonly refine: StageResult | null;
  readonly ingest: StageResult | null;
  readonly durationSec: number;
  /** --abort-on-error stopped the run after a stage's failure. */
  readonly aborted: boolean;
  readonly cancelled: boolean;
  /** `PipelineSummary.successful()`, and not cancelled. */
  readonly ok: boolean;
  /** The batch's `.done.json`, when this run finished the batch. */
  readonly batchDone: string | null;
}

export interface PipelineOptions extends RunOptions {
  readonly stages: readonly PipelineStage[];
  /** The list the URLs came from; a batch under `listsDir` is marked done by a clean full run. */
  readonly urlList: string | null;
  readonly urls: readonly string[];
  readonly vodsDir: string;
  readonly streamsDir: string;
  /** The persona's lists folder, where its batches are; no batch is tracked without it. */
  readonly listsDir?: string;
  /** The index the ingest stage rebuilds, which the catalog joins. */
  readonly dbPath: string;
  /** The embedding cache; null embeds every row afresh. embedCachePath() when omitted. */
  readonly cachePath?: string | null;
  readonly abortOnError?: boolean;
  readonly dryRun?: boolean;
  /** Takes the index's lock for the ingest stage and returns its release; throws LockedError. */
  readonly holdIndex?: () => () => void;
  /** Receives what Python printed, the stage summaries among it, in order. */
  readonly print?: (text: string) => void;

  readonly format?: string;
  /** null: no browser's cookies. */
  readonly cookiesFromBrowser?: string | null;
  readonly cookiesFile?: string | null;
  readonly extraArgs?: readonly string[];
  readonly output?: download.DownloadOptions["output"];
  readonly onOutput?: (line: string) => void;
  readonly ytDlp?: download.YtDlp;
  readonly ytDlpOptions?: download.DownloadOptions["ytDlpOptions"];

  /** Soniox's language hint; '' sends none. transcription.language's when omitted. */
  readonly language?: string;
  readonly sonioxModel?: string;
  /** The glossary; null runs without one. The active persona's when omitted. */
  readonly contextFile?: string | null;
  readonly keepSonioxFiles?: boolean;
  readonly autoSlice?: boolean;
  readonly sliceMaxMin?: number;
  /** 1 or less transcribes one file at a time. */
  readonly transcribeConcurrency?: number;
  /** ffprobe and ffmpeg: looked up on PATH when undefined, missing when null. */
  readonly ffprobe?: string | null;
  readonly ffmpeg?: string | null;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly retryDelaysMs?: readonly number[];

  /** `--refine-model` as given: an empty one leaves refine.refineModel() in charge. */
  readonly refineModel?: string | null;
  readonly refineConcurrency?: number | null;
  readonly refineForce?: boolean;

  /** `--skip-types` as given; null leaves defaultSkipTypes() in charge. */
  readonly skipTypes?: string | null;
  readonly embeddingClient?: Pick<EmbeddingClient, "embedWithUsage">;

  /** Soniox's and the refine provider's fetch. */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

const RULE = "=".repeat(64);

/** `print_pipeline_summary`'s text. */
export function pipelineSummaryText(report: PipelineReport, vodsDir: string): string {
  const d = (seconds: number): string => `${pyFixed(seconds, 1)}s`;
  const flag = (stage: { readonly cancelled: boolean }): string =>
    stage.cancelled ? "  ⚠ cancelled" : "";
  const lines = [
    "",
    RULE,
    "Pipeline Summary",
    RULE,
    `Stages run: ${report.stages.join(", ") || "(none)"}`,
    `Duration:   ${d(report.durationSec)}`,
    "",
  ];
  if (report.download !== null) {
    const r = report.download;
    const noYtDlp = r.error === null ? "" : "  ⚠ yt-dlp couldn't run; see the error above";
    lines.push(
      `  download:   ${r.succeededUrls}/${r.requestedUrls} URLs ok, ${r.failedUrls.length} ` +
        `failed, ${r.newFiles.length} new files (${d(r.durationSec)})${noYtDlp}${flag(r)}`,
    );
  }
  if (report.transcribe !== null) {
    const t = report.transcribe;
    const noSpeech = t.noSpeech > 0 ? `${t.noSpeech} no speech, ` : "";
    lines.push(
      `  transcribe: ${t.succeeded} new, ${noSpeech}${t.skipped} already done, ` +
        `${t.skippedNoDate} no-date, ${t.failed.length} failed of ${t.total} audio files in ` +
        `${vodsDir}/ (${d(t.durationSec)})${flag(t)}`,
    );
  }
  for (const [name, stage] of [
    ["refine", report.refine],
    ["ingest", report.ingest],
  ] as const) {
    if (stage === null) continue;
    const label = `  ${`${name}:`.padEnd(11)} `;
    if (stage.cancelled) {
      lines.push(`${label}cancelled (${d(stage.durationSec)})`);
    } else {
      const warning = stage.rc === 0 ? "" : `  ⚠ check ${name} output above for details`;
      lines.push(`${label}exit=${stage.rc} (${d(stage.durationSec)})${warning}`);
    }
  }
  lines.push("");
  if (report.aborted) lines.push("⚠  Pipeline aborted early (--abort-on-error was set).");
  else if (report.cancelled)
    lines.push("⚠  Pipeline cancelled — re-run the same command to resume.");
  else if (report.ok) lines.push("✓  All stages succeeded.");
  else lines.push("⚠  One or more stages had failures — re-run the same command to retry.");
  lines.push(RULE);
  return `${lines.join("\n")}\n`;
}

/**
 * `main()` after parsing: the stages asked for, in order. A failed item is recorded and the run
 * goes on, unless --abort-on-error stops it after that stage. Once `signal` aborts, the stage in
 * progress stops and no other starts. Emits each stage's events, then the pipeline's summary.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineReport> {
  const emit = options.onProgress ?? noProgress;
  const print = options.print ?? (() => {});
  const { signal, stages } = options;
  const started = performance.now();
  const dryRun = options.dryRun ?? false;
  // Set inside runStages, which control-flow narrowing can't see.
  let downloadReport = null as download.DownloadReport | null;
  let transcribeReport = null as TranscribeStageReport | null;
  let refineResult = null as StageResult | null;
  let ingestResult = null as StageResult | null;
  let aborted = false;
  // Python's `_Abort`: no later stage starts, and the summary says why.
  const halts = (failed: boolean): boolean => {
    if (options.abortOnError && failed) aborted = true;
    return aborted || signal?.aborted === true;
  };

  const runStages = async (): Promise<void> => {
    if (stages.includes("download")) {
      if (dryRun) {
        logger.info(
          `[dry-run] would download ${options.urls.length} URL(s) → ${options.vodsDir}/ ` +
            `(format=${pyRepr(options.format ?? download.DEFAULT_FORMAT)})`,
        );
      } else {
        // Python's RuntimeError for a missing yt-dlp crashed the run; here only the stage fails.
        const report = await download.downloadUrls(options.urls, {
          vodsDir: options.vodsDir,
          format: options.format,
          cookiesFromBrowser: options.cookiesFromBrowser,
          cookiesFile: options.cookiesFile,
          extraArgs: options.extraArgs,
          output: options.output,
          onOutput: options.onOutput,
          ytDlp: options.ytDlp,
          ytDlpOptions: { command: "laplace-pipeline", ...options.ytDlpOptions },
          onProgress: options.onProgress,
          signal,
        });
        downloadReport = report;
        if (report.error === null) print(download.downloadSummaryText(report, options.vodsDir));
        if (halts(report.error !== null || report.failedUrls.length > 0)) return;
      }
    }
    if (stages.includes("transcribe")) {
      transcribeReport = await transcribeStage(options);
      if (halts(transcribeReport.failed.length > 0)) return;
    }
    if (stages.includes("refine")) {
      refineResult = await refineStage(options);
      if (halts(refineResult.rc !== 0)) return;
    }
    if (stages.includes("ingest")) {
      ingestResult = await ingestStage(options);
      halts(ingestResult.rc !== 0);
    }
  };
  await runStages();

  const cancelled =
    signal?.aborted === true ||
    [downloadReport, transcribeReport, refineResult, ingestResult].some(
      (stage) => stage?.cancelled === true,
    );
  const ok =
    !aborted &&
    !cancelled &&
    (downloadReport?.error ?? null) === null &&
    (downloadReport?.failedUrls.length ?? 0) === 0 &&
    (transcribeReport?.failed.length ?? 0) === 0 &&
    (refineResult?.rc ?? 0) === 0 &&
    (ingestResult?.rc ?? 0) === 0;
  const fullRun = !dryRun && stages.length === ALL_STAGES.length;
  const batchDone =
    ok && fullRun && options.urlList !== null ? markBatchDone(options, options.urlList) : null;
  const report: PipelineReport = {
    stages,
    download: downloadReport,
    transcribe: transcribeReport,
    refine: refineResult,
    ingest: ingestResult,
    durationSec: (performance.now() - started) / 1000,
    aborted,
    cancelled,
    ok,
    batchDone,
  };
  emit(pipelineSummaryEvent(report));
  return report;
}

function pipelineSummaryEvent(report: PipelineReport): SummaryEvent {
  const failures: { item: string; error: string }[] = [];
  if (report.download !== null && report.download.error !== null) {
    failures.push({ item: "download", error: report.download.error });
  } else if (report.download !== null && report.download.failedUrls.length > 0) {
    failures.push({ item: "download", error: `${report.download.failedUrls.length} URLs failed` });
  }
  if (report.transcribe !== null && report.transcribe.failed.length > 0) {
    failures.push({ item: "transcribe", error: `${report.transcribe.failed.length} files failed` });
  }
  for (const [name, stage] of [
    ["refine", report.refine],
    ["ingest", report.ingest],
  ] as const) {
    if (stage !== null && !stage.cancelled && stage.rc !== 0) {
      failures.push({ item: name, error: `exit=${stage.rc}` });
    }
  }
  return {
    type: "summary",
    stage: "pipeline",
    ok: report.ok,
    ...(report.cancelled ? { cancelled: true } : {}),
    counts: {
      stages: report.stages.length,
      failed: failures.length,
      aborted: report.aborted ? 1 : 0,
    },
    durationSec: report.durationSec,
    ...summaryCost([
      report.transcribe?.cost ?? null,
      report.refine?.cost ?? null,
      report.ingest?.cost ?? null,
    ]),
    ...(failures.length > 0 ? { failures } : {}),
  };
}

interface TranscribeJob {
  readonly audio: string;
  readonly name: string;
  readonly label: string;
  readonly index: number;
  readonly date: string;
}

async function transcribeStage(options: PipelineOptions): Promise<TranscribeStageReport> {
  const emit = options.onProgress ?? noProgress;
  const { signal, vodsDir, streamsDir } = options;
  const dryRun = options.dryRun ?? false;
  const started = performance.now();
  const files = transcribe.listAudioFiles(vodsDir);
  const total = files.length;
  let skipped = 0;
  let skippedNoDate = 0;
  let succeeded = 0;
  let noSpeech = 0;
  const failed: { audio: string; error: string }[] = [];
  const failures: (Failure | null)[] = [];
  const spent: (number | null)[] = [];

  const finish = (status: "done" | "skipped" | "cancelled"): TranscribeStageReport => {
    const cancelled = status === "cancelled";
    let cost: StageCost | null = null;
    if (spent.length > 0) {
      cost = spent.includes(null)
        ? { usd: 0, source: "unpriced" }
        : { usd: spent.reduce((sum: number, usd) => sum + (usd ?? 0), 0), source: "estimated" };
    }
    const report: TranscribeStageReport = {
      total,
      skipped,
      skippedNoDate,
      succeeded,
      noSpeech,
      failed,
      durationSec: (performance.now() - started) / 1000,
      cancelled,
      cost,
    };
    const failedStage = status === "done" && failed.length > 0;
    emit({
      type: "stage",
      stage: "transcribe",
      status: failedStage ? "failed" : status,
      ...(cancelled ? { code: "cancelled" } : {}),
      ...(failedStage ? sharedFailure(failures) : {}),
    });
    emit({
      type: "summary",
      stage: "transcribe",
      ok: !cancelled && failed.length === 0,
      ...(cancelled ? { cancelled: true } : {}),
      counts: { total, skipped, skippedNoDate, succeeded, failed: failed.length, noSpeech },
      durationSec: report.durationSec,
      ...summaryCost([cost]),
      ...(failed.length > 0
        ? { failures: failed.map(({ audio, error }) => ({ item: pyPathName(audio), error })) }
        : {}),
    });
    return report;
  };

  if (total === 0) {
    logger.warning(
      `No audio files in ${vodsDir}/ — did the download stage run? ` +
        `(extensions checked: ${pyRepr(sortedPy(AUDIO_EXTENSIONS))})`,
    );
    return finish("skipped");
  }
  emit({ type: "stage", stage: "transcribe", status: "start", total });
  // Python made the folder on a dry run too; a dry run here writes nothing.
  if (!dryRun) mkdirSync(streamsDir, { recursive: true });

  const jobs: TranscribeJob[] = [];
  for (const [i, audio] of files.entries()) {
    const index = i + 1;
    const label = `[${index}/${total}]`;
    const name = pyPathName(audio);
    const item = {
      type: "item",
      stage: "transcribe",
      item: name,
      video: pyPathStem(audio),
      index,
      total,
    } as const;
    let status: transcribe.AudioStatus;
    try {
      status = transcribe.audioStatus(audio, streamsDir);
    } catch (error) {
      // Python's run crashed on an info.json it couldn't decode, like an AppleDouble `._x.info.json`.
      const message = `can't read ${pyPathName(infoJsonPath(audio))}: ${errorText(error)}`;
      logger.error(`${label} ${name}: ${message}`);
      failed.push({ audio, error: message });
      failures.push(null);
      emit({ ...item, status: "failed", message });
      continue;
    }
    if (status.state === "no-date") {
      const command = `laplace-transcribe ${audio} --date YYYY-MM-DD`;
      logger.warning(
        `${label} ${name}: no upload_date in ${pyPathName(infoJsonPath(audio))}, skipping. ` +
          `Re-download the URL or transcribe manually with \`${ingestHint(command)}\`.`,
      );
      skippedNoDate++;
      emit({ ...item, status: "skipped", code: "no-upload-date", message: "no upload date" });
      continue;
    }
    if (status.state === "done") {
      logger.info(`${label} ${name}: already transcribed → ${pyPathName(status.mdPath)}`);
      skipped++;
      emit({ ...item, status: "skipped", message: "already transcribed" });
      continue;
    }
    if (status.state === "no-speech") {
      const payload = pyPathName(status.payloadPath);
      logger.info(`${label} ${name}: already transcribed, no speech → ${payload}`);
      skipped++;
      emit({ ...item, status: "skipped", code: "no-speech", message: "no speech" });
      continue;
    }
    const { date } = status;
    if (dryRun) {
      logger.info(
        `${label} [dry-run] would transcribe ${name} (date=${date}) → ${pyPathName(status.mdPath)}`,
      );
      continue;
    }
    jobs.push({ audio, name, label, index, date });
  }
  if (jobs.length === 0) return finish("done");

  const apiKey = transcribe.sonioxApiKey();
  if (!apiKey) {
    // Each of Python's transcribe children failed on it in turn.
    const message = transcribe.MISSING_API_KEY;
    logger.error(message);
    for (const job of jobs) {
      failed.push({ audio: job.audio, error: message });
      failures.push({ code: "missing-credential" });
      emit({
        type: "item",
        stage: "transcribe",
        item: job.name,
        video: pyPathStem(job.audio),
        index: job.index,
        total,
        status: "failed",
        code: "missing-credential",
        message,
      });
    }
    return finish("done");
  }

  const concurrency = options.transcribeConcurrency ?? 1;
  const parallel = concurrency > 1;
  if (parallel) {
    logger.info(
      `Running ${jobs.length} transcribe job(s) in parallel (concurrency=${concurrency})`,
    );
  }
  // --abort-on-error keeps the queued jobs from starting, and lets running ones finish: a Soniox
  // upload cut off mid-flight leaves a server record that still counts against the quota.
  const halt = new AbortController();
  const limit = createLimiter(
    parallel ? concurrency : 1,
    signal ? AbortSignal.any([signal, halt.signal]) : halt.signal,
  );
  const contextFile =
    options.contextFile === undefined
      ? transcribe.glossaryPath(activePersona().id)
      : options.contextFile;
  const runJob = async (job: TranscribeJob): Promise<void> => {
    logger.info(`${job.label} transcribing ${job.name} (date=${job.date}, provider=soniox)`);
    let result: transcribe.TranscribeResult;
    try {
      result = await transcribe.transcribeAudio({
        audioPath: job.audio,
        date: job.date,
        outDir: streamsDir,
        apiKey,
        model: options.sonioxModel ?? transcribe.configuredModel(),
        language: options.language ?? transcribe.configuredLanguage(),
        contextFile,
        keepFiles: options.keepSonioxFiles ?? false,
        autoSlice: options.autoSlice ?? true,
        sliceMaxMin: options.sliceMaxMin ?? transcribe.SLICE_MAX_MIN_DEFAULT,
        index: job.index,
        total,
        fetch: options.fetch,
        sleep: options.sleep,
        retryDelaysMs: options.retryDelaysMs,
        ffprobe: options.ffprobe,
        ffmpeg: options.ffmpeg,
        onProgress: emit,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) return;
      const message = errorText(error);
      logger.error(
        parallel
          ? `  ✗ ${job.name}: transcribe failed: ${message}`
          : `  ✗ transcribe failed: ${message}`,
      );
      failed.push({ audio: job.audio, error: message });
      failures.push(failureOf(error, "soniox"));
      if (options.abortOnError && !halt.signal.aborted) {
        if (parallel) {
          logger.warning(
            "  abort_on_error: cancelling pending transcribes (in-flight ones will finish naturally)",
          );
        }
        halt.abort();
      }
      return;
    }
    spent.push(result.costUsd);
    if (result.status === "no-speech") noSpeech++;
    else succeeded++;
    if (parallel) logger.info(`  ✓ ${job.name}`);
  };
  await Promise.all(
    jobs.map((job) =>
      limit(() => runJob(job)).catch(() => {
        // A job the stop or the signal kept from starting.
      }),
    ),
  );
  return finish(signal?.aborted ? "cancelled" : "done");
}

/** What Python logged for each child it started: the command that runs the same stage alone. */
function commandLine(command: string, args: readonly (string | false)[]): string {
  return [command, ...args.filter((arg): arg is string => arg !== false)].join(" ");
}

/** What refine.py's main did with the pipeline's flags, in this process. */
async function refineStage(options: PipelineOptions): Promise<StageResult> {
  const emit = options.onProgress ?? noProgress;
  const { streamsDir } = options;
  const dryRun = options.dryRun ?? false;
  const started = performance.now();
  // Python forwarded --model only when it was truthy, --concurrency whenever it was given.
  const flagModel = options.refineModel || null;
  const flagConcurrency = options.refineConcurrency ?? null;
  const model = flagModel ?? refine.refineModel();
  const concurrency = flagConcurrency ?? refine.refineConcurrency();
  const force = options.refineForce ?? false;
  logger.info(
    `Refining: ${commandLine("laplace-refine", [
      "--streams-dir",
      streamsDir,
      flagModel !== null && "--model",
      flagModel ?? false,
      flagConcurrency !== null && "--concurrency",
      flagConcurrency !== null && String(flagConcurrency),
      force && "--force",
      dryRun && "--dry-run",
    ])}`,
  );
  const result = (rc: number, cancelled = false, cost: StageCost | null = null): StageResult => ({
    rc,
    durationSec: (performance.now() - started) / 1000,
    cancelled,
    cost,
  });
  const fail = (message: string, code?: "missing-credential"): StageResult => {
    emit({ type: "stage", stage: "refine", status: "failed", message, ...(code ? { code } : {}) });
    emit({
      type: "summary",
      stage: "refine",
      ok: false,
      counts: zeroCounts("refine"),
      durationSec: (performance.now() - started) / 1000,
      failures: [{ item: pyPathName(streamsDir), error: message }],
    });
    return result(1);
  };

  const run = await refine.runRefine({
    paths: [],
    streamsDir,
    model,
    concurrency,
    force,
    dryRun,
    print: options.print ?? (() => {}),
    fetch: options.fetch,
    now: options.now,
    onProgress: emit,
    signal: options.signal,
  });
  switch (run.kind) {
    case "cancelled":
      return result(1, true);
    case "unreadable":
      // refine.py crashed on a transcript it couldn't parse.
      logger.error(`Refine failed: ${errorText(run.error)}`, run.error);
      return fail(errorText(run.error));
    case "empty":
      emit({ type: "stage", stage: "refine", status: "skipped", total: 0 });
      emit({
        type: "summary",
        stage: "refine",
        ok: true,
        counts: zeroCounts("refine"),
        durationSec: 0,
      });
      return result(0);
    case "dry-run":
      return result(0);
    case "no-key":
      logger.error(refine.MISSING_API_KEY);
      return fail(refine.MISSING_API_KEY, "missing-credential");
    case "done": {
      const { report } = run;
      const spent = report.results.some((r) => r.chunksSucceeded + r.chunksFailed > 0);
      const cost: StageCost | null = spent
        ? { usd: report.usage.costUsd, source: COST_SOURCES[report.usage.costSource] }
        : null;
      return result(report.ok ? 0 : 1, report.cancelled, cost);
    }
  }
}

/** ingest_streams.py, then build_stream_catalog.py when it succeeded and wasn't a dry run. */
async function ingestStage(options: PipelineOptions): Promise<StageResult> {
  const emit = options.onProgress ?? noProgress;
  const { signal, streamsDir, dbPath } = options;
  const dryRun = options.dryRun ?? false;
  const started = performance.now();
  const flagSkipTypes = options.skipTypes ?? null;
  logger.info(
    `Ingesting: ${commandLine("laplace-ingest-streams", [
      "--streams-dir",
      streamsDir,
      flagSkipTypes !== null && "--skip-types",
      flagSkipTypes ?? false,
      dryRun && "--dry-run",
    ])}`,
  );
  const result = (rc: number, cancelled = false, cost: StageCost | null = null): StageResult => ({
    rc,
    durationSec: (performance.now() - started) / 1000,
    cancelled,
    cost,
  });
  let release = (): void => {};
  if (!dryRun && options.holdIndex) {
    try {
      release = options.holdIndex();
    } catch (error) {
      if (!(error instanceof LockedError)) throw error;
      lockedOut(emit, "ingest-streams", error, zeroCounts("ingest-streams"), STREAM_CHUNKS_TABLE);
      return result(1);
    }
  }
  try {
    const report = await ingestStreams({
      streamsDir,
      dbPath,
      skipTypes: parseSkipTypes(flagSkipTypes ?? defaultSkipTypes()),
      dryRun,
      cachePath: options.cachePath === undefined ? embedCachePath() : options.cachePath,
      client: options.embeddingClient,
      now: options.now,
      onProgress: emit,
      signal,
    });
    const cost: StageCost | null =
      report.usage === null || report.embedded === 0
        ? null
        : { usd: report.usage.costUsd, source: COST_SOURCES[report.usage.costSource] };
    if (!report.ok || dryRun) return result(report.ok ? 0 : 1, report.cancelled, cost);
    // As Python passed it: the catalog's paths are relative to the streams folder as given.
    const built = await writeStreamCatalog({ streamsDir, dbPath, onProgress: emit, signal });
    return result(built.ok ? 0 : 1, built.cancelled, cost);
  } finally {
    release();
  }
}

/** What the plan reads from a video's `.info.json`. */
interface InfoFields {
  readonly title?: string;
  readonly durationSec?: number;
  readonly webpageUrl?: string;
  /** On one part of a multi-part video: how many parts the video has. */
  readonly parts?: number;
}

interface VodsEntry {
  /** The audio file, once downloaded. */
  audio?: string;
  /** The info.json, which yt-dlp writes before the audio. */
  info?: InfoFields;
}

/** The vods folder by yt-dlp id: its audio files and info.json files, and the parts of each video. */
interface Vods {
  readonly entries: ReadonlyMap<string, VodsEntry>;
  /** A multi-part video's `_p<N>` ids by N, under its bare id. */
  readonly parts: ReadonlyMap<string, ReadonlyMap<number, string>>;
}

const INFO_SUFFIX = ".info.json";
const PART = /^(.+)_p(\d+)$/s;

function readInfo(path: string): InfoFields {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (!isPlainObject(data)) return {};
  const { title, duration, webpage_url, n_entries } = data;
  return {
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof duration === "number" ? { durationSec: duration } : {}),
    ...(typeof webpage_url === "string" ? { webpageUrl: webpage_url } : {}),
    ...(Number.isInteger(n_entries) ? { parts: n_entries as number } : {}),
  };
}

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readVods(vodsDir: string): Vods {
  const entries = new Map<string, VodsEntry>();
  const entry = (id: string): VodsEntry => {
    let found = entries.get(id);
    if (found === undefined) {
      found = {};
      entries.set(id, found);
    }
    return found;
  };
  for (const audio of transcribe.listAudioFiles(vodsDir)) entry(pyPathStem(audio)).audio = audio;
  for (const name of sortedPy(listNames(vodsDir))) {
    if (name.endsWith(INFO_SUFFIX) && name !== INFO_SUFFIX) {
      entry(name.slice(0, -INFO_SUFFIX.length)).info = readInfo(join(vodsDir, name));
    }
  }
  const parts = new Map<string, Map<number, string>>();
  for (const id of entries.keys()) {
    const part = PART.exec(id);
    if (part === null) continue;
    const base = part[1] as string;
    const numbers = parts.get(base) ?? new Map<number, string>();
    numbers.set(Number(part[2]), id);
    parts.set(base, numbers);
  }
  return { entries, parts };
}

/**
 * The yt-dlp ids a list entry stands for. A Bilibili video is its bare id and its `_p<N>` parts,
 * every part its info.json counts included, downloaded or not; another site's URL is whatever
 * yt-dlp downloaded from that page. Just `key` while nothing is downloaded.
 */
function videosOf(key: string, url: string, vods: Vods): string[] {
  const ids: string[] = [];
  if (download.BV_ID.test(key)) {
    if (vods.entries.has(key)) ids.push(key);
    const parts = new Map(vods.parts.get(key) ?? []);
    let expected = 0;
    for (const id of parts.values()) {
      expected = Math.max(expected, vods.entries.get(id)?.info?.parts ?? 0);
    }
    for (let n = 1; n <= expected; n++) if (!parts.has(n)) parts.set(n, `${key}_p${n}`);
    ids.push(...[...parts].sort(([a], [b]) => a - b).map(([, id]) => id));
  } else {
    for (const [id, entry] of vods.entries) if (entry.info?.webpageUrl === url) ids.push(id);
  }
  return ids.length > 0 ? ids : [key];
}

/** A list's line, under the key prepare_batch gives it: a BV id, else the URL as written. */
interface ListEntry {
  readonly url: string;
  readonly batch?: string;
}

/**
 * The videos `urlList` names, else every list under `listsDir` (the prepared lists, then the
 * batches), by key in first mention's order; an entry keeps the first batch that names it.
 */
function listEntries(listsDir: string, urlList?: string | null): Map<string, ListEntry> {
  const entries = new Map<string, ListEntry>();
  const addList = (path: string, batch: string | undefined): void => {
    for (const url of download.readUrlList(path)) {
      const key = download.listKey(url) ?? url;
      const known = entries.get(key);
      if (known === undefined) entries.set(key, batch === undefined ? { url } : { url, batch });
      else if (batch !== undefined && known.batch === undefined) {
        entries.set(key, { ...known, batch });
      }
    }
  };
  if (urlList) {
    addList(urlList, isBatch(urlList, listsDir) ? batchId(urlList) : undefined);
  } else {
    for (const path of download.baselineLists(listsDir)) addList(path, undefined);
    for (const path of download.batchLists(listsDir)) addList(path, batchId(path));
  }
  return entries;
}

/** Every video the persona's lists name, one URL each: what a dry run without a list counts. */
export function knownUrls(listsDir: string): string[] {
  return [...listEntries(listsDir).values()].map((entry) => entry.url);
}

/** Whether `urlList` is one of the batches under `listsDir`. */
function isBatch(urlList: string, listsDir: string): boolean {
  const target = canonicalPath(urlList);
  return download.batchLists(listsDir).some((batch) => canonicalPath(batch) === target);
}

/** A batch's id: its file name without `.txt`. */
function batchId(path: string): string {
  return pyPathStem(path);
}

/**
 * Writes `<batch>.done.json` when every video of the batch is downloaded and transcribed. A clean
 * run leaves one undone when it lacks an upload date, or a part is still missing. Returns the
 * file written, or null.
 */
function markBatchDone(options: PipelineOptions, urlList: string): string | null {
  if (options.listsDir === undefined || !isBatch(urlList, options.listsDir)) return null;
  let ids: string[];
  try {
    ids = download.readIds(urlList);
  } catch (error) {
    logger.warning(`Can't mark ${pyPathName(urlList)} done: ${errorText(error)}`);
    return null;
  }
  const vods = readVods(options.vodsDir);
  const parts: string[] = [];
  for (const id of ids) {
    for (const video of videosOf(id, id, vods)) {
      const audio = vods.entries.get(video)?.audio;
      if (audio === undefined) return null;
      const state = transcribe.audioStatus(audio, options.streamsDir).state;
      if (state !== "done" && state !== "no-speech") return null;
      parts.push(video);
    }
  }
  download.writeBatchDone(urlList, {
    finishedAt: (options.now ?? (() => new Date()))().toISOString(),
    ids,
    parts,
    exitCode: 0,
  });
  const path = download.batchDonePath(urlList);
  logger.info(`Finished batch ${batchId(urlList)}: ${path}`);
  return path;
}

export interface PlanOptions extends RunOptions {
  /** Plan this list's videos; without it, those of every list under `listsDir`. */
  readonly urlList?: string | null;
  readonly vodsDir?: string;
  readonly streamsDir?: string;
  readonly listsDir?: string;
  /** The index `indexed` describes: the persona's indexWritePath() when omitted. */
  readonly dbPath?: string | null;
  /** The models the estimates price: transcribe's and refine's configured ones when omitted. */
  readonly transcribeModel?: string;
  readonly refineModel?: string;
}

export interface Plan {
  readonly videos: readonly PlanVideo[];
  readonly transcribeModel: string;
  readonly refineModel: string;
}

const TRANSCRIPT_NAME = /^(\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2})-(.+)\.md$/su;
const PAYLOAD_NAME = /^(\p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2})-(.+)\.soniox\.json$/su;
// The mean characters (text and heading) per chunk across milky-green's 51,882, for a persona
// that has no transcript to measure yet.
const CHARS_PER_CHUNK = 1158;

/** What the index was built from: its build record's files, else the catalog's stream ids. */
interface IndexState {
  readonly sources: ReadonlyMap<string, { readonly size: number; readonly mtime: string }> | null;
  readonly streamIds: ReadonlySet<string>;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Whether `dbPath` holds `table`; a path LanceDB can't list, such as a file, holds none. */
async function hasTable(dbPath: string, table: string): Promise<boolean> {
  try {
    return (await listTableNames(dbPath)).includes(table);
  } catch {
    return false;
  }
}

async function readIndexState(dbPath: string | null): Promise<IndexState> {
  const streamIds = new Set<string>();
  // The build record and the catalog stay behind when the table is gone.
  if (dbPath === null || !(await hasTable(dbPath, STREAM_CHUNKS_TABLE))) {
    return { sources: null, streamIds };
  }
  const metaPath = indexMetaPath(dbPath, STREAM_CHUNKS_TABLE);
  if (existsSync(metaPath)) {
    const meta = readJson(metaPath);
    const sources = new Map<string, { size: number; mtime: string }>();
    const listed = isPlainObject(meta) && Array.isArray(meta.sources) ? meta.sources : [];
    for (const source of listed) {
      if (!isPlainObject(source)) continue;
      const { name, size, mtime } = source;
      if (typeof name === "string" && typeof size === "number" && typeof mtime === "string") {
        sources.set(name, { size, mtime });
      }
    }
    return { sources, streamIds };
  }
  const catalog = readJson(pyPath(`${dbPath}/${CATALOG_FILENAME}`));
  const broadcasts =
    isPlainObject(catalog) && Array.isArray(catalog.broadcasts) ? catalog.broadcasts : [];
  for (const broadcast of broadcasts) {
    const ids = isPlainObject(broadcast) ? broadcast.stream_ids : null;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) if (typeof id === "string") streamIds.add(id);
  }
  return { sources: null, streamIds };
}

/** Whether the build record has `path` as it is now; one it doesn't list must not exist. */
function unchanged(sources: NonNullable<IndexState["sources"]>, path: string): boolean {
  const recorded = sources.get(pyPathName(path));
  let stat: { size: number; mtime: Date } | null = null;
  try {
    stat = statSync(path);
  } catch {
    stat = null;
  }
  if (recorded === undefined || stat === null) return recorded === undefined && stat === null;
  return recorded.size === stat.size && recorded.mtime === stat.mtime.toISOString();
}

interface Transcript {
  readonly path: string;
  readonly date: string;
  /** What the plan reads of it; null when it doesn't parse, which fails refine and ingest. */
  readonly stream: {
    readonly streamId: string;
    readonly sidecarPath: string;
    readonly work: refine.RefineWork;
  } | null;
}

/** readUploadDate, an info.json it can't read counting as no date. */
function uploadDate(audio: string): string | null {
  try {
    return readUploadDate(audio);
  } catch {
    return null;
  }
}

/**
 * Where every video the persona's sources know stands, stage by stage, and what the rest would
 * cost; reads only. The videos are the URL list's (every list's without one), then the audio no
 * list names, then transcripts whose audio is gone. Emits one `plan` event per video.
 */
export async function planPipeline(persona: string, options: PlanOptions = {}): Promise<Plan> {
  const emit = options.onProgress ?? noProgress;
  const { signal } = options;
  const vodsDir = options.vodsDir ?? sourceFolder(persona, "vods");
  const streamsDir = options.streamsDir ?? sourceFolder(persona, "streams");
  const listsDir = options.listsDir ?? sourceFolder(persona, "lists");
  const transcribeModel = options.transcribeModel ?? transcribe.configuredModel();
  const refineModel = options.refineModel ?? refine.refineModel();
  let dbPath = options.dbPath ?? null;
  if (options.dbPath === undefined) {
    try {
      dbPath = indexWritePath(persona);
    } catch {
      dbPath = null;
    }
  }

  const entries = listEntries(listsDir, options.urlList);
  const vods = readVods(vodsDir);

  // Transcripts under the audio stem their name carries, read one at a time so a signal lands.
  // Each keeps only what the plan reads, so the corpus's text and sidecars never pile up.
  const transcripts = new Map<string, Transcript[]>();
  const sidecarStats: unknown[] = [];
  let chars = 0;
  let chunks = 0;
  for (const path of transcriptPaths(streamsDir)) {
    await nextTranscript(signal);
    const name = TRANSCRIPT_NAME.exec(pyPathName(path));
    const stem = name === null ? pyPathStem(path) : (name[2] as string);
    let parsed: ParsedStream | null = null;
    let sidecar: unknown = null;
    try {
      parsed = parseStream(path);
      sidecar = loadSidecar(parsed);
    } catch (error) {
      parsed = null;
      logger.warning(`Can't plan ${pyPathName(path)}: ${errorText(error)}`);
    }
    let stream: Transcript["stream"] = null;
    if (parsed !== null) {
      // refineHistory reads nothing of a sidecar but its stats.
      sidecarStats.push(isPlainObject(sidecar) ? { stats: sidecar.stats } : null);
      for (const chunk of parsed.chunks) chars += cpLen(chunk.text) + cpLen(chunk.heading);
      chunks += parsed.chunks.length;
      stream = {
        streamId: parsed.streamId,
        sidecarPath: parsed.sidecarPath,
        work: refine.refineWork(parsed, sidecar),
      };
    }
    const found = transcripts.get(stem) ?? [];
    found.push({ path, date: name === null ? "" : (name[1] as string), stream });
    transcripts.set(stem, found);
  }
  const noSpeech = new Set<string>();
  for (const name of listNames(streamsDir)) {
    const payload = PAYLOAD_NAME.exec(name);
    if (payload === null) continue;
    const [date, stem] = [payload[1] as string, payload[2] as string];
    if (transcribe.transcriptState(streamsDir, date, stem) === "no-speech") noSpeech.add(stem);
  }
  const history = refine.refineHistory(sidecarStats, refineModel);
  const charsPerChunk = chunks > 0 ? chars / chunks : CHARS_PER_CHUNK;
  const index = await readIndexState(dbPath);
  signal?.throwIfAborted();

  const ordered: { id: string; url?: string; batch?: string }[] = [];
  const seen = new Set<string>();
  const add = (id: string, entry?: ListEntry): void => {
    if (seen.has(id)) return;
    seen.add(id);
    ordered.push({ id, ...entry });
  };
  for (const [key, entry] of entries) {
    for (const id of videosOf(key, entry.url, vods)) add(id, entry);
  }
  for (const id of sortedPy(vods.entries.keys())) add(id);
  for (const id of sortedPy(transcripts.keys())) add(id);

  const videos: PlanVideo[] = [];
  for (const { id, url, batch } of ordered) {
    const entry = vods.entries.get(id);
    const info = entry?.info;
    const audio = entry?.audio;
    // readUploadDate reads the info.json beside an audio path, whether the audio is there or not.
    const date = entry === undefined ? null : uploadDate(audio ?? join(vodsDir, `${id}.m4a`));
    const candidates = transcripts.get(id) ?? [];
    let transcript: Transcript | undefined;
    let state: PlanVideo["transcribe"];
    if (date !== null) {
      state = transcribe.transcriptState(streamsDir, date, id);
      transcript = candidates.find((candidate) => candidate.date === date);
    } else {
      transcript = candidates[0];
      if (audio !== undefined) state = "no-date";
      else if (transcript !== undefined) state = "done";
      else state = noSpeech.has(id) ? "no-speech" : "pending";
    }
    const stream = transcript?.stream ?? null;
    const work =
      stream === null
        ? null
        : {
            chunks: stream.work.chunks,
            done: stream.work.done,
            ...refine.refineCost(refineModel, stream.work.pending, stream.work.chars, history),
          };

    const bases: PlanVideo["estimate"]["basis"][] = [];
    let transcribeUsd: number | undefined;
    let refineUsd: number | undefined;
    if (state === "pending") {
      const usd =
        info?.durationSec === undefined
          ? null
          : transcribe.estimateTranscribeUsd(info.durationSec, transcribeModel);
      if (usd === null) bases.push("unpriced");
      else {
        transcribeUsd = usd;
        bases.push("price-table");
      }
    } else {
      transcribeUsd = 0;
    }
    if (transcript !== undefined) {
      if (work === null) bases.push("unpriced");
      else if (work.chunks === work.done) refineUsd = 0;
      else {
        refineUsd = work.costUsd;
        bases.push(work.basis);
      }
    } else if (state === "pending") {
      if (info?.durationSec === undefined) bases.push("unpriced");
      else {
        // One scene per transcription window at most, so the audio's length bounds the chunks.
        const guess = Math.ceil(info.durationSec / transcribe.DEFAULT_WINDOW_SEC);
        const cost = refine.refineCost(
          refineModel,
          guess,
          Math.round(guess * charsPerChunk),
          history,
        );
        refineUsd = cost.costUsd;
        bases.push(cost.basis);
      }
    } else {
      refineUsd = 0;
    }
    const basis = bases.includes("unpriced")
      ? "unpriced"
      : bases.includes("history")
        ? "history"
        : "price-table";

    let indexed = false;
    if (stream !== null && transcript !== undefined) {
      indexed =
        index.sources === null
          ? index.streamIds.has(stream.streamId)
          : unchanged(index.sources, transcript.path) &&
            unchanged(index.sources, stream.sidecarPath);
    }
    const link = url ?? info?.webpageUrl;
    const video: PlanVideo = {
      id,
      ...(link === undefined ? {} : { url: link }),
      ...(batch === undefined ? {} : { batch }),
      ...(info?.title === undefined ? {} : { title: info.title }),
      ...(date === null ? {} : { uploadDate: date }),
      ...(info?.durationSec === undefined ? {} : { durationSec: info.durationSec }),
      download: audio === undefined ? "pending" : "done",
      transcribe: state,
      refine: work === null ? null : { chunks: work.chunks, done: work.done },
      indexed,
      estimate: {
        ...(transcribeUsd === undefined ? {} : { transcribeUsd }),
        ...(refineUsd === undefined ? {} : { refineUsd }),
        basis,
      },
    };
    videos.push(video);
    emit({ type: "plan", video });
  }
  return { videos, transcribeModel, refineModel };
}

/** The dry run's summary event: the plan's totals, under stage "plan". */
export function planSummaryEvent(plan: Plan, durationSec: number): SummaryEvent {
  const count = (test: (video: PlanVideo) => boolean): number => plan.videos.filter(test).length;
  const unpriced = plan.videos.some((video) => video.estimate.basis === "unpriced");
  const usd = plan.videos.reduce(
    (sum, video) => sum + (video.estimate.transcribeUsd ?? 0) + (video.estimate.refineUsd ?? 0),
    0,
  );
  return {
    type: "summary",
    stage: "plan",
    ok: true,
    counts: {
      videos: plan.videos.length,
      downloadPending: count((video) => video.download === "pending"),
      transcribePending: count((video) => video.transcribe === "pending"),
      noDate: count((video) => video.transcribe === "no-date"),
      refinePending: plan.videos.reduce(
        (sum, video) => sum + (video.refine === null ? 0 : video.refine.chunks - video.refine.done),
        0,
      ),
      unindexed: count((video) => !video.indexed && video.transcribe !== "no-speech"),
    },
    durationSec,
    ...estimatedCost(unpriced ? null : usd),
  };
}
