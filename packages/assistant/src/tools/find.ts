// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/core/tools/find.ts@ac78a60
//
// pi runs fd; this walks the folder itself and matches with minimatch, keeping fd's rules: hidden
// files listed, .gitignore files obeyed, a "/" after each directory. grep shares the walk.
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { Minimatch } from "minimatch";
import type { AssistantTool, PathGuard } from "../types.ts";
import { pathExists, resolveToCwd } from "./path.ts";
import {
  ABORTED,
  errorResult,
  guardPath,
  integerArgument,
  invalidArguments,
  stringArgument,
} from "./results.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const DEFAULT_LIMIT = 1000;
const NEVER_SEARCHED = new Set([".git", "node_modules"]);

export interface FindDetails {
  readonly truncation?: TruncationResult;
  readonly resultLimitReached?: number;
}

/** An entry under a searched folder. */
export interface FolderEntry {
  /** From the searched folder, with "/" between names. */
  readonly path: string;
  readonly absolute: string;
  /** Symbolic links are "other": listed, never followed. */
  readonly kind: "file" | "directory" | "other";
}

export interface WalkOptions {
  readonly guard: PathGuard;
  readonly signal: AbortSignal;
  /** Leaves a directory out, and everything under it. */
  readonly skipDirectory?: (path: string) => boolean;
}

/** A .gitignore file's rules, and how an entry's path reads from the folder holding the file. */
interface IgnoreScope {
  readonly rules: Ignore;
  /** For a file above the searched folder: the searched folder's path from it, as "src/app/". */
  readonly lead: string;
  /** For a file inside it: the length of the entry path's part above the file's folder. */
  readonly strip: number;
}

interface Frame {
  readonly dir: string;
  readonly path: string;
  readonly scopes: readonly IgnoreScope[];
  readonly entries: readonly Dirent[];
  next: number;
}

export function createFindTool(guard: PathGuard): AssistantTool {
  return {
    schema: {
      name: "find",
      description: `Search for files by glob pattern. Returns matching paths relative to the search directory, with a '/' suffix for directories. Respects .gitignore and skips .git and node_modules. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
      properties: {
        pattern: {
          type: "string",
          description:
            "Glob pattern relative to the search directory, e.g. 'src/**/*.ts'. Without '/', e.g. '*.ts', it matches file names at any depth",
        },
        path: {
          type: "string",
          description: "Directory to search in (default: the task's folder)",
        },
        limit: {
          type: "integer",
          description: `Maximum number of results (default: ${DEFAULT_LIMIT})`,
        },
      },
      required: ["pattern"],
    },
    replay: "safe",
    snippet: "Find files by glob pattern (respects .gitignore)",
    guidelines: [],
    async execute(args, { signal }) {
      const problems: string[] = [];
      const pattern = stringArgument(args, "pattern", problems);
      if (args.pattern === "") problems.push("pattern: must not be empty");
      const path = args.path == null ? "" : stringArgument(args, "path", problems);
      const limit = integerArgument(args, "limit", problems) ?? DEFAULT_LIMIT;
      if (problems.length > 0) return invalidArguments("find", problems, args);
      if (signal.aborted) return errorResult(ABORTED);

      const searchPath = await guardPath(guard, path || ".", "read");
      if (typeof searchPath !== "string") return searchPath;
      let isDirectory: boolean;
      try {
        isDirectory = (await stat(searchPath)).isDirectory();
      } catch {
        return errorResult(`Path not found: ${searchPath}`);
      }
      if (!isDirectory) return errorResult(`Not a directory: ${searchPath}`);

      const effectiveLimit = Math.max(1, limit);
      // fd's smart case: an all-lowercase pattern matches case-insensitively.
      const named = resolveToCwd(path || ".", guard.folder);
      const matches = globMatcher(pattern, searchPath, named, pattern === pattern.toLowerCase());
      // Results past the byte cap are counted, each with its newline, but not kept: truncateHead
      // drops them anyway.
      const kept: string[] = [];
      let resultCount = 0;
      let outputBytes = 0;
      let resultLimitReached = false;
      for await (const entry of walkFolder(searchPath, { guard, signal })) {
        if (!matches(entry.path)) continue;
        // One result past the limit tells "exactly N matches" apart from "more than N" (pi #7121).
        if (resultCount === effectiveLimit) {
          resultLimitReached = true;
          break;
        }
        const result = entry.kind === "directory" ? `${entry.path}/` : entry.path;
        resultCount++;
        if (outputBytes - 1 <= DEFAULT_MAX_BYTES) kept.push(result);
        outputBytes += Buffer.byteLength(result, "utf-8") + 1;
      }
      if (signal.aborted) return errorResult(ABORTED);
      if (resultCount === 0) return { content: "No files found matching pattern" };

      const truncation: TruncationResult = {
        ...truncateHead(kept.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER }),
        totalLines: resultCount,
        totalBytes: outputBytes - 1,
      };
      const notices: string[] = [];
      if (resultLimitReached) {
        notices.push(
          `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
        );
      }
      if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      if (notices.length === 0) return { content: truncation.content };
      const details: FindDetails = {
        ...(truncation.truncated ? { truncation } : {}),
        ...(resultLimitReached ? { resultLimitReached: effectiveLimit } : {}),
      };
      return { content: `${truncation.content}\n\n[${notices.join(". ")}]`, details };
    },
  };
}

