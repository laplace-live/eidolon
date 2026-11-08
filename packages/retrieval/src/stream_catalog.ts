// Broadcast overviews from `stream_catalog.json`, which the offline Python chain writes. One parsed
// copy per (path, mtime, size) is shared process-wide, so per-session instances never reparse.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { cpLen, errorText, logger, pyCompare, pyRepr, pyStr } from "@eidolon/config";
import type { IsoDate } from "./civil_date.ts";
import { OccurrenceIndex, type Timeline } from "./occurrences.ts";
import { clip } from "./py.ts";
import { Slicer } from "./slicer.ts";

export const CATALOG_FILENAME = "stream_catalog.json";
export const CATALOG_VERSION = 1;
export const OVERVIEW_MAX_CHARS = 1800;

export const TYPE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  commentary: "杂谈/解说",
  sc_session: "读SC",
  anime_audio: "动画播放",
  karaoke: "唱歌",
  opening: "开场",
  closing: "收尾",
  mixed: "混合内容",
  transition: "转场",
  "": "未分类",
});

export interface BroadcastScene {
  readonly id: string;
  readonly streamId: string;
  readonly heading: string;
  readonly summary: string;
  readonly topics: readonly string[];
  readonly chunkType: string;
  readonly refined: boolean;
  readonly timestamp: string;
}

export interface Broadcast {
  readonly id: string;
  readonly streamDate: string;
  readonly streamIds: readonly string[];
  readonly overview: string;
  readonly sourceChunkIds: readonly string[];
  readonly scenes: readonly BroadcastScene[];
  readonly sourcePaths: readonly string[];
  readonly unrefinedCount: number;
  readonly overviewCompressed: boolean;
}

type JsonObject = Record<string, unknown>;

function typeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (Array.isArray(value)) return "list";
  return { string: "str", number: "int", boolean: "bool" }[typeof value as string] ?? "object";
}

/** Python `obj[key]` on a decoded JSON value. */
function item(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new TypeError(`'${typeName(obj)}' object is not subscriptable`);
  }
  if (!(key in obj)) throw new Error(pyRepr(key));
  return (obj as JsonObject)[key];
}

/** Python `obj.get(key, fallback)`. */
function get(obj: JsonObject, key: string, fallback: unknown): unknown {
  return key in obj ? obj[key] : fallback;
}

/** Python `tuple(value)` on a decoded JSON value: a string becomes its characters. */
function tuple(value: unknown): unknown[] {
  if (typeof value === "string" || Array.isArray(value)) return [...value];
  if (typeof value === "object" && value !== null) return Object.keys(value);
  throw new TypeError(`'${typeName(value)}' object is not iterable`);
}

function sceneFromJson(scene: unknown): BroadcastScene {
  return {
    id: item(scene, "id") as string,
    streamId: item(scene, "stream_id") as string,
    heading: item(scene, "heading") as string,
    summary: item(scene, "summary") as string,
    topics: tuple(item(scene, "topics")) as string[],
    chunkType: item(scene, "chunk_type") as string,
    refined: item(scene, "refined") as boolean,
    timestamp: get(scene as JsonObject, "timestamp", "") as string,
  };
}

/** `_broadcast_from_json`: throws on a missing required key, as Python does. */
export function broadcastFromJson(entry: unknown): Broadcast {
  const id = item(entry, "id") as string;
  const obj = entry as JsonObject;
  return {
    id,
    streamDate: item(obj, "stream_date") as string,
    streamIds: tuple(item(obj, "stream_ids")) as string[],
    overview: item(obj, "overview") as string,
    sourceChunkIds: tuple(item(obj, "source_chunk_ids")) as string[],
    scenes: tuple(get(obj, "scenes", [])).map(sceneFromJson),
    sourcePaths: tuple(get(obj, "source_paths", [])) as string[],
    unrefinedCount: get(obj, "unrefined_count", 0) as number,
    overviewCompressed: get(obj, "overview_compressed", false) as boolean,
  };
}

function descending(a: Broadcast, b: Broadcast): number {
  return pyCompare(b.streamDate, a.streamDate) || pyCompare(b.id, a.id);
}

