// laplace-refine's run: each transcript scene through two LLM passes, extract then synthesize, into
// the stream's .refined.json sidecar. Streams go one at a time, their chunks `concurrency` at a
// time, and a checkpoint every 16 completions keeps an interrupted run's work.
import { existsSync } from "node:fs";
import {
  activePersona,
  errorText,
  isPlainObject,
  type JsonPoster,
  logger,
  PyFloat,
  partition,
  pyError,
  pyFixed,
  pyJsonDumps,
  pyPathName,
  pyPathStem,
  pyRepr,
  pyStr,
  pyStrip,
  pyTruthy,
  pyTypeName,
} from "@eidolon/config";
import { type Failure, failureOf, sharedFailure } from "../failure.ts";
import { createLimiter, type Limiter } from "../limit.ts";
import { canonicalPath } from "../paths.ts";
import {
  costFields,
  noProgress,
  type ProgressEvent,
  type ProgressSink,
  type RunOptions,
  zeroCounts,
} from "../progress.ts";
import {
  loadSidecar,
  nextTranscript,
  type ParsedStream,
  parseStream,
  type StreamChunk,
  saveSidecar,
  transcriptPaths,
} from "../streams.ts";
import { refineApiKey, refineClient } from "./client.ts";
import { callLlmJson } from "./llm.ts";
import {
  EXTRACT_USER_TEMPLATE,
  fillTemplate,
  type RefineIdentity,
  type RefinePrompts,
  refinePrompts,
  SYNTHESIZE_USER_TEMPLATE,
} from "./prompts.ts";
import { type DryRunReport, dryRun, formatRunSummary } from "./report.ts";
import { Usage } from "./usage.ts";
import {
  buildRefinement,
  type Extract,
  isV2Refinement,
  type Refinement,
  type Synthesis,
  validateExtract,
  validateSynthesis,
} from "./validate.ts";

export const SCHEMA_VERSION = 2;
// Synthesize writes the long `details`; extract only short arrays.
const EXTRACT_MAX_TOKENS = 4096;
const SYNTHESIZE_MAX_TOKENS = 8192;
// Extract must be faithful; synthesize writes prose.
const EXTRACT_TEMPERATURE = 0.2;
const SYNTHESIZE_TEMPERATURE = 0.4;
const SAVE_EVERY = 16;

/**
 * `_stream_context`: the frontmatter line every chunk's prompts start with. Built the same way on
 * every run, so the prompt prefix stays byte-stable for the provider's prompt cache.
 */
export function streamContext(parsed: Pick<ParsedStream, "metadata">): string {
  const meta = parsed.metadata;
  const parts: string[] = [];
  for (const [key, label] of [
    ["stream_date", "date"],
    ["language", "language"],
    ["mood", "mood"],
    ["notes", "notes"],
    ["duration_min", "duration_min"],
  ] as const) {
    const value = Object.hasOwn(meta, key) ? meta[key] : null;
    if (pyTruthy(value)) parts.push(`${label}=${pyStr(value)}`);
  }
  return parts.length > 0 ? parts.join("; ") : "(no frontmatter context)";
}

/** `_heading_timestamp`: "05:00" from "05:00 — 喂？", or the whole heading without an em dash. */
export function headingTimestamp(heading: string): string {
  return pyStrip(partition(heading, "—")[0]);
}

/** The audio's stem, which is the video's yt-dlp id, from the transcript's `source_file`. */
function videoOf(parsed: ParsedStream): string | undefined {
  const source = parsed.metadata.source_file;
  return typeof source === "string" && source ? pyPathStem(source) : undefined;
}

export interface ChunkOutcome {
  readonly chunk: StreamChunk;
  /** Null when a pass failed; the chunk stays unrefined and the next run retries it. */
  readonly refinement: Refinement | null;
  /** Both passes' cost, a failed chunk's included. */
  readonly usage: Usage;
  /** The event code of the API error that failed the chunk, if it has one. */
  readonly failure?: Failure | null;
}

const direct: Limiter = (task) => task();

