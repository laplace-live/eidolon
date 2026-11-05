// Transcripts and their sidecars, as tools/_streams.py reads and writes them. Refine, the ingest
// and the catalog all parse through here, so a chunk id means the same scene to each of them.
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  cpLen,
  cpSlice,
  isPlainObject,
  loadsPy,
  pyGet,
  pyJsonDumps,
  pyJsonLoads,
  pyPath,
  pyPathStem,
  pyPathWithSuffix,
  pyStr,
  pyStrip,
  pyTruthy,
  sortedPy,
} from "@eidolon/config";
import { PyPattern } from "@eidolon/retrieval";

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
    data = loadsPython(readUtf8(path));
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
   * The frontmatter through YAML 1.2 (Bun), where Python read YAML 1.1. What YAML 1.1 types
   * implicitly comes out differently: booleans like yes/no/on/off, timestamps, sexagesimal and
   * octal numbers, `1_000`, `1e3` and `1.0`. A non-string key, which crashes Python, parses.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly chunks: readonly StreamChunk[];
  /** `<stem>.refined.json` beside the transcript. */
  readonly sidecarPath: string;
}

// re.MULTILINE `\s+` can cross into the next line, so "##" alone heads the next line's text, and
// `$` backs off to just before a newline: a match can end on one.
const H2 = new PyPattern(String.raw`^##\s+(.+?)\s*$`, "m");
// python-frontmatter's YAML and JSON handlers (no TOML: the toml package isn't installed).
const YAML_BOUNDARY = new PyPattern(String.raw`^-{3,}\s*$`, "m");
const JSON_BOUNDARY = new PyPattern(String.raw`^(?:\{|\})$`, "m");

/** `split_into_chunks`: the H2 sections with text; whatever precedes the first H2 is dropped. */
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

/** `parse_stream`: a transcript's frontmatter and chunks, with ids that stay stable across runs. */
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
 * `iter_streams`: every `*.md` directly in `streamsDir` (dotfiles too, case-sensitive), parsed in
 * file-name order, which the date prefix makes chronological. [] when the folder doesn't exist.
 */
export function iterStreams(streamsDir: string): ParsedStream[] {
  if (!existsSync(streamsDir)) return [];
  let names: string[];
  try {
    names = readdirSync(streamsDir);
  } catch {
    // pathlib's glob finds nothing in a folder it can't list.
    return [];
  }
  return sortedPy(names.filter((name) => name.endsWith(".md"))).map((name) =>
    parseStream(`${streamsDir}/${name}`),
  );
}

function isJsonDecodeError(error: unknown): boolean {
  return error instanceof Error && error.name === "JSONDecodeError";
}

/**
 * `json.loads` keeping floats as PyFloat. JSON.parse takes the common case; what it refuses goes
 * to the exact port, which also accepts NaN and Infinity and raises Python's errors.
 */
function loadsPython(text: string): unknown {
  try {
    return loadsPy(text);
  } catch {
    return pyJsonLoads(text, { strict: true, floats: true });
  }
}

/** `{schema_version: 1, stream_id, chunks: {}}`, what refine starts a stream from. */
export function emptySidecar(streamId: string): Record<string, unknown> {
  return { schema_version: 1, stream_id: streamId, chunks: {} };
}

/**
 * `load_sidecar`: the `.refined.json` as Python's json.loads returns it (floats as PyFloat), or the
 * empty sidecar when it is missing or not JSON, so a corrupt one is overwritten at the next save.
 */
export function loadSidecar(parsed: ParsedStream): unknown {
  if (!existsSync(parsed.sidecarPath)) return emptySidecar(parsed.streamId);
  const text = readUtf8(parsed.sidecarPath);
  try {
    return loadsPython(text);
  } catch (error) {
    if (isJsonDecodeError(error)) return emptySidecar(parsed.streamId);
    throw error;
  }
}

/**
 * `save_sidecar`: `json.dumps(data, ensure_ascii=False, indent=2)`, written to a temporary file
 * beside the sidecar and renamed over it, so a reader never sees half a file. Wrap every float
 * Python would write as `1.0` in PyFloat.
 */
export function saveSidecar(parsed: ParsedStream, data: unknown): void {
  const tmp = `${parsed.sidecarPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, pyJsonDumps(data, { ensureAscii: false, indent: 2 }), "utf8");
    renameSync(tmp, parsed.sidecarPath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Never written.
    }
    throw error;
  }
}
