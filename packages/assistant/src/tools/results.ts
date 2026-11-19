// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/ai/src/utils/validation.ts@ac78a60 and packages/schema/src/explain.ts@ac78a60
//
// How the file tools answer what they can't do (bad arguments, a refused path, a failure): as a
// result with isError, which the task's loop hands the model, never as a throw.
import { errorText } from "@eidolon/config";
import type { TaskToolResult } from "@eidolon/engine";
import { type PathGuard, PathRefused } from "../types.ts";
import { sliceHead } from "./truncate.ts";

/** pi's text for a call its abort signal stopped. */
export const ABORTED = "Operation aborted";

/**
 * How much of an invalid call's arguments its result repeats, so a long `content` isn't echoed
 * whole.
 */
const ECHO_CHARS = 2000;

export function errorResult(message: string): TaskToolResult {
  return { content: message, isError: true };
}

/** A thrown error as its message. */
export function failure(error: unknown): TaskToolResult {
  return errorResult(errorText(error));
}

/**
 * Throws once `signal` has aborted. A write checks it after each await: rejecting from an abort
 * listener would release the file's queue while the write may still land.
 */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(ABORTED);
}

/** The path the guard resolves `path` to, or the result refusing `access` to it. */
export async function guardPath(
  guard: PathGuard,
  path: string,
  access: "read" | "write",
): Promise<string | TaskToolResult> {
  try {
    return await guard.resolve(path, access);
  } catch (error) {
    if (!(error instanceof PathRefused)) return failure(error);
    // No grant opens a denied path, so it carries no `refused` for an approval to ask about.
    if (error.why === "denied") {
      return errorResult(`${error.message}, whatever access it is given.`);
    }
    return {
      content: `${error.message}. If the task needs it, ask for access rather than working around it.`,
      isError: true,
      refused: { path: error.path, access: error.access },
    };
  }
}

/** `problems` with `args`, worded like pi's validateToolArguments. */
export function invalidArguments(
  tool: string,
  problems: readonly string[],
  args: Readonly<Record<string, unknown>>,
): TaskToolResult {
  const json = JSON.stringify(args, null, 2) ?? String(args);
  const echo = json.length > ECHO_CHARS ? `${sliceHead(json, ECHO_CHARS)}\n... [truncated]` : json;
  return errorResult(
    `Validation failed for tool "${tool}":\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n\nReceived arguments:\n${echo}`,
  );
}

/** pi-schema's name for a value's type in its errors. */
export function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return typeof value;
}

/** `args[key]` when it is a string; else "", with what is wrong added to `problems`. */
export function stringArgument(
  args: Readonly<Record<string, unknown>>,
  key: string,
  problems: string[],
): string {
  const value = args[key];
  if (typeof value === "string") return value;
  problems.push(
    `${key}: ${value === undefined ? "missing" : `expected string, got ${typeName(value)}`}`,
  );
  return "";
}

/** `args.path`, which must be a string and not empty. */
export function pathArgument(args: Readonly<Record<string, unknown>>, problems: string[]): string {
  const path = stringArgument(args, "path", problems);
  if (args.path === "") problems.push("path: must not be empty");
  return path;
}

/**
 * `args[key]` as a whole number of at least `minimum`, undefined when absent or null. Models send
 * numbers as strings, so a string that reads as one counts.
 */
export function integerArgument(
  args: Readonly<Record<string, unknown>>,
  key: string,
  problems: string[],
  minimum = Number.NEGATIVE_INFINITY,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number)) {
    problems.push(`${key}: expected integer, got ${typeName(value)}`);
    return undefined;
  }
  if (number < minimum) {
    problems.push(`${key}: must be ${minimum} or more`);
    return undefined;
  }
  return number;
}