/**
 * `_refine_one`: extract, validate, synthesize, validate, holding one of `limit`'s slots across
 * both passes. A failure is logged and gives a null refinement.
 */
export async function refineChunk(
  client: JsonPoster,
  model: string,
  parsed: ParsedStream,
  chunk: StreamChunk,
  prompts: RefinePrompts,
  limit: Limiter = direct,
): Promise<ChunkOutcome> {
  const context = streamContext(parsed);
  const timestamp = headingTimestamp(chunk.heading);
  const usage = new Usage();
  const failed = (message: string, apiError?: unknown): ChunkOutcome => {
    logger.error(`  ✗ ${chunk.id}: ${message}`);
    return { chunk, refinement: null, usage, failure: failureOf(apiError, "refine") };
  };
  return limit(async () => {
    const [extractRaw, extractUsage, extractError] = await callLlmJson(client, model, {
      system: prompts.extractSystem,
      user: fillTemplate(EXTRACT_USER_TEMPLATE, { context, timestamp, text: chunk.text }),
      temperature: EXTRACT_TEMPERATURE,
      maxTokens: EXTRACT_MAX_TOKENS,
      responseFormat: prompts.extractResponseFormat,
    });
    usage.add(extractUsage);
    if (extractRaw === null) return failed("pass 1 (extract) failed", extractError);
    let extract: Extract;
    try {
      extract = validateExtract(extractRaw);
    } catch (error) {
      if (!isValueError(error)) throw error;
      return failed(`extract validation failed: ${errorText(error)}`);
    }

    const [synthRaw, synthUsage, synthError] = await callLlmJson(client, model, {
      system: prompts.synthesizeSystem,
      user: fillTemplate(SYNTHESIZE_USER_TEMPLATE, {
        context,
        timestamp,
        existing_heading: chunk.heading,
        extract_json: pyJsonDumps(extract, { ensureAscii: false }),
      }),
      temperature: SYNTHESIZE_TEMPERATURE,
      maxTokens: SYNTHESIZE_MAX_TOKENS,
      responseFormat: prompts.synthesisResponseFormat,
    });
    usage.add(synthUsage);
    if (synthRaw === null) return failed("pass 2 (synthesize) failed", synthError);
    let synthesis: Synthesis;
    try {
      synthesis = validateSynthesis(synthRaw);
    } catch (error) {
      if (!isValueError(error)) throw error;
      return failed(`synthesis validation failed: ${errorText(error)}`);
    }
    return { chunk, refinement: buildRefinement(extract, synthesis), usage };
  });
}

function isValueError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "ValueError" || error.name === "JSONDecodeError")
  );
}

/** What happened to one stream in a run. */
export interface StreamResult {
  readonly parsed: ParsedStream;
  readonly chunksTotal: number;
  readonly chunksSkipped: number;
  readonly chunksSucceeded: number;
  readonly chunksFailed: number;
  readonly usage: Usage;
  readonly durationSec: number;
  /** Why the stream crashed; all its chunks then count as failed. */
  readonly error: string | null;
  /** The run was stopped before every chunk finished; a checkpoint holds what did. */
  readonly cancelled: boolean;
  /** The event code every failed chunk, or the crash, shares. */
  readonly failure?: Failure | null;
}

export interface RefineOptions extends RunOptions {
  readonly client: JsonPoster;
  readonly model: string;
  /** Chunks in flight per stream, which is also the run's cap: streams never overlap. */
  readonly concurrency: number;
  /** Redo every chunk of each stream, v1 records and orphans included. */
  readonly force?: boolean;
  readonly identity: RefineIdentity;
  /** Completions between checkpoints. */
  readonly saveEvery?: number;
  readonly now?: () => Date;
  /** Seconds on a monotonic clock. */
  readonly monotonic?: () => number;
}

export interface RefineReport {
  readonly results: readonly StreamResult[];
  /** Every stream's usage summed in order, as the run summary sums it. */
  readonly usage: Usage;
  readonly durationSec: number;
  readonly cancelled: boolean;
  /** refine.py's exit 0: no stream crashed and no chunk failed. */
  readonly ok: boolean;
}