function checkVersion(payload: unknown): void {
  if (item(payload, "schema_version") !== CATALOG_VERSION) {
    throw new Error("Unsupported stream catalog version");
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const COMMA = 0x2c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;

function isJsonSpace(b: number | undefined): boolean {
  return b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;
}

function skipSpace(bytes: Uint8Array, pos: number): number {
  while (isJsonSpace(bytes[pos])) pos++;
  return pos;
}

/** Index just past the string opening at `pos`. UTF-8 continuation bytes are never ASCII. */
function skipString(bytes: Uint8Array, pos: number): number {
  for (let from = pos + 1; ; ) {
    const quote = bytes.indexOf(QUOTE, from);
    if (quote === -1) throw new SyntaxError("Unterminated string in stream catalog");
    let slashes = 0;
    while (bytes[quote - 1 - slashes] === BACKSLASH) slashes++;
    if (slashes % 2 === 0) return quote + 1;
    from = quote + 1;
  }
}

/** Index just past the JSON value starting at `pos`; JSON.parse validates it afterwards. */
function skipValue(bytes: Uint8Array, pos: number): number {
  const first = bytes[pos];
  if (first === QUOTE) return skipString(bytes, pos);
  if (first !== OPEN_OBJECT && first !== OPEN_ARRAY) {
    let i = pos;
    while (i < bytes.length) {
      const b = bytes[i];
      if (b === COMMA || b === CLOSE_OBJECT || b === CLOSE_ARRAY || isJsonSpace(b)) break;
      i++;
    }
    return i;
  }
  let depth = 0;
  for (let i = pos; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === QUOTE) i = skipString(bytes, i) - 1;
    else if (b === OPEN_OBJECT || b === OPEN_ARRAY) depth++;
    else if ((b === CLOSE_OBJECT || b === CLOSE_ARRAY) && --depth === 0) return i + 1;
  }
  throw new SyntaxError("Unterminated container in stream catalog");
}

interface Layout {
  /** Offsets of the `broadcasts` array's `[` and of the byte after its `]`. */
  readonly arrayStart: number;
  readonly arrayEnd: number;
  /** [start, end) of each element. */
  readonly elements: [number, number][];
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Element boundaries of the top-level `broadcasts` array, scanned in slices, or null when the
 * document has any other shape (the caller then falls back to one JSON.parse).
 */
async function scanLayout(bytes: Uint8Array, slicer: Slicer): Promise<Layout | null> {
  let pos = skipSpace(bytes, 0);
  if (bytes[pos] !== OPEN_OBJECT) return null;
  pos = skipSpace(bytes, pos + 1);
  let layout: Layout | null = null;
  if (bytes[pos] === CLOSE_OBJECT) return null;
  for (;;) {
    if (bytes[pos] !== QUOTE) return null;
    const keyEnd = skipString(bytes, pos);
    const key: unknown = JSON.parse(UTF8.decode(bytes.subarray(pos, keyEnd)));
    pos = skipSpace(bytes, keyEnd);
    if (bytes[pos] !== COLON) return null;
    pos = skipSpace(bytes, pos + 1);
    if (key === "broadcasts") {
      if (layout !== null || bytes[pos] !== OPEN_ARRAY) return null;
      const arrayStart = pos;
      const elements: [number, number][] = [];
      pos = skipSpace(bytes, pos + 1);
      if (bytes[pos] !== CLOSE_ARRAY) {
        for (;;) {
          const end = skipValue(bytes, pos);
          elements.push([pos, end]);
          pos = skipSpace(bytes, end);
          if (bytes[pos] === CLOSE_ARRAY) break;
          if (bytes[pos] !== COMMA) return null;
          pos = skipSpace(bytes, pos + 1);
          await slicer.tick();
        }
      }
      pos += 1;
      layout = { arrayStart, arrayEnd: pos, elements };
    } else {
      pos = skipValue(bytes, pos);
    }
    pos = skipSpace(bytes, pos);
    if (bytes[pos] === CLOSE_OBJECT) break;
    if (bytes[pos] !== COMMA) return null;
    pos = skipSpace(bytes, pos + 1);
  }
  return layout;
}

/**
 * `_load_catalog`, parsed one broadcast at a time between yields: a single JSON.parse of the
 * whole file would stall every call's audio.
 */
async function parseCatalog(path: string): Promise<readonly Broadcast[]> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const slicer = new Slicer();
  const layout = await scanLayout(bytes, slicer);
  if (layout === null) {
    const payload: unknown = JSON.parse(UTF8.decode(bytes));
    checkVersion(payload);
    return Object.freeze(
      tuple(item(payload, "broadcasts")).map(broadcastFromJson).sort(descending),
    );
  }
  const header =
    UTF8.decode(bytes.subarray(0, layout.arrayStart)) +
    "[]" +
    UTF8.decode(bytes.subarray(layout.arrayEnd));
  checkVersion(JSON.parse(header));
  const broadcasts: Broadcast[] = [];
  for (const [start, end] of layout.elements) {
    await slicer.tick();
    broadcasts.push(broadcastFromJson(JSON.parse(UTF8.decode(bytes.subarray(start, end)))));
  }
  return Object.freeze(broadcasts.sort(descending));
}

// functools.lru_cache(maxsize=2) keyed by (path, stamp); a failed load is not cached.
const CACHE_SIZE = 2;
const cache = new Map<string, Promise<readonly Broadcast[]>>();

async function loadCatalog(path: string, stamp: string): Promise<readonly Broadcast[]> {
  const key = `${path}\0${stamp}`;
  let entry = cache.get(key);
  if (entry !== undefined) cache.delete(key);
  else entry = parseCatalog(path);
  cache.set(key, entry);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  try {
    return await entry;
  } catch (error) {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  }
}

/** Drops every parsed catalog. */
export function clearCatalogCache(): void {
  cache.clear();
}

// Python's process-wide _CATALOG_LOCK: one stamp check and load at a time, across instances.
let lockTail: Promise<void> = Promise.resolve();

async function withCatalogLock(fn: () => Promise<void>): Promise<void> {
  const previous = lockTail;
  let release = () => {};
  lockTail = new Promise((resolveLock) => {
    release = resolveLock;
  });
  await previous;
  try {
    await fn();
  } finally {
    release();
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

// One occurrence index per parsed catalog, shared by every session's instance like the parse.
const occurrenceIndexes = new WeakMap<readonly Broadcast[], Promise<OccurrenceIndex>>();

/** Process-wide parsed cache keyed by (path, mtime, size); the 30 MB parse never blocks audio. */
export class StreamCatalog {
  readonly path: string;
  #stamp: string | null = null;
  #broadcasts: readonly Broadcast[] = [];
  #missingLogged = false;

  constructor(dbPath: string) {
    this.path = resolve(dbPath, CATALOG_FILENAME);
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  /** Newest first. A missing file is [] (logged once); a broken one is [] and warns every call. */
  async broadcasts(): Promise<Broadcast[]> {
    try {
      const stat = statSync(this.path, { bigint: true });
      const stamp = `${stat.mtimeNs}:${stat.size}`;
      await withCatalogLock(async () => {
        if (stamp === this.#stamp) return;
        this.#broadcasts = await loadCatalog(this.path, stamp);
        this.#stamp = stamp;
        this.#missingLogged = false;
      });
    } catch (error) {
      this.#broadcasts = [];
      if (isMissingFile(error)) {
        this.#stamp = null;
        if (!this.#missingLogged) {
          logger.debug(`Stream catalog unavailable: ${this.path}`);
          this.#missingLogged = true;
        }
      } else {
        logger.warning(`Stream catalog unavailable: ${errorText(error)}`);
      }
    }
    return [...this.#broadcasts];
  }

  /** `endDate` is exclusive; `streamIds` matches a broadcast id or any of its part ids. */
  async select(
    options: {
      startDate?: IsoDate | null;
      endDate?: IsoDate | null;
      streamIds?: readonly string[] | null;
    } = {},
  ): Promise<Broadcast[]> {
    const { startDate = null, endDate = null, streamIds = null } = options;
    const ids = streamIds === null ? null : new Set(streamIds);
    return (await this.broadcasts()).filter(
      (b) =>
        (startDate === null || pyCompare(b.streamDate, startDate) >= 0) &&
        (endDate === null || (b.streamDate !== "" && pyCompare(b.streamDate, endDate) < 0)) &&
        (ids === null || ids.has(b.id) || b.streamIds.some((id) => ids.has(id))),
    );
  }

  async recent(n = 3): Promise<Broadcast[]> {
    return (await this.broadcasts()).slice(0, Math.max(0, n));
  }

  /** The current parse's occurrence index, built once per parse. */
  async occurrences(): Promise<OccurrenceIndex> {
    await this.broadcasts();
    // The parse itself keys the shared index: broadcasts() returns a copy.
    const parse = this.#broadcasts;
    let index = occurrenceIndexes.get(parse);
    if (index === undefined) {
      index = OccurrenceIndex.build(parse);
      occurrenceIndexes.set(parse, index);
    }
    return index;
  }

  /** The broadcasts naming the topics `query` contains, newest first; null if it contains none. */
  async timeline(query: string): Promise<Timeline | null> {
    return (await this.occurrences()).timeline(query);
  }
}

/** Parses and indexes the catalog into the process-wide caches; apps/bot calls it at boot. */
export async function warmStreamCatalog(dbPath: string): Promise<void> {
  await new StreamCatalog(dbPath).occurrences();
}

function mostCommon<T>(counts: Map<T, number>): [T, number][] {
  return [...counts].sort((a, b) => b[1] - a[1]);
}

/** A broadcast's activity mix, top themes and evenly spread representative scenes, clipped. */
export function compactOverview(scenes: readonly BroadcastScene[], maxChars: number): string {
  if (scenes.length === 0) return clip("没有可用的分段摘要。", maxChars);
  const types = new Map<string, number>();
  for (const scene of scenes) types.set(scene.chunkType, (types.get(scene.chunkType) ?? 0) + 1);
  const activities = mostCommon(types)
    .map(
      ([kind, count]) =>
        `${Object.hasOwn(TYPE_NAMES, kind) ? TYPE_NAMES[kind] : pyStr(kind)}(${count}段)`,
    )
    .join("、");
  const topics = new Map<string, number>();
  for (const scene of scenes) {
    for (const topic of new Set(scene.topics)) topics.set(topic, (topics.get(topic) ?? 0) + 1);
  }
  const themes = mostCommon(topics)
    .slice(0, 12)
    .map(([topic]) => topic)
    .join("、");
  let prefix = `活动：${activities}。`;
  if (themes) prefix += `主题：${clip(themes, Math.max(30, Math.floor(maxChars / 4)))}。`;

  const selected = new Set<number>();
  const seenTypes = new Set<string>();
  const seenParts = new Set<string>();
  scenes.forEach((scene, index) => {
    if (!seenTypes.has(scene.chunkType) || !seenParts.has(scene.streamId)) {
      selected.add(index);
      seenTypes.add(scene.chunkType);
      seenParts.add(scene.streamId);
    }
  });
  const spread = Math.min(8, scenes.length);
  // step·(n−1)/7 is never an exact .5, so Math.round agrees with Python's half-even round().
  for (let step = 0; step < spread; step++) {
    selected.add(Math.round((step * (scenes.length - 1)) / Math.max(1, spread - 1)));
  }
  const remaining = maxChars - cpLen(prefix) - cpLen("代表片段：");
  if (remaining < 40) return clip(prefix, maxChars);
  const perScene = Math.min(150, Math.max(24, Math.floor(remaining / selected.size) - 1));
  const snippets = [...selected]
    .sort((a, b) => a - b)
    .map((index) => {
      const scene = scenes[index] as BroadcastScene;
      const text = scene.summary
        ? `${scene.heading}：${scene.summary}`
        : `${scene.heading}（尚无精炼摘要）`;
      return clip(text, perScene);
    });
  return clip(`${prefix}代表片段：${snippets.join("；")}`, maxChars);
}

/** The archived broadcasts as one prompt block, every header kept within `maxChars`. */
export function formatBroadcasts(broadcasts: readonly Broadcast[], maxChars = 7000): string {
  if (broadcasts.length === 0)
    return clip("该范围没有已归档录播；这不代表当时没有直播。", maxChars);
  const intro = `已归档录播共${broadcasts.length}场；仅据现有记录，不能视为完整开播记录。\n`;
  const headers = broadcasts.map(
    (b) =>
      `${b.streamDate || "日期未知"} [${b.id}] ` +
      `${b.streamIds.length}个录播分P/${b.sourceChunkIds.length}段` +
      (b.unrefinedCount ? `，${b.unrefinedCount}段未精炼` : ""),
  );
  let footer = "\n以上是压缩概览，片段为代表性摘录；具体细节需查询原始分段。";
  const baseSize =
    cpLen(intro) + cpLen(footer) + headers.reduce((sum, header) => sum + cpLen(header) + 2, 0);
  const perBroadcast = Math.min(
    OVERVIEW_MAX_CHARS,
    Math.max(0, Math.floor((maxChars - baseSize) / broadcasts.length)),
  );
  if (perBroadcast < 50) {
    footer = "\n篇幅不足，以下场次及内容可能省略，不能据此声称完整回顾。";
    const available = Math.max(0, maxChars - cpLen(intro) - cpLen(footer));
    return clip(intro + clip(headers.join("\n"), available) + footer, maxChars);
  }
  const entries = broadcasts.map((b, index) => {
    const overview =
      b.scenes.length > 0
        ? compactOverview(b.scenes, perBroadcast)
        : clip(b.overview, perBroadcast);
    return `${headers[index]}\n${overview}`;
  });
  return clip(intro + entries.join("\n") + footer, maxChars);
}
