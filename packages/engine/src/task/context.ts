// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/core/compaction/compaction.ts@ac78a60, packages/coding-agent/src/core/compaction/utils.ts@ac78a60 and packages/coding-agent/src/core/messages.ts@ac78a60
//
// A task's context, rebuilt from its transcript for each request: the latest summary, then what
// came after it, each assistant entry followed by its calls' results in the order it made them.
import type { TaskBrief, TaskEntry } from "../task.ts";
import type { MindToolCall } from "../types.ts";

type EntryOf<T extends TaskEntry["type"]> = Extract<TaskEntry, { readonly type: T }>;

/** What compaction never splits: a line given to the task, or an assistant entry and its results. */
export type Block =
  | { readonly kind: "line"; readonly seq: number; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly seq: number;
      readonly entry: EntryOf<"assistant">;
      /** By call, in the order of `entry.calls`; undefined for a call with no result yet. */
      readonly results: readonly (EntryOf<"tool-result"> | undefined)[];
    };

export interface TaskContext {
  readonly compaction: EntryOf<"compaction"> | null;
  /** Oldest first, from the compaction's first kept entry. */
  readonly blocks: readonly Block[];
}

/** OpenAI-shaped, as a MindRequest takes them. */
export type ContextMessage =
  | { readonly role: "user" | "assistant"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly tool_calls: readonly {
        readonly id: string;
        readonly type: "function";
        readonly function: { readonly name: string; readonly arguments: string };
      }[];
    }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

/**
 * Chinese, Japanese and Korean characters and their punctuation: up to about a token each
 * (DeepSeek documents 0.6), where pi's estimate counts four characters a token.
 */
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/gu;

/** pi's estimate, four characters a token, but a token for each CJK character. */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil((text.length - cjk) / 4) + cjk;
}

export function messageTokens(message: ContextMessage): number {
  if ("content" in message) return estimateTokens(message.content);
  return message.tool_calls.reduce(
    (sum, call) => sum + estimateTokens(call.function.name + call.function.arguments),
    0,
  );
}

/** Finish reasons of a reply that ended as its model meant it to (pi's mapStopReason). */
const ENDED: ReadonlySet<string> = new Set([
  "stop",
  "end",
  "end_turn",
  "stop_sequence",
  "tool_calls",
  "tool_use",
]);

/** Finish reasons of a reply the output limit, or the context window, cut off. */
const CUT_OFF: ReadonlySet<string> = new Set([
  "length",
  "max_tokens",
  "model_context_window_exceeded",
]);

/** Finish reasons of a reply its provider stopped. */
const STOPPED: ReadonlySet<string> = new Set(["content_filter", "refusal"]);

/** Whether a reply ended for `finishReason`; any other, or none, means its stream broke off. */
export function endedReply(finishReason: string | null): boolean {
  return (
    finishReason !== null &&
    (ENDED.has(finishReason) || CUT_OFF.has(finishReason) || STOPPED.has(finishReason))
  );
}

export function cutOff(finishReason: string | null | undefined): boolean {
  return finishReason !== null && finishReason !== undefined && CUT_OFF.has(finishReason);
}

/**
 * Why a reply that made no calls can't be the task's report, and the note the requests after it
 * give the model; null when it can be.
 */
export function unfinished(
  finishReason: string | null | undefined,
): { readonly error: string; readonly note: string } | null {
  if (finishReason === null || finishReason === undefined) return null;
  if (CUT_OFF.has(finishReason)) {
    return {
      error: "The model's reply was cut off at its output limit",
      note: "[Your reply was cut off at the output limit. Go on from where it stopped, in smaller steps.]",
    };
  }
  if (STOPPED.has(finishReason)) {
    return {
      error: "The model's provider stopped its reply",
      note: "[The model's provider stopped your reply before it ended.]",
    };
  }
  if (finishReason === "tool_calls" || finishReason === "tool_use") {
    return {
      error: "The model's tool calls couldn't be read",
      note: "[Your reply's tool calls couldn't be read. Make them again.]",
    };
  }
  return null;
}

