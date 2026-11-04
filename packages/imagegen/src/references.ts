import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { envOptional, expandUser, PROJECT_ROOT, pyStrip, sortedPy } from "@eidolon/config";
import { ImageGenError } from "./errors.ts";
import { imageMediaType } from "./mime.ts";
import { AFTER_DARK, ambience, type PersonaClock, personaClock } from "./prompt.ts";
import { pyPath, pyPathName, pyPathStem } from "./pypath.ts";

// Resolved against the repo root rather than the working directory, like the LanceDB path, so any
// launcher finds it.
export const BUNDLED_REFERENCES = join(PROJECT_ROOT, "data", "selfie-references");
// Two directories, two rules: one of outfits/ is the persona, and every friends/ image is a
// different person.
export const OUTFITS = join(BUNDLED_REFERENCES, "outfits");
export const FRIENDS = join(BUNDLED_REFERENCES, "friends");

/** One `input_references` entry. */
export interface ReferenceImage {
  readonly type: "image_url";
  readonly image_url: { readonly url: string };
}

export interface ReferenceOptions {
  /** The selfie-references directory; BUNDLED_REFERENCES by default. */
  readonly root?: string;
  /** Picks the outfit; the persona clock now by default. */
  readonly clock?: PersonaClock;
}

export function isReferenceUrl(source: string): boolean {
  return source.startsWith("http://") || source.startsWith("https://");
}

// os.path.isfile / isdir: they follow symlinks and answer false on any OSError.
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every image file directly in `directory`, sorted by name; `[]` when it isn't a directory. */
export function imagesIn(directory: string): string[] {
  if (!isDirectory(directory)) return [];
  return sortedPy(readdirSync(directory))
    .map((name) => join(directory, name))
    .filter((path) => isFile(path) && imageMediaType(pyPathName(path)) !== null);
}

/** `name → path` for every image in `friends/`. The file name is the name the LLM asks for. */
export function friendSources(options: Pick<ReferenceOptions, "root"> = {}): Map<string, string> {
  const friends = new Map<string, string>();
  for (const path of imagesIn(join(options.root ?? BUNDLED_REFERENCES, "friends"))) {
    friends.set(pyPathStem(path), path);
  }
  return friends;
}

/**
 * `sources` narrowed to the one outfit this hour calls for. Hand the model two and it reads the
 * second as a second person: a group selfie with one friend came back with three people in frame.
 * So exactly one of them ever reaches `input_references`, and the hour picks which, matching the
 * light the prompt asks for. `night` in the file name is the whole convention.
 */
export function selectOutfit(sources: readonly string[], clock?: PersonaClock): string[] {
  if (sources.length <= 1) return [...sources];
  const afterDark = AFTER_DARK.has(ambience((clock ?? personaClock()).hour).label);
  for (const source of sources) {
    if (pyPathStem(source).toLowerCase().includes("night") === afterDark) return [source];
  }
  return sources.slice(0, 1);
}

/** The persona's reference for right now — one outfit, never two. */
export function referenceSources(options: ReferenceOptions = {}): string[] {
  const configured = (envOptional("SELFIE_REFERENCE_IMAGES") ?? "")
    .split(",")
    .map((part) => pyStrip(part))
    .filter((part) => part !== "");
  if (configured.length > 0) return selectOutfit(configured, options.clock);
  const root = options.root ?? BUNDLED_REFERENCES;
  // Loose images directly under selfie-references/ also count as outfits, so a deployment
  // mounting its own older data/ keeps working.
  const outfits = imagesIn(join(root, "outfits"));
  return selectOutfit(outfits.length > 0 ? outfits : imagesIn(root), options.clock);
}

/**
 * A local path or http(s) URL as an `input_references` entry. A local file has to become a
 * `data:` URL carrying its real media type — the provider rejects a mislabelled one.
 */
export function loadReference(source: string): ReferenceImage {
  if (isReferenceUrl(source)) return { type: "image_url", image_url: { url: source } };
  const path = pyPath(expandUser(source));
  if (!isFile(path)) throw new ImageGenError(`${path}: no such file`);
  const mediaType = imageMediaType(pyPathName(path));
  if (mediaType === null) throw new ImageGenError(`${path}: not a recognizable image type`);
  const encoded = readFileSync(path).toString("base64");
  return { type: "image_url", image_url: { url: `data:${mediaType};base64,${encoded}` } };
}

/**
 * The persona's current outfit, encoded. Throws ImageGenError for a configured path that doesn't
 * resolve — silently generating a selfie of nobody is worse than not offering one.
 */
export function loadReferences(options: ReferenceOptions = {}): ReferenceImage[] {
  return referenceSources(options).map((source) => loadReference(source));
}

/**
 * A key and an outfit that exists, without paying to encode it. The media type goes unchecked, so
 * a non-image path passes here and still fails `loadReferences`.
 */
export function isSelfieConfigured(options: ReferenceOptions = {}): boolean {
  if (!envOptional("OPENROUTER_API_KEY")) return false;
  const sources = referenceSources(options);
  return (
    sources.length > 0 &&
    sources.every((source) => isReferenceUrl(source) || isFile(pyPath(expandUser(source))))
  );
}