const monotonicSeconds = (): number => performance.now() / 1000;

/** `datetime.now(timezone.utc).isoformat(timespec="seconds")`. */
function isoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

/** The loaded sidecar as the dict refine.py assigns into, or Python's error for a non-dict. */
function sidecarDict(sidecar: unknown): Record<string, unknown> {
  if (isPlainObject(sidecar)) return sidecar;
  throw pyError("TypeError", `'${pyTypeName(sidecar)}' object does not support item assignment`);
}

/** `sidecar["chunks"]`, iterated with `.items()`. */
function chunksOf(sidecar: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(sidecar, "chunks")) throw pyError("KeyError", "'chunks'");
  const chunks = sidecar.chunks;
  if (isPlainObject(chunks)) return chunks;
  throw pyError("AttributeError", `'${pyTypeName(chunks)}' object has no attribute 'items'`);
}

interface StreamPosition {
  readonly index: number;
  readonly total: number;
}

async function refineStream(
  parsed: ParsedStream,
  options: RefineOptions,
  prompts: RefinePrompts,
  emit: ProgressSink,
  position: StreamPosition,
): Promise<StreamResult> {
  const clock = options.monotonic ?? monotonicSeconds;
  const now = options.now ?? (() => new Date());
  const saveEvery = options.saveEvery ?? SAVE_EVERY;
  const { model, signal } = options;
  const force = options.force ?? false;
  const started = clock();
  const name = pyPathName(parsed.mdPath);
  const sidecar = sidecarDict(loadSidecar(parsed));
  // Under --force a checkpoint keeps each old record until its chunk is redone, so an interrupted
  // run loses nothing; the final save holds the new records alone, as refine.py's does.
  let old: Record<string, unknown> | null = null;
  if (force) {
    old = isPlainObject(sidecar.chunks) ? sidecar.chunks : {};
    sidecar.chunks = {};
  }
  sidecar.schema_version = SCHEMA_VERSION;
  const chunks = chunksOf(sidecar);

  const v1 = Object.values(chunks).filter((record) => !isV2Refinement(record)).length;
  if (v1 > 0 && !force) {
    logger.warning(
      `  ${name}: ${v1} chunks are still in v1 format (no \`details\` / \`sc_events\`). ` +
        "Re-run with --force to upgrade.",
    );
  }

  const todo = parsed.chunks.filter((chunk) => !Object.hasOwn(chunks, chunk.id));
  const skipped = parsed.chunks.length - todo.length;
  const result = (fields: Partial<StreamResult>): StreamResult => ({
    parsed,
    chunksTotal: parsed.chunks.length,
    chunksSkipped: skipped,
    chunksSucceeded: 0,
    chunksFailed: 0,
    usage: new Usage(),
    durationSec: 0,
    error: null,
    cancelled: false,
    ...fields,
  });
  if (todo.length === 0) {
    // Nothing is saved, so a stream without chunks never gets a sidecar.
    logger.info(`  ${name}: all ${parsed.chunks.length} chunks already refined`);
    return result({});
  }

  logger.info(
    `  ${name}: ${todo.length} chunks to refine (${skipped} already done) using ${model}`,
  );
  const item = parsed.streamId;
  const video = videoOf(parsed);
  emit({ type: "item", stage: "refine", item, video, status: "start", ...position });

  // A crash stops the stream's queued chunks; a run's abort stops them and its requests.
  const stop = new AbortController();
  const slots = createLimiter(
    options.concurrency,
    signal ? AbortSignal.any([signal, stop.signal]) : stop.signal,
  );
  const usage = new Usage();
  const failures: (Failure | null)[] = [];
  let succeeded = 0;
  let failed = 0;
  let completed = 0;
  let saved = 0;
  // Set from the callbacks below, which control-flow narrowing can't see.
  let crash = null as { error: unknown } | null;
  const fail = (error: unknown): void => {
    crash = { error };
    stop.abort(error);
  };
  // Records a crash before the failed chunk gives up its slot, so the next one never starts.
  const limit: Limiter = (task) =>
    slots(async () => {
      try {
        return await task();
      } catch (error) {
        if (!crash && !signal?.aborted) fail(error);
        throw error;
      }
    });

  const checkpoint = (): void => {
    sidecar.model = model;
    sidecar.refined_at = isoSeconds(now());
    if (old === null) {
      saveSidecar(parsed, sidecar);
    } else {
      const redone = chunks;
      const kept = Object.entries(old).filter(([id]) => !Object.hasOwn(redone, id));
      saveSidecar(parsed, {
        ...sidecar,
        chunks: Object.fromEntries([...Object.entries(redone), ...kept]),
      });
    }
    saved = completed;
  };

  // In completion order, as asyncio.as_completed hands them over.
  const onOutcome = (outcome: ChunkOutcome): void => {
    if (crash) return;
    try {
      usage.add(outcome.usage);
      completed++;
      const { refinement } = outcome;
      if (refinement === null) {
        failed++;
        failures.push(outcome.failure ?? null);
      } else {
        chunks[outcome.chunk.id] = refinement;
        succeeded++;
        logger.debug(
          `  ✓ ${outcome.chunk.id} (${completed}/${todo.length}): ` +
            `${pyRepr(refinement.heading)} [${refinement.chunk_type}]`,
        );
      }
      if (completed % saveEvery === 0) {
        checkpoint();
        logger.info(
          `  ... ${completed}/${todo.length} done, running cost: $${pyFixed(usage.costUsd, 4)}`,
        );
      }
      emit({
        type: "progress",
        stage: "refine",
        item,
        video,
        done: completed,
        total: todo.length,
        unit: "chunks",
      });
    } catch (error) {
      fail(error);
    }
  };
  const onError = (error: unknown): void => {
    // Once the run is stopped, a rejection is a queued chunk that never started or a request
    // that was aborted.
    if (crash || signal?.aborted) return;
    fail(error);
  };

  // A crash leaves the chunks already in flight to finish, unread, before the next stream starts;
  // refine.py leaves them running beside it.
  await Promise.all(
    todo.map((chunk) =>
      refineChunk(options.client, model, parsed, chunk, prompts, limit).then(onOutcome, onError),
    ),
  );
  const elapsed = (): number => clock() - started;
  if (crash) throw crash.error;

  if (completed < todo.length) {
    if (completed > saved) checkpoint();
    return result({
      chunksSucceeded: succeeded,
      chunksFailed: failed,
      usage,
      durationSec: elapsed(),
      cancelled: true,
      failure: sharedFailure(failures),
    });
  }

  sidecar.model = model;
  sidecar.refined_at = isoSeconds(now());
  sidecar.stats = {
    chunks_total: parsed.chunks.length,
    chunks_refined: Object.keys(chunks).length,
    tokens_in: usage.promptTokens,
    tokens_out: usage.completionTokens,
    cost_usd: new PyFloat(Number(pyFixed(usage.costUsd, 6))),
    cost_source: usage.costSource,
    model,
    duration_sec: new PyFloat(Number(pyFixed(elapsed(), 2))),
  };
  saveSidecar(parsed, sidecar);
  return result({
    chunksSucceeded: succeeded,
    chunksFailed: failed,
    usage,
    durationSec: elapsed(),
    failure: sharedFailure(failures),
  });
}