/**
 * Whether a path under the searched folder `root` matches `pattern`, as fd's and rg's globs do: a
 * pattern without "/" matches a name at any depth, and any other the path from the folder, or the
 * whole path when the pattern is absolute. `root` is where the folder lies on disk; `named` is the
 * folder as the task names it, which an absolute pattern may start with instead.
 */
export function globMatcher(
  pattern: string,
  root: string,
  named: string,
  ignoreCase = false,
): (path: string) => boolean {
  // fd and rg never match a leading "./" (pi #12020).
  const cleaned = pattern.replace(/^(?:\.\/)+/, "");
  const glob = compileGlob(ignoreCase ? cleaned.toLowerCase() : cleaned);
  const fold = ignoreCase ? (text: string) => text.toLowerCase() : (text: string) => text;
  if (!cleaned.includes("/")) {
    return (path) => glob(fold(path.slice(path.lastIndexOf("/") + 1)));
  }
  if (isAbsolute(cleaned)) {
    return (path) => glob(fold(join(root, path))) || glob(fold(join(named, path)));
  }
  return (path) => glob(fold(path));
}

/**
 * Whether a path matches `glob`, dot files included. A leading # is part of a name, not a comment,
 * and each leading ! negates but one that opens an extglob, as in !(*.test).ts.
 */
function compileGlob(glob: string): (path: string) => boolean {
  let negations = 0;
  while (glob[negations] === "!") negations++;
  if (glob[negations] === "(") negations--;
  const matcher = new Minimatch(glob.slice(negations), {
    dot: true,
    nocomment: true,
    nonegate: true,
    // . and .. stay as written: a walked path holds neither.
    optimizationLevel: 0,
  });
  const negated = negations % 2 === 1;
  return (path) => matcher.match(path) !== negated;
}

/**
 * Everything under `root`, depth first in name order, but .git, node_modules and what .gitignore
 * files ignore. A directory the guard refuses is listed but never entered.
 */
export async function* walkFolder(root: string, options: WalkOptions): AsyncGenerator<FolderEntry> {
  const { guard, signal, skipDirectory } = options;
  const stack: Frame[] = [];
  const enter = async (dir: string, path: string, outer: readonly IgnoreScope[]) => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Rules from above a repository stop at its top, as fd's do inside one (pi #5960).
    let scopes = entries.some((entry) => entry.name === ".git") ? [] : outer;
    const rules = entries.some((entry) => entry.name === ".gitignore" && entry.isFile())
      ? await readIgnoreFile(dir)
      : null;
    if (rules) {
      scopes = [...scopes, { rules, lead: "", strip: path === "" ? 0 : path.length + 1 }];
    }
    stack.push({ dir, path, scopes, entries: entries.sort(byName), next: 0 });
  };

  await enter(root, "", await scopesAbove(root, guard));
  while (stack.length > 0 && !signal.aborted) {
    const frame = stack[stack.length - 1];
    if (frame.next === frame.entries.length) {
      stack.pop();
      continue;
    }
    const entry = frame.entries[frame.next++];
    if (NEVER_SEARCHED.has(entry.name)) continue;
    const path = frame.path === "" ? entry.name : `${frame.path}/${entry.name}`;
    const isDirectory = entry.isDirectory();
    if (isIgnored(frame.scopes, path, isDirectory)) continue;
    if (isDirectory && skipDirectory?.(path)) continue;
    const absolute = join(frame.dir, entry.name);
    yield {
      path,
      absolute,
      kind: isDirectory ? "directory" : entry.isFile() ? "file" : "other",
    };
    if (isDirectory && (await readable(guard, absolute))) {
      await enter(absolute, path, frame.scopes);
    }
  }
}

function isIgnored(scopes: readonly IgnoreScope[], path: string, isDirectory: boolean): boolean {
  // A deeper .gitignore overrides a shallower one, as in git.
  for (let i = scopes.length - 1; i >= 0; i--) {
    const { rules, lead, strip } = scopes[i];
    const result = rules.test(`${lead}${path.slice(strip)}${isDirectory ? "/" : ""}`);
    if (result.ignored) return true;
    if (result.unignored) return false;
  }
  return false;
}

/**
 * The .gitignore files above `root` that apply in it: up to its repository's top, and no further
 * than the task may read. None when they ignore `root` itself, which fd and rg still search when
 * asked to.
 */
async function scopesAbove(root: string, guard: PathGuard): Promise<IgnoreScope[]> {
  const scopes: IgnoreScope[] = [];
  if (await pathExists(join(root, ".git"))) return scopes;
  for (let dir = dirname(root); await readable(guard, dir); dir = dirname(dir)) {
    const rules = await readIgnoreFile(dir);
    if (rules) {
      scopes.unshift({ rules, lead: `${relative(dir, root).split(sep).join("/")}/`, strip: 0 });
    }
    if (dir === dirname(dir) || (await pathExists(join(dir, ".git")))) break;
  }
  for (let i = scopes.length - 1; i >= 0; i--) {
    const { rules, lead } = scopes[i];
    const result = rules.test(lead);
    if (result.ignored) return [];
    if (result.unignored) break;
  }
  return scopes;
}

/** The rules in `dir`'s .gitignore, when that is a file. */
async function readIgnoreFile(dir: string): Promise<Ignore | null> {
  const file = join(dir, ".gitignore");
  try {
    if (!(await lstat(file)).isFile()) return null;
    return ignore().add(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readable(guard: PathGuard, path: string): Promise<boolean> {
  try {
    await guard.resolve(path, "read");
    return true;
  } catch {
    return false;
  }
}

function byName(a: Dirent, b: Dirent): number {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
