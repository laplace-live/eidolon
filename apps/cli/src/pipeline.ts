// laplace-pipeline: takes a URL list's videos through download, transcribe, refine and ingest.
import {
  envOptional,
  errorText,
  logger,
  pyRepr,
  pyStrip,
  sortedPy,
  sourceFolder,
} from "@eidolon/config";
import {
  acquireLock,
  canonicalPath,
  download,
  type EventCode,
  indexLockKey,
  LockedError,
  ndjsonSink,
  noProgress,
  type ProgressSink,
  pipeline,
  refine,
  sourcesLockKey,
  transcribe,
  zeroCounts,
} from "@eidolon/ingest";
import type { EmbeddingClient } from "@eidolon/retrieval";
import {
  ArgparseExit,
  type ArgType,
  ArgumentTypeError,
  commandPersona,
  INT,
  type Namespace,
  PATH,
  type ParserSpec,
  parseArgs,
  parserError,
} from "./argparse.ts";
import { writerDbPath } from "./ingest_streams.ts";
import { type CommandDeps, reportExit, resolveIo } from "./io.ts";
import { CONCURRENCY, checkConcurrency } from "./refine.ts";

const PROG = "laplace-pipeline";

const USAGE = `usage: laplace-pipeline [-h] [--stages STAGES] [--vods-dir VODS_DIR]
                        [--streams-dir STREAMS_DIR] [--abort-on-error]
                        [--dry-run] [--persona PERSONA] [--json]
                        [--format FORMAT]
                        [--cookies-from-browser COOKIES_FROM_BROWSER]
                        [--cookies COOKIES] [--yt-dlp-args YT_DLP_ARGS]
                        [--language LANGUAGE] [--provider {soniox}]
                        [--soniox-model SONIOX_MODEL] [--no-context]
                        [--context-file CONTEXT_FILE] [--keep-soniox-files]
                        [--no-auto-slice] [--slice-max-min SLICE_MAX_MIN]
                        [--transcribe-concurrency TRANSCRIBE_CONCURRENCY]
                        [--refine-model REFINE_MODEL]
                        [--refine-concurrency REFINE_CONCURRENCY]
                        [--refine-force] [--skip-types SKIP_TYPES]
                        [--db-path DB_PATH]
                        [url_list]
`;

/** `_parse_stages`: "all" or "" is every stage; the rest, comma-separated, in run order. */
export const STAGES: ArgType<pipeline.PipelineStage[]> = {
  name: "_parse_stages",
  parse(text: string): pipeline.PipelineStage[] {
    const raw = pyStrip(text).toLowerCase();
    const all: readonly string[] = pipeline.ALL_STAGES;
    if (!raw || raw === "all") return [...pipeline.ALL_STAGES];
    const requested = new Set(
      raw
        .split(",")
        .map((stage) => pyStrip(stage))
        .filter(Boolean),
    );
    const unknown = [...requested].filter((stage) => !all.includes(stage));
    if (unknown.length > 0) {
      throw new ArgumentTypeError(
        `Unknown stage(s): ${pyRepr(sortedPy(unknown))}. Valid: ${pyRepr(all)}.`,
      );
    }
    return pipeline.ALL_STAGES.filter((stage) => requested.has(stage));
  },
};

