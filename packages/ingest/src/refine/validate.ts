// The passes' responses coerced into what the sidecar stores. The response schema constrains a
// provider at decode time, but some ignore it, so every field goes through Python's str(), strip()
// and int(): a null viewer becomes "None", a float title "1.0".
import {
  isPlainObject,
  PyFloat,
  pyError,
  pyParseInt,
  pyStr,
  pyStrip,
  pyTruthy,
  pyTypeName,
} from "@eidolon/config";
import { CHUNK_TYPES, type ChunkType } from "./prompts.ts";

export interface ScEvent {
  readonly viewer: string;
  readonly amount_yuan: number | null;
  readonly content: string;
  readonly response: string;
}

export interface Song {
  readonly title: string;
  readonly note: string;
}

/** Pass 1's validated result, in the key order pass 2 receives it. */
export interface Extract {
  readonly sc_events: ScEvent[];
  readonly songs: Song[];
  readonly events: string[];
  readonly promises: string[];
  readonly topics: string[];
  readonly mentions: string[];
  readonly key_quotes: string[];
  readonly is_anime_audio_dominant: boolean;
  readonly is_karaoke_dominant: boolean;
}

export interface Synthesis {
  readonly heading: string;
  readonly summary: string;
  readonly details: string;
  readonly chunk_type: ChunkType;
}

/** One chunk's record in the sidecar, in its key order. */
export interface Refinement {
  readonly heading: string;
  readonly summary: string;
  readonly details: string;
  readonly chunk_type: ChunkType;
  readonly topics: string[];
  readonly mentions: string[];
  readonly key_quotes: string[];
  readonly sc_events: ScEvent[];
  readonly songs: Song[];
  readonly events: string[];
  readonly promises: string[];
}

/** A record of the two-pass design; records from before it lack `details` and `key_quotes`. */
export function isV2Refinement(record: unknown): boolean {
  return (
    isPlainObject(record) && Object.hasOwn(record, "details") && Object.hasOwn(record, "key_quotes")
  );
}

const valueError = (message: string): Error => pyError("ValueError", message);

function get(dict: Readonly<Record<string, unknown>>, key: string, fallback: unknown = null) {
  return Object.hasOwn(dict, key) ? dict[key] : fallback;
}

/** `str(dict.get(key, "")).strip()`. */
function text(dict: Readonly<Record<string, unknown>>, key: string, fallback = ""): string {
  return pyStrip(pyStr(get(dict, key, fallback)));
}

/** `dict.get(key) or []`. */
function orEmpty(dict: Readonly<Record<string, unknown>>, key: string): unknown {
  const value = get(dict, key);
  return pyTruthy(value) ? value : [];
}

/** Python `int(value)`, or null where it raises TypeError or ValueError. */
function pyInt(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return pyParseInt(value);
  const number = value instanceof PyFloat ? value.value : value;
  if (typeof number !== "number") return null;
  if (Number.isNaN(number)) return null;
  // Not a ValueError, so it fails the whole stream, not just the chunk.
  if (!Number.isFinite(number)) {
    throw pyError("OverflowError", "cannot convert float infinity to integer");
  }
  return Math.trunc(number) || 0;
}

/**
 * Gemini sometimes wraps a lone object in `[...]`. A list of two or more objects passes through:
 * the extract validator merges it, the synthesis validator takes the first.
 */
export function unwrapListPayload(payload: unknown): unknown {
  if (!Array.isArray(payload)) return payload;
  if (payload.length === 0) throw valueError("Empty list returned");
  if (!payload.every(isPlainObject)) throw valueError("List contained non-dict items");
  return payload.length === 1 ? payload[0] : payload;
}

const LIST_KEYS = [
  "sc_events",
  "songs",
  "events",
  "promises",
  "topics",
  "mentions",
  "key_quotes",
] as const;