function failureText(result: StreamResult): string | null {
  if (result.error !== null) return result.error;
  if (result.chunksFailed > 0) {
    return `${result.chunksFailed} of ${result.chunksTotal - result.chunksSkipped} chunks failed`;
  }
  return null;
}

/**
 * `main_async`'s loop: refines `streams` one at a time. A stream that crashes is logged and
 * counted as failed, and the run goes on. Once `signal` aborts, no chunk or stream starts, the
 * in-flight requests abort, and the stream in progress saves a checkpoint.
 */
export async function refineStreams(
  streams: readonly ParsedStream[],
  options: RefineOptions,
): Promise<RefineReport> {
  const emit = options.onProgress ?? noProgress;
  const clock = options.monotonic ?? monotonicSeconds;
  const prompts = refinePrompts(options.identity);
  const started = clock();
  emit({ type: "stage", stage: "refine", status: "start", total: streams.length });

  const results: StreamResult[] = [];
  for (const [i, parsed] of streams.entries()) {
    if (options.signal?.aborted) break;
    const position = { index: i + 1, total: streams.length };
    let result: StreamResult;
    try {
      result = await refineStream(parsed, options, prompts, emit, position);
    } catch (error) {
      logger.error(`  ✗ ${pyPathName(parsed.mdPath)}: ${errorText(error)}`);
      result = {
        parsed,
        chunksTotal: parsed.chunks.length,
        chunksSkipped: 0,
        chunksSucceeded: 0,
        chunksFailed: parsed.chunks.length,
        usage: new Usage(),
        durationSec: 0,
        error: errorText(error),
        cancelled: false,
        failure: failureOf(error),
      };
    }
    results.push(result);
    emit(itemEnd(result, position));
  }

  const usage = new Usage();
  for (const result of results) usage.add(result.usage);
  const cancelled = results.length < streams.length || results.some((result) => result.cancelled);
  const ok = !cancelled && results.every((r) => r.error === null && r.chunksFailed === 0);
  const durationSec = clock() - started;
  const failures = results.flatMap((result) => {
    const error = failureText(result);
    return error === null ? [] : [{ item: result.parsed.streamId, error }];
  });
  const failed = results.filter((result) => failureText(result) !== null);
  emit({
    type: "stage",
    stage: "refine",
    status: cancelled ? "cancelled" : ok ? "done" : "failed",
    ...(cancelled || ok ? {} : sharedFailure(failed.map((result) => result.failure ?? null))),
  });
  emit({
    type: "summary",
    stage: "refine",
    ok,
    ...(cancelled ? { cancelled } : {}),
    counts: {
      streams: results.length,
      chunksNew: sum(results, (r) => r.chunksSucceeded),
      chunksSkipped: sum(results, (r) => r.chunksSkipped),
      chunksFailed: sum(results, (r) => r.chunksFailed),
      tokensIn: usage.promptTokens,
      tokensOut: usage.completionTokens,
    },
    durationSec,
    ...costFields(
      usage,
      results.some((result) => result.chunksSucceeded + result.chunksFailed > 0),
    ),
    ...(failures.length > 0 ? { failures } : {}),
  });
  return { results, usage, durationSec, cancelled, ok };
}

