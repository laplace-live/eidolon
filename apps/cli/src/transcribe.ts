// laplace-transcribe: turns audio into a transcript of timestamped scenes with Soniox.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  envOptional,
  errorText,
  logger,
  pyPath,
  pyPathName,
  pyPathStem,
  pyPathWithSuffix,
  sourceFolder,
} from "@eidolon/config";
import {
  acquireLock,
  LockedError,
  ndjsonSink,
  noProgress,
  type ProgressEvent,
  type ProgressSink,
  type SUMMARY_COUNTS,
  sourcesLockKey,
  transcribe,
  transcriptPath,
} from "@eidolon/ingest";
import { ingestHint } from "@eidolon/retrieval";
import {
  ArgparseExit,
  commandPersona,
  INT,
  type Namespace,
  PATH,
  type ParserSpec,
  parseArgs,
} from "./argparse.ts";
import { type CommandDeps, reportExit, resolveIo } from "./io.ts";

const USAGE = `usage: laplace-transcribe [-h] [--provider {soniox}] [--date DATE]
                          [--language LANGUAGE] [--window WINDOW]
                          [--out-dir OUT_DIR] [--persona PERSONA] [--force]
                          [--json] [--soniox-model SONIOX_MODEL]
                          [--keep-soniox-files] [--context-file CONTEXT_FILE]
                          [--no-context] [--auto-slice]
                          [--slice-max-min SLICE_MAX_MIN]
                          audio
`;

export const TRANSCRIBE_PARSER: ParserSpec = {
  prog: "laplace-transcribe",
  usage: USAGE,
  help: `${USAGE}
Transcribe a VOD audio/video file into a streams/*.md transcript.

positional arguments:
  audio                 VOD file (mp3, m4a, mp4, wav, ...)

options:
  -h, --help            show this help message and exit
  --provider {soniox}   Transcription backend (default: soniox, cloud).
  --date DATE           Stream date YYYY-MM-DD (default: today)
  --language LANGUAGE   ISO 639-1 code (e.g. 'en', 'zh'), sent to Soniox as a
                        language hint (the model still auto-detects). Default:
                        zh (this project is Mandarin-focused). Pass --language
                        '' for no hint.
  --window WINDOW       Scene window in seconds (default: 300 = 5 minutes)
  --out-dir OUT_DIR     Output directory (default: the persona's streams/ in
                        the data home's sources)
  --persona PERSONA     Persona whose sources and glossary to use (default:
                        the active persona)
  --force               Transcribe again over an existing transcript (Soniox
                        bills again)
  --json                Report progress as JSON lines on stdout

soniox provider:
  --soniox-model SONIOX_MODEL
                        Soniox async STT model (default: the
                        transcription.model setting, else stt-async-v5)
  --keep-soniox-files   Don't delete the uploaded file + transcription record
                        from Soniox after success. Default is to clean up so
                        the 10GB / 1000-file quota stays open.
  --context-file CONTEXT_FILE
                        TOML file with structured context (glossary + domain
                        hints) passed to Soniox to improve accuracy. Mirrors
                        Soniox's StructuredContext schema. Defaults to the
                        persona's glossary.toml. Missing file is fine — the
                        run just goes out without context.
  --no-context          Skip the context file even if it exists. Useful for
                        clean A/B comparisons or when you want to confirm a
                        transcription issue is not caused by your glossary.
  --auto-slice          When the source audio exceeds Soniox's 300-min per-
                        file cap, split it with ffmpeg into multiple parts,
                        transcribe each independently, and merge the segments
                        + tokens with offset timestamps. Original file is
                        never modified — slices live in a temp directory and
                        are wiped on exit. Default off so the existing fail-
                        fast behavior is preserved for one-off runs.
  --slice-max-min SLICE_MAX_MIN
                        Max minutes per slice when --auto-slice is on
                        (default: 280). Must be ≤ 300. Lower values produce
                        more parts and more Soniox jobs but tolerate more
                        drift from ffmpeg's keyframe-bounded cuts.
`,
  actions: [
    { dest: "audio", flags: [], kind: "store", type: PATH },
    {
      dest: "provider",
      flags: ["--provider"],
      kind: "store",
      choices: ["soniox"],
      default: "soniox",
    },
    { dest: "date", flags: ["--date"], kind: "store" },
    { dest: "language", flags: ["--language"], kind: "store", default: "zh" },
    { dest: "window", flags: ["--window"], kind: "store", type: INT, default: 300 },
    { dest: "out_dir", flags: ["--out-dir"], kind: "store", type: PATH },
    { dest: "persona", flags: ["--persona"], kind: "store" },
    { dest: "force", flags: ["--force"], kind: "store_true" },
    { dest: "json", flags: ["--json"], kind: "store_true" },
    { dest: "soniox_model", flags: ["--soniox-model"], kind: "store" },
    { dest: "keep_soniox_files", flags: ["--keep-soniox-files"], kind: "store_true" },
    { dest: "context_file", flags: ["--context-file"], kind: "store", type: PATH },
    { dest: "no_context", flags: ["--no-context"], kind: "store_true" },
    { dest: "auto_slice", flags: ["--auto-slice"], kind: "store_true" },
    {
      dest: "slice_max_min",
      flags: ["--slice-max-min"],
      kind: "store",
      type: INT,
      default: transcribe.SLICE_MAX_MIN_DEFAULT,
    },
  ],
};

