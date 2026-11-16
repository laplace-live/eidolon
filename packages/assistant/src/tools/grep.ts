// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/core/tools/grep.ts@ac78a60
//
// pi runs rg; this reads the files itself, on find's walk, a line at a time as rg does. It has no
// context lines.
import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AssistantTool, PathGuard } from "../types.ts";
import { globMatcher, walkFolder } from "./find.ts";
import {
  ABORTED,
  errorResult,
  failure,
  guardPath,
  integerArgument,
  invalidArguments,
  stringArgument,
  typeName,
} from "./results.ts";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  type TruncationResult,
  truncateHead,
  truncateLine,
} from "./truncate.ts";

const DEFAULT_LIMIT = 100;
const CHUNK_BYTES = 64 * 1024;

export interface GrepDetails {
  readonly truncation?: TruncationResult;
  readonly matchLimitReached?: number;
  readonly linesTruncated?: boolean;
}

export function createGrepTool(guard: PathGuard): AssistantTool {
  return {
    schema: {
      name: "grep",
      description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore and skips .git, node_modules and binary files. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
      properties: {
        pattern: {
          type: "string",
          description: "Search pattern (JavaScript regex or literal string)",
        },
        path: {
          type: "string",
          description: "Directory or file to search (default: the task's folder)",
        },
        glob: {
          type: "string",
          description:
            "Filter files by glob pattern relative to path, e.g. 'src/**/*.ts'. Without '/', e.g. '*.ts', it matches file names at any depth. A leading '!' excludes what it matches",
        },
        ignoreCase: {
          type: "boolean",
          description: "Case-insensitive search (default: false)",
        },
        literal: {
          type: "boolean",
          description: "Treat pattern as literal string instead of regex (default: false)",
        },
        limit: {
          type: "integer",
          description: `Maximum number of matches to return (default: ${DEFAULT_LIMIT})`,
        },
      },
      required: ["pattern"],
    },
    replay: "safe",
    snippet: "Search file contents for patterns (respects .gitignore)",
    guidelines: [],
    async execute(args, { signal }) {
      const problems: string[] = [];
      const pattern = stringArgument(args, "pattern", problems);
      if (args.pattern === "") problems.push("pattern: must not be empty");
      const path = args.path == null ? "" : stringArgument(args, "path", problems);
      const glob = args.glob == null ? "" : stringArgument(args, "glob", problems);
      const ignoreCase = booleanArgument(args, "ignoreCase", problems);
      const literal = booleanArgument(args, "literal", problems);
      const limit = integerArgument(args, "limit", problems) ?? DEFAULT_LIMIT;
      if (problems.length > 0) return invalidArguments("grep", problems, args);
      const regex = compile(pattern, literal, ignoreCase);
      if (typeof regex === "string") return errorResult(regex);
      if (signal.aborted) return errorResult(ABORTED);

      const searchPath = await guardPath(guard, path || ".", "read");
      if (typeof searchPath !== "string") return searchPath;
      let stats: Stats;
      try {
        stats = await stat(searchPath);
      } catch {
        return errorResult(`Path not found: ${searchPath}`);
      }
      if (!stats.isFile() && !stats.isDirectory()) {
        return errorResult(`Not a file or directory: ${searchPath}`);
      }

      const effectiveLimit = Math.max(1, limit);
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      // Rows past the byte cap are counted, each with its newline, but not kept: truncateHead
      // drops them anyway.
      const kept: string[] = [];
      let matchCount = 0;
      let outputBytes = 0;
      let matchLimitReached = false;
      let linesTruncated = false;
      const search = (file: string, shown: string) =>
        eachLine(file, buffer, signal, (text, lineNumber) => {
          if (!regex.test(text)) return true;
          // Only one more match proves that the limit cut results off.
          if (matchCount === effectiveLimit) {
            matchLimitReached = true;
            return false;
          }
          matchCount++;
          const line = truncateLine(text);
          if (line.wasTruncated) linesTruncated = true;
          const row = `${shown}:${lineNumber}: ${line.text}`;
          if (outputBytes - 1 <= DEFAULT_MAX_BYTES) kept.push(row);
          outputBytes += Buffer.byteLength(row, "utf-8") + 1;
          return true;
        });

      if (stats.isFile()) {
        const name = basename(searchPath);
        try {
          if ((await search(searchPath, name)) === "binary") {
            return { content: `No matches found: ${name} is a binary file` };
          }
        } catch (error) {
          return failure(error);
        }
      } else {
        let included = (_path: string) => true;
        let skipDirectory: ((path: string) => boolean) | undefined;
        if (glob !== "") {
          const excludes = glob.startsWith("!");
          const matches = globMatcher(excludes ? glob.slice(1) : glob, searchPath);
          included = excludes ? (entryPath) => !matches(entryPath) : matches;
          // As with rg, an excluded directory takes everything under it along.
          if (excludes) skipDirectory = matches;
        }
        for await (const entry of walkFolder(searchPath, { guard, signal, skipDirectory })) {
          if (entry.kind !== "file" || !included(entry.path)) continue;
          try {
            await guard.resolve(entry.absolute, "read");
            await search(entry.absolute, entry.path);
          } catch {
            // Like rg past a file it can't read, the search goes on past one the guard refuses.
          }
          if (matchLimitReached) break;
        }
      }
      if (signal.aborted) return errorResult(ABORTED);
      if (matchCount === 0) return { content: "No matches found" };

      const truncation: TruncationResult = {
        ...truncateHead(kept.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER }),
        totalLines: matchCount,
        totalBytes: outputBytes - 1,
      };
      const notices: string[] = [];
      if (matchLimitReached) {
        notices.push(
          `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
        );
      }
      if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      if (linesTruncated) {
        notices.push(
          `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
        );
      }
      if (notices.length === 0) return { content: truncation.content };
      const details: GrepDetails = {
        ...(truncation.truncated ? { truncation } : {}),
        ...(matchLimitReached ? { matchLimitReached: effectiveLimit } : {}),
        ...(linesTruncated ? { linesTruncated } : {}),
      };
      return { content: `${truncation.content}\n\n[${notices.join(". ")}]`, details };
    },
  };
}

