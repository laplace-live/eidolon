// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/mcp/src/output-limit.ts@ac78a60
//
// The size limit of the text a model reads from an MCP result. Longer text keeps its start and end
// with the middle cut out, like Codex does, since JSON results end with their pagination cursors.
// pi saves the whole text where its model can read it; a task's read can't reach such a file, so
// the worker asks again for less.

/** Model-facing text of an MCP result beyond this is cut in the middle. */
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;

const ASK_FOR_LESS =
  "The middle was cut. To see it, call the tool again asking for less: a narrower query, a " +
  "smaller page or a filter.";

export interface LimitedMcpText {
  readonly text: string;
  /** The whole text's size, when its middle was cut. */
  readonly truncated?: { readonly totalBytes: number; readonly totalLines: number };
}

/** `text` within {@link MCP_OUTPUT_MAX_BYTES}: as it is, or in Codex's truncation format. */
export function limitMcpText(text: string): LimitedMcpText {
  const truncation = truncateMiddle(text, MCP_OUTPUT_MAX_BYTES);
  if (!truncation) return { text };
  const { totalBytes, totalLines } = truncation;
  const tokens = Math.ceil(totalBytes / 4);
  return {
    text: `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${totalLines}\n${ASK_FOR_LESS}\n\n${truncation.content}`,
    truncated: { totalBytes, totalLines },
  };
}

/** Text cut in the middle, with the size of the whole text. */
interface MiddleTruncation {
  /** The start and the end of the text with a `…N chars truncated…` marker between them. */
  content: string;
  totalBytes: number;
  totalLines: number;
}

/**
 * Keep the start and the end of `text`, half of `maxBytes` each, and replace the middle with a
 * `…N chars truncated…` marker. Cuts only at character boundaries. Undefined when `text` fits.
 */
function truncateMiddle(text: string, maxBytes: number): MiddleTruncation | undefined {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return undefined;
  // Continuation bytes (10xxxxxx) are not character starts.
  const isBoundary = (index: number) =>
    index >= buf.length || ((buf[index] as number) & 0xc0) !== 0x80;
  let headEnd = Math.floor(maxBytes / 2);
  while (headEnd > 0 && !isBoundary(headEnd)) headEnd--;
  let tailStart = buf.length - (maxBytes - Math.floor(maxBytes / 2));
  while (tailStart < buf.length && !isBoundary(tailStart)) tailStart++;
  const head = buf.subarray(0, headEnd).toString("utf-8");
  const tail = buf.subarray(tailStart).toString("utf-8");
  const removedChars = Array.from(buf.subarray(headEnd, tailStart).toString("utf-8")).length;
  // A final newline ends the last line instead of starting another.
  const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  return {
    content: `${head}…${removedChars} chars truncated…${tail}`,
    totalBytes: buf.length,
    totalLines: lines,
  };
}
