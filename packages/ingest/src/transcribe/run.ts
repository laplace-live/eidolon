// One audio file through Soniox into `<date>-<stem>.soniox.json` and its transcript `.md`, and the
// skip rules the pipeline and its plan share with the laplace-transcribe command.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cpLen,
  cpSlice,
  envOptional,
  envStr,
  errorText,
  logger,
  PyFloat,
  pyFixed,
  pyJsonDumps,
  pyNumber,
  pyPath,
  pyPathName,
  pyPathStem,
  pyPathSuffix,
  pyRepr,
  pyStr,
  raceAbort,
  resolvePersonaPath,
  sortedPy,
} from "@eidolon/config";
import { failureOf } from "../failure.ts";
import { writeTextAtomic } from "../paths.ts";
import { noProgress, type RunOptions } from "../progress.ts";
import {
  AUDIO_EXTENSIONS,
  infoJsonPath,
  readUploadDate,
  streamId,
  transcriptPath,
} from "../streams.ts";
import { apiContext, loadContext, type SonioxContext, summarizeContext } from "./context.ts";
import { TranscribeError } from "./errors.ts";
import {
  ffmpegMissing,
  ffmpegSlice,
  infoJsonDurationSec,
  locateBinary,
  probeDurationSec,
} from "./media.ts";
import {
  DEFAULT_WINDOW_SEC,
  formatDur,
  formatTs,
  groupSegmentsIntoScenes,
  payloadSegments,
  renderMarkdown,
  type Segment,
  type SlicePart,
  type SonioxToken,
  segmentsFromParts,
  slicedDurationSec,
  type TokenPart,
  tokensToSegments,
} from "./render.ts";
import { SonioxClient } from "./soniox.ts";

export const DEFAULT_SONIOX_MODEL = "stt-async-v5";
export const DEFAULT_LANGUAGE = "zh";
/** Soniox's per-file cap, checked before the upload so an oversized file fails first. */
export const SONIOX_MAX_DURATION_MIN = 300;
// 280 leaves ~20 min of headroom for server-side measurement drift and container padding, and still
// yields only 2 parts for a typical 300-340 min VOD.
export const SLICE_MAX_MIN_DEFAULT = 280;
const POLL_INTERVAL_MS = 5_000;
const STATUS_LOG_EVERY_MS = 10_000;
// Soniox bills async transcription by the hour of audio.
const USD_PER_AUDIO_HOUR: Readonly<Record<string, number>> = {
  "stt-async-v4": 0.1,
  "stt-async-v5": 0.1,
  "stt-async-v6": 0.1,
};
// What deleting Soniox's copies may take once a run is cancelled; the CLI quits at 10 s.
const CANCEL_CLEANUP_MS = 8_000;
// The SDK's limit on `client_reference_id`, in code points.
const REFERENCE_ID_MAX = 256;
const TOKEN_FIELDS = [
  "text",
  "start_ms",
  "end_ms",
  "confidence",
  "is_final",
  "speaker",
  "translation_status",
  "language",
  "source_language",
];

export interface TranscribeOptions extends RunOptions {
  readonly audioPath: string;
  /** The stream date as given: with the audio's stem it names the stream for good. */
  readonly date: string;
  /** The streams folder the payload and the transcript go to. */
  readonly outDir: string;
  readonly apiKey: string;
  readonly model?: string;
  /**
   * Soniox's language hint (`zh` by default); `''` or null sends none, as `--language ''` does,
   * and the frontmatter omits it.
   */
  readonly language?: string | null;
  readonly windowSec?: number;
  /** The glossary; null runs without one. */
  readonly contextFile?: string | null;
  /** Leave each transcription and its upload on Soniox; an upload with none is deleted anyway. */
  readonly keepFiles?: boolean;
  /** Cut audio over SONIOX_MAX_DURATION_MIN into parts, instead of failing. */
  readonly autoSlice?: boolean;
  readonly sliceMaxMin?: number;
  /** Stamped on the item events of a run over many files. */
  readonly index?: number;
  readonly total?: number;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly retryDelaysMs?: readonly number[];
  /** ffprobe and ffmpeg: found on PATH when undefined, missing when null. */
  readonly ffprobe?: string | null;
  readonly ffmpeg?: string | null;
}