export function briefText(brief: TaskBrief): string {
  return [
    `Goal: ${brief.goal}`,
    `Deliverable: ${brief.deliverable}`,
    `Folder: ${brief.folder}`,
    `Check: ${brief.check}`,
  ].join("\n");
}

export function taskContext(entries: readonly TaskEntry[]): TaskContext {
  let compaction: EntryOf<"compaction"> | null = null;
  for (const entry of entries) if (entry.type === "compaction") compaction = entry;
  const from = compaction?.firstKeptSeq ?? Number.NEGATIVE_INFINITY;
  const blocks: Block[] = [];
  // A call's result goes to the latest assistant entry with its id, should a provider reuse ids.
  const owners = new Map<string, { results: (EntryOf<"tool-result"> | undefined)[]; at: number }>();
  for (const entry of entries) {
    if (entry.seq < from) continue;
    switch (entry.type) {
      case "brief":
        blocks.push({ kind: "line", seq: entry.seq, text: briefText(entry.brief) });
        break;
      case "steer":
      case "follow-up":
        blocks.push({ kind: "line", seq: entry.seq, text: entry.text });
        break;
      case "assistant": {
        const results: (EntryOf<"tool-result"> | undefined)[] = entry.calls.map(() => undefined);
        for (const [at, call] of entry.calls.entries()) owners.set(call.id, { results, at });
        blocks.push({ kind: "assistant", seq: entry.seq, entry, results });
        break;
      }
      case "tool-result": {
        const owner = owners.get(entry.callId);
        if (owner !== undefined) owner.results[owner.at] = entry;
        break;
      }
    }
  }
  return { compaction, blocks };
}

function toolCallsMessage(calls: readonly MindToolCall[]): ContextMessage {
  return {
    role: "assistant",
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })),
  };
}

/**
 * The messages of `block`, unmasked: its text, then its calls, then their results; or, for a reply
 * that made no calls and can't be a report, its text and a note saying why.
 */
function blockMessages(block: Block): ContextMessage[] {
  if (block.kind === "line") return [{ role: "user", content: block.text }];
  const { text, calls, finishReason } = block.entry;
  const messages: ContextMessage[] = [];
  if (text !== "") messages.push({ role: "assistant", content: text });
  if (calls.length > 0) messages.push(toolCallsMessage(calls));
  calls.forEach((call, at) => {
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: block.results[at]?.content ?? "",
    });
  });
  const why = calls.length === 0 ? unfinished(finishReason) : null;
  if (why !== null) messages.push({ role: "user", content: why.note });
  return messages;
}

export function blockTokens(block: Block): number {
  return blockMessages(block).reduce((sum, message) => sum + messageTokens(message), 0);
}

const ARGUMENTS_CHARS = 200;

/** A call's arguments as a stub or a pause names them: the head of their JSON. */
export function argumentsHead(json: string): string {
  return json.length > ARGUMENTS_CHARS ? `${json.slice(0, ARGUMENTS_CHARS)}…` : json;
}

/** A masked result: the call, so the model can run it again, and what it would get back. */
function stub(call: MindToolCall, content: string): string {
  const args = argumentsHead(JSON.stringify(call.arguments));
  return (
    `[Result elided to save context: ${call.name} ${args} returned ${content.length} ` +
    "characters. Run it again if you need them.]"
  );
}

const SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

/** pi's formatFileOperations. */
export function fileLists(files: {
  readonly read: readonly string[];
  readonly written: readonly string[];
}): string {
  const sections: string[] = [];
  if (files.read.length > 0) sections.push(`<read-files>\n${files.read.join("\n")}\n</read-files>`);
  if (files.written.length > 0) {
    sections.push(`<modified-files>\n${files.written.join("\n")}\n</modified-files>`);
  }
  return sections.join("\n\n");
}

/**
 * What a request sends: the summary, then the blocks, with each tool result older than the newest
 * `maskAfterTokens` of context masked to a stub (JetBrains Research, "The Complexity Trap", 2025:
 * masking matches summarizing on long agent runs, for less). The boundary moves in steps of half
 * that, so each request between two steps only adds to the one before, which keeps the provider's
 * prompt cache. It rounds up, keeping half of `maskAfterTokens` to all of it whole and never more:
 * rounded down, a window that fits the newest `maskAfterTokens` would compact before masking.
 */
