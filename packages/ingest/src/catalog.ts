// laplace-build-stream-catalog's library: stream_catalog.json, every transcript's scenes grouped
// into broadcasts by date and BV id, karaoke and anime playback included, each with a compact
// overview. The bot answers recaps from it without searching the archive.
import { mkdirSync } from "node:fs";
import {
  type Clock,
  errorText,
  logger,
  pyCompare,
  pyGet,
  pyIsoformatUtc,
  pyIter,
  pyJsonDumps,
  pyPath,
  pyStr,
  pyTruthy,
  wallClockMicros,
} from "@eidolon/config";
import {
  type Broadcast,
  type BroadcastScene,
  CATALOG_FILENAME,
  CATALOG_VERSION,
  compactOverview,
  fromIsoformat,
  OVERVIEW_MAX_CHARS,
  PyPattern,
  pyInt,
} from "@eidolon/retrieval";
import {
  nextTranscript,
  pyParent,
  pyRelativeTo,
  transcriptPaths,
  writeTextAtomic,
} from "./ingest_streams.ts";
import { noProgress, type ProgressEvent, type RunOptions } from "./progress.ts";
import { loadSidecar, type ParsedStream, parseStream } from "./streams.ts";

const STAGE = "catalog";
const BV = new PyPattern("BV[A-Za-z0-9]+");
const PART_SUFFIX = new PyPattern(String.raw`_p\d+$`);
const PART_NUMBER = new PyPattern(String.raw`_p(\d+)$`);
const TIMESTAMP = new PyPattern(String.raw`\d{1,3}:\d{2}(?::\d{2})?`);

/** `_broadcast_id`: the date and BV id the parts of one broadcast share. */
export function broadcastId(streamId: string, streamDate: string): string {
  const bv = BV.search(streamId);
  const base = bv ? bv[0] : PART_SUFFIX.sub("", streamId);
  if (base.startsWith(`${streamDate}-`)) return base;
  return streamDate ? `${streamDate}-${base}` : base;
}

function partNumber(streamId: string): number {
  const match = PART_NUMBER.search(streamId);
  return match ? pyInt(match[1] as string) : 0;
}

/** `_part_order`: by part number, so `_p10` follows `_p2`, then by id. */
function byPart(a: ParsedStream, b: ParsedStream): number {
  return partNumber(a.streamId) - partNumber(b.streamId) || pyCompare(a.streamId, b.streamId);
}

function or(value: unknown, fallback: unknown): unknown {
  return pyTruthy(value) ? value : fallback;
}

/**
 * A part's scenes. Unlike the table, nothing is skipped, `chunk_type` keeps its spaces, and
 * `refined` means the sidecar wrote a summary.
 */
function scenesOf(parsed: ParsedStream): BroadcastScene[] {
  const refinedMap = or(pyGet(loadSidecar(parsed), "chunks"), {});
  return parsed.chunks.map((chunk) => {
    const refined = or(pyGet(refinedMap, chunk.id), {});
    const timestamp = TIMESTAMP.match(chunk.heading);
    return {
      id: chunk.id,
      streamId: parsed.streamId,
      heading: pyStr(or(pyGet(refined, "heading"), chunk.heading)),
      summary: pyStr(or(pyGet(refined, "summary"), "")),
      topics: pyIter(or(pyGet(refined, "topics"), [])).map(pyStr),
      chunkType: pyStr(or(pyGet(refined, "chunk_type"), "")),
      refined: pyTruthy(pyGet(refined, "summary")),
      timestamp: timestamp ? timestamp[0] : "",
    };
  });
}

interface Group {
  readonly streamDate: string;
  readonly id: string;
  readonly parts: { readonly parsed: ParsedStream; readonly scenes: BroadcastScene[] }[];
}

export interface Catalog {
  /** Newest first. */
  readonly broadcasts: readonly Broadcast[];
  /** Every transcript read, scenes or not. */
  readonly sourceParts: number;
}

async function groupBroadcasts(
  streamsDir: string,
  paths: readonly string[],
  options: RunOptions,
): Promise<Catalog> {
  const emit = options.onProgress ?? noProgress;
  if (paths.length === 0) throw new Error(`No stream transcripts found in ${streamsDir}`);
  const groups = new Map<string, Group>();
  for (const [i, path] of paths.entries()) {
    await nextTranscript(options.signal);
    const parsed = parseStream(path);
    const raw = pyGet(parsed.metadata, "stream_date");
    // The table keeps the date as written; the catalog normalizes it and fails on a bad one.
    const streamDate = pyTruthy(raw) ? fromIsoformat(pyStr(raw)) : "";
    const id = broadcastId(parsed.streamId, streamDate);
    const key = JSON.stringify([streamDate, id]);
    let group = groups.get(key);
    if (group === undefined) {
      group = { streamDate, id, parts: [] };
      groups.set(key, group);
    }
    group.parts.push({ parsed, scenes: scenesOf(parsed) });
    emit({ type: "progress", stage: STAGE, done: i + 1, total: paths.length, unit: "files" });
  }

  const parent = pyParent(streamsDir);
  const broadcasts = [...groups.values()]
    .sort((a, b) => pyCompare(b.streamDate, a.streamDate) || pyCompare(b.id, a.id))
    .map(({ streamDate, id, parts }): Broadcast => {
      const ordered = [...parts].sort((a, b) => byPart(a.parsed, b.parsed));
      const scenes = ordered.flatMap((part) => part.scenes);
      return {
        id,
        streamDate,
        streamIds: ordered.map((part) => part.parsed.streamId),
        overview: compactOverview(scenes, OVERVIEW_MAX_CHARS),
        sourceChunkIds: scenes.map((scene) => scene.id),
        scenes,
        sourcePaths: ordered.map((part) => pyRelativeTo(part.parsed.mdPath, parent)),
        unrefinedCount: scenes.filter((scene) => !scene.refined).length,
        overviewCompressed: true,
      };
    });
  return { broadcasts, sourceParts: paths.length };
}