export interface TranscribeResult {
  /** "no-speech": Soniox found nothing to render, so only the payload was written. */
  readonly status: "done" | "no-speech";
  readonly streamId: string;
  readonly mdPath: string;
  readonly payloadPath: string;
  readonly scenes: number;
  readonly tokens: number;
  /** The audio Soniox processed, in seconds. */
  readonly durationSec: number;
  /** What the run cost by Soniox's price list; null for a model the list lacks. */
  readonly costUsd: number | null;
}

/** Where a transcription stands: "no-speech" counts as done, so it is billed once. */
export type TranscriptState = "pending" | "done" | "no-speech";

/** The raw Soniox payload beside the transcript: `<streamsDir>/<date>-<stem>.soniox.json`. */
export function payloadPath(streamsDir: string, date: string, audioStem: string): string {
  return pyPath(`${streamsDir}/${streamId(date, audioStem)}.soniox.json`);
}

/**
 * "done" once the transcript exists; "no-speech" once a payload records that Soniox found nothing
 * to render; else "pending".
 */
export function transcriptState(
  streamsDir: string,
  date: string,
  audioStem: string,
): TranscriptState {
  if (existsSync(transcriptPath(streamsDir, date, audioStem))) return "done";
  const payload = payloadPath(streamsDir, date, audioStem);
  if (!existsSync(payload)) return "pending";
  try {
    const parsed: unknown = JSON.parse(readFileSync(payload, "utf8"));
    return payloadSegments(parsed).length === 0 ? "no-speech" : "pending";
  } catch {
    return "pending";
  }
}

export type AudioStatus =
  /** The audio's `.info.json` names no upload date, which the stream id needs. */
  | { readonly state: "no-date" }
  | {
      readonly state: TranscriptState;
      readonly date: string;
      readonly mdPath: string;
      readonly payloadPath: string;
    };

