// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/core/tools/edit.ts@ac78a60 and packages/coding-agent/src/utils/text.ts@ac78a60
//
// The task's edit tool: exact replacements in one file, each matched against the file as it was.
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import type { TaskToolResult } from "@eidolon/engine";
import type { AssistantTool, PathGuard } from "../types.ts";
import {
  applyEditsToNormalizedContent,
  applyReplacementsToOriginal,
  type Edit,
  generateEditDiff,
  normalizeToLF,
} from "./edit-diff.ts";
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
  typeName,
} from "./results.ts";

export function createEditTool(guard: PathGuard): AssistantTool {
  return {
    schema: {
      name: "edit",
      description:
        "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
      properties: {
        path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
        edits: {
          type: "array",
          description:
            "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
          items: {
            type: "object",
            properties: {
              oldText: {
                type: "string",
                description:
                  "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
              },
              newText: { type: "string", description: "Replacement text for this targeted edit." },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
    snippet:
      "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    guidelines: [
      "Use edit for targeted changes. Batch changes to one file in a single call.",
      "Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
    ],
    replay: "never",
    // As write's: a read later in the reply must see the edit.
    executionMode: "sequential",
    prepareArguments: (args) => prepareEditArguments(args) as Readonly<Record<string, unknown>>,
    async execute(args, { signal }) {
      // Again for a caller that skips prepareArguments; prepared arguments come back unchanged.
      const input = prepareEditArguments(args) as Readonly<Record<string, unknown>>;
      const problems: string[] = [];
      const path = pathArgument(input, problems);
      const edits = editsArgument(input, problems);
      if (problems.length > 0) return invalidArguments("edit", problems, args);
      if (edits.length === 0) {
        return errorResult(
          "Edit tool input is invalid. edits must contain at least one replacement.",
        );
      }
      if (signal.aborted) return errorResult(ABORTED);
      try {
        const target = await guardPath(guard, path, "write");
        if (typeof target !== "string") return target;
        return await withFileMutationQueue(target, () => editFile(target, path, edits, signal));
      } catch (error) {
        return failure(error);
      }
    },
  };
}

function isSingleEditInput(value: unknown): value is Edit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edit = value as Record<string, unknown>;
  return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * pi's prepareArguments for what models send: `edits` as a JSON string (Opus 4.6, GLM-5.1) or as
 * one edit rather than an array, and the top-level oldText and newText of the tool's older schema.
 * `input` itself when nothing changes, else a copy.
 */
export function prepareEditArguments(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  let args = input as Record<string, unknown>;
  const setEdits = (edits: unknown[]): void => {
    args = { ...args, edits };
  };
  if (typeof args.edits === "string") {
    const parsed = parseJson(args.edits);
    if (Array.isArray(parsed)) setEdits(parsed);
    else if (isSingleEditInput(parsed)) setEdits([parsed]);
  } else if (isSingleEditInput(args.edits)) {
    setEdits([args.edits]);
  }

  if (typeof args.oldText !== "string" || typeof args.newText !== "string") return args;
  const edits = Array.isArray(args.edits) ? [...args.edits] : [];
  edits.push({ oldText: args.oldText, newText: args.newText });
  const { oldText: _oldText, newText: _newText, ...rest } = args;
  return { ...rest, edits };
}

/** `args.edits` as edits; what is wrong with it goes in `problems`. */
function editsArgument(args: Readonly<Record<string, unknown>>, problems: string[]): Edit[] {
  const value = args.edits;
  if (!Array.isArray(value)) {
    problems.push(
      `edits: ${value === undefined ? "missing" : `expected array, got ${typeName(value)}`}`,
    );
    return [];
  }
  const edits: Edit[] = [];
  value.forEach((edit: unknown, index) => {
    if (edit === null || typeof edit !== "object" || Array.isArray(edit)) {
      problems.push(`edits.${index}: expected object, got ${typeName(edit)}`);
      return;
    }
    const own: string[] = [];
    const fields = edit as Readonly<Record<string, unknown>>;
    const oldText = stringArgument(fields, "oldText", own);
    const newText = stringArgument(fields, "newText", own);
    for (const problem of own) problems.push(`edits.${index}.${problem}`);
    if (own.length === 0) edits.push({ oldText, newText });
  });
  return edits;
}

/** A leading byte order mark, split from decoded text: no model puts one in oldText. */
function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith("\u{feff}")
    ? { bom: "\u{feff}", text: content.slice(1) }
    : { bom: "", text: content };
}

/**
 * `buffer` as UTF-8, a byte order mark kept; null when it isn't UTF-8, which written back as text
 * would lose every byte that isn't.
 */
function decodeUtf8(buffer: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return null;
  }
}

async function editFile(
  target: string,
  path: string,
  edits: readonly Edit[],
  signal: AbortSignal,
): Promise<TaskToolResult> {
  throwIfAborted(signal);
  try {
    await access(target, constants.R_OK | constants.W_OK);
  } catch (error) {
    throwIfAborted(signal);
    const reason =
      error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
    return errorResult(`Could not edit file: ${path}. ${reason}.`);
  }
  throwIfAborted(signal);
  const raw = decodeUtf8(await readFile(target));
  throwIfAborted(signal);
  if (raw === null) return errorResult(`${path} isn't UTF-8 text, so edit would damage it.`);

  const { bom, text: content } = splitBom(raw);
  const normalizedContent = normalizeToLF(content);
  const { baseContent, newContent, replacements } = applyEditsToNormalizedContent(
    normalizedContent,
    edits,
    path,
  );
  // Diffed before the write, so the diff can't fail after the file has changed.
  const diff = generateEditDiff(path, baseContent, newContent, replacements);
  throwIfAborted(signal);

  // Spliced into the original text, so untouched lines keep their line endings. Without any CR
  // the original is the normalized text, and the normalized result is already final.
  const finalContent =
    bom +
    (content === normalizedContent
      ? newContent
      : applyReplacementsToOriginal(content, replacements));
  await writeFile(target, finalContent, "utf-8");
  throwIfAborted(signal);

  return {
    content: `Successfully replaced ${edits.length} block(s) in ${path}.`,
    details: diff,
    files: { written: [target] },
  };
}
