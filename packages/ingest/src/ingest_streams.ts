// laplace-ingest-streams' library: the stream_chunks rows, from transcripts and their sidecars,
// embedded through the shared cache and written as the table the archive searches. The table is
// rebuilt whole on every run.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  cpLen,
  envOptional,
  errorText,
  logger,
  pyGet,
  pyIter,
  pyJsonDumps,
  pyPath,
  pyPathName,
  pyRepr,
  pyStr,
  pyStrip,
  pyTruthy,
  sortedPy,
} from "@eidolon/config";
import {
  defaultEmbeddingClient,
  EmbedCache,
  type EmbeddingClient,
  type EmbeddingUsage,
  type EmbedReport,
  embeddingTotalsMessage,
  embedInBatches,
  STREAM_CHUNKS_TABLE,
  streamChunksSchema,
  tokenizeZh,
  writeTable,
} from "@eidolon/retrieval";
import { failureOf } from "./failure.ts";
import { canonicalPath } from "./paths.ts";
import {
  type EventCode,
  noProgress,
  type ProgressEvent,
  type Provider,
  type RunOptions,
} from "./progress.ts";
import { loadSidecar, type ParsedStream, parseStream } from "./streams.ts";

const STAGE = "ingest-streams";

/** What `--skip-types` drops when nothing configures it. */
export const DEFAULT_SKIP_TYPES = "anime_audio,karaoke";

/** Stream chunks per embedding request. */
export const EMBED_BATCH_SIZE = 64;

/**
 * `--skip-types`' default, raw: INGEST_SKIP_TYPES (knowledge.archive.skipTypes), where blank means
 * the default and `none` drops nothing.
 */
export function defaultSkipTypes(): string {
  const value = envOptional("INGEST_SKIP_TYPES");
  if (value === undefined) return DEFAULT_SKIP_TYPES;
  return value === "none" ? "" : value;
}

/** `_parse_skip_types`: comma-separated, each stripped, blanks dropped; "" drops nothing. */
export function parseSkipTypes(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((type) => pyStrip(type))
      .filter(Boolean),
  );
}

/** One stream_chunks row as load_streams builds it, by column name. */
export interface StreamRow {
  readonly id: string;
  readonly stream_id: string;
  readonly stream_date: string;
  readonly heading: string;
  /** The raw section, even when refined: the reranker scores this column. */
  readonly text: string;
  readonly summary: string;
  readonly details: string;
  readonly chunk_type: string;
  readonly topics: string;
  readonly mentions: string;
  readonly extras_json: string;
  /** The sidecar has a non-empty entry for the chunk. */
  readonly refined: boolean;
  readonly tokens: string;
  /** What gets embedded; never stored. */
  readonly embed_input: string;
  readonly source_path: string;
}

/** `iter_streams`' listing: every `*.md` directly in `streamsDir`, in file-name order. */
export function transcriptPaths(streamsDir: string): string[] {
  if (!existsSync(streamsDir)) return [];
  let names: string[];
  try {
    names = readdirSync(streamsDir);
  } catch {
    // pathlib's glob finds nothing in a folder it can't list.
    return [];
  }
  return sortedPy(names.filter((name) => name.endsWith(".md"))).map((name) =>
    pyPath(`${streamsDir}/${name}`),
  );
}

/**
 * A turn of the event loop, so a long read notices SIGINT between transcripts: on a cold disk,
 * reading 1,697 of them took 45 s.
 */
export async function nextTranscript(signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal?.throwIfAborted();
}

/** `PurePath.parent`. */
export function pyParent(path: string): string {
  const normalized = pyPath(path);
  const slash = normalized.lastIndexOf("/");
  if (slash === -1) return ".";
  const head = normalized.slice(0, slash);
  // "/x" and "//x" keep their root.
  return head === "" || head === "/" ? normalized.slice(0, slash + 1) : head;
}

/** `PurePath(path).relative_to(base)`, for a path inside `base`. */
export function pyRelativeTo(path: string, base: string): string {
  const normalized = pyPath(path);
  const root = pyPath(base);
  if (root === ".") return normalized;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!normalized.startsWith(prefix)) {
    throw new Error(`${pyRepr(normalized)} is not in the subpath of ${pyRepr(root)}`);
  }
  return normalized.slice(prefix.length);
}

/** Python's `value or fallback`. */
function or(value: unknown, fallback: unknown): unknown {
  return pyTruthy(value) ? value : fallback;
}

function dumps(value: unknown): string {
  return pyJsonDumps(value, { ensureAscii: false });
}