/** The pipeline's rule: a downloaded audio file is named by its upload date, and skipped without one. */
export function audioStatus(audioPath: string, streamsDir: string): AudioStatus {
  const date = readUploadDate(audioPath);
  if (date === null) return { state: "no-date" };
  const stem = pyPathStem(audioPath);
  return {
    state: transcriptState(streamsDir, date, stem),
    date,
    mdPath: transcriptPath(streamsDir, date, stem),
    payloadPath: payloadPath(streamsDir, date, stem),
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The files directly in `vodsDir` with an audio suffix (case-sensitive), in name order. */
export function listAudioFiles(vodsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(vodsDir);
  } catch {
    return [];
  }
  return sortedPy(names)
    .filter((name) => AUDIO_EXTENSIONS.has(pyPathSuffix(name)) && isFile(join(vodsDir, name)))
    .map((name) => pyPath(`${vodsDir}/${name}`));
}

/** The model a run uses unless told otherwise: the transcription.model setting, else the default. */
export function configuredModel(): string {
  return envStr("SONIOX_ASYNC_MODEL", DEFAULT_SONIOX_MODEL);
}

export const MISSING_API_KEY =
  "SONIOX_API_KEY is not set. Add it to credentials.json or .env (it's the same key the bot's " +
  "realtime STT uses).";

/** SONIOX_API_KEY; undefined when it isn't set. */
export function sonioxApiKey(): string | undefined {
  return envOptional("SONIOX_API_KEY");
}

/**
 * The language hint a run sends unless told otherwise: the transcription.language setting
 * (TRANSCRIBE_LANGUAGE), where `none` sends none, else zh.
 */
export function configuredLanguage(): string {
  const value = envOptional("TRANSCRIBE_LANGUAGE");
  if (value === undefined) return DEFAULT_LANGUAGE;
  return value === "none" ? "" : value;
}

/** A persona's glossary: her own glossary.toml, else her template's. */
export function glossaryPath(persona: string): string {
  return resolvePersonaPath(persona, "glossary.toml");
}

/** What `durationSec` of audio costs with `model`, or null for a model without a known price. */
export function estimateTranscribeUsd(durationSec: number, model: string): number | null {
  const rate = USD_PER_AUDIO_HOUR[model];
  return rate === undefined ? null : (durationSec / 3600) * rate;
}

/**
 * Transcribes one audio file with Soniox and writes the payload, then the transcript, each
 * atomically. Audio Soniox finds no speech in gets only its payload. Emits the file's item events;
 * throws a TranscribeError or a SonioxError on failure, and the signal's reason once cancelled.
 */
export async function transcribeAudio(options: TranscribeOptions): Promise<TranscribeResult> {
  const onProgress = options.onProgress ?? noProgress;
  const item = {
    type: "item",
    stage: "transcribe",
    item: pyPathName(options.audioPath),
    video: pyPathStem(options.audioPath),
    ...(options.index === undefined ? {} : { index: options.index }),
    ...(options.total === undefined ? {} : { total: options.total }),
  } as const;
  onProgress({ ...item, status: "start" });
  try {
    const result = await transcribe(options);
    onProgress({
      ...item,
      status: "done",
      ...(result.status === "no-speech"
        ? { code: "no-speech", message: "no speech" }
        : { message: `${result.scenes} scenes` }),
      ...(result.costUsd === null ? {} : { costUsd: result.costUsd }),
    });
    return result;
  } catch (error) {
    if (options.signal?.aborted) {
      onProgress({ ...item, status: "cancelled", code: "cancelled" });
      throw options.signal.reason;
    }
    onProgress({
      ...item,
      status: "failed",
      message: errorText(error),
      ...failureOf(error, "soniox"),
    });
    throw error;
  }
}

/** One upload on Soniox and the transcription made from it, deleted once the run is over. */
interface Job {
  fileId: string | null;
  transcriptionId: string | null;
}

interface Session {
  readonly client: SonioxClient;
  readonly model: string;
  readonly languageHints: string[] | null;
  readonly context: SonioxContext | null;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal: AbortSignal | undefined;
  readonly jobs: Job[];
}

interface Outcome {
  readonly payload: Record<string, unknown>;
  readonly segments: Segment[];
  readonly tokens: number;
  readonly durationSec: number;
}

async function transcribe(options: TranscribeOptions): Promise<TranscribeResult> {
  const { audioPath: audio, outDir, date, signal } = options;
  const name = pyPathName(audio);
  const stem = pyPathStem(audio);
  const model = options.model ?? DEFAULT_SONIOX_MODEL;
  const language = options.language === undefined ? DEFAULT_LANGUAGE : options.language || null;
  const windowSec = options.windowSec ?? DEFAULT_WINDOW_SEC;
  // Both fail in Python too, but only after Soniox has been paid (the window) or with a traceback.
  if (language !== null && cpLen(language) !== 2) {
    throw new TranscribeError(
      `Soniox takes two-letter ISO 639-1 language hints, not ${pyRepr(language)}; ` +
        "pass --language '' for none.",
    );
  }
  if (!(windowSec > 0)) {
    throw new TranscribeError(
      `The scene window must be a positive number of seconds, not ${windowSec}.`,
    );
  }
  mkdirSync(outDir, { recursive: true });

  let durationSec = await probeDurationSec(audio, { ffprobe: options.ffprobe, signal });
  if (durationSec === null) {
    durationSec = infoJsonDurationSec(audio);
    if (durationSec !== null) {
      logger.info(
        `ffprobe gave no duration for ${name}; ${pyPathName(infoJsonPath(audio))} says ${durationSec}s`,
      );
    }
  }
  let slices: SlicePlan | null = null;
  if (durationSec !== null && durationSec / 60 > SONIOX_MAX_DURATION_MIN) {
    if (!options.autoSlice) {
      throw new TranscribeError(
        `Audio is ${pyFixed(durationSec / 60, 1)} min — Soniox caps async jobs at ` +
          `${SONIOX_MAX_DURATION_MIN} min per file. Re-run with --auto-slice to chunk it via ffmpeg.`,
      );
    }
    slices = slicePlan(name, durationSec, options.sliceMaxMin ?? SLICE_MAX_MIN_DEFAULT);
    if (!locateBinary(options.ffmpeg, "ffmpeg")) throw ffmpegMissing();
  }

  const contextFile = options.contextFile ?? null;
  const context = loadContext(contextFile);
  if (context !== null) {
    logger.info(`Soniox context: ${summarizeContext(context)} (from ${contextFile})`);
  }
  const session: Session = {
    client: new SonioxClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      sleep: options.sleep,
      retryDelaysMs: options.retryDelaysMs,
    }),
    model,
    languageHints: language === null ? null : [language],
    context,
    sleep: options.sleep ?? Bun.sleep,
    signal,
    jobs: [],
  };
  try {
    const outcome =
      slices === null
        ? await transcribeWhole(session, audio, durationSec)
        : await transcribeSliced(session, audio, slices, options.ffmpeg);
    // The payload first: it holds everything the transcript renders from, and the transcript
    // stays the mark of a finished stream.
    const scenes = groupSegmentsIntoScenes(outcome.segments, windowSec);
    const id = streamId(date, stem);
    const payloadFile = payloadPath(outDir, date, stem);
    const mdPath = transcriptPath(outDir, date, stem);
    const payloadText = pyJsonDumps(outcome.payload, { ensureAscii: false, indent: 2 });
    writeTextAtomic(payloadFile, payloadText);
    logger.info(
      `Wrote raw soniox payload to ${payloadFile} (${Math.floor(Buffer.byteLength(payloadText) / 1024)} KB)`,
    );
    if (scenes.length > 0) {
      const meta = {
        streamDate: date,
        streamId: id,
        durationMin: Math.trunc(outcome.durationSec / 60),
        sourceFile: name,
        language,
      };
      writeTextAtomic(mdPath, renderMarkdown(meta, scenes));
      logger.info(`Wrote ${mdPath} (${scenes.length} scenes via soniox)`);
    } else {
      if (existsSync(mdPath)) {
        unlinkSync(mdPath);
        logger.warning(`Removed ${mdPath}: the new transcript has no speech in it`);
      }
      logger.warning(
        `No speech in ${name}: ${payloadFile} records that, so it isn't transcribed or billed again.`,
      );
    }
    return {
      status: scenes.length > 0 ? "done" : "no-speech",
      streamId: id,
      mdPath,
      payloadPath: payloadFile,
      scenes: scenes.length,
      tokens: outcome.tokens,
      durationSec: outcome.durationSec,
      costUsd: estimateTranscribeUsd(outcome.durationSec, model),
    };
  } finally {
    await deleteJobs(session, options.keepFiles === true);
  }
}

