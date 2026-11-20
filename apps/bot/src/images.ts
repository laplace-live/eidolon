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

/** What a PNG that goes as it is may hold: its pixels and how to show them, nothing about it. */
const PLAIN_PNG_CHUNKS: ReadonlySet<string> = new Set([
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

/**
 * Whether a PNG holds only PLAIN_PNG_CHUNKS: libvips reads its chunks only up to its pixels, and a
 * text chunk can follow them.
 */
function plainPng(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 8 <= bytes.byteLength; at += view.getUint32(at) + 12) {
    if (!PLAIN_PNG_CHUNKS.has(String.fromCharCode(...bytes.subarray(at + 4, at + 8)))) {
      return false;
    }
  }
  return true;
}

/** Whether an image goes as it is: one frame, 8-bit sRGB, nothing written in it, and in bounds. */
function goesAsIs(meta: Metadata, type: string, bytes: Uint8Array): boolean {
  return (
    type !== "image/gif" &&
    (type !== "image/png" || plainPng(bytes)) &&
    (meta.pages ?? 1) === 1 &&
    meta.exif === undefined &&
    meta.xmp === undefined &&
    meta.iptc === undefined &&
    !meta.hasProfile &&
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
