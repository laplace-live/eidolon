// The files a viewer sends with a line, made ready in the browser before they go, so they go small:
// an image is drawn upright, with nothing its camera wrote in it, and scaled into what minds take, a
// PNG or WebP that already fits going as it is; a text file goes as UTF-8, as it is. The server
// takes no image larger, and makes each one ready for her mind again.
import {
  type ChatFile,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  MAX_TEXT_FILE_BYTES,
} from "./types.ts";

const JPEG_QUALITIES = [0.85, 0.75, 0.6] as const;

/** A file that can't go with a line: of a kind not taken, or past its size even scaled down. */
export class ChatFileError extends Error {
  override name = "ChatFileError";
  readonly code: "unsupported" | "too-large";

  constructor(code: "unsupported" | "too-large", filename: string) {
    super(code === "too-large" ? `${filename} is too large to send` : `${filename} can't be sent`);
    this.code = code;
  }
}

/** A file made ready to go with a line. */
export type PreparedChatFile = ChatFile & { readonly kind: "image" | "file" };

/** The extensions of text files a browser gives no type of its own. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "ini",
  "log",
  "srt",
  "vtt",
  "ass",
  "lrc",
  "xml",
  "html",
  "css",
  "js",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "sh",
  "sql",
]);

/** The extensions of pictures a browser may give no type, as some drags do. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "avif",
  "heic",
  "heif",
  "bmp",
]);

/** A file input's `accept`: images and text files. */
export const CHAT_FILE_ACCEPT = [
  "image/*",
  "text/*",
  ...[...TEXT_EXTENSIONS].map((ext) => `.${ext}`),
].join(",");

/**
 * Whether a file goes as an image, a text file, or not at all, by its type and else its name. An
 * SVG is no image here: it is script a host would serve.
 */
export function chatFileKind(file: {
  readonly type: string;
  readonly name: string;
}): "image" | "file" | null {
  const type = file.type.toLowerCase();
  if (type.startsWith("image/")) return type === "image/svg+xml" ? null : "image";
  if (type.startsWith("text/") || type === "application/json") return "file";
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (type === "" && IMAGE_EXTENSIONS.has(ext)) return "image";
  return TEXT_EXTENSIONS.has(ext) ? "file" : null;
}

/**
 * The size an image of `width` × `height` goes at: within MAX_IMAGE_PIXELS and MAX_IMAGE_EDGE, never
 * larger, rounded down as the server fits one, so what this sends it takes as it is.
 */
export function fittedSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(
    1,
    Math.sqrt(MAX_IMAGE_PIXELS / (width * height)),
    MAX_IMAGE_EDGE / Math.max(width, height),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/** Whether an image goes as it is: a PNG or WebP that fits, which cameras don't write. */
export function goesAsIs(type: string, size: number, width: number, height: number): boolean {
  const fitted = fittedSize(width, height);
  return (
    (type === "image/png" || type === "image/webp") &&
    size <= MAX_IMAGE_BYTES &&
    fitted.width === width &&
    fitted.height === height
  );
}

/** Whether `bytes` are UTF-8 with no NUL, as a text file is. */
export function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function encoded(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function hasAlpha(context: CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = context.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) if ((data[i] as number) < 255) return true;
  return false;
}

/**
 * `file` drawn upright at its fitted size: with transparency as WebP, or PNG where the browser
 * makes no WebP (Safari); else, or when that is too large, as JPEG at the first quality that fits,
 * on white.
 */
async function preparedImage(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ChatFileError("unsupported", file.name);
  }
  try {
    if (goesAsIs(file.type, file.size, bitmap.width, bitmap.height)) return file;
    const { width, height } = fittedSize(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) throw new ChatFileError("unsupported", file.name);
    context.drawImage(bitmap, 0, 0, width, height);
    if (file.type !== "image/jpeg" && hasAlpha(context, width, height)) {
      for (const type of ["image/webp", "image/png"]) {
        const blob = await encoded(canvas, type, JPEG_QUALITIES[0]);
        if (blob?.type === type && blob.size <= MAX_IMAGE_BYTES) return blob;
      }
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
    }
    for (const quality of JPEG_QUALITIES) {
      const blob = await encoded(canvas, "image/jpeg", quality);
      if (blob !== null && blob.size <= MAX_IMAGE_BYTES) return blob;
    }
    throw new ChatFileError("too-large", file.name);
  } finally {
    bitmap.close();
  }
}

async function preparedText(file: File): Promise<PreparedChatFile> {
  if (file.size > MAX_TEXT_FILE_BYTES) throw new ChatFileError("too-large", file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0 || !isUtf8Text(bytes)) {
    throw new ChatFileError("unsupported", file.name);
  }
  return { kind: "file", blob: new Blob([bytes], { type: "text/plain" }), filename: file.name };
}

/**
 * `file` as it goes with a line: an image (PNG, JPEG or WebP, at most MAX_IMAGE_BYTES) or a text
 * file (UTF-8, at most MAX_TEXT_FILE_BYTES); `ChatFileError` when it can't go.
 */
export async function prepareChatFile(file: File): Promise<PreparedChatFile> {
  const kind = chatFileKind(file);
  if (kind === null) throw new ChatFileError("unsupported", file.name);
  return kind === "image" ? { kind, blob: await preparedImage(file) } : preparedText(file);
}
