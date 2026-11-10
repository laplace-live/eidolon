// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/core/src/processors/aggregators/async_tool_messages.ts@ce8f8bc and packages/core/src/services/llm_service.ts@ce8f8bc
//
// The standing guidance a call's system instruction carries while one of her tools runs on after
// her reply (take_selfie), as pipedog composes it into every call's prompt today.
import type { LlmTool } from "@eidolon/core";

/**
 * pipedog's ASYNC_TOOL_INSTRUCTIONS, verbatim: the per-result message says the same, but it lands
 * where the latest request may outweigh it, so the policy is stated before any result exists.
 */
export const ASYNC_TOOL_INSTRUCTIONS =
  "ASYNC TOOLS:\n" +
  "Some of your tools keep running after you have replied. Their results arrive later as " +
  "messages in the conversation, on whatever turn happens to be in progress by then.\n" +
  "\n" +
  "A result that has arrived is owed to the user, whatever the conversation has moved on to. " +
  "If the user has said something you have not answered yet, answer that first, then add the " +
  "result at the end of that same reply — never before your answer. If you have already " +
  "answered everything the user said, deliver just the result — do not repeat or rephrase " +
  "your earlier reply. State a short result outright; for a long one, say what came back and " +
  "offer the details. Say it once, and do not repeat it in later replies.";

/** Runs on past her reply: pipedog's async tool. */
export function isAsyncTool(tool: LlmTool): boolean {
  return !tool.cancelOnInterruption;
}

/** `_composeSystemInstruction`: her instruction, then the async guidance while she has such a tool. */
export function callInstruction(system: string, tools: readonly LlmTool[]): string {
  if (!tools.some(isAsyncTool)) return system;
  return [system, ASYNC_TOOL_INSTRUCTIONS].filter((part) => part !== "").join("\n\n");
}