/**
 * `build_catalog`'s broadcasts, from every transcript in `streamsDir`. `source_paths` are relative
 * to the folder's parent as given, unresolved. Throws when there is no transcript.
 */
export function buildCatalog(streamsDir: string, options: RunOptions = {}): Promise<Catalog> {
  return groupBroadcasts(streamsDir, transcriptPaths(streamsDir), options);
}

function sceneJson(scene: BroadcastScene): Record<string, unknown> {
  return {
    id: scene.id,
    stream_id: scene.streamId,
    heading: scene.heading,
    summary: scene.summary,
    topics: scene.topics,
    chunk_type: scene.chunkType,
    refined: scene.refined,
    timestamp: scene.timestamp,
  };
}

function broadcastJson(broadcast: Broadcast): Record<string, unknown> {
  return {
    id: broadcast.id,
    stream_date: broadcast.streamDate,
    stream_ids: broadcast.streamIds,
    overview: broadcast.overview,
    source_chunk_ids: broadcast.sourceChunkIds,
    scenes: broadcast.scenes.map(sceneJson),
    source_paths: broadcast.sourcePaths,
    unrefined_count: broadcast.unrefinedCount,
    overview_compressed: broadcast.overviewCompressed,
  };
}

/** The file's text, as Python's `json.dumps(payload, ensure_ascii=False)` writes it. */
export function catalogJson(catalog: Catalog, builtAt: string): string {
  return pyJsonDumps(
    {
      schema_version: CATALOG_VERSION,
      built_at: builtAt,
      source_parts: catalog.sourceParts,
      broadcasts: catalog.broadcasts.map(broadcastJson),
    },
    { ensureAscii: false },
  );
}

export interface StreamCatalogOptions extends RunOptions {
  readonly streamsDir: string;
  readonly dbPath: string;
  /** Microseconds since the epoch, for `built_at`. */
  readonly clock?: Clock;
}

export interface StreamCatalogReport {
  readonly ok: boolean;
  readonly cancelled: boolean;
  /** `<dbPath>/stream_catalog.json`. */
  readonly path: string;
  readonly broadcasts: number;
  /** Recording parts across the broadcasts. */
  readonly parts: number;
  readonly error: string | null;
  readonly durationSec: number;
}

/**
 * `main`: builds the catalog and replaces `<dbPath>/stream_catalog.json` in one rename. A failed
 * (and logged) or cancelled run leaves the old file and resolves with `ok` false.
 */
export async function writeStreamCatalog(
  options: StreamCatalogOptions,
): Promise<StreamCatalogReport> {
  const emit = options.onProgress ?? noProgress;
  const { signal } = options;
  const started = performance.now();
  const path = pyPath(`${options.dbPath}/${CATALOG_FILENAME}`);
  const paths = transcriptPaths(options.streamsDir);
  const finish = (
    fields: Partial<StreamCatalogReport>,
    status: "done" | "failed" | "cancelled",
    stage: Partial<Extract<ProgressEvent, { type: "stage" }>> = {},
  ): StreamCatalogReport => {
    const report: StreamCatalogReport = {
      ok: status === "done",
      cancelled: status === "cancelled",
      path,
      broadcasts: 0,
      parts: 0,
      error: null,
      durationSec: (performance.now() - started) / 1000,
      ...fields,
    };
    emit({ type: "stage", stage: STAGE, status, ...stage });
    emit({
      type: "summary",
      stage: STAGE,
      ok: report.ok,
      ...(report.cancelled ? { cancelled: true } : {}),
      counts: { broadcasts: report.broadcasts, parts: report.parts },
      durationSec: report.durationSec,
      ...(report.error === null
        ? {}
        : { failures: [{ item: CATALOG_FILENAME, error: report.error }] }),
    });
    return report;
  };

  emit({ type: "stage", stage: STAGE, status: "start", total: paths.length });
  try {
    const catalog = await groupBroadcasts(options.streamsDir, paths, { onProgress: emit, signal });
    signal?.throwIfAborted();
    const text = catalogJson(catalog, pyIsoformatUtc((options.clock ?? wallClockMicros)()));
    mkdirSync(pyParent(path), { recursive: true });
    writeTextAtomic(path, text);
    const parts = catalog.broadcasts.reduce((sum, b) => sum + b.streamIds.length, 0);
    logger.info(
      `Built ${catalog.broadcasts.length} broadcast overviews from ${parts} recording parts ` +
        `into ${path}`,
    );
    return finish({ broadcasts: catalog.broadcasts.length, parts }, "done");
  } catch (error) {
    if (signal?.aborted) return finish({}, "cancelled", { code: "cancelled" });
    const message = errorText(error);
    logger.error(`Stream catalog build failed: ${message}`);
    return finish({ error: message }, "failed", { message });
  }
}
