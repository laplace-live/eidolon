// Reading and writing transcripts and their sidecars. Refine, the ingest and the catalog all
// parse through here, so a chunk id means the same scene to each of them.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  cpLen,
  cpSlice,
  isPlainObject,
  pyGet,
  pyJsonDumps,
  pyJsonLoads,
  pyJsonLoadsFast,
  pyPath,
  pyPathStem,
  pyPathWithSuffix,
  pyStr,
  pyStrip,
  pyTruthy,
  sortedPy,
} from "@eidolon/config";
import { PyPattern } from "@eidolon/retrieval";
import { writeTextAtomic } from "./paths.ts";

/** The audio files a download leaves for transcription, by suffix. */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  ".m4a",
  ".mp3",
  ".wav",
  ".flac",
  ".webm",
  ".opus",
  ".aac",
]);

/** yt-dlp writes `<id>.info.json` beside `<id>.m4a`. */
export function infoJsonPath(audioPath: string): string {
  return pyPathWithSuffix(audioPath, ".info.json");
}

const DIGITS = /^\p{Nd}+$/u;

/**
 * `YYYY-MM-DD` from the audio's info.json `upload_date`, or null when the file, the JSON or the
 * date is missing or malformed. Never a fallback such as today: the date becomes a permanent
 * stream id.
 */
export function readUploadDate(audioPath: string): string | null {
  const path = infoJsonPath(audioPath);
  if (!existsSync(path)) return null;
  let data: unknown;
  try {
    data = pyJsonLoadsFast(readUtf8(path));
  } catch (error) {
    if (isJsonDecodeError(error)) return null;
    throw error;
  }
  const raw = pyGet(data, "upload_date");
  const s = pyStrip(pyTruthy(raw) ? pyStr(raw) : "");
  if (cpLen(s) !== 8 || !DIGITS.test(s)) return null;
  return `${cpSlice(s, 0, 4)}-${cpSlice(s, 4, 6)}-${cpSlice(s, 6, 8)}`;
}

/** transcribe's stream id: the upload date, then the audio's stem. */
export function streamId(dateIso: string, audioStem: string): string {
  return `${dateIso}-${audioStem}`;
}

/** Where the transcript of an audio file uploaded on `dateIso` is written. */
export function transcriptPath(streamsDir: string, dateIso: string, audioStem: string): string {
  return pyPath(`${streamsDir}/${streamId(dateIso, audioStem)}.md`);
}

/** One H2 section of a transcript: the unit of refinement and retrieval. */
export interface StreamChunk {
  /** `<stream id>::<idx, 3 digits or more>`. */
  readonly id: string;
  readonly streamId: string;
  readonly idx: number;
  readonly heading: string;
  readonly text: string;
}

export interface ParsedStream {
  readonly mdPath: string;
  readonly streamId: string;
  /**
   * The frontmatter through YAML 1.2 (Bun), not PyYAML's YAML 1.1. What YAML 1.1 types
   * implicitly comes out differently: booleans like yes/no/on/off, timestamps, sexagesimal and
   * octal numbers, `1_000`, `1e3` and `1.0`. A non-string key such as `2021` parses as a string.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly chunks: readonly StreamChunk[];
  /** `<stem>.refined.json` beside the transcript. */
  readonly sidecarPath: string;
}

// re.MULTILINE `\s+` can cross into the next line, so "##" alone heads the next line's text, and
// `$` backs off to just before a newline: a match can end on one.
const H2 = new PyPattern(String.raw`^##\s+(.+?)\s*$`, "m");
// python-frontmatter's YAML and JSON handlers; no TOML.
const YAML_BOUNDARY = new PyPattern(String.raw`^-{3,}\s*$`, "m");
const JSON_BOUNDARY = new PyPattern(String.raw`^(?:\{|\})$`, "m");

/** The H2 sections with text; whatever precedes the first H2 is dropped. */
export function splitIntoChunks(body: string): { heading: string; text: string }[] {
  const chunks: { heading: string; text: string }[] = [];
  const matches = H2.finditer(body);
  matches.forEach((match, i) => {
    const heading = pyStrip(match[1] as string);
    const start = match.index + match[0].length;
    const end = matches[i + 1]?.index ?? body.length;
    const text = pyStrip(body.slice(start, end));
    if (text) chunks.push({ heading, text });
  });
  return chunks;
}

