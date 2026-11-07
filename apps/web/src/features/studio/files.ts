// The studio's checks on files before they reach the server, which checks them again: names,
// image types and sizes, and what a prompt asks of the voice model.
import type { SettingRow } from "@/lib/api";
import { parseMarkup } from "@/lib/markup";

/** The server refuses larger uploads. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;
/** A file input's `accept` for a picture. */
export const IMAGE_ACCEPT = [...IMAGE_TYPES, ...IMAGE_EXTENSIONS].join(",");
export const FACT_EXTENSIONS = [".txt"] as const;

const NAME = /^[^/\\:\p{Cc}]{1,128}$/u;

/** The model that reads a prompt's delivery cues aloud as directions, not as words. */
export const CUE_MODEL = "drama-3";

export type NameProblem = "invalid" | "extension";

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** Whether the studio can show reference `name`: the server serves PNG, JPEG and WebP alone. */
export function previewable(name: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

/** Why the server would refuse `name` for a file with one of `extensions`, or null. */
export function nameProblem(name: string, extensions: readonly string[]): NameProblem | null {
  const normal = name.normalize("NFC");
  if (!NAME.test(normal) || normal.startsWith(".") || normal.trim() !== normal) return "invalid";
  return extensions.includes(extensionOf(normal)) ? null : "extension";
}

/** A fact file's name as typed, with `.txt` added when it has no extension. */
export function factFileName(typed: string): string {
  const name = typed.trim().normalize("NFC");
  return extensionOf(name) === "" ? `${name}.txt` : name;
}

/** `name` with its stem replaced, keeping the extension: a friend's picture is named after them. */
export function renamed(name: string, stem: string): string {
  return `${stem.trim().normalize("NFC")}${extensionOf(name)}`;
}

export function stemOf(name: string): string {
  const extension = extensionOf(name);
  return extension === "" ? name : name.slice(0, -extension.length);
}

export type ImageProblem = "type" | "size";

export function imageProblem(file: Pick<File, "type" | "size">): ImageProblem | null {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return "type";
  return file.size > MAX_IMAGE_BYTES ? "size" : null;
}

/**
 * An object URL showing `file` before its upload, typed as one of IMAGE_TYPES; null for a file of
 * any other type. The URL is this page's origin, so one of an SVG or HTML file, opened in a tab,
 * would be a page of the app.
 */
export function previewUrl(file: Blob): string | null {
  const type = IMAGE_TYPES.find((allowed) => allowed === file.type);
  // A Blob of the list's type, not the file: CodeQL's js/xss-through-dom traces an object URL of
  // the file itself back to the <input> that picked it.
  return type === undefined ? null : URL.createObjectURL(new Blob([file], { type }));
}

export interface TextCounts {
  /** Unicode characters, so a Chinese character counts once. */
  readonly chars: number;
  readonly lines: number;
}

export function textCounts(text: string): TextCounts {
  let chars = 0;
  for (const _ of text) chars++;
  return { chars, lines: text === "" ? 0 : text.split("\n").length };
}

/** The draft once a save of `sent` answers `saved`: what was typed while it was out stays. */
export function draftAfterSave(draft: string, sent: string, saved: string): string {
  return draft === sent ? saved : draft;
}

/** Whether a prompt teaches delivery cues: `[…]` directions or paired word tags. */
export function hasDeliveryCues(prompt: string): boolean {
  return parseMarkup(prompt).some((token) => token.kind !== "text" || token.tags.length > 0);
}

/**
 * Why the voice model may speak a prompt's cues as words: the model she reads isn't CUE_MODEL. It
 * is her persona.yaml's (`model`), else the one she inherits from the environment (`env`).
 */
export type CueClash =
  | { readonly kind: "model"; readonly model: string }
  | { readonly kind: "env"; readonly env: string; readonly model: string };

/** The clash between voice.model's row and a prompt; null when none. */
export function cueClash(
  row: Pick<SettingRow, "env" | "value" | "envValue"> | undefined,
  prompt: string | undefined,
): CueClash | null {
  if (row === undefined || prompt === undefined || !hasDeliveryCues(prompt)) return null;
  const own = typeof row.value === "string" ? row.value.trim() : "";
  const model = own || (row.envValue?.trim() ?? "");
  // Neither sets one: the bot's default applies, which the built-in prompts are written for.
  if (model === "" || model === CUE_MODEL) return null;
  return own === "" ? { kind: "env", env: row.env, model } : { kind: "model", model };
}
