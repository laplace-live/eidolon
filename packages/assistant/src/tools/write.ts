// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/core/tools/write.ts@ac78a60
//
// The task's write tool: a whole file, created or overwritten, its folders made as needed.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AssistantTool, PathGuard } from "../types.ts";
import { withFileMutationQueue } from "./mutation-queue.ts";
import {
  ABORTED,
  errorResult,
  failure,
  guardPath,
  invalidArguments,
  pathArgument,
  stringArgument,
  throwIfAborted,
} from "./results.ts";

export function createWriteTool(guard: PathGuard): AssistantTool {
  return {
    schema: {
      name: "write",
      description:
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
      properties: {
        path: { type: "string", description: "Path to the file to write (relative or absolute)" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    },
    snippet: "Create or overwrite files",
    guidelines: ["Use write only for new files or complete rewrites."],
    replay: "safe",
    async execute(args, { signal }) {
      const problems: string[] = [];
      const path = pathArgument(args, problems);
      const content = stringArgument(args, "content", problems);
      if (problems.length > 0) return invalidArguments("write", problems, args);
      if (signal.aborted) return errorResult(ABORTED);
      try {
        const target = await guardPath(guard, path, "write");
        if (typeof target !== "string") return target;
        return await withFileMutationQueue(target, async () => {
          throwIfAborted(signal);
          await mkdir(dirname(target), { recursive: true });
          throwIfAborted(signal);
          await writeFile(target, content, "utf-8");
          throwIfAborted(signal);
          return { content: `Successfully wrote to ${path}`, files: { written: [target] } };
        });
      } catch (error) {
        return failure(error);
      }
    },
  };
}
