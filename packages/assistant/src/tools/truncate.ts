// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/core/tools/truncate.ts@ac78a60
//
// How much of a tool's output the model sees: whichever of the line and byte limits is hit first
// wins, and only whole lines are kept, except when the one line left is longer than the limit.

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
/** The characters a grep match line keeps. */
export const GREP_MAX_LINE_LENGTH = 500;

export interface TruncationResult {
  readonly content: string;
  readonly truncated: boolean;
  /** The limit that was hit; null when nothing was cut. */
  readonly truncatedBy: "lines" | "bytes" | null;
  readonly totalLines: number;
  readonly totalBytes: number;
  /** Whole lines kept. */
  readonly outputLines: number;
  readonly outputBytes: number;
  /** truncateTail kept only the end of the last line, which alone was over the byte limit. */
  readonly lastLinePartial: boolean;
  /** truncateHead kept nothing: the first line alone is over the byte limit. */
  readonly firstLineExceedsLimit: boolean;
  readonly maxLines: number;
  readonly maxBytes: number;
}

export interface TruncationOptions {
  /** Default DEFAULT_MAX_LINES. */
  readonly maxLines?: number;
  /** Default DEFAULT_MAX_BYTES. */
  readonly maxBytes?: number;
}

/** A trailing newline ends the last line rather than starting an empty one. */
function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

/** `bytes` as 512B, 1.5KB or 2.0MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function untruncated(
  content: string,
  totalLines: number,
  totalBytes: number,
  maxLines: number,
  maxBytes: number,
): TruncationResult {
  return {
    content,
    truncated: false,
    truncatedBy: null,
    totalLines,
    totalBytes,
    outputLines: totalLines,
    outputBytes: totalBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

/** The first lines of `content` that fit, for a file read from its start. */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return untruncated(content, totalLines, totalBytes, maxLines, maxBytes);
  }

  if (Buffer.byteLength(lines[0] as string, "utf-8") > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  const kept: string[] = [];
  let keptBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i] as string;
    // Every line after the first brings its newline.
    const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0);
    if (keptBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    kept.push(line);
    keptBytes += lineBytes;
  }
  if (kept.length >= maxLines && keptBytes <= maxBytes) truncatedBy = "lines";

  const output = kept.join("\n");
  return {
    content: output,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: kept.length,
    outputBytes: Buffer.byteLength(output, "utf-8"),
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

/** The last lines of `content` that fit, for output whose end matters most: errors, results. */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return untruncated(content, totalLines, totalBytes, maxLines, maxBytes);
  }

  const kept: string[] = [];
  let keptBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  let lastLinePartial = false;
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const line = lines[i] as string;
    const lineBytes = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0);
    if (keptBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      // The last line alone is over the limit: keep its end rather than nothing.
      if (kept.length === 0) {
        const end = truncateStringToBytesFromEnd(line, maxBytes);
        kept.unshift(end);
        keptBytes = Buffer.byteLength(end, "utf-8");
        lastLinePartial = true;
      }
      break;
    }
    kept.unshift(line);
    keptBytes += lineBytes;
  }
  if (kept.length >= maxLines && keptBytes <= maxBytes) truncatedBy = "lines";

  const output = kept.join("\n");
  return {
    content: output,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: kept.length,
    outputBytes: Buffer.byteLength(output, "utf-8"),
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

/** The end of `str` that fits in `maxBytes`, starting on a whole UTF-8 character. */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;
  let start = buf.length - maxBytes;
  // Skip continuation bytes (10xxxxxx) to the start of a character.
  while (start < buf.length && ((buf[start] as number) & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf-8");
}

/** `line` cut to `maxChars`, marked "... [truncated]" where it was cut. */
export function truncateLine(
  line: string,
  maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  return { text: `${sliceHead(line, maxChars)}... [truncated]`, wasTruncated: true };
}

/** At most the first `maxUnits` UTF-16 code units of `text`, never half a surrogate pair. */
export function sliceHead(text: string, maxUnits: number): string {
  const end = Math.max(0, maxUnits);
  return isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))
    ? text.slice(0, end - 1)
    : text.slice(0, end);
}

/** At most the last `maxUnits` UTF-16 code units of `text`, never half a surrogate pair. */
export function sliceTail(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return "";
  const start = Math.max(0, text.length - maxUnits);
  return isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))
    ? text.slice(start + 1)
    : text.slice(start);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
