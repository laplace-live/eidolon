// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/core/tools/read.ts@ac78a60 and packages/coding-agent/src/utils/mime.ts@ac78a60
//
// The task's read tool: a text file's lines from an offset, streamed so that only what is shown is
// kept. An image or another binary file gets a note in place of its bytes.
import { type FileHandle, open } from "node:fs/promises";
import type { TaskToolResult } from "@eidolon/engine";
import type { AssistantTool, PathGuard } from "../types.ts";
import {
  ABORTED,
  errorResult,
  failure,
  guardPath,
  integerArgument,
  invalidArguments,
  pathArgument,
} from "./results.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "./truncate.ts";

/**
 * Git takes a NUL in a file's first 8,000 bytes to mean it is binary; image types are read from the
 * same bytes.
 */
const SNIFF_BYTES = 8000;
const CHUNK_BYTES = 64 * 1024;

/** What a text read shows. */
export interface ReadText {
  readonly text: string;
  /** How the shown lines were cut, when they were; the text itself is left out. */
  readonly truncation?: Omit<TruncationResult, "content">;
}

export function createReadTool(guard: PathGuard): AssistantTool {
  return {
    schema: {
      name: "read",
      description: `Read the contents of a text file. Images and other binary files get a short note instead of their contents. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
      properties: {
        path: { type: "string", description: "Path to the file to read (relative or absolute)" },
        offset: { type: "integer", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "integer", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
    snippet: "Read file contents",
    guidelines: ["Use read to examine files instead of cat or sed."],
    replay: "safe",
    async execute(args, { signal }) {
      const problems: string[] = [];
      const path = pathArgument(args, problems);
      const offset = integerArgument(args, "offset", problems);
      const limit = integerArgument(args, "limit", problems, 0);
      if (problems.length > 0) return invalidArguments("read", problems, args);
      if (signal.aborted) return errorResult(ABORTED);
      return untilAborted(signal, readPath(guard, path, offset, limit, signal));
    },
  };
}

/** `work`'s result, or the aborted one as soon as `signal` aborts; `work` never rejects. */
function untilAborted(signal: AbortSignal, work: Promise<TaskToolResult>): Promise<TaskToolResult> {
  return new Promise((resolve) => {
    const onAbort = () => resolve(errorResult(ABORTED));
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then((result) => {
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    });
  });
}

async function readPath(
  guard: PathGuard,
  path: string,
  offset: number | undefined,
  limit: number | undefined,
  signal: AbortSignal,
): Promise<TaskToolResult> {
  try {
    const target = await guardPath(guard, path, "read");
    if (typeof target !== "string") return target;
    const handle = await open(target, "r");
    try {
      const stats = await handle.stat();
      if (stats.isDirectory()) return errorResult(`${path} is a directory. Use ls to list it.`);
      const head = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await handle.read(head, 0, SNIFF_BYTES, 0);
      const sniffed = head.subarray(0, bytesRead);
      const files = { read: [target] };
      const mimeType = detectSupportedImageMimeType(sniffed);
      if (mimeType !== null || sniffed.includes(0)) {
        const kind = mimeType === null ? "a binary file" : `an image (${mimeType})`;
        return {
          content: `${path} is ${kind} of ${formatSize(stats.size)}. read shows text only, so its contents aren't shown.`,
          files,
        };
      }
      const chunks = fileChunks(handle, stats.isFile() ? stats.size : 0);
      const { text, truncation } = await readLines(chunks, offset, limit, signal);
      return { content: text, details: truncation && { truncation }, files };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return failure(error);
  }
}

/**
 * The file's bytes from its start, up to `size` when that is above 0, as fs.readFile reads a
 * regular file: one that grows during the read still ends. A size of 0, as /proc files report,
 * reads to EOF.
 */