async function transcribeWhole(
  session: Session,
  audio: string,
  probedSec: number | null,
): Promise<Outcome> {
  const job = await runJob(session, audio, `laplace-eidolon:${pyPathName(audio)}`, probedSec);
  return {
    payload: job.payload,
    segments: job.segments,
    tokens: job.tokens.length,
    durationSec: job.serverDurationSec || probedSec || 0,
  };
}

interface SlicePlan {
  readonly durationSec: number;
  readonly sliceMaxMin: number;
  readonly parts: number;
  readonly partSec: number;
}

function slicePlan(name: string, durationSec: number, sliceMaxMin: number): SlicePlan {
  if (!(sliceMaxMin > 0 && sliceMaxMin <= SONIOX_MAX_DURATION_MIN)) {
    throw new TranscribeError(
      `--slice-max-min must be in (0, ${SONIOX_MAX_DURATION_MIN}], got ${sliceMaxMin}`,
    );
  }
  const parts = Math.ceil(durationSec / (sliceMaxMin * 60));
  // An even split costs the same (Soniox bills per second) but makes progress steadier than
  // N-1 full parts and a tiny tail.
  const partSec = durationSec / parts;
  logger.info(
    `Auto-slicing ${name}: ${pyFixed(durationSec / 60, 1)} min → ${parts} parts × ` +
      `~${pyFixed(partSec / 60, 1)} min (cap=${sliceMaxMin} min/part)`,
  );
  return { durationSec, sliceMaxMin, parts, partSec };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * One Soniox job per part, one at a time. Each part's segments are grouped on its own timeline
 * and then shifted, so none spans a cut; its tokens are shifted too, so the payload re-renders.
 */
async function transcribeSliced(
  session: Session,
  audio: string,
  plan: SlicePlan,
  ffmpeg: string | null | undefined,
): Promise<Outcome> {
  const name = pyPathName(audio);
  const suffix = pyPathSuffix(audio) || ".m4a";
  const parts: TokenPart[] = [];
  const records: Record<string, unknown>[] = [];
  const tokens: Record<string, unknown>[] = [];
  const texts: string[] = [];
  const measured: SlicePart[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "laplace-slice-"));
  try {
    for (let i = 0; i < plan.parts; i++) {
      session.signal?.throwIfAborted();
      const offsetSec = i * plan.partSec;
      // The last part absorbs the rounding remainder, so the whole source is covered.
      const partDurSec = i === plan.parts - 1 ? plan.durationSec - offsetSec : plan.partSec;
      const partName = `part_${pad2(i + 1)}_of_${pad2(plan.parts)}${suffix}`;
      const partPath = join(tmp, partName);
      logger.info(
        `[part ${i + 1}/${plan.parts}] slicing ${formatTs(offsetSec)} + ${formatTs(partDurSec)} → ${partName}`,
      );
      await ffmpegSlice(
        audio,
        { startSec: offsetSec, durationSec: partDurSec, outPath: partPath },
        { ffmpeg, signal: session.signal },
      );
      const job = await runJob(
        session,
        partPath,
        `laplace-eidolon:${name}:part_${i + 1}_of_${plan.parts}`,
        partDurSec,
      );
      parts.push({ offsetSec, tokens: job.tokens });
      const transcript = job.payload.transcript as {
        id: unknown;
        text: string;
        tokens: Record<string, unknown>[];
      };
      const offsetMs = Math.trunc(offsetSec * 1000);
      for (const token of transcript.tokens) {
        if (token.start_ms !== null) token.start_ms = (token.start_ms as number) + offsetMs;
        if (token.end_ms !== null) token.end_ms = (token.end_ms as number) + offsetMs;
        tokens.push(token);
      }
      if (transcript.text) texts.push(transcript.text);
      measured.push({ audioDurationMs: job.serverMs, durationSec: partDurSec });
      records.push({
        part_index: i + 1,
        part_count: plan.parts,
        offset_sec: new PyFloat(offsetSec),
        duration_sec: new PyFloat(partDurSec),
        transcription_id: job.payload.transcription_id,
        audio_filename: job.payload.audio_filename,
        audio_duration_ms: job.payload.audio_duration_ms,
        created_at: job.payload.created_at,
        transcript_id: transcript.id,
      });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const segments = segmentsFromParts(parts, true);
  const durationSec = slicedDurationSec(measured) || plan.durationSec;
  logger.info(
    `Merged ${plan.parts} parts: ${segments.length} segments, ${tokens.length} tokens, ` +
      `${formatTs(durationSec)} total`,
  );
  return {
    payload: {
      provider: "soniox",
      sliced: true,
      slice_max_min: plan.sliceMaxMin,
      model: session.model,
      language_hints: session.languageHints,
      context: session.context,
      audio_filename: name,
      audio_duration_ms: Math.trunc(durationSec * 1000),
      parts: records,
      transcript: {
        // A sliced run has no one transcript id; the first part's stands in.
        id: records[0]?.transcript_id ?? null,
        text: texts.join(""),
        tokens,
      },
    },
    segments,
    tokens: tokens.length,
    durationSec,
  };
}

interface JobResult {
  /** The tokens as Soniox sent them, on the job's own timeline. */
  readonly tokens: readonly SonioxToken[];
  readonly segments: Segment[];
  /** The job's .soniox.json. */
  readonly payload: Record<string, unknown>;
  /** Soniox's measurement of the audio, else the probed length. */
  readonly serverDurationSec: number;
  readonly serverMs: number | null;
}

/** Upload, create, poll until done, fetch the transcript. */
async function runJob(
  session: Session,
  path: string,
  clientReferenceId: string,
  probedSec: number | null,
): Promise<JobResult> {
  const { client, signal } = session;
  logger.info(
    `Uploading ${pyFixed(statSync(path).size / (1024 * 1024), 1)} MB to Soniox ` +
      `(model=${session.model}, language_hints=${pyRepr(session.languageHints)})…`,
  );
  const started = performance.now();
  const job: Job = { fileId: null, transcriptionId: null };
  session.jobs.push(job);
  const referenceId = cpSlice(clientReferenceId, 0, REFERENCE_ID_MAX);
  const file = await client.upload(path, pyPathName(path), referenceId, signal);
  job.fileId = file.id;
  const body: Record<string, unknown> = { model: session.model, file_id: file.id };
  if (session.languageHints !== null) body.language_hints = session.languageHints;
  if (session.context !== null) body.context = apiContext(session.context);
  body.client_reference_id = referenceId;
  const created = await client.createTranscription(body, signal);
  job.transcriptionId = created.id;
  logger.info(`Job submitted: id=${created.id}, status=${created.status}. Polling every 5s…`);

  let lastStatus: string | null = null;
  let lastLog = performance.now();
  let polled = created;
  for (;;) {
    polled = await client.getTranscription(created.id, signal);
    const now = performance.now();
    if (polled.status !== lastStatus || now - lastLog >= STATUS_LOG_EVERY_MS) {
      lastLog = now;
      lastStatus = polled.status;
      const audio = polled.audio_duration_ms
        ? `, audio=${formatTs(polled.audio_duration_ms / 1000)}`
        : "";
      logger.info(
        `  status=${polled.status}  elapsed ${formatDur((now - started) / 1000)}${audio}`,
      );
    }
    if (polled.status === "completed") break;
    if (polled.status === "error") {
      throw new TranscribeError(
        `Soniox job failed: ${pyStr(polled.error_type)}: ${pyStr(polled.error_message)}`,
      );
    }
    await raceAbort(session.sleep(POLL_INTERVAL_MS), signal);
  }

  const transcript = await client.getTranscript(created.id, signal);
  const segments = tokensToSegments(transcript.tokens);
  const elapsedSec = (performance.now() - started) / 1000;
  // Soniox's measurement of what it processed beats the local probe.
  const serverDurationSec = polled.audio_duration_ms
    ? polled.audio_duration_ms / 1000
    : probedSec || 0;
  if (serverDurationSec > 0 && elapsedSec > 0) {
    logger.info(
      `Soniox done: ${transcript.tokens.length} tokens → ${segments.length} segments, ` +
        `${formatTs(serverDurationSec)} of audio in ${formatDur(elapsedSec)} ` +
        `(${pyFixed(serverDurationSec / elapsedSec, 2)}x realtime)`,
    );
  }
  return {
    tokens: transcript.tokens,
    segments,
    payload: {
      provider: "soniox",
      transcription_id: created.id,
      // The model asked for, not the one Soniox routed it to.
      model: session.model,
      language_hints: session.languageHints,
      // The context exactly as sent, so editing the glossary leaves old transcripts explainable.
      context: session.context,
      audio_filename: polled.filename,
      audio_duration_ms: polled.audio_duration_ms,
      created_at: polled.created_at === null ? null : isoformat(polled.created_at),
      transcript: {
        id: transcript.id,
        text: transcript.text,
        tokens: transcript.tokens.map(dumpToken),
      },
    },
    serverDurationSec,
    serverMs: polled.audio_duration_ms,
  };
}

/**
 * A token as the Python SDK dumped it: its nine fields first, null where Soniox sent none, with
 * `confidence` a float; then whatever else Soniox sent, in Soniox's order.
 */
export function dumpToken(token: SonioxToken): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of TOKEN_FIELDS) {
    const value = Object.hasOwn(token, key) ? token[key] : null;
    if (key === "confidence" && typeof value === "number") out[key] = new PyFloat(value);
    else if (key === "start_ms" || key === "end_ms") out[key] = pyNumber(value);
    else out[key] = value ?? null;
  }
  for (const [key, value] of Object.entries(token)) {
    if (!TOKEN_FIELDS.includes(key)) out[key] = value;
  }
  return out;
}

const TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:[.,](\d+))?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * Python's `datetime.isoformat()` of a timestamp Soniox sent: microseconds only when non-zero,
 * and UTC as `+00:00`. Date would drop the microseconds.
 */
export function isoformat(value: string): string {
  const match = TIMESTAMP.exec(value);
  if (!match) return value;
  const [, date, time, fraction = "", zone] = match;
  const micros = fraction.slice(0, 6).padEnd(6, "0");
  const frac = /^0+$/.test(micros) ? "" : `.${micros}`;
  let offset = "";
  if (zone !== undefined) {
    const digits = zone.replace(":", "");
    offset = /^[Zz]$|^[+-]00(00)?$/.test(digits)
      ? "+00:00"
      : `${digits.slice(0, 3)}:${digits.slice(3, 5).padEnd(2, "0")}`;
  }
  return `${date}T${time}${frac}${offset}`;
}

/** A signal that gives a cancelled run's cleanup CANCEL_CLEANUP_MS, and an uncancelled one all it needs. */
function cleanupSignal(run: AbortSignal | undefined): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    timer = setTimeout(
      () => controller.abort(new DOMException("Cleanup ran out of time", "TimeoutError")),
      CANCEL_CLEANUP_MS,
    );
  };
  if (run?.aborted) arm();
  else run?.addEventListener("abort", arm, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      run?.removeEventListener("abort", arm);
    },
  };
}

