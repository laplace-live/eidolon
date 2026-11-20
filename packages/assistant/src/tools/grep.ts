// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/core/tools/grep.ts@ac78a60
//
// pi runs rg; this reads the files itself, on find's walk, and matches their lines in a child
// process. It has no context lines.
import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, parse } from "node:path";
import { errorText, jsRuntime, type Subprocess, spawnProcess } from "@eidolon/config";
import type { TaskToolResult } from "@eidolon/engine";
import type { AssistantTool, PathGuard } from "../types.ts";
import { globMatcher, walkFolder } from "./find.ts";
import { resolveToCwd } from "./path.ts";
import { textEncoding } from "./read.ts";
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
  sliceHead,
  type TruncationResult,
  truncateHead,
  truncateLine,
} from "./truncate.ts";

const DEFAULT_LIMIT = 100;
const CHUNK_BYTES = 64 * 1024;

// JavaScript regexes backtrack, and V8 sets no limit on it: one test of a line can run for minutes
// (\w+x over a long one) and hold its thread. Lines are matched in a child process, killed on a
// cancel or past the deadline. A line whose test fails slowly is named with those the deadline cut,
// its time counted against SLOW_BUDGET_MS, so a pattern slow on line after line can't hold a search
// for long.
const SLOW_TEST_MS = 50;
const MATCH_DEADLINE_MS = 2000;
/** The time a search may spend on lines it can't search before it stops. */
const SLOW_BUDGET_MS = 5000;

// A parent killed outright takes its deadline and its kill along, and a test that runs on holds
// the child's thread, deaf to its channel closing: a worker ends the child once the parent is gone.
const MATCHER_SOURCE = `
let regex;
const parent = process.ppid;
const watch = "setInterval(() => { if (process.ppid !== " + parent + ") process.kill(process.pid, 'SIGKILL'); }, 200);";
new (require("node:worker_threads").Worker)(watch, { eval: true }).unref();
process.on("disconnect", () => process.exit(0));
process.on("message", (data) => {
  if (data.lines === undefined) {
    regex = new RegExp(data.source, data.flags);
    return;
  }
  const hits = [];
  for (let i = 0; i < data.lines.length; i++) {
    const started = performance.now();
    const match = regex.exec(data.lines[i]);
    if (match !== null) hits.push(i, match.index);
    else if (performance.now() - started >= ${SLOW_TEST_MS}) {
      process.send({ hits, slow: i });
      return;
    }
  }
  process.send({ hits, slow: -1 });
});
`;

/** The lines of a batch that match, as [line, at] pairs, and the first that failed slowly. */
interface Matched {
  readonly hits: readonly number[];
  readonly slow: number;
}

/** A pattern running over batches of lines in a process of its own. */
class LineMatcher {
  readonly #child: Subprocess;
  #settle: ((outcome: Matched | Error) => void) | null = null;

  constructor(regex: RegExp) {
    const { command, env } = jsRuntime();
    const child = spawnProcess([command, "-e", MATCHER_SOURCE], {
      // Node took 160 ms to start in a removed working folder, as this process's may be, and 40 in
      // one that is there.
      cwd: parse(command).root,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      ipc: (message) => this.#settle?.(message as Matched),
    });
    void child.exited.then(() => {
      this.#settle?.(new Error(`grep's matcher exited (${child.signalCode ?? child.exitCode})`));
    });
    this.#child = child;
    this.#child.unref();
    this.#child.send({ source: regex.source, flags: regex.flags });
  }

  /** What matches in `lines`; "aborted" once `signal` aborts, "late" past the deadline. */
  match(lines: readonly string[], signal: AbortSignal): Promise<Matched | "aborted" | "late"> {
    if (signal.aborted) return Promise.resolve("aborted");
    return new Promise((resolve, reject) => {
      this.#child.send({ lines });
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("late"), MATCH_DEADLINE_MS);
      const finish = (outcome: Matched | Error | "aborted" | "late") => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.#settle = null;
        if (outcome instanceof Error) reject(outcome);
        else resolve(outcome);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#settle = finish;
    });
  }

  stop(): void {
    this.#settle = null;
    this.#child.kill("SIGKILL");
  }
}

/** How much of a long line before its match its row keeps. */
const BEFORE_MATCH = 100;

/**
 * `line` cut to GREP_MAX_LINE_LENGTH characters around its match at `at`, not from its head: only
 * grep shows any of a line past read's byte limit, so the match must be in what it shows.
 */
