// An image the viewer sends, made what her mind is shown: upright, without what its camera wrote,
// and fitted to what minds take, after DeepSeek Harness's attachments
// (github.com/deepseek-ai/deepseek-harness).
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  sendableImageType,
} from "@eidolon/chat";
import { errorText, logger } from "@eidolon/config";
import type { Metadata } from "sharp";

/** The largest image the local app takes, and its pixels at most, as DeepSeek Harness takes them. */
export const MAX_SENT_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_SENT_IMAGE_PIXELS = 64_000_000;

const QUALITIES = [85, 75, 60] as const;
/** DeepSeek Harness's measure: a deeper search takes 3 to 4 times as long for about 5% less. */
const WEBP_EFFORT = 0;
/** How many images are made at once, each on libvips's own threads, beside a call's. */
const SLOTS = 2;

/** An image as her mind is shown it. */
export interface NormalizedImage {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

/** Why an image can't go: past its bytes or pixels, or not a whole PNG, JPEG, WebP or GIF. */
export type ImageRefusal = "too-large" | "unsupported";

type Sharp = typeof import("sharp")["default"];

let loaded: Promise<Sharp> | undefined;

/** Sharp, imported with the first image: a bot sent none never loads libvips. */
function loadSharp(): Promise<Sharp> {
  loaded ??= import("sharp").then((module) => module.default);
  return loaded;
}

let running = 0;
const waiting: (() => void)[] = [];

/** `work`, once fewer than SLOTS images are being made. */
async function inSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running < SLOTS) running += 1;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next === undefined) running -= 1;
    else next();
  }
}

/** The type of image `bytes` hold by their signature, so libvips parses no other kind (an SVG). */
function sourceType(bytes: Uint8Array): string | null {
  const head = String.fromCharCode(...bytes.subarray(0, 6));
  return sendableImageType(bytes) ?? (head === "GIF87a" || head === "GIF89a" ? "image/gif" : null);
}

/** The size an image of `width` × `height` is shown at: within MAX_IMAGE_PIXELS and MAX_IMAGE_EDGE. */
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

/** The chunks of a bare PNG: its pixels and how to show them. */
const PNG_CHUNKS: ReadonlySet<string> = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "sBIT",
  "pHYs",
  "bKGD",
]);
/** The chunks of a bare WebP: its one frame and its transparency. */
const WEBP_CHUNKS: ReadonlySet<string> = new Set(["VP8 ", "VP8L", "VP8X", "ALPH"]);
/** The segments of a bare JPEG besides JFIF's header and its scans: SOF0-2, DHT and DQT. */
const JPEG_SEGMENTS: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2, 0xc4, 0xdb]);
const JFIF = [0x4a, 0x46, 0x49, 0x46, 0];

const fourcc = (bytes: Uint8Array, at: number) =>
  String.fromCharCode(...bytes.subarray(at, at + 4));

function barePng(bytes: Uint8Array, view: DataView): boolean {
  for (let at = 8; at + 12 <= bytes.byteLength; ) {
    const type = fourcc(bytes, at + 4);
    if (!PNG_CHUNKS.has(type)) return false;
    at += view.getUint32(at) + 12;
    if (type === "IEND") return at === bytes.byteLength;
  }
  return false;
}

function bareWebp(bytes: Uint8Array, view: DataView): boolean {
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) return false;
  const chunks = new Set<string>();
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const chunk = fourcc(bytes, at);
    if (!WEBP_CHUNKS.has(chunk) || chunks.has(chunk)) return false;
    chunks.add(chunk);
    const size = view.getUint32(at + 4, true);
    at += 8 + size + (size % 2);
  }
  // One frame: lossy or lossless, not both.
  return at === bytes.byteLength && chunks.has("VP8 ") !== chunks.has("VP8L");
}

/**
 * Where a scan's data from `at` ends: at its first `FF` that isn't `FF 00`. A restart or a fill
 * byte ends it too, so a JPEG with them is made again.
 */
function scanEnd(bytes: Uint8Array, at: number): number {
  for (; at + 1 < bytes.byteLength; at++) if (bytes[at] === 0xff && bytes[at + 1] !== 0) return at;
  return bytes.byteLength;
}