export const PIPELINE_PARSER: ParserSpec = {
  prog: PROG,
  usage: USAGE,
  help: `${USAGE}
End-to-end pipeline: bilibili URL list → ingested LanceDB rows.

positional arguments:
  url_list              Path to a text file with one URL per line (# comments
                        + blanks ignored). Optional when --stages leaves out
                        download, and with --dry-run, which then plans every
                        video the persona's sources know.

options:
  -h, --help            show this help message and exit
  --stages STAGES       Comma-separated stages to run. Default: all four.
                        Stages always execute in
                        download→transcribe→refine→ingest order regardless of
                        how you list them. Valid:
                        download,transcribe,refine,ingest.
  --vods-dir VODS_DIR   Where audio files live (default: the persona's vods/
                        in the data home's sources).
  --streams-dir STREAMS_DIR
                        Where transcripts go (default: the persona's streams/
                        in the data home's sources).
  --abort-on-error      Fail fast on the first per-item failure (a bad URL, a
                        transcribe crash). Default is to log and continue so a
                        44-VOD batch isn't killed by one flaky video.
  --dry-run             Don't run any stage; just report what would happen.
                        Refine and ingest report what they would do. With
                        --json, one plan event per video instead.
  --persona PERSONA     Persona whose sources and index to use (default: the
                        active persona)
  --json                Report progress as JSON lines on stdout; the summaries
                        go to stderr

download stage:
  --format FORMAT       yt-dlp format spec (default: 'bestaudio[ext=m4a]').
  --cookies-from-browser COOKIES_FROM_BROWSER
                        Browser to read cookies from (default:
                        YT_DLP_COOKIES_FROM_BROWSER, else chrome). Pass an
                        empty string to disable.
  --cookies COOKIES     Path to a cookies.txt file (default: YT_DLP_COOKIES).
                        yt-dlp writes the cookies it used back into it.
  --yt-dlp-args YT_DLP_ARGS
                        Extra args forwarded to yt-dlp as a single shell-
                        quoted string. Example: --yt-dlp-args="--rate-limit 2M
                        --sleep-interval 5".

transcribe stage:
  --language LANGUAGE   Language hint (default: the transcription.language
                        setting, else zh). Pass --language '' for none.
  --provider {soniox}   Transcription backend (default: soniox).
  --soniox-model SONIOX_MODEL
                        Override Soniox model (default: the
                        transcription.model setting, else stt-async-v5).
  --no-context          Skip the Soniox structured-context glossary even if
                        the file exists.
  --context-file CONTEXT_FILE
                        Override the path to the Soniox context TOML (default:
                        the persona's glossary.toml).
  --keep-soniox-files   Don't delete the uploaded file + transcription record
                        from Soniox after success.
  --no-auto-slice       Disable automatic ffmpeg slicing of audio that exceeds
                        Soniox's 300-min per-file cap. With slicing off,
                        oversized files fail their transcribe step (and are
                        reported as failures in the summary). Default: slicing
                        on.
  --slice-max-min SLICE_MAX_MIN
                        Max minutes per slice when --auto-slice is on
                        (default: 280, which sits well under the 300-min hard
                        cap to absorb container/encoder drift).
  --transcribe-concurrency TRANSCRIBE_CONCURRENCY
                        Max transcriptions in flight at once (default: 1, i.e.
                        sequential). Soniox async accounts cap concurrent jobs
                        at 25 — pick a number well below that for safety; 4–8
                        is a good sweet spot for typical home upload
                        bandwidth.

refine stage:
  --refine-model REFINE_MODEL
                        Override OpenRouter model (default: refine.model or
                        $REFINE_MODEL, else ~google/gemini-pro-latest).
  --refine-concurrency REFINE_CONCURRENCY
                        Max concurrent LLM calls during refine (default:
                        refine.concurrency or $REFINE_CONCURRENCY, else 8).
  --refine-force        Re-refine all chunks even if a sidecar already exists.

ingest stage:
  --skip-types SKIP_TYPES
                        Comma-separated chunk_type values to leave out of the
                        index (default: knowledge.archive.skipTypes or
                        $INGEST_SKIP_TYPES, else 'anime_audio,karaoke'; none
                        drops nothing). Pass an empty string to disable
                        filtering.
  --db-path DB_PATH     LanceDB directory the ingest stage writes (default:
                        the index the bot reads: knowledge.index or
                        $LANCEDB_PATH, else the persona's index/ in the data
                        home)
`,
  actions: [
    { dest: "url_list", flags: [], kind: "store", nargs: "?", type: PATH },
    {
      dest: "stages",
      flags: ["--stages"],
      kind: "store",
      type: STAGES,
      default: [...pipeline.ALL_STAGES],
    },
    { dest: "vods_dir", flags: ["--vods-dir"], kind: "store", type: PATH },
    { dest: "streams_dir", flags: ["--streams-dir"], kind: "store", type: PATH },
    { dest: "abort_on_error", flags: ["--abort-on-error"], kind: "store_true" },
    { dest: "dry_run", flags: ["--dry-run"], kind: "store_true" },
    { dest: "persona", flags: ["--persona"], kind: "store" },
    { dest: "json", flags: ["--json"], kind: "store_true" },
    { dest: "format", flags: ["--format"], kind: "store", default: download.DEFAULT_FORMAT },
    { dest: "cookies_from_browser", flags: ["--cookies-from-browser"], kind: "store" },
    { dest: "cookies", flags: ["--cookies"], kind: "store", type: PATH },
    { dest: "yt_dlp_args", flags: ["--yt-dlp-args"], kind: "store", default: "" },
    { dest: "language", flags: ["--language"], kind: "store" },
    {
      dest: "provider",
      flags: ["--provider"],
      kind: "store",
      choices: ["soniox"],
      default: "soniox",
    },
    { dest: "soniox_model", flags: ["--soniox-model"], kind: "store" },
    { dest: "no_context", flags: ["--no-context"], kind: "store_true" },
    { dest: "context_file", flags: ["--context-file"], kind: "store", type: PATH },
    { dest: "keep_soniox_files", flags: ["--keep-soniox-files"], kind: "store_true" },
    { dest: "auto_slice", flags: ["--no-auto-slice"], kind: "store_false" },
    { dest: "slice_max_min", flags: ["--slice-max-min"], kind: "store", type: INT },
    {
      dest: "transcribe_concurrency",
      flags: ["--transcribe-concurrency"],
      kind: "store",
      type: INT,
      default: 1,
    },
    { dest: "refine_model", flags: ["--refine-model"], kind: "store" },
    {
      dest: "refine_concurrency",
      flags: ["--refine-concurrency"],
      kind: "store",
      type: CONCURRENCY,
    },
    { dest: "refine_force", flags: ["--refine-force"], kind: "store_true" },
    { dest: "skip_types", flags: ["--skip-types"], kind: "store" },
    { dest: "db_path", flags: ["--db-path"], kind: "store" },
  ],
};