/** python-frontmatter 1.3.0's `parse` of an already-read file. */
function parseFrontmatter(raw: string): { metadata: Record<string, unknown>; content: string } {
  const text = pyStrip(raw);
  const yaml = YAML_BOUNDARY.match(text) !== null;
  if (!yaml && JSON_BOUNDARY.match(text) === null) return { metadata: {}, content: text };
  const [open, close] = (yaml ? YAML_BOUNDARY : JSON_BOUNDARY).finditer(text);
  // `_, fm, content = BOUNDARY.split(text, 2)` raises ValueError, which means no frontmatter.
  if (open === undefined || close === undefined) return { metadata: {}, content: text };
  const fm = text.slice(open.index + open[0].length, close.index);
  const loaded: unknown = yaml
    ? Bun.YAML.parse(fm)
    : pyJsonLoads(`{${fm}}`, { strict: true, floats: true });
  return {
    metadata: isPlainObject(loaded) ? { ...loaded } : {},
    content: pyStrip(text.slice(close.index + close[0].length)),
  };
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `read_text(encoding="utf-8")`: strict, a BOM kept. */
function readUtf8(path: string): string {
  return UTF8.decode(readFileSync(path));
}

/** A transcript's frontmatter and chunks, with ids that stay stable across runs. */
export function parseStream(mdPath: string): ParsedStream {
  const path = pyPath(mdPath);
  // Text mode's universal newlines.
  const { metadata, content } = parseFrontmatter(readUtf8(path).replace(/\r\n?/g, "\n"));
  const id = Object.hasOwn(metadata, "stream_id") ? pyStr(metadata.stream_id) : pyPathStem(path);
  const chunks = splitIntoChunks(content).map((chunk, idx) => ({
    id: `${id}::${String(idx).padStart(3, "0")}`,
    streamId: id,
    idx,
    heading: chunk.heading,
    text: chunk.text,
  }));
  return {
    mdPath: path,
    streamId: id,
    metadata,
    chunks,
    sidecarPath: pyPathWithSuffix(path, ".refined.json"),
  };
}

/**
 * Every `*.md` directly in `streamsDir` (dotfiles too, case-sensitive), in file-name order, which
 * the date prefix makes chronological. [] when the folder doesn't exist.
 */
export function transcriptPaths(streamsDir: string): string[] {
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

/** Every transcript in `streamsDir`, parsed, in file-name order. */
export function iterStreams(streamsDir: string): ParsedStream[] {
  return transcriptPaths(streamsDir).map(parseStream);
}

/**
 * A turn of the event loop, so a long read notices SIGINT between transcripts: on a cold disk,
 * reading 1,697 of them took 45 s.
 */
export async function nextTranscript(signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal?.throwIfAborted();
}

function isJsonDecodeError(error: unknown): boolean {
  return error instanceof Error && error.name === "JSONDecodeError";
}

/** `{schema_version: 1, stream_id, chunks: {}}`, what refine starts a stream from. */
export function emptySidecar(streamId: string): Record<string, unknown> {
  return { schema_version: 1, stream_id: streamId, chunks: {} };
}

/**
 * The `.refined.json` as Python's json.loads returns it (floats as PyFloat), or the empty sidecar
 * when it is missing or not JSON, so a corrupt one is overwritten at the next save.
 */
export function loadSidecar(parsed: ParsedStream): unknown {
  if (!existsSync(parsed.sidecarPath)) return emptySidecar(parsed.streamId);
  const text = readUtf8(parsed.sidecarPath);
  try {
    return pyJsonLoadsFast(text);
  } catch (error) {
    if (isJsonDecodeError(error)) return emptySidecar(parsed.streamId);
    throw error;
  }
}

/**
 * `json.dumps(data, ensure_ascii=False, indent=2)`, written to a temporary file beside the sidecar
 * and renamed over it, so a reader never sees half a file. Wrap every float Python would write as
 * `1.0` in PyFloat.
 */
export function saveSidecar(parsed: ParsedStream, data: unknown): void {
  writeTextAtomic(parsed.sidecarPath, pyJsonDumps(data, { ensureAscii: false, indent: 2 }));
}