function aroundMatch(line: string, at: number): { text: string; wasTruncated: boolean } {
  let start = Math.max(0, Math.min(at - BEFORE_MATCH, line.length - GREP_MAX_LINE_LENGTH));
  if (start === 0) return truncateLine(line);
  // Not from the middle of a surrogate pair.
  const code = line.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start++;
  const shown = sliceHead(line.slice(start), GREP_MAX_LINE_LENGTH);
  const cut = start + shown.length < line.length ? "... [truncated]" : "";
  return { text: `[truncated] ...${shown}${cut}`, wasTruncated: true };
}

/** The notice for the lines, as file:line or file:first-last, the pattern was too slow to search. */
function notSearched(lines: readonly string[], stopped: boolean): string {
  const more = lines.length > 10 ? ` and ${lines.length - 10} more` : "";
  return (
    `Not searched, the pattern was too slow there: ${lines.slice(0, 10).join(", ")}${more}. ` +
    (stopped
      ? `grep stopped after ${SLOW_BUDGET_MS / 1000} s on such lines, and searched nothing after them. `
      : "") +
    "JavaScript regexes backtrack: avoid nested quantifiers such as (a+)+, and \\w+x or .* after a common word, which rescan a long line from every start; or set literal to true, or leave such files out with a glob such as '!*.min.js'"
  );
}

export interface GrepDetails {
  readonly truncation?: TruncationResult;
  readonly matchLimitReached?: number;
  readonly linesTruncated?: boolean;
  /** The lines the pattern was too slow to search, as file:line or file:first-last. */
  readonly unsearched?: readonly string[];
}