export interface PipelineArgs {
  readonly ns: Namespace;
  readonly persona: string;
  readonly stages: pipeline.PipelineStage[];
  /**
   * Null for a dry run, which then plans every list's videos, and for a run without the download
   * stage, the only one that reads a list.
   */
  readonly urlList: string | null;
  /** Null when no ingest stage writes and no --db-path was given. */
  readonly dbPath: string | null;
}

/** The parsed command line. Throws ArgparseExit for -h and usage errors. */
export function parsePipelineArgs(argv: readonly string[]): PipelineArgs {
  const spec = PIPELINE_PARSER;
  const ns = parseArgs(spec, argv);
  const personaFlag = ns.persona as string | null;
  const persona = commandPersona(spec, personaFlag);
  const urlList = ns.url_list as string | null;
  const stages = ns.stages as pipeline.PipelineStage[];
  if (urlList === null && !ns.dry_run && stages.includes("download")) {
    throw parserError(spec, "the following arguments are required: url_list");
  }
  if (stages.includes("refine") && ns.refine_concurrency === null) {
    checkConcurrency(spec, refine.refineConcurrency());
  }
  const dbFlag = ns.db_path as string | null;
  // A dry run writes nothing, so it needs no --db-path beside LANCEDB_PATH; its plan reads the
  // index the bot reads.
  const dbPath =
    stages.includes("ingest") && !ns.dry_run
      ? writerDbPath(spec, dbFlag, personaFlag, persona)
      : dbFlag;
  return { ns, persona, stages, urlList, dbPath };
}

