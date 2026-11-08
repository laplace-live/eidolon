// Soniox tokens become Whisper-length segments, segments become fixed-window scenes, and scenes
// become the transcript's H2 sections. The .soniox.json keeps every token, so a transcript
// re-renders from it without paying Soniox again.
import {
  cpLen,
  cpSlice,
  isPlainObject,
  isPySpace,
  PY_SPACE_CLASS,
  pyNumber,
  pyRstrip,
  pyStrip,
} from "@eidolon/config";

/** A stretch of speech; `start` and `end` in seconds. */
export interface Segment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** One window of the transcript: `start` is where the window starts; `end` is never rendered. */
export interface Scene {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A token as Soniox returns it and the .soniox.json keeps it. */
export type SonioxToken = Readonly<Record<string, unknown>>;

// Soniox returns sub-word tokens; grouping them into segments of Whisper-comparable length keeps
// the scene windows behaving as they did for Whisper.
export const MIN_SEGMENT_SEC = 3.0;
export const MAX_SEGMENT_SEC = 30.0;
export const DEFAULT_WINDOW_SEC = 300;

const SENTENCE_END = new Set([".", "!", "?", "。", "！", "？"]);
const SENTENCE_END_CHARS = ".!?。！？";
const SPACE_RUN = new RegExp(`[${PY_SPACE_CLASS}]+`, "g");
const SENTENCE_BREAK = new RegExp(`(?<=[${SENTENCE_END_CHARS}])[${PY_SPACE_CLASS}]`);

/** `re.search(r"[.!?。！？]\s*$", text)`. */
function endsSentence(text: string): boolean {
  // Every Python whitespace character is one BMP code unit, so scanning code units is exact.
  let i = text.length;
  while (i > 0 && isPySpace(text[i - 1] as string)) i--;
  return i > 0 && SENTENCE_END.has(text[i - 1] as string);
}

/**
 * Tokens joined bare (Soniox carries the spaces a language needs, and joining with spaces would
 * wreck Mandarin) until a sentence ends after at least MIN_SEGMENT_SEC, or MAX_SEGMENT_SEC has
 * passed. A token without timestamps is dropped, text and all. `shiftMs` comes off every timestamp
 * first, undoing a sliced run's shift.
 */
export function tokensToSegments(tokens: Iterable<SonioxToken>, shiftMs = 0): Segment[] {
  const segments: Segment[] = [];
  let curStart: number | null = null;
  let curEnd = 0;
  let joined = "";
  let open = false;
  const flush = (): void => {
    if (!open || curStart === null) return;
    const text = pyStrip(joined);
    if (text) segments.push({ start: curStart, end: curEnd, text });
    curStart = null;
    curEnd = 0;
    joined = "";
    open = false;
  };
  for (const token of tokens) {
    const startMs = pyNumber(token.start_ms);
    const endMs = pyNumber(token.end_ms);
    if (startMs === null || endMs === null) continue;
    const start = (startMs - shiftMs) / 1000;
    const end = (endMs - shiftMs) / 1000;
    if (curStart === null) curStart = start;
    joined += typeof token.text === "string" ? token.text : "";
    open = true;
    curEnd = end;
    const dur = curEnd - curStart;
    if ((endsSentence(joined) && dur >= MIN_SEGMENT_SEC) || dur >= MAX_SEGMENT_SEC) flush();
  }
  flush();
  return segments;
}

/** Python's float `v // w` (CPython's `_float_div_mod`), which `Math.floor(v / w)` can miss by one. */
export function pyFloorDiv(v: number, w: number): number {
  const mod = v % w;
  let div = (v - mod) / w;
  if (mod && w < 0 !== mod < 0) div -= 1;
  if (!div) return 0;
  let floor = Math.floor(div);
  if (div - floor > 0.5) floor += 1;
  return floor;
}

/**
 * Each segment joins the window it starts in, a scene starts at its window's start, and empty
 * windows are skipped.
 */
export function groupSegmentsIntoScenes(
  segments: readonly Segment[],
  windowSeconds: number,
): Scene[] {
  const scenes: Scene[] = [];
  let currentStart: number | null = null;
  let currentEnd = 0;
  let parts: string[] = [];
  for (const seg of segments) {
    if (currentStart === null) currentStart = pyFloorDiv(seg.start, windowSeconds) * windowSeconds;
    if (seg.start - currentStart >= windowSeconds) {
      scenes.push({ start: currentStart, end: currentEnd, text: pyStrip(parts.join(" ")) });
      currentStart = pyFloorDiv(seg.start, windowSeconds) * windowSeconds;
      parts = [];
    }
    parts.push(pyStrip(seg.text));
    currentEnd = seg.end;
  }
  if (parts.length > 0 && currentStart !== null) {
    scenes.push({ start: currentStart, end: currentEnd, text: pyStrip(parts.join(" ")) });
  }
  return scenes;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `734.5` → `00:12:14`. */
export function formatTs(seconds: number): string {
  const total = Math.trunc(seconds);
  const h = Math.floor(total / 3600);
  const rem = total - h * 3600;
  return `${pad2(h)}:${pad2(Math.floor(rem / 60))}:${pad2(rem % 60)}`;
}

/** `HH:MM` past the first hour, else `MM:00`, so 60 s and one hour both read `01:00`. */
export function shortTs(seconds: number): string {
  const total = Math.trunc(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total - h * 3600) / 60);
  return h ? `${pad2(h)}:${pad2(m)}` : `${pad2(m)}:00`;
}

/** `42s`, `5m12s`, `1h23m`. */
export function formatDur(seconds: number): string {
  const s = Math.trunc(Math.max(0, seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad2(s % 60)}s`;
  return `${Math.floor(s / 3600)}h${pad2(Math.floor((s % 3600) / 60))}m`;
}

/** The scene's first sentence, at most `maxChars` code points. */
export function headingHint(text: string, maxChars = 60): string {
  const collapsed = pyStrip(text.replace(SPACE_RUN, " "));
  if (!collapsed) return "(no transcript)";
  const brk = SENTENCE_BREAK.exec(collapsed);
  let sentence = pyRstrip(
    pyStrip(brk ? collapsed.slice(0, brk.index) : collapsed),
    SENTENCE_END_CHARS,
  );
  if (cpLen(sentence) > maxChars) sentence = `${pyRstrip(cpSlice(sentence, 0, maxChars - 1))}…`;
  return sentence;
}

/** The frontmatter a transcript carries, its values written unquoted. */
export interface TranscriptMeta {
  readonly streamDate: string;
  readonly streamId: string;
  readonly durationMin: number;
  readonly sourceFile: string;
  /** The language hint sent, or null for none; the line is left out then. */
  readonly language: string | null;
}

/** The frontmatter, then one `## MM:00 — hint` section per scene. */
export function renderMarkdown(meta: TranscriptMeta, scenes: readonly Scene[]): string {
  const lines = [
    "---",
    `stream_date: ${meta.streamDate}`,
    `stream_id: ${meta.streamId}`,
    `duration_min: ${meta.durationMin}`,
  ];
  if (meta.language) lines.push(`language: ${meta.language}`);
  lines.push(`source_file: ${meta.sourceFile}`, "---", "");
  for (const scene of scenes) {
    lines.push(`## ${shortTs(scene.start)} — ${headingHint(scene.text)}`, "", scene.text, "");
  }
  return `${pyRstrip(lines.join("\n"))}\n`;
}

/** One Soniox job's tokens, on the job's own timeline; `offsetSec` places it in the source. */
export interface TokenPart {
  readonly offsetSec: number;
  readonly tokens: readonly SonioxToken[];
  /** What comes off each timestamp before grouping: 0 for a job's own tokens. */
  readonly shiftMs?: number;
}

/**
 * Segments per job, then shifted into the source's timeline by the float offset, so no segment
 * spans a slice boundary. A single job has no shift at all.
 */
export function segmentsFromParts(parts: readonly TokenPart[], sliced: boolean): Segment[] {
  if (!sliced) return tokensToSegments(parts[0]?.tokens ?? [], parts[0]?.shiftMs ?? 0);
  const segments: Segment[] = [];
  for (const part of parts) {
    for (const seg of tokensToSegments(part.tokens, part.shiftMs ?? 0)) {
      segments.push({
        start: seg.start + part.offsetSec,
        end: seg.end + part.offsetSec,
        text: seg.text,
      });
    }
  }
  return segments;
}

/** The parts of a sliced run, as its payload records them: what each measured. */
export interface SlicePart {
  readonly audioDurationMs: number | null;
  readonly durationSec: number;
}

/** A sliced run's length: what Soniox measured of each part, else the part's requested length. */
export function slicedDurationSec(parts: readonly SlicePart[]): number {
  let total = 0;
  for (const part of parts) {
    total += part.audioDurationMs ? part.audioDurationMs / 1000 : part.durationSec;
  }
  return total;
}

function field(value: unknown, key: string): unknown {
  return isPlainObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function numberField(value: unknown, key: string): number | null {
  return pyNumber(field(value, key));
}

function tokenList(payload: unknown): SonioxToken[] {
  const tokens = field(field(payload, "transcript"), "tokens");
  return Array.isArray(tokens) ? (tokens as SonioxToken[]) : [];
}

/** Whether a .soniox.json came from a sliced run. */
export function isSlicedPayload(payload: unknown): boolean {
  return field(payload, "sliced") === true;
}

/**
 * A stored payload's tokens, per Soniox job. A sliced payload holds every part's tokens shifted
 * into the source's timeline; they split back at each part's offset.
 */
export function payloadParts(payload: unknown): TokenPart[] {
  const tokens = tokenList(payload);
  if (!isSlicedPayload(payload)) return [{ offsetSec: 0, tokens }];
  const parts = field(payload, "parts");
  const offsets = (Array.isArray(parts) ? parts : []).map((p) => numberField(p, "offset_sec") ?? 0);
  if (offsets.length === 0) return [{ offsetSec: 0, tokens }];
  const offsetsMs = offsets.map((offset) => Math.trunc(offset * 1000));
  const buckets: SonioxToken[][] = offsets.map(() => []);
  let k = 0;
  for (const token of tokens) {
    const start = pyNumber(token.start_ms);
    while (start !== null && k + 1 < offsets.length && start >= (offsetsMs[k + 1] as number)) k++;
    (buckets[k] as SonioxToken[]).push(token);
  }
  return offsets.map((offsetSec, i) => ({
    offsetSec,
    tokens: buckets[i] as SonioxToken[],
    shiftMs: offsetsMs[i] as number,
  }));
}

/** The segments a stored payload renders from. */
export function payloadSegments(payload: unknown): Segment[] {
  return segmentsFromParts(payloadParts(payload), isSlicedPayload(payload));
}

/** The audio length a stored payload's transcript reports, in seconds. */
export function payloadDurationSec(payload: unknown): number {
  if (!isSlicedPayload(payload)) {
    const ms = numberField(payload, "audio_duration_ms");
    return ms ? ms / 1000 : 0;
  }
  const parts = field(payload, "parts");
  return slicedDurationSec(
    (Array.isArray(parts) ? parts : []).map((p) => ({
      audioDurationMs: numberField(p, "audio_duration_ms"),
      durationSec: numberField(p, "duration_sec") ?? 0,
    })),
  );
}

/** The transcript a stored payload renders to, given what the frontmatter names. */
export function renderPayload(
  payload: unknown,
  meta: Omit<TranscriptMeta, "durationMin">,
  windowSec: number = DEFAULT_WINDOW_SEC,
): string {
  const scenes = groupSegmentsIntoScenes(payloadSegments(payload), windowSec);
  return renderMarkdown(
    { ...meta, durationMin: Math.trunc(payloadDurationSec(payload) / 60) },
    scenes,
  );
}