export function createGrepTool(guard: PathGuard): AssistantTool {
  return {
    schema: {
      name: "grep",
      description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore and skips .git, node_modules and binary files. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars around the match.`,
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
      // One of them is longer than read shows.
      let linesPastRead = false;
      let matcher: LineMatcher | undefined;
      // Set when the search can't go on: its matcher failed.
      let stopped: TaskToolResult | undefined;
      const unsearched: string[] = [];
      let slowMs = 0;
      let gaveUp = false;
      const search = (file: string, shown: string) =>
        eachBatch(file, buffer, signal, async (lines, firstLine) => {
          for (let start = 0; start < lines.length; ) {
            if (slowMs >= SLOW_BUDGET_MS) {
              gaveUp = true;
              return false;
            }
            const began = performance.now();
            let matched: Matched | "aborted" | "late";
            try {
              matcher ??= new LineMatcher(regex);
              matched = await matcher.match(start === 0 ? lines : lines.slice(start), signal);
            } catch (error) {
              stopped = failure(error);
              return false;
            }
            if (matched === "aborted") return false;
            if (matched === "late") {
              // Which line it is still on is unknown, so the rest of the batch goes unsearched.
              matcher?.stop();
              matcher = undefined;
              slowMs += performance.now() - began;
              const [first, last] = [firstLine + start, firstLine + lines.length - 1];
              unsearched.push(first === last ? `${shown}:${first}` : `${shown}:${first}-${last}`);
              return true;
            }
            for (let i = 0; i < matched.hits.length; i += 2) {
              // Only one more match proves that the limit cut results off.
              if (matchCount === effectiveLimit) {
                matchLimitReached = true;
                return false;
              }
              matchCount++;
              const index = start + (matched.hits[i] as number);
              const text = lines[index] as string;
              const line = aroundMatch(text, matched.hits[i + 1] as number);
              if (line.wasTruncated) {
                linesTruncated = true;
                linesPastRead ||= Buffer.byteLength(text, "utf-8") > DEFAULT_MAX_BYTES;
              }
              const row = `${shown}:${firstLine + index}: ${line.text}`;
              if (outputBytes - 1 <= DEFAULT_MAX_BYTES) kept.push(row);
              outputBytes += Buffer.byteLength(row, "utf-8") + 1;
            }
            if (matched.slow === -1) return true;
            slowMs += performance.now() - began;
            unsearched.push(`${shown}:${firstLine + start + matched.slow}`);
            start += matched.slow + 1;
          }
          return true;
        });

      try {
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
            const named = resolveToCwd(path || ".", guard.folder);
            const matches = globMatcher(excludes ? glob.slice(1) : glob, searchPath, named);
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
            if (matchLimitReached || stopped !== undefined || gaveUp) break;
          }
        }
      } finally {
        matcher?.stop();
      }
      if (signal.aborted) return errorResult(ABORTED);
      if (stopped !== undefined) return stopped;
      if (matchCount === 0) {
        if (unsearched.length === 0) return { content: "No matches found" };
        const details: GrepDetails = { unsearched };
        return { content: `No matches found\n\n[${notSearched(unsearched, gaveUp)}]`, details };
      }

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
        // read shows the head of a longer line, and sends the model back here for the rest.
        const longer = linesPastRead
          ? ` of up to ${formatSize(DEFAULT_MAX_BYTES)}; to see more of a longer one, grep a pattern further along it`
          : "";
        notices.push(
          `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines${longer}`,
        );
      }
      if (unsearched.length > 0) notices.push(notSearched(unsearched, gaveUp));
      if (notices.length === 0) return { content: truncation.content };
      const details: GrepDetails = {
        ...(truncation.truncated ? { truncation } : {}),
        ...(matchLimitReached ? { matchLimitReached: effectiveLimit } : {}),
        ...(linesTruncated ? { linesTruncated } : {}),
        ...(unsearched.length > 0 ? { unsearched } : {}),
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

const UNICODE_MODE =
  "grep takes JavaScript regexes in Unicode mode: write \\p{Script=Han} for \\p{Han}, \\p{L} for \\pL, \\u{...} for \\x{...}, and ^ and $ for \\A and \\z.";

/** `pattern` as a RegExp, or why it isn't one. */
function compile(pattern: string, literal: boolean, ignoreCase: boolean): RegExp | string {
  const source = literal
    ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : unescapePunctuation(pattern);
  try {
    return new RegExp(source, ignoreCase ? "ui" : "u");
  } catch (error) {
    // Without Unicode mode, \p{Han} would be the text p{Han} and \A the letter A.
    return `${errorText(error)}. ${UNICODE_MODE}`;
  }
}

/** Punctuation that rg takes escaped as itself, and that Unicode mode refuses escaped. */
const PLAIN_PUNCTUATION = new Set("!\"#%&',-:;=@_`~ ");

/** A count's braces, {n}, {n,} or {n,m}; any other } closes nothing. */
const COUNT = /^\{\d+(?:,\d*)?\}/;

/**
 * `pattern` with those escapes dropped; a class keeps its \-, which Unicode mode takes. A ] or }
 * that closes nothing is escaped: rg takes it as itself, and Unicode mode refuses it.
 */
function unescapePunctuation(pattern: string): string {
  let source = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "\\" && i + 1 < pattern.length) {
      const next = pattern[++i] as string;
      // \p{…} and \u{…} keep their braces.
      const close = /[a-z]/i.test(next) && pattern[i + 1] === "{" ? pattern.indexOf("}", i) : -1;
      if (close !== -1) {
        source += `\\${pattern.slice(i, close + 1)}`;
        i = close;
        continue;
      }
      source += PLAIN_PUNCTUATION.has(next) && !(inClass && next === "-") ? next : `\\${next}`;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
    } else if (char === "[") {
      inClass = true;
    } else if (char === "{") {
      const count = COUNT.exec(pattern.slice(i))?.[0];
      if (count !== undefined) {
        source += count;
        i += count.length - 1;
        continue;
      }
    } else if (char === "]" || char === "}") {
      source += `\\${char}`;
      continue;
    }
    source += char;
  }
  return source;
}

/**
 * Hands `onBatch` the file's lines, a chunk's at a time, without their line endings and with the
 * number of the first, until it answers false. A NUL byte marks binary data, as it does for rg: in
 * the first chunk the file is skipped, in a later one the search stops before it. The text reads as
 * read reads it (textEncoding).
 */
async function eachBatch(
  path: string,
  buffer: Buffer,
  signal: AbortSignal,
  onBatch: (lines: readonly string[], firstLine: number) => Promise<boolean>,
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
        decoder = new TextDecoder(textEncoding(chunk));
        if (!decoder.encoding.startsWith("utf-16") && chunk.includes(0)) return "binary";
      } else if (!decoder.encoding.startsWith("utf-16") && chunk.includes(0)) {
        return "text";
      }
      const text = decoder.decode(chunk, { stream: true });
      const lines: string[] = [];
      let start = 0;
      for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
        lines.push(withoutCr(carry + text.slice(start, end)));
        carry = "";
        start = end + 1;
      }
      carry += text.slice(start);
      if (lines.length > 0) {
        if (!(await onBatch(lines, lineNumber + 1))) return "text";
        lineNumber += lines.length;
      }
    }
    const last = carry + (decoder?.decode() ?? "");
    if (last !== "") await onBatch([withoutCr(last)], lineNumber + 1);
    return "text";
  } finally {
    await handle.close();
  }
}

/** A lone CR inside a line is content, as the read tool shows it; only a CRLF's goes. */
function withoutCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
