// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/core/tools/ls.ts@ac78a60
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantTool, PathGuard } from "../types.ts";
import {
  ABORTED,
  errorResult,
  guardPath,
  integerArgument,
  invalidArguments,
  stringArgument,
} from "./results.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const DEFAULT_LIMIT = 500;

export interface LsDetails {
  readonly truncation?: TruncationResult;
  readonly entryLimitReached?: number;
}

export function createLsTool(guard: PathGuard): AssistantTool {
  return {
    schema: {
      name: "ls",
      description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
      properties: {
        path: {
          type: "string",
          description: "Directory to list (default: the task's folder)",
        },
        limit: {
          type: "integer",
          description: `Maximum number of entries to return (default: ${DEFAULT_LIMIT})`,
        },
      },
      required: [],
    },
    replay: "safe",
    snippet: "List directory contents",
    guidelines: [],
    async execute(args, { signal }) {
      const problems: string[] = [];
      const path = args.path == null ? "" : stringArgument(args, "path", problems);
      const limit = integerArgument(args, "limit", problems) ?? DEFAULT_LIMIT;
      if (problems.length > 0) return invalidArguments("ls", problems, args);
      if (signal.aborted) return errorResult(ABORTED);

      const dirPath = await guardPath(guard, path || ".", "read");
      if (typeof dirPath !== "string") return dirPath;
      let isDirectory: boolean;
      try {
        isDirectory = (await stat(dirPath)).isDirectory();
      } catch {
        return errorResult(`Path not found: ${dirPath}`);
      }
      if (!isDirectory) return errorResult(`Not a directory: ${dirPath}`);
      let entries: string[];
      try {
        entries = await readdir(dirPath);
      } catch (error) {
        return errorResult(
          `Cannot read directory: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      // A limit of 0 would list nothing and report "(empty directory)", so it means 1.
      const effectiveLimit = Math.max(1, limit);
      const results: string[] = [];
      let entryLimitReached = false;
      for (const entry of entries) {
        if (signal.aborted) return errorResult(ABORTED);
        if (results.length >= effectiveLimit) {
          entryLimitReached = true;
          break;
        }
        try {
          results.push((await stat(join(dirPath, entry))).isDirectory() ? `${entry}/` : entry);
        } catch {
          // Skip entries it cannot stat, such as a link to nothing.
        }
      }
      if (results.length === 0) return { content: "(empty directory)" };

      // No line limit: the entry count is already capped.
      const truncation = truncateHead(results.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      const notices: string[] = [];
      if (entryLimitReached) {
        notices.push(
          `${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`,
        );
      }
      if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      if (notices.length === 0) return { content: truncation.content };
      const details: LsDetails = {
        ...(truncation.truncated ? { truncation } : {}),
        ...(entryLimitReached ? { entryLimitReached: effectiveLimit } : {}),
      };
      return { content: `${truncation.content}\n\n[${notices.join(". ")}]`, details };
    },
  };
}