/**
 * Deletes the transcriptions and uploads the run made, keeping Soniox's 1,000-file and 10 GB caps
 * clear; `keep` spares each transcription and its upload, never an upload without one. A
 * transcription still processing can't be deleted (Soniox answers 409); its upload is deleted
 * anyway, and Soniox removes the rest after 30 days.
 */
async function deleteJobs(session: Session, keep: boolean): Promise<void> {
  const jobs = keep ? session.jobs.filter((job) => job.transcriptionId === null) : session.jobs;
  if (jobs.length === 0) return;
  const deadline = cleanupSignal(session.signal);
  try {
    await Promise.all(jobs.map((job) => deleteJob(session.client, job, deadline.signal)));
  } finally {
    deadline.dispose();
  }
}

async function deleteJob(client: SonioxClient, job: Job, signal: AbortSignal): Promise<void> {
  let clean = true;
  if (job.transcriptionId !== null) {
    try {
      await client.deleteTranscription(job.transcriptionId, signal);
    } catch (error) {
      clean = false;
      logger.warning(`Failed to cleanup Soniox job ${job.transcriptionId}: ${errorText(error)}`);
    }
  }
  if (job.fileId !== null) {
    try {
      await client.deleteFile(job.fileId, signal);
    } catch (error) {
      clean = false;
      logger.warning(`Failed to delete Soniox file ${job.fileId}: ${errorText(error)}`);
    }
  }
  if (!clean) return;
  if (job.transcriptionId !== null) logger.info(`Cleaned up Soniox job ${job.transcriptionId}`);
  else if (job.fileId !== null) logger.info(`Deleted Soniox file ${job.fileId}`);
}