async function* fileChunks(handle: FileHandle, size: number): AsyncGenerator<Uint8Array> {
  const end = size > 0 ? size : Number.POSITIVE_INFINITY;
  for (let position = 0; position < end; ) {
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

/**
 * What read shows of a text file streamed as `chunks`: its lines from `offset` (1-based), at most
 * `limit` of them, cut at DEFAULT_MAX_LINES or DEFAULT_MAX_BYTES with a note on how to read on.
 * Lines count as `text.split("\n")` counts them. Throws when `offset` is past the end, or when
 * `signal` aborts.
 */
export async function readLines(
  chunks: AsyncIterable<Uint8Array>,
  offset: number | undefined,
  limit: number | undefined,
  signal?: AbortSignal,
): Promise<ReadText> {
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const first = startLine + 1;
  const { totalFileLines, truncation, firstLineBytes } = await selectLines(
    chunks,
    startLine,
    limit,
    signal,
  );
  if (startLine >= totalFileLines) {
    throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
  }
  const { content, ...cut } = truncation;
  if (truncation.firstLineExceedsLimit) {
    const next = first < totalFileLines ? ` Use offset=${first + 1} to continue.` : "";
    return {
      text: `[Line ${first} is ${formatSize(firstLineBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit, so read can't show it.${next}]`,
      truncation: cut,
    };
  }
  if (truncation.truncated) {
    const last = first + truncation.outputLines - 1;
    const limitHit =
      truncation.truncatedBy === "lines" ? "" : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
    return {
      text: `${content}\n\n[Showing lines ${first}-${last} of ${totalFileLines}${limitHit}. Use offset=${last + 1} to continue.]`,
      truncation: cut,
    };
  }
  // A limit is honored before truncation: the lines it left out are counted here.
  const shown =
    limit === undefined ? undefined : Math.min(startLine + limit, totalFileLines) - startLine;
  if (shown !== undefined && startLine + shown < totalFileLines) {
    const remaining = totalFileLines - (startLine + shown);
    return {
      text: `${content}\n\n[${remaining} more lines in file. Use offset=${startLine + shown + 1} to continue.]`,
    };
  }
  return { text: content };
}

interface SelectedLines {
  readonly totalFileLines: number;
  readonly truncation: TruncationResult;
  /** The first selected line's size, for the note when it alone is over the byte limit. */
  readonly firstLineBytes: number;
}

/**
 * The lines from `startLine` (0-based), at most `limit`, read in chunks. Only lines truncateHead
 * can show are stored, and the rest counted, so memory doesn't grow with the file.
 */
async function selectLines(
  chunks: AsyncIterable<Uint8Array>,
  startLine: number,
  limit: number | undefined,
  signal: AbortSignal | undefined,
): Promise<SelectedLines> {
  const endLine = limit === undefined ? Number.POSITIVE_INFINITY : startLine + limit;
  // ignoreBOM keeps a byte order mark, as Buffer.toString("utf-8") does.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const storedLines: string[] = [];
  let storedBytes = 0;
  let storedPastCaps = false;
  let line = 0;
  let selectedLines = 0;
  let selectedBytes = 0;
  let firstLineBytes = 0;
  let lastLineEmpty = true;
  // The selected line being read: its text, while it is stored, and its size.
  let pieces: string[] | undefined = [];
  let lineBytes = 0;
  let lineHasText = false;

  const appendToLine = (text: string, start: number, end: number): void => {
    lineHasText = true;
    if (!pieces) return;
    const piece = text.slice(start, end);
    // A line over the byte cap is never shown, and a first line over it is only measured: never
    // store all of a 1 GB line.
    if (lineBytes <= DEFAULT_MAX_BYTES) pieces.push(piece);
    lineBytes += Buffer.byteLength(piece, "utf-8");
  };
  const finishLine = (): void => {
    if (pieces) {
      if (selectedLines === 0) firstLineBytes = lineBytes;
      // Storing goes on one line past the caps: truncateHead ignores a trailing empty line, so the
      // line after the cap must be there for it to decide truncation as it would for the full text.
      if (storedLines.length > DEFAULT_MAX_LINES || storedBytes > DEFAULT_MAX_BYTES) {
        storedPastCaps = true;
      }
      const text = pieces.join("");
      storedBytes += Buffer.byteLength(text, "utf-8") + (storedLines.length > 0 ? 1 : 0);
      storedLines.push(text);
    }
    selectedLines++;
    lastLineEmpty = !lineHasText;
    pieces = storedPastCaps ? undefined : [];
    lineBytes = 0;
    lineHasText = false;
  };
  const select = (text: string): void => {
    let position = 0;
    // Where the selected text starts in this piece, to measure the joined lines' size.
    let selectionStart = -1;
    while (true) {
      const selected = line >= startLine && line < endLine;
      if (selected && selectionStart === -1) selectionStart = position;
      const newline = text.indexOf("\n", position);
      const end = newline === -1 ? text.length : newline;
      if (selected && end > position) appendToLine(text, position, end);
      if (newline === -1) break;
      if (selected) {
        finishLine();
        if (line + 1 === endLine) {
          selectedBytes += Buffer.byteLength(text.slice(selectionStart, newline), "utf-8");
          selectionStart = -1;
        }
      }
      line++;
      position = newline + 1;
    }
    if (selectionStart !== -1) {
      selectedBytes += Buffer.byteLength(text.slice(selectionStart), "utf-8");
    }
  };

  for await (const chunk of chunks) {
    if (signal?.aborted) throw new Error(ABORTED);
    select(decoder.decode(chunk, { stream: true }));
  }
  select(decoder.decode());
  if (line >= startLine && line < endLine) finishLine();
  const truncation: TruncationResult = {
    ...truncateHead(storedLines.join("\n")),
    // truncateHead's counts, for all the selected lines: it drops a trailing empty line.
    totalLines: selectedBytes === 0 ? 0 : selectedLines - (lastLineEmpty ? 1 : 0),
    totalBytes: selectedBytes,
  };
  return { totalFileLines: line + 1, truncation, firstLineBytes };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The image type `buffer`, a file's first bytes, holds, when it is one models take; else null. */
function detectSupportedImageMimeType(buffer: Uint8Array): string | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    // JPEG-LS, which models don't take.
    return buffer[3] === 0xf7 ? null : "image/jpeg";
  }
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
  }
  if (startsWithAscii(buffer, 0, "GIF87a") || startsWithAscii(buffer, 0, "GIF89a")) {
    return "image/gif";
  }
  if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
    return "image/webp";
  }
  if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) return "image/bmp";
  return null;
}