function bareJpeg(bytes: Uint8Array, view: DataView): boolean {
  let at = 2;
  while (at + 4 <= bytes.byteLength && bytes[at] === 0xff) {
    const marker = bytes[at + 1] as number;
    if (marker === 0xd9) return at + 2 === bytes.byteLength;
    const end = at + 2 + view.getUint16(at + 2);
    // JFIF's own header: 16 bytes, so no thumbnail in it.
    const jfif =
      marker === 0xe0 && end - at === 18 && JFIF.every((byte, i) => bytes[at + 4 + i] === byte);
    if (marker === 0xda) at = scanEnd(bytes, end);
    else if (jfif || JPEG_SEGMENTS.has(marker)) at = end;
    else return false;
  }
  return at + 2 === bytes.byteLength && bytes[at] === 0xff && bytes[at + 1] === 0xd9;
}

/**
 * Whether `bytes` hold their image and nothing else, ending where it ends: nothing a camera or an
 * editor wrote, no second frame, no comment. libvips reads a PNG's chunks only up to its pixels,
 * and no JPEG comment or trailing bytes at all, so the container is read here.
 */
function bare(type: string, bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "image/png") return barePng(bytes, view);
  if (type === "image/webp") return bareWebp(bytes, view);
  return type === "image/jpeg" && bareJpeg(bytes, view);
}

/** Whether an image goes as it is: bare, 8-bit sRGB, and in bounds. */
function goesAsIs(meta: Metadata, type: string, bytes: Uint8Array): boolean {
  return (
    bare(type, bytes) &&
    meta.space === "srgb" &&
    bytes.byteLength <= MAX_IMAGE_BYTES &&
    meta.width * meta.height <= MAX_IMAGE_PIXELS &&
    Math.max(meta.width, meta.height) <= MAX_IMAGE_EDGE
  );
}

async function normalized(
  bytes: Uint8Array,
  type: string,
  maxPixels: number,
): Promise<NormalizedImage | { readonly refused: ImageRefusal }> {
  const sharp = await loadSharp();
  // "error" also fails a truncated image. The pixels are checked from the header below instead, so
  // that a refusal says why.
  const options = { failOn: "error", limitInputPixels: false } as const;
  try {
    const meta = await sharp(bytes, options).metadata();
    if (meta.width * meta.height > maxPixels) return { refused: "too-large" };
    if (goesAsIs(meta, type, bytes)) {
      await sharp(bytes, options).raw().toBuffer();
      return { bytes, mime: type };
    }
    const { width, height } = fittedSize(meta.autoOrient.width, meta.autoOrient.height);
    // sharp writes sRGB with no metadata unless told to keep it (`withMetadata` in its API docs).
    const sized = sharp(bytes, { ...options, autoOrient: true }).resize({
      width,
      height,
      fit: "fill",
    });
    const mime = meta.hasAlpha ? "image/webp" : "image/jpeg";
    for (const quality of QUALITIES) {
      const encoded = await (mime === "image/webp"
        ? sized.clone().webp({ quality, effort: WEBP_EFFORT })
        : sized.clone().jpeg({ quality })
      ).toBuffer();
      if (encoded.byteLength <= MAX_IMAGE_BYTES) return { bytes: encoded, mime };
    }
    return { refused: "too-large" };
  } catch (error) {
    logger.info(`[images] A ${type} image was refused: ${errorText(error)}`);
    return { refused: "unsupported" };
  }
}

/**
 * `bytes` as her mind is shown them, or why they can't be: a whole PNG, JPEG, WebP or GIF, whose
 * first frame alone is taken, of at most `maxPixels`. It rejects only when sharp can't be loaded.
 */
export function normalizeImage(
  bytes: Uint8Array,
  maxPixels: number,
): Promise<NormalizedImage | { readonly refused: ImageRefusal }> {
  const type = sourceType(bytes);
  if (type === null) return Promise.resolve({ refused: "unsupported" });
  return inSlot(() => normalized(bytes, type, maxPixels));
}