export function contextMessages(context: TaskContext, maskAfterTokens: number): ContextMessage[] {
  const chunks = context.blocks.map(blockMessages);
  let total = 0;
  for (const message of chunks.flat()) total += messageTokens(message);
  const over = total - maskAfterTokens;
  const step = Math.max(1, Math.floor(maskAfterTokens / 2));
  const boundary = over > 0 ? Math.ceil(over / step) * step : 0;
  let end = 0;
  for (const [i, messages] of chunks.entries()) {
    const block = context.blocks[i] as Block;
    for (const [m, message] of messages.entries()) {
      end += messageTokens(message);
      if (message.role !== "tool" || block.kind !== "assistant" || end > boundary) continue;
      const call = block.entry.calls.find(({ id }) => id === message.tool_call_id);
      const masked = call === undefined ? null : stub(call, message.content);
      if (masked !== null && masked.length < message.content.length) {
        messages[m] = { ...message, content: masked };
      }
    }
  }
  const messages = chunks.flat();
  const { compaction } = context;
  if (compaction === null) return messages;
  const lists = fileLists(compaction.files);
  const summary = `${compaction.summary}${lists === "" ? "" : `\n\n${lists}`}`;
  return [{ role: "user", content: `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}` }, ...messages];
}

/**
 * The index of the first block compaction keeps: the newest blocks holding at least `keepTokens`,
 * whole. 0 when they all fit, and nothing is left to summarize.
 */
export function firstKept(blocks: readonly Block[], keepTokens: number): number {
  let kept = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    kept += blockTokens(blocks[i] as Block);
    if (kept >= keepTokens) return i;
  }
  return 0;
}

/** pi's TOOL_RESULT_MAX_CHARS: a summary needs what a result was, not all of it. */
const SUMMARY_RESULT_CHARS = 2000;

function truncated(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return `${text.slice(0, end)}\n\n[... ${text.length - end} more characters truncated]`;
}

/** pi's serializeConversation: text, so the summarizer reads it rather than carrying it on. */
function serialized(blocks: readonly Block[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === "line") {
      if (block.text !== "") parts.push(`[User]: ${block.text}`);
      continue;
    }
    const { text, calls } = block.entry;
    if (text !== "") parts.push(`[Assistant]: ${text}`);
    if (calls.length > 0) {
      const listed = calls.map(({ name, arguments: args }) => {
        const fields = Object.entries(args).map(
          ([key, value]) => `${key}=${JSON.stringify(value)}`,
        );
        return `${name}(${fields.join(", ")})`;
      });
      parts.push(`[Assistant tool calls]: ${listed.join("; ")}`);
    }
    for (const result of block.results) {
      if (result?.content) {
        parts.push(`[Tool result]: ${truncated(result.content, SUMMARY_RESULT_CHARS)}`);
      }
    }
  }
  return parts.join("\n\n");
}

/** The files the results before entry `seq` read and wrote; a file written is not listed as read. */
export function filesBefore(
  entries: readonly TaskEntry[],
  seq: number,
): { readonly read: string[]; readonly written: string[] } {
  const read = new Set<string>();
  const written = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "tool-result" || entry.seq >= seq) continue;
    for (const path of entry.files?.read ?? []) read.add(path);
    for (const path of entry.files?.written ?? []) written.add(path);
  }
  return {
    read: [...read].filter((path) => !written.has(path)).sort(),
    written: [...written].sort(),
  };
}

/** The summary request's one message: what pi's generateSummary sends, file lists added. */
export function summaryPrompt(
  older: readonly Block[],
  previous: string | null,
  files: { readonly read: readonly string[]; readonly written: readonly string[] },
  instructions: string,
): string {
  let prompt = `<conversation>\n${serialized(older)}\n</conversation>\n\n`;
  if (previous !== null) prompt += `<previous-summary>\n${previous}\n</previous-summary>\n\n`;
  const lists = fileLists(files);
  if (lists !== "") prompt += `${lists}\n\n`;
  return prompt + instructions;
}