/** Pass 1's response with every key present, empty rather than missing. */
export function validateExtract(raw: unknown): Extract {
  let payload = unwrapListPayload(raw);
  if (Array.isArray(payload)) {
    // The model split the chunk into sub-extracts; union their arrays back together.
    const merged: Record<string, unknown> = {};
    for (const key of LIST_KEYS) merged[key] = [];
    let anime = false;
    let karaoke = false;
    for (const item of payload as Record<string, unknown>[]) {
      for (const key of LIST_KEYS) {
        const value = orEmpty(item, key);
        if (Array.isArray(value)) (merged[key] as unknown[]).push(...value);
      }
      anime ||= pyTruthy(get(item, "is_anime_audio_dominant"));
      karaoke ||= pyTruthy(get(item, "is_karaoke_dominant"));
    }
    payload = { ...merged, is_anime_audio_dominant: anime, is_karaoke_dominant: karaoke };
  }
  if (!isPlainObject(payload)) {
    throw valueError(`Expected JSON object, got ${pyTypeName(payload)}`);
  }
  const dict = payload;

  const strList = (key: string, cap = 50): string[] => {
    const items = orEmpty(dict, key);
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => pyStrip(pyStr(item)))
      .filter((item) => item)
      .slice(0, cap);
  };

  const scEvents: ScEvent[] = [];
  const scRaw = orEmpty(dict, "sc_events");
  if (Array.isArray(scRaw)) {
    for (const sc of scRaw) {
      if (!isPlainObject(sc)) continue;
      const viewer = text(sc, "viewer");
      const content = text(sc, "content");
      if (!viewer && !content) continue;
      const amount = get(sc, "amount_yuan");
      scEvents.push({
        viewer: viewer || "(unknown)",
        amount_yuan: amount === null ? null : pyInt(amount),
        content,
        response: text(sc, "response"),
      });
    }
  }

  const songs: Song[] = [];
  const songsRaw = orEmpty(dict, "songs");
  if (Array.isArray(songsRaw)) {
    for (const song of songsRaw) {
      if (isPlainObject(song)) {
        // The extract prompt asks for untitled songs, but they are dropped here.
        const title = text(song, "title");
        if (title) songs.push({ title, note: text(song, "note") });
      } else if (typeof song === "string" && pyStrip(song)) {
        songs.push({ title: pyStrip(song), note: "" });
      }
    }
  }

  return {
    sc_events: scEvents,
    songs,
    events: strList("events"),
    promises: strList("promises"),
    topics: strList("topics", 10),
    mentions: strList("mentions"),
    key_quotes: strList("key_quotes", 10),
    is_anime_audio_dominant: pyTruthy(get(dict, "is_anime_audio_dominant")),
    is_karaoke_dominant: pyTruthy(get(dict, "is_karaoke_dominant")),
  };
}

const CHUNK_TYPE_SET: ReadonlySet<string> = new Set(CHUNK_TYPES);

/** Pass 2's response: heading and summary required; an unknown chunk type is commentary. */
export function validateSynthesis(raw: unknown): Synthesis {
  let payload = unwrapListPayload(raw);
  // A split synthesis still carries the right heading and summary in its first item.
  if (Array.isArray(payload)) payload = payload[0];
  if (!isPlainObject(payload)) {
    throw valueError(`Expected JSON object, got ${pyTypeName(payload)}`);
  }
  const heading = text(payload, "heading");
  const summary = text(payload, "summary");
  const details = text(payload, "details");
  if (!heading || !summary) throw valueError("heading and summary are required from synthesis");
  const type = text(payload, "chunk_type", "commentary").toLowerCase();
  const chunkType = (CHUNK_TYPE_SET.has(type) ? type : "commentary") as ChunkType;
  return { heading, summary, details, chunk_type: chunkType };
}

/** The sidecar record: pass 2's prose, then pass 1's lists cut to the record's caps. */
export function buildRefinement(extract: Extract, synthesis: Synthesis): Refinement {
  return {
    heading: synthesis.heading,
    summary: synthesis.summary,
    details: synthesis.details,
    chunk_type: synthesis.chunk_type,
    topics: extract.topics.slice(0, 7),
    mentions: extract.mentions.slice(0, 25),
    key_quotes: extract.key_quotes.slice(0, 5),
    sc_events: extract.sc_events,
    songs: extract.songs,
    events: extract.events.slice(0, 15),
    promises: extract.promises.slice(0, 10),
  };
}