/** `" ".join(str(t) for t in value)`: a string gives its characters, a dict its keys. */
function joined(value: unknown): string {
  return pyIter(value).map(pyStr).join(" ");
}

/** load_streams' loop body: `parsed`'s rows, appended to `rows`. */
function appendRows(
  rows: StreamRow[],
  parsed: ParsedStream,
  sourcePath: string,
  skipTypes: ReadonlySet<string>,
): { kept: number; skipped: number; refinedCount: number } {
  const refinedMap = or(pyGet(loadSidecar(parsed), "chunks", {}), {});
  const streamDate = pyStr(pyGet(parsed.metadata, "stream_date", ""));
  let kept = 0;
  let skipped = 0;
  for (const chunk of parsed.chunks) {
    const refined = or(pyGet(refinedMap, chunk.id), {});
    const chunkType = pyStrip(pyStr(pyGet(refined, "chunk_type", "")));
    if (chunkType && skipTypes.has(chunkType)) {
      skipped++;
      continue;
    }
    const heading = pyStr(or(pyGet(refined, "heading"), chunk.heading));
    const summary = pyStr(or(pyGet(refined, "summary"), ""));
    // Heading and date ride along so a topic or a "last week" question lands without a filter.
    const base = summary ? summary : chunk.text;
    const embedInput = streamDate
      ? `On ${streamDate}, ${heading}.\n${base}`
      : `${heading}.\n${base}`;
    const topics = or(pyGet(refined, "topics"), []);
    const mentions = or(pyGet(refined, "mentions"), []);
    const details = pyStr(or(pyGet(refined, "details"), ""));
    // Once a chunk is refined its transcript stays out of FTS: Soniox's filler words and mishears
    // would dominate BM25.
    const ftsText =
      summary || details || pyTruthy(topics) || pyTruthy(mentions)
        ? [heading, summary, details, joined(topics), joined(mentions)].join(" ")
        : `${heading} ${chunk.text}`;
    const extras = {
      key_quotes: or(pyGet(refined, "key_quotes"), []),
      sc_events: or(pyGet(refined, "sc_events"), []),
      songs: or(pyGet(refined, "songs"), []),
      events: or(pyGet(refined, "events"), []),
      promises: or(pyGet(refined, "promises"), []),
    };
    rows.push({
      id: chunk.id,
      stream_id: chunk.streamId,
      stream_date: streamDate,
      heading,
      text: chunk.text,
      summary,
      details,
      chunk_type: chunkType,
      topics: dumps(topics),
      mentions: dumps(mentions),
      extras_json: dumps(extras),
      refined: pyTruthy(refined),
      tokens: tokenizeZh(ftsText),
      embed_input: embedInput,
      source_path: sourcePath,
    });
    kept++;
  }
  // With any chunk, the loop above has already thrown on a refined_map that isn't a dict.
  const refinedCount = parsed.chunks.filter((chunk) =>
    Object.hasOwn(refinedMap as object, chunk.id),
  ).length;
  return { kept, skipped, refinedCount };
}

/** A file an ingest read, as it was just before the read. */
export interface SourceFile {
  readonly name: string;
  readonly size: number;
  readonly mtime: string;
}

function sourceFile(path: string): SourceFile {
  const stat = statSync(path);
  return { name: pyPathName(path), size: stat.size, mtime: stat.mtime.toISOString() };
}

export interface LoadStreamsOptions extends RunOptions {
  /** chunk_type values to leave out; only refined chunks carry one, so raw ones always stay. */
  readonly skipTypes: ReadonlySet<string>;
}

async function readRows(
  streamsDir: string,
  paths: readonly string[],
  options: LoadStreamsOptions,
): Promise<{ rows: StreamRow[]; sources: SourceFile[] }> {
  const emit = options.onProgress ?? noProgress;
  const rows: StreamRow[] = [];
  const sources: SourceFile[] = [];
  if (paths.length === 0) {
    logger.warning(`Streams directory not found or empty: ${streamsDir}`);
    return { rows, sources };
  }
  const parent = pyParent(streamsDir);
  let totalSkipped = 0;
  for (const [i, path] of paths.entries()) {
    await nextTranscript(options.signal);
    sources.push(sourceFile(path));
    const parsed = parseStream(path);
    if (existsSync(parsed.sidecarPath)) sources.push(sourceFile(parsed.sidecarPath));
    const sourcePath = pyRelativeTo(parsed.mdPath, parent);
    const { kept, skipped, refinedCount } = appendRows(rows, parsed, sourcePath, options.skipTypes);
    totalSkipped += skipped;
    logger.info(
      `Loaded ${pyPathName(parsed.mdPath)}: ${kept} chunks kept ` +
        `(${refinedCount} refined, ${skipped} skipped by chunk_type)`,
    );
    emit({ type: "progress", stage: STAGE, done: i + 1, total: paths.length, unit: "files" });
  }
  if (totalSkipped) {
    logger.info(
      `Filtered out ${totalSkipped} chunks total ` +
        `(skip_types=${pyRepr(sortedPy(options.skipTypes))})`,
    );
  }
  return { rows, sources };
}