/** `args[key]` when it is a boolean; false when absent or null, or with the problem added. */
function booleanArgument(
  args: Readonly<Record<string, unknown>>,
  key: string,
  problems: string[],
): boolean {
  const value = args[key];
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  problems.push(`${key}: expected boolean, got ${typeName(value)}`);
  return false;
}

/** `pattern` as a RegExp, or why it isn't one. */
function compile(pattern: string, literal: boolean, ignoreCase: boolean): RegExp | string {
  const source = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
  const flags = ignoreCase ? "i" : "";
  try {
    return new RegExp(source, `u${flags}`);
  } catch {
    // Unicode mode refuses escapes rg takes, such as \- outside a class.
    try {
      return new RegExp(source, flags);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}

/**
 * Hands `onLine` each line of the file, without its line ending, until it returns false. A NUL byte
 * marks binary data, as it does for rg: in the first chunk the file is skipped, in a later one the
 * search stops before it. UTF-16 is read by its byte order mark.
 */
async function eachLine(
  path: string,
  buffer: Buffer,
  signal: AbortSignal,
  onLine: (text: string, lineNumber: number) => boolean,
): Promise<"text" | "binary"> {
  const handle = await open(path, "r");
  try {
    let decoder: TextDecoder | undefined;
    // The start of a line that runs on into the next chunk.
    let carry = "";
    let lineNumber = 0;
    for (;;) {
      if (signal.aborted) return "text";
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (decoder === undefined) {
        decoder = new TextDecoder(encodingOf(chunk));
        if (decoder.encoding === "utf-8" && chunk.includes(0)) return "binary";
      } else if (decoder.encoding === "utf-8" && chunk.includes(0)) {
        return "text";
      }
      const text = decoder.decode(chunk, { stream: true });
      let start = 0;
      for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
        const line = carry + text.slice(start, end);
        carry = "";
        start = end + 1;
        if (!onLine(withoutCr(line), ++lineNumber)) return "text";
      }
      carry += text.slice(start);
    }
    const last = carry + (decoder?.decode() ?? "");
    if (last !== "") onLine(withoutCr(last), lineNumber + 1);
    return "text";
  } finally {
    await handle.close();
  }
}

function encodingOf(chunk: Uint8Array): "utf-8" | "utf-16le" | "utf-16be" {
  if (chunk[0] === 0xff && chunk[1] === 0xfe) return "utf-16le";
  if (chunk[0] === 0xfe && chunk[1] === 0xff) return "utf-16be";
  return "utf-8";
}

/** A lone CR inside a line is content, as the read tool shows it; only a CRLF's goes. */
function withoutCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
