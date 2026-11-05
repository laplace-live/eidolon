// The studio's checks on files before they reach the server, which checks them again: names,
// image types and sizes, and what a prompt asks of the voice model.
import { parseMarkup } from "@/lib/markup";

/** The server refuses larger uploads. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;
export const FACT_EXTENSIONS = [".txt"] as const;

const NAME = /^[^/\\:\p{Cc}]{1,128}$/u;

/** The model that reads a prompt's delivery cues aloud as directions, not as words. */
export const CUE_MODEL = "drama-3";

export type NameProblem = "invalid" | "extension";

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
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

/** Whether a prompt teaches delivery cues: `[…]` directions or paired word tags. */
export function hasDeliveryCues(prompt: string): boolean {
  return parseMarkup(prompt).some((token) => token.kind !== "text" || token.tags.length > 0);
}