/**
 * `load_streams`: one row per H2 section of every transcript in `streamsDir`, in file then
 * section order. `source_path` is relative to the folder's parent, so pass the folder resolved.
 */
export async function loadStreams(
  streamsDir: string,
  options: LoadStreamsOptions,
): Promise<StreamRow[]> {
  return (await readRows(streamsDir, transcriptPaths(streamsDir), options)).rows;
}

/** Writes `text` to `path` through a temporary file beside it, so no reader sees half a file. */
export function writeTextAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Renamed, or never written.
    }
  }
}

/** What `index/<table>.meta.json` records of the build that wrote stream_chunks. */
export interface StreamsIndexMeta {
  readonly embedModel: string;
  readonly embedDim: number;
  readonly rows: number;
  readonly builtAt: string;
  /** Each transcript and sidecar read, in order. */
  readonly sources: readonly SourceFile[];
  /** The chunk types left out. */
  readonly skipTypes: readonly string[];
}

/** Where a table's build record sits beside it. */
export function indexMetaPath(dbPath: string, table: string): string {
  return pyPath(`${dbPath}/${table}.meta.json`);
}

class MissingCredentialError extends Error {
  override name = "MissingCredentialError";
}

// Built at the first cache miss, so a fully cached run needs no key.
const lazyDefaultClient: Pick<EmbeddingClient, "embedWithUsage"> = {
  embedWithUsage(texts, options) {
    let client: EmbeddingClient;
    try {
      client = defaultEmbeddingClient();
    } catch (error) {
      throw new MissingCredentialError(errorText(error));
    }
    return client.embedWithUsage(texts, options);
  },
};

export interface IngestStreamsOptions extends RunOptions {
  readonly streamsDir: string;
  readonly dbPath: string;
  readonly table?: string;
  readonly skipTypes: ReadonlySet<string>;
  /** Parse and log what would be written; nothing is embedded or written. */
  readonly dryRun?: boolean;
  /** The embedding cache; null embeds every row afresh. */
  readonly cachePath: string | null;
  /** Empty the cache first. Every persona and model shares it. */
  readonly clearCache?: boolean;
  /** EMBED_MODEL and EMBED_DIM when omitted. */
  readonly model?: string;
  readonly dim?: number;
  readonly client?: Pick<EmbeddingClient, "embedWithUsage">;
  /** When the table was built, for the meta file. */
  readonly now?: () => Date;
}

export interface IngestStreamsReport {
  readonly ok: boolean;
  readonly cancelled: boolean;
  /** The table was rebuilt. */
  readonly written: boolean;
  /** Rows written, or that a dry run would write. */
  readonly rows: number;
  readonly refined: number;
  readonly cacheHits: number;
  readonly embedded: number;
  /** The embedding requests' tokens and cost; null when none ran to the end. */
  readonly usage: EmbeddingUsage | null;
  readonly error: string | null;
  readonly durationSec: number;
}

const COST_SOURCES = {
  openrouter: "reported",
  estimate: "estimated",
  mixed: "estimated",
  unknown: "unpriced",
} as const;

type SummaryEvent = Extract<ProgressEvent, { type: "summary" }>;

function summaryCost(report: IngestStreamsReport): Pick<SummaryEvent, "costUsd" | "costSource"> {
  if (report.usage === null) return {};
  if (report.embedded === 0) return { costUsd: 0 };
  const costSource = COST_SOURCES[report.usage.costSource];
  return costSource === "unpriced" ? { costSource } : { costUsd: report.usage.costUsd, costSource };
}

/**
 * `main_async` after argument parsing: every transcript's rows, embedded (cache first), written
 * as the table, then recorded in `<table>.meta.json` beside it. Nothing is written until every row
 * has its vector, so a failed or cancelled run leaves the old table. Never throws: a failure ends
 * in a report with `ok` false, its summary event, and the error logged.
 */
