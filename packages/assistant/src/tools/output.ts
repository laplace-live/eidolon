// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/core/tools/output-accumulator.ts@ac78a60
//
// A command's output: its log keeps every byte, stdout and stderr in the order they came, and a
// result shows the end of it, cleaned of what a terminal would have drawn.
import { open } from "node:fs/promises";
import { sanitizeBinaryOutput } from "./shell.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type TruncationOptions,
  type TruncationResult,
  truncateTail,
} from "./truncate.ts";

const CHUNK_BYTES = 64 * 1024;
/** The end of a log a tail is cut from, a partial first line dropped, as pi's rolling tail is. */
const TAIL_WINDOW_BYTES = 128 * 1024;
const NEWLINE = 0x0a;

/** The end of a log, as a result shows it. */
export interface LogTail {
  /** The last lines that fit, decoded but not yet sanitized. */
  readonly content: string;
  /** Totals of the whole log: its bytes, and its lines as truncateTail counts them. */
  readonly truncation: TruncationResult;
  /** The log's last line, in bytes, its newline left out, for the note on one too long to show whole. */
  readonly lastLineBytes: number;
  /** A NUL in what is shown: git's test for binary output. */
  readonly binary: boolean;
}

/** The log at `path` as it stands: the last lines within `options`' limits, and its totals. */
export async function readLogTail(path: string, options: TruncationOptions = {}): Promise<LogTail> {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const handle = await open(path, "r");
  try {
    // A log still being written is read up to its size now.
    const size = (await handle.stat()).size;
    let newlines = 0;
    let lastNewline = -1;
    let newlineBefore = -1;
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    for (let position = 0; position < size; ) {
      const length = Math.min(CHUNK_BYTES, size - position);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) break;
      for (let at = chunk.indexOf(NEWLINE); at !== -1 && at < bytesRead; ) {
        newlines++;
        newlineBefore = lastNewline;
        lastNewline = position + at;
        at = chunk.indexOf(NEWLINE, at + 1);
      }
      position += bytesRead;
    }
    const unended = size - (lastNewline + 1);
    const totalLines = newlines + (unended > 0 ? 1 : 0);
    // A log that ends a line ends with the one before its last newline.
    const lastLineBytes = Math.max(0, unended > 0 ? unended : lastNewline - (newlineBefore + 1));

    const windowBytes = Math.min(size, Math.max(TAIL_WINDOW_BYTES, maxBytes * 2));
    const start = size - windowBytes;
    // One byte more, to tell whether the window starts a line.
    const window = Buffer.alloc(windowBytes + (start > 0 ? 1 : 0));
    await handle.read(window, 0, window.length, start > 0 ? start - 1 : 0);
    const startsLine = start === 0 || window[0] === NEWLINE;
    let from = start > 0 ? 1 : 0;
    while (from < window.length && ((window[from] as number) & 0xc0) === 0x80) from++;
    const text = window.subarray(from).toString("utf-8");
    // Clipping drops the partial first line of the window. When the window is only the end of one
    // over-long line, that is everything, so show the end of that line instead.
    const newline = startsLine ? -1 : text.indexOf("\n");
    const shown = newline === -1 || newline === text.length - 1 ? text : text.slice(newline + 1);

    const tail = truncateTail(shown, { maxLines, maxBytes });
    const truncated = totalLines > maxLines || size > maxBytes;
    const truncatedBy = truncated
      ? (tail.truncatedBy ?? (size > maxBytes ? "bytes" : "lines"))
      : null;
    return {
      content: tail.content,
      truncation: {
        ...tail,
        truncated,
        truncatedBy,
        totalLines,
        totalBytes: size,
        maxLines,
        maxBytes,
      },
      lastLineBytes,
      binary: tail.content.includes("\0"),
    };
  } finally {
    await handle.close();
  }
}

/**
 * The part of `line` a terminal shows last: what follows its last carriage return, as a progress
 * bar's last state, unless nothing does.
 */
function lastRedraw(line: string): string {
  const drawn = line.split("\r");
  while (drawn.length > 1 && drawn.at(-1) === "") drawn.pop();
  return drawn.at(-1) as string;
}

/**
 * `text` as a model should read it: no colours, cursor moves or links (Bun.stripANSI), CRLF and a
 * redrawn line's carriage returns resolved, and no other control characters. Its lines stay the
 * log's, so line numbers hold.
 */
export function sanitize(text: string): string {
  return Bun.stripANSI(text)
    .split("\n")
    .map((line) => sanitizeBinaryOutput(lastRedraw(line)))
    .join("\n");
}