export interface PipelineDeps extends CommandDeps {
  /** Soniox's and the refine provider's fetch. */
  readonly fetch?: typeof fetch;
  /** The yt-dlp to run, and how the managed one is installed; tests fake both. */
  readonly ytDlp?: download.YtDlp;
  readonly ytDlpOptions?: download.DownloadOptions["ytDlpOptions"];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly retryDelaysMs?: readonly number[];
  /** ffprobe and ffmpeg: looked up on PATH when undefined, missing when null. */
  readonly ffprobe?: string | null;
  readonly ffmpeg?: string | null;
  readonly embeddingClient?: Pick<EmbeddingClient, "embedWithUsage">;
  readonly now?: () => Date;
}

/** `_split_extra_args`: an unbalanced quote throws, as shlex's ValueError did. */
function splitExtraArgs(raw: string): string[] {
  const text = pyStrip(raw);
  return text ? download.shlexSplit(text) : [];
}

/** A run that couldn't start: why, as a failed setup stage, then the run's or the plan's summary. */
function refused(
  emit: ProgressSink,
  summary: "pipeline" | "plan",
  stages: readonly string[],
  item: string,
  message: string,
  code?: EventCode,
): number {
  logger.error(message);
  emit({ type: "stage", stage: "setup", status: "failed", message, ...(code ? { code } : {}) });
  emit({
    type: "summary",
    stage: summary,
    ok: false,
    counts:
      summary === "plan" ? zeroCounts("plan") : { stages: stages.length, failed: 1, aborted: 0 },
    durationSec: 0,
    failures: [{ item, error: message }],
  });
  return 1;
}

