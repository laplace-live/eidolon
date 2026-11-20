// What her mind is shown of the files the viewer sends with a line.
import { type Attachment, type ChatEventOf, sentFiles, type ViewUserMessage } from "@eidolon/chat";
import { errorText, isPlainObject, logger } from "@eidolon/config";
import { ProviderHttpError } from "@eidolon/providers";
import type { EngineDeps, ShownFile } from "./types.ts";

/** The most images one request shows her. */
export const SHOWN_IMAGES = 8;
/**
 * The most image bytes one request carries: base64 grows them by a third, and Gemini's API takes
 * 20 MB of inline data in a request, Anthropic's 32 MB in all.
 */
const SHOWN_IMAGE_BYTES = 12 * 1024 * 1024;
/** The most of one text file she is shown, in UTF-16 units. */
export const SHOWN_FILE_CHARS = 20_000;
/** The most text from files one request shows her. */
const SHOWN_TEXT_CHARS = 40_000;

/** In place of an image the budget leaves out, or one that couldn't be read. */
export const UNSHOWN_IMAGE = "（一张图片，这次没给你看）";
/** In place of each image, for a mind that can't see images. */
export const UNSEEN_IMAGE = "（一张图片，你看不到）";

/** A text file's name as her view gives it: what it was called, or a name of its kind. */
function fileName(file: Attachment): string {
  return (file.kind === "file" && file.filename ? file.filename : "file.txt").replace(/["<>]/g, "");
}

/**
 * What a line's files leave where only text is read, as the director and a call's seed read it. A
 * name loses its @, which the director would read as the viewer mentioning a persona.
 */
export function filesNote(files: readonly Attachment[]): string {
  return files
    .map((file) =>
      file.kind === "image" ? "（图片）" : `（文件 ${fileName(file).replace(/[@＠]/g, "")}）`,
    )
    .join("");
}

/** A message's text, with the note its files leave where only text is read. */
export function withFilesNote(message: ChatEventOf<"message">): string {
  return message.text + filesNote(sentFiles(message));
}

/** Reads each file of the viewer's once a turn; null for one that can't be read. */
export class FileCache {
  readonly #read: EngineDeps["readAttachment"];
  readonly #files = new Map<string, Promise<ShownFile | null>>();
  readonly #urls = new Map<string, string>();

  constructor(read: EngineDeps["readAttachment"]) {
    this.#read = read;
  }

  read(file: Attachment, signal: AbortSignal): Promise<ShownFile | null> {
    let read = this.#files.get(file.name);
    if (read === undefined) {
      read = this.#load(file, signal);
      this.#files.set(file.name, read);
    }
    return read;
  }

  /** `shown`, what `file` was read as, as a data URL, made once. */
  url(file: Attachment, shown: ShownFile): string {
    let url = this.#urls.get(file.name);
    if (url === undefined) {
      url = `data:${shown.mime};base64,${Buffer.from(shown.bytes).toString("base64")}`;
      this.#urls.set(file.name, url);
    }
    return url;
  }

  async #load(file: Attachment, signal: AbortSignal): Promise<ShownFile | null> {
    if (this.#read === undefined) return null;
    try {
      return await this.#read(file.name, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      logger.warning(`[chat] Could not read ${file.name} to show her: ${errorText(error)}`);
      return null;
    }
  }
}

function hasFiles(message: unknown): message is ViewUserMessage {
  return (
    isPlainObject(message) &&
    message.role === "user" &&
    typeof message.content === "string" &&
    Array.isArray(message.attachments) &&
    message.attachments.length > 0
  );
}

/** What a request has left to show. */
interface Budget {
  images: number;
  bytes: number;
  chars: number;
}

/** A text file as her view shows it, cut at `room` with a note of what is left. */
function fileBlock(file: Attachment, text: string, room: number): string {
  let shown = text.length > room ? text.slice(0, room) : text;
  if (/[\uD800-\uDBFF]$/.test(shown)) shown = shown.slice(0, -1);
  const rest = text.length - shown.length;
  const more = rest > 0 ? `\n（后面还有 ${rest} 字，这次没给你看）` : "";
  return `<file name="${fileName(file)}">\n${shown}${more}\n</file>`;
}

/** One line of the viewer's with its files, as much of them as `budget` still holds. */
async function lineWithFiles(
  message: ViewUserMessage,
  files: FileCache,
  budget: Budget,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const { attachments } = message;
  const notes: string[] = [];
  const images: (string | null)[] = [];
  // The budget goes to the newest first: a line's last file was sent last. A file it has no room
  // for isn't read.
  for (let i = attachments.length - 1; i >= 0; i--) {
    const file = attachments[i] as Attachment;
    if (file.kind === "image") {
      const shown = budget.images > 0 ? await files.read(file, signal) : null;
      const fits = shown !== null && shown.bytes.byteLength <= budget.bytes;
      if (fits) {
        budget.images -= 1;
        budget.bytes -= shown.bytes.byteLength;
      }
      images[i] = fits ? files.url(file, shown) : null;
      notes[i] = fits ? "" : UNSHOWN_IMAGE;
      continue;
    }
    const room = Math.min(SHOWN_FILE_CHARS, budget.chars);
    const shown = room > 0 ? await files.read(file, signal) : null;
    if (shown === null) {
      notes[i] = `（文件 ${fileName(file)}，这次没给你看）`;
      continue;
    }
    const text = new TextDecoder().decode(shown.bytes);
    budget.chars -= Math.min(text.length, room);
    notes[i] = `\n\n${fileBlock(file, text, room)}`;
  }
  const text = (message.content + notes.join("")).trim();
  const shown = images.filter((url): url is string => typeof url === "string");
  if (shown.length === 0) return { role: "user", content: text };
  return {
    role: "user",
    content: [
      ...(text === "" ? [] : [{ type: "text", text }]),
      ...shown.map((url) => ({ type: "image_url", image_url: { url } })),
    ],
  };
}

/**
 * `messages` as a mind takes them: each line of the viewer's with files becomes its words, then its
 * text files, then its images as `image_url` parts, in OpenAI's shape, which every mind reads. The
 * newest SHOWN_IMAGES images within SHOWN_IMAGE_BYTES are shown, and SHOWN_TEXT_CHARS of text
 * files, each cut at SHOWN_FILE_CHARS; a note stands in for the rest, and for a file that can't be
 * read. A line left with no image is text. Anything else passes as it is.
 */
export async function showFiles(
  messages: readonly unknown[],
  files: FileCache,
  signal: AbortSignal,
): Promise<unknown[]> {
  if (!messages.some(hasFiles)) return [...messages];
  const budget: Budget = {
    images: SHOWN_IMAGES,
    bytes: SHOWN_IMAGE_BYTES,
    chars: SHOWN_TEXT_CHARS,
  };
  const shown: unknown[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    shown.push(hasFiles(message) ? await lineWithFiles(message, files, budget, signal) : message);
  }
  return shown.reverse();
}

/** Whether `messages` show a mind any image. */
export function showsImages(messages: readonly unknown[]): boolean {
  return messages.some(
    (message) =>
      isPlainObject(message) &&
      Array.isArray(message.content) &&
      message.content.some((part) => isPlainObject(part) && part.type === "image_url"),
  );
}

/**
 * `messages` for a mind that can't see images: UNSEEN_IMAGE in place of each image part, and each
 * message's parts joined into its text again.
 */
export function withoutImages(messages: readonly unknown[]): unknown[] {
  return messages.map((message) => {
    if (!isPlainObject(message) || !Array.isArray(message.content)) return message;
    const parts = message.content.filter(isPlainObject);
    if (!parts.some((part) => part.type === "image_url")) return message;
    const text = parts
      .map((part) => {
        if (part.type === "image_url") return UNSEEN_IMAGE;
        return part.type === "text" ? String(part.text ?? "") : "";
      })
      .join("");
    return { ...message, content: text };
  });
}

/**
 * Whether a provider refused a request for the images in it: OpenRouter's 404 when no endpoint of
 * the model takes images, and the 400s and 422s of APIs whose model reads text alone, which name
 * the image part.
 */
export function refusedImages(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  if (![400, 404, 415, 422].includes(error.status)) return false;
  return /image|vision|multimodal|modalit|图片|图像|多模态/i.test(error.message);
}