export interface TranscribeDeps extends CommandDeps {
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** ffprobe and ffmpeg: found on PATH when undefined, missing when null. */
  readonly ffprobe?: string | null;
  readonly ffmpeg?: string | null;
  /** `date.today().isoformat()`: the local date `--date` defaults to. */
  readonly today?: () => string;
}

function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function parentOf(path: string): string {
  const normalized = pyPath(path);
  const slash = normalized.lastIndexOf("/");
  if (slash === -1) return ".";
  return slash === 0 ? "/" : normalized.slice(0, slash);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Python's hint for a missing audio file: BLREC names are long and full of CJK, so a dropped `!!`
 * or `_1` is near-invisible; the siblings that nearly match are offered instead.
 */
function reportMissingAudio(audio: string): void {
  logger.error(`Audio file not found: ${audio}`);
  const parent = parentOf(audio);
  if (!existsSync(parent)) {
    logger.error(`Parent directory also missing: ${parent}`);
    return;
  }
  try {
    const names = readdirSync(parent).filter((name) => isFile(join(parent, name)));
    const hints = transcribe.closeMatches(pyPathName(audio), names, 5, 0.5);
    if (hints.length === 0) return;
    logger.error("Did you mean one of these (in the same directory)?");
    for (const hint of hints) logger.error(`  ${pyPath(`${parent}/${hint}`)}`);
  } catch {
    // A hint only; an unreadable folder has none to give.
  }
}

type Counts = Record<(typeof SUMMARY_COUNTS.transcribe)[number], number>;

/** The `laplace-transcribe` command; resolves to its exit code. */
export async function transcribeMain(
  argv: readonly string[],
  deps: TranscribeDeps = {},
): Promise<number> {
  const io = resolveIo(deps);
  let ns: Namespace;
  let persona: string;
  try {
    ns = parseArgs(TRANSCRIBE_PARSER, argv);
    persona = commandPersona(TRANSCRIBE_PARSER, ns.persona as string | null);
  } catch (error) {
    if (error instanceof ArgparseExit) return reportExit(io, error);
    throw error;
  }
  const started = performance.now();
  const emit: ProgressSink = ns.json === true ? ndjsonSink(io.stdout) : noProgress;
  const audio = ns.audio as string;
  const name = pyPathName(audio);
  const item = { type: "item", stage: "transcribe", item: name, video: pyPathStem(audio) } as const;
  const counts: Counts = {
    total: 1,
    skipped: 0,
    skippedNoDate: 0,
    succeeded: 0,
    failed: 0,
    noSpeech: 0,
  };
  const finish = (
    code: number,
    status: "done" | "failed" | "cancelled",
    extra: Partial<Extract<ProgressEvent, { type: "summary" }>> = {},
    stage: Partial<Extract<ProgressEvent, { type: "stage" }>> = {},
  ): number => {
    emit({ type: "stage", stage: "transcribe", status, ...stage });
    emit({
      type: "summary",
      stage: "transcribe",
      ok: code === 0,
      counts,
      durationSec: (performance.now() - started) / 1000,
      ...extra,
    });
    return code;
  };
  const fail = (message: string, stage: Partial<Extract<ProgressEvent, { type: "stage" }>> = {}) =>
    finish(1, "failed", { failures: [{ item: name, error: message }] }, stage);
  emit({ type: "stage", stage: "transcribe", status: "start", total: 1 });

  if (!existsSync(audio)) {
    reportMissingAudio(audio);
    counts.failed = 1;
    emit({ ...item, status: "failed", message: `Audio file not found: ${audio}` });
    return fail(`Audio file not found: ${audio}`);
  }

  let release: () => void;
  try {
    release = acquireLock(sourcesLockKey(persona), "transcribe");
  } catch (error) {
    if (!(error instanceof LockedError)) throw error;
    logger.error(error.message);
    return fail(error.message, { code: "locked", message: error.message });
  }
  try {
    const date = (ns.date as string | null) ?? (deps.today ?? localToday)();
    const outDir = (ns.out_dir as string | null) ?? sourceFolder(persona, "streams");
    const stem = pyPathStem(audio);
    const force = ns.force === true;
    const state = transcribe.transcriptState(outDir, date, stem);
    if (state !== "pending" && !force) {
      const message =
        state === "done"
          ? `${transcriptPath(outDir, date, stem)} already exists`
          : `${transcribe.payloadPath(outDir, date, stem)} records no speech in ${name}`;
      logger.error(`${message}; pass --force to transcribe it again (Soniox bills again).`);
      counts.skipped = 1;
      emit({
        ...item,
        status: "skipped",
        message,
        ...(state === "no-speech" ? { code: "no-speech" } : {}),
      });
      return finish(1, "done", { failures: [{ item: name, error: `${message}; pass --force` }] });
    }
    const sidecar = pyPathWithSuffix(transcriptPath(outDir, date, stem), ".refined.json");
    if (state === "done" && existsSync(sidecar)) {
      logger.warning(
        `${sidecar} refines the transcript being replaced; run laplace-refine --force after this.`,
      );
    }

    const apiKey = envOptional("SONIOX_API_KEY");
    if (!apiKey) {
      const message =
        "SONIOX_API_KEY is not set. Add it to credentials.json or .env (it's the same key the " +
        "bot's realtime STT uses).";
      logger.error(message);
      counts.failed = 1;
      emit({ ...item, status: "failed", code: "missing-credential", message });
      return fail(message, { code: "missing-credential", message });
    }
    const model = (ns.soniox_model as string | null) ?? transcribe.configuredModel();
    let result: transcribe.TranscribeResult;
    try {
      result = await transcribe.transcribeAudio({
        audioPath: audio,
        date,
        outDir,
        apiKey,
        model,
        language: ns.language as string,
        windowSec: ns.window as number,
        contextFile:
          ns.no_context === true
            ? null
            : ((ns.context_file as string | null) ?? transcribe.glossaryPath(persona)),
        keepFiles: ns.keep_soniox_files === true,
        autoSlice: ns.auto_slice === true,
        sliceMaxMin: ns.slice_max_min as number,
        index: 1,
        total: 1,
        fetch: deps.fetch,
        sleep: deps.sleep,
        ffprobe: deps.ffprobe,
        ffmpeg: deps.ffmpeg,
        onProgress: emit,
        signal: deps.signal,
      });
    } catch (error) {
      if (deps.signal?.aborted) {
        return finish(1, "cancelled", { cancelled: true }, { code: "cancelled" });
      }
      if (
        !(error instanceof transcribe.TranscribeError || error instanceof transcribe.SonioxError)
      ) {
        throw error;
      }
      logger.error(errorText(error));
      counts.failed = 1;
      return fail(errorText(error));
    }
    const cost =
      result.costUsd === null
        ? { costSource: "unpriced" as const }
        : { costUsd: result.costUsd, costSource: "estimated" as const };
    if (result.status === "no-speech") {
      counts.noSpeech = 1;
      return finish(0, "done", cost);
    }
    counts.succeeded = 1;
    logger.info(
      "Next: hand-edit the H2 headings to be more descriptive, then run:\n" +
        `    ${ingestHint("laplace-ingest-streams", persona)}`,
    );
    return finish(0, "done", cost);
  } finally {
    release();
  }
}