/** The `laplace-pipeline` command; resolves to its exit code. */
export async function pipelineMain(
  argv: readonly string[],
  deps: PipelineDeps = {},
): Promise<number> {
  const io = resolveIo(deps);
  let args: PipelineArgs;
  try {
    args = parsePipelineArgs(argv);
  } catch (error) {
    if (error instanceof ArgparseExit) return reportExit(io, error);
    throw error;
  }
  const { ns, persona, stages, urlList, dbPath } = args;
  const json = ns.json === true;
  const dryRun = ns.dry_run === true;
  const emit = json ? ndjsonSink(io.stdout) : noProgress;
  // With --json, stdout carries only events.
  const human = json ? io.stderr : io.stdout;
  const browser = ns.cookies_from_browser as string | null;
  // An explicit empty value means no browser, as Python's `or None` read it.
  const cookiesFromBrowser =
    browser === null ? download.defaultCookiesFromBrowser() : browser || null;
  const cookiesFile = (ns.cookies as string | null) ?? download.defaultCookiesFile();
  const extraArgs = splitExtraArgs(ns.yt_dlp_args as string);
  const vodsDir = (ns.vods_dir as string | null) ?? sourceFolder(persona, "vods");
  const streamsDir = (ns.streams_dir as string | null) ?? sourceFolder(persona, "streams");
  const listsDir = sourceFolder(persona, "lists");
  const refineModel = (ns.refine_model as string | null) ?? envOptional("REFINE_MODEL") ?? null;
  const sonioxModel = (ns.soniox_model as string | null) || transcribe.configuredModel();

  // Read before any stage, so a bad path fails before Soniox bills anything. A dry run without a
  // list counts every list's videos as its download.
  let urls: string[] =
    urlList === null && stages.includes("download") ? pipeline.knownUrls(listsDir) : [];
  if (urlList !== null) {
    try {
      urls = download.readUrlList(urlList);
    } catch (error) {
      if (!(error instanceof Error && error.name === "FileNotFoundError")) throw error;
      const summary = dryRun && json ? "plan" : "pipeline";
      return refused(emit, summary, stages, urlList, errorText(error));
    }
    if (stages.includes("download") && urls.length === 0) {
      logger.warning(`No URLs in ${urlList} — download stage is a no-op.`);
    }
  }
  logger.info(`Pipeline stages: ${stages.join(", ")} (url_list=${urlList ?? "None"})`);
  if (stages.includes("ingest") && dbPath !== null) {
    logger.info(`Persona ${persona}'s index: ${canonicalPath(dbPath)}`);
  }

  if (dryRun && json) {
    const started = performance.now();
    let plan: pipeline.Plan;
    try {
      plan = await pipeline.planPipeline(persona, {
        urlList,
        vodsDir,
        streamsDir,
        listsDir,
        ...(dbPath === null ? {} : { dbPath }),
        transcribeModel: sonioxModel,
        refineModel: refineModel || refine.refineModel(),
        onProgress: emit,
        signal: deps.signal,
      });
    } catch (error) {
      if (!deps.signal?.aborted) throw error;
      emit({
        type: "summary",
        stage: "plan",
        ok: false,
        cancelled: true,
        counts: zeroCounts("plan"),
        durationSec: (performance.now() - started) / 1000,
      });
      return 1;
    }
    const summary = pipeline.planSummaryEvent(plan, (performance.now() - started) / 1000);
    const { counts } = summary;
    logger.info(
      `Planned ${counts.videos} video(s): ${counts.downloadPending} to download, ` +
        `${counts.transcribePending} to transcribe, ${counts.noDate} without an upload date, ` +
        `${counts.refinePending} chunk(s) to refine, ${counts.unindexed} not in the index`,
    );
    emit(summary);
    return 0;
  }

  let release = (): void => {};
  if (!dryRun) {
    try {
      release = acquireLock(sourcesLockKey(persona), PROG);
    } catch (error) {
      if (!(error instanceof LockedError)) throw error;
      return refused(emit, "pipeline", stages, persona, error.message, error.code);
    }
  }
  try {
    const report = await pipeline.runPipeline({
      stages,
      urlList,
      urls,
      vodsDir,
      streamsDir,
      listsDir,
      // A dry run of a pipeline without the ingest stage reads no index.
      dbPath: dbPath ?? "",
      abortOnError: ns.abort_on_error === true,
      dryRun,
      holdIndex: () => acquireLock(indexLockKey(dbPath as string), PROG),
      print: human,
      format: ns.format as string,
      cookiesFromBrowser,
      cookiesFile,
      extraArgs,
      output: json ? "events" : "inherit",
      onOutput: (line) => io.stderr(`${line}\n`),
      ytDlp: deps.ytDlp,
      ytDlpOptions: deps.ytDlpOptions,
      language: (ns.language as string | null) ?? transcribe.configuredLanguage(),
      sonioxModel,
      contextFile:
        ns.no_context === true
          ? null
          : ((ns.context_file as string | null) ?? transcribe.glossaryPath(persona)),
      keepSonioxFiles: ns.keep_soniox_files === true,
      autoSlice: ns.auto_slice === true,
      ...(ns.slice_max_min === null ? {} : { sliceMaxMin: ns.slice_max_min as number }),
      transcribeConcurrency: ns.transcribe_concurrency as number,
      ffprobe: deps.ffprobe,
      ffmpeg: deps.ffmpeg,
      sleep: deps.sleep,
      retryDelaysMs: deps.retryDelaysMs,
      refineModel,
      refineConcurrency: ns.refine_concurrency as number | null,
      refineForce: ns.refine_force === true,
      skipTypes: ns.skip_types as string | null,
      embeddingClient: deps.embeddingClient,
      fetch: deps.fetch,
      now: deps.now,
      onProgress: emit,
      signal: deps.signal,
    });
    human(pipeline.pipelineSummaryText(report, vodsDir));
    return report.ok ? 0 : 1;
  } finally {
    release();
  }
}