function isPng(buffer: Uint8Array): boolean {
  return (
    buffer.length >= 16 &&
    readUint32BE(buffer, PNG_SIGNATURE.length) === 13 &&
    startsWithAscii(buffer, 12, "IHDR")
  );
}

function isAnimatedPng(buffer: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const chunkLength = readUint32BE(buffer, offset);
    const chunkTypeOffset = offset + 4;
    if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
    if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;
    const nextOffset = offset + 8 + chunkLength + 4;
    if (nextOffset <= offset || nextOffset > buffer.length) return false;
    offset = nextOffset;
  }
  return false;
}

/** A header a BMP decoder would take, so text that starts with "BM" isn't one. */
function isBmp(buffer: Uint8Array): boolean {
  if (buffer.length < 26) return false;
  const declaredFileSize = readUint32LE(buffer, 2);
  const pixelDataOffset = readUint32LE(buffer, 10);
  const dibHeaderSize = readUint32LE(buffer, 14);
  if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
  if (pixelDataOffset < 14 + dibHeaderSize) return false;
  if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;

  let colorPlanes: number;
  let bitsPerPixel: number;
  if (dibHeaderSize === 12) {
    colorPlanes = readUint16LE(buffer, 22);
    bitsPerPixel = readUint16LE(buffer, 24);
  } else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
    if (buffer.length < 30) return false;
    colorPlanes = readUint16LE(buffer, 26);
    bitsPerPixel = readUint16LE(buffer, 28);
  } else {
    return false;
  }
  return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

function readUint16LE(buffer: Uint8Array, offset: number): number {
  return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] ?? 0) * 0x1000000 +
    ((buffer[offset + 1] ?? 0) << 16) +
    ((buffer[offset + 2] ?? 0) << 8) +
    (buffer[offset + 3] ?? 0)
  );
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] ?? 0) +
    ((buffer[offset + 1] ?? 0) << 8) +
    ((buffer[offset + 2] ?? 0) << 16) +
    (buffer[offset + 3] ?? 0) * 0x1000000
  );
}

function startsWith(buffer: Uint8Array, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++) {
    if (buffer[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}