function sum(results: readonly StreamResult[], value: (result: StreamResult) => number): number {
  return results.reduce((total, result) => total + value(result), 0);
}

function itemEnd(result: StreamResult, position: StreamPosition): ProgressEvent {
  const base = {
    type: "item",
    stage: "refine",
    item: result.parsed.streamId,
    video: videoOf(result.parsed),
    ...position,
  } as const;
  const cost = result.usage.costSource === "unknown" ? {} : { costUsd: result.usage.costUsd };
  if (result.cancelled) return { ...base, status: "cancelled", code: "cancelled", ...cost };
  const error = failureText(result);
  if (error !== null) {
    return { ...base, status: "failed", message: error, ...result.failure, ...cost };
  }
  const worked = result.chunksSucceeded > 0;
  return { ...base, status: worked ? "done" : "skipped", ...cost };
}

/**
 * `_select_streams`: the transcripts named in `paths` (a missing one is logged and skipped), or
 * every `*.md` in `streamsDir`. All are parsed before any LLM call, so a transcript that won't
 * parse stops the run before it spends anything. One is parsed per turn of the event loop, and
 * once `signal` aborts the next turn throws its reason.
 */
export async function selectStreams(
  paths: readonly string[],
  streamsDir: string,
  signal?: AbortSignal,
): Promise<ParsedStream[]> {
  const streams: ParsedStream[] = [];
  if (paths.length === 0) {
    for (const path of transcriptPaths(canonicalPath(streamsDir))) {
      await nextTranscript(signal);
      streams.push(parseStream(path));
    }
    return streams;
  }
  for (const path of paths) {
    await nextTranscript(signal);
    if (!existsSync(path)) {
      logger.error(`File not found: ${path}`);
      continue;
    }
    streams.push(parseStream(path));
  }
  return streams;
}