export async function ingestStreams(options: IngestStreamsOptions): Promise<IngestStreamsReport> {
  const emit = options.onProgress ?? noProgress;
  const { signal } = options;
  const started = performance.now();
  const streamsDir = canonicalPath(options.streamsDir);
  const dbPath = canonicalPath(options.dbPath);
  const table = options.table ?? STREAM_CHUNKS_TABLE;
  let rows: StreamRow[] = [];
  let embedded = 0;
  let vectors: EmbedReport | null = null;
  let written = false;

  const finish = (
    status: "done" | "failed" | "cancelled",
    detail: { message?: string; code?: EventCode; provider?: Provider } = {},
  ): IngestStreamsReport => {
    const report: IngestStreamsReport = {
      ok: status === "done",
      cancelled: status === "cancelled",
      written,
      rows: rows.length,
      refined: rows.filter((row) => row.refined).length,
      cacheHits: vectors?.cacheHits ?? 0,
      embedded,
      usage: vectors?.usage ?? null,
      error: status === "failed" ? (detail.message ?? "failed") : null,
      durationSec: (performance.now() - started) / 1000,
    };
    emit({ type: "stage", stage: STAGE, status, ...detail });
    emit({
      type: "summary",
      stage: STAGE,
      ok: report.ok,
      ...(report.cancelled ? { cancelled: true } : {}),
      counts: { rows: report.rows, cacheHits: report.cacheHits, embedded: report.embedded },
      durationSec: report.durationSec,
      ...summaryCost(report),
      ...(report.error === null ? {} : { failures: [{ item: table, error: report.error }] }),
    });
    return report;
  };

  const paths = transcriptPaths(streamsDir);
  emit({ type: "stage", stage: STAGE, status: "start", total: paths.length });
  try {
    const read = await readRows(streamsDir, paths, {
      skipTypes: options.skipTypes,
      onProgress: emit,
      signal,
    });
    rows = read.rows;
    if (rows.length === 0) {
      logger.warning(
        `No chunks to ingest from ${streamsDir}. Add markdown files (with H2 sections) and re-run.`,
      );
      return finish("done");
    }
    if (options.dryRun) {
      const refined = rows.filter((row) => row.refined).length;
      logger.info(
        `Dry run: ${rows.length} chunks would be embedded and written ` +
          `(${refined} refined, ${rows.length - refined} raw).`,
      );
      for (const row of rows.slice(0, 5)) {
        logger.info(
          `  - ${row.id} [${row.refined ? "refined" : "raw"}, type=${row.chunk_type || "?"}]: ` +
            `${pyRepr(row.heading)} (${cpLen(row.embed_input)} embed chars)`,
        );
      }
      return finish("done");
    }

    // Before any spend: a folder that can't be created fails the run now.
    mkdirSync(dbPath, { recursive: true });
    let cache: EmbedCache | null = null;
    if (options.cachePath !== null) {
      const cachePath = canonicalPath(options.cachePath);
      const existed = existsSync(cachePath);
      cache = new EmbedCache(cachePath);
      if (options.clearCache && existed) {
        cache.clear();
        logger.info(`Cleared embedding cache at ${cachePath}`);
      }
      logger.info(`Embedding cache: ${cachePath} (${cache.count()} vectors on disk)`);
    }
    try {
      vectors = await embedInBatches(
        rows.map((row) => row.embed_input),
        {
          batchSize: EMBED_BATCH_SIZE,
          noun: "chunks",
          cache,
          model: options.model,
          dim: options.dim,
          client: options.client ?? lazyDefaultClient,
          signal,
          onProgress: (progress) => {
            embedded = progress.done;
            emit({ type: "progress", stage: STAGE, ...progress, unit: "chunks" });
          },
        },
      );
    } finally {
      cache?.close();
    }
    embedded = vectors.embedded;
    await writeTable(dbPath, table, rows, streamChunksSchema(vectors.dim), vectors.vectors, {
      signal,
    });
    written = true;
    logger.info(embeddingTotalsMessage(rows.length, "chunks", vectors.usage));
    const meta: StreamsIndexMeta = {
      embedModel: vectors.model,
      embedDim: vectors.dim,
      rows: rows.length,
      builtAt: (options.now ?? (() => new Date()))().toISOString(),
      sources: read.sources,
      skipTypes: sortedPy(options.skipTypes),
    };
    writeTextAtomic(indexMetaPath(dbPath, table), `${JSON.stringify(meta, null, 2)}\n`);
    return finish("done");
  } catch (error) {
    if (signal?.aborted && !written) return finish("cancelled", { code: "cancelled" });
    const message = errorText(error);
    if (error instanceof MissingCredentialError) {
      logger.error(message);
      return finish("failed", { message, code: "missing-credential" });
    }
    logger.error(`Stream ingest failed: ${message}`, error);
    return finish("failed", { message, ...failureOf(error, "embeddings") });
  }
}