/** How a refine run ended before or after refining, for its caller to report. */
export type RefineRun =
  | { readonly kind: "cancelled" }
  /** A transcript wouldn't parse; nothing was sent. */
  | { readonly kind: "unreadable"; readonly error: unknown }
  | { readonly kind: "empty" }
  | { readonly kind: "dry-run"; readonly report: DryRunReport; readonly durationSec: number }
  | { readonly kind: "no-key" }
  | { readonly kind: "done"; readonly report: RefineReport };

export interface RunRefineOptions extends RunOptions {
  /** The transcripts to refine; every `*.md` in `streamsDir` when empty. */
  readonly paths: readonly string[];
  readonly streamsDir: string;
  readonly model: string;
  readonly concurrency: number;
  readonly force: boolean;
  readonly dryRun: boolean;
  /** Receives what refine.py printed: the dry run's report, or the run's summary table. */
  readonly print: (text: string) => void;
  /**
   * Called before a run that isn't a dry run reads its first transcript; returns the release.
   * laplace-refine's lock.
   */
  readonly hold?: () => () => void;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  /** Seconds on a monotonic clock. */
  readonly monotonic?: () => number;
}

/**
 * `main_async` after argument parsing, for laplace-refine and the pipeline's refine stage: selects
 * the transcripts, then estimates or refines them. A signal that stops the run before refining
 * ends in a cancelled stage and summary; the other ends before refining are the caller's to
 * report, since the command and the pipeline report them differently.
 */
export async function runRefine(options: RunRefineOptions): Promise<RefineRun> {
  const emit = options.onProgress ?? noProgress;
  const clock = options.monotonic ?? monotonicSeconds;
  const { signal, model } = options;
  const started = clock();
  const cancelled = (): RefineRun => {
    emit({ type: "stage", stage: "refine", status: "cancelled" });
    emit({
      type: "summary",
      stage: "refine",
      ok: false,
      cancelled: true,
      counts: zeroCounts("refine"),
      durationSec: clock() - started,
    });
    return { kind: "cancelled" };
  };

  // Before the first read: a transcript rewritten after it would be billed stale.
  const release = options.dryRun ? () => {} : (options.hold?.() ?? (() => {}));
  try {
    let streams: ParsedStream[];
    try {
      streams = await selectStreams(options.paths, options.streamsDir, signal);
    } catch (error) {
      if (signal?.aborted) return cancelled();
      return { kind: "unreadable", error };
    }
    if (streams.length === 0) {
      logger.warning("No streams to process. Add files under streams/ or pass paths.");
      return { kind: "empty" };
    }
    if (options.dryRun) {
      let report: DryRunReport;
      try {
        report = await dryRun(streams, model, signal);
      } catch (error) {
        if (signal?.aborted) return cancelled();
        throw error;
      }
      options.print(report.text);
      return { kind: "dry-run", report, durationSec: clock() - started };
    }
    const apiKey = refineApiKey();
    if (apiKey === undefined) return { kind: "no-key" };
    logger.info(
      `Refining ${streams.length} stream(s) with ${model} ` +
        `(concurrency=${options.concurrency}, force=${options.force ? "True" : "False"})`,
    );
    const report = await refineStreams(streams, {
      client: refineClient(apiKey, { signal, fetch: options.fetch }),
      model,
      concurrency: options.concurrency,
      force: options.force,
      identity: activePersona().identity,
      onProgress: emit,
      signal,
      now: options.now,
      monotonic: clock,
    });
    options.print(formatRunSummary(report.results, model, report.durationSec));
    return { kind: "done", report };
  } finally {
    release();
  }
}
