// The user half of mem0's additive extraction call (`generate_additive_extraction_prompt`), with
// what this bot never passes left out: a summary, recently extracted memories, custom instructions.
import { cpLen, cpSlice, pyJsonDumps, pyStr, pyTruthy } from "@eidolon/config";

export const PAST_MESSAGE_TRUNCATION_LIMIT = 300;

/** A `messages` row of the history DB. */
export interface StoredMessage {
  readonly role: unknown;
  readonly content: unknown;
  readonly name: unknown;
  readonly created_at: unknown;
}

export interface ExistingMemory {
  readonly id: string;
  readonly text: unknown;
}

function truncate(text: string): string {
  if (cpLen(text) <= PAST_MESSAGE_TRUNCATION_LIMIT) return text;
  return `${cpSlice(text, 0, PAST_MESSAGE_TRUNCATION_LIMIT)}...`;
}

function formatHistory(rows: readonly StoredMessage[]): string {
  let out = "";
  for (const row of rows) {
    const role = row.role ?? "";
    const content = row.content ?? "";
    if (pyTruthy(role) && pyTruthy(content)) out += `${pyStr(role)}: ${truncate(pyStr(content))}\n`;
  }
  return out;
}

export function generateAdditiveExtractionPrompt(options: {
  readonly existingMemories: readonly ExistingMemory[];
  readonly newMessages: string;
  readonly lastKMessages: readonly StoredMessage[];
  /** UTC `YYYY-MM-DD`; observation and current date alike. */
  readonly currentDate: string;
}): string {
  const date = options.currentDate;
  return [
    "## Summary\n",
    `## Last k Messages\n${formatHistory(options.lastKMessages)}`,
    "## Recently Extracted Memories\n[]",
    `## Existing Memories\n${pyJsonDumps(options.existingMemories, { ensureAscii: false })}`,
    `## New Messages\n${options.newMessages}`,
    `## Observation Date\n${date}`,
    `## Current Date\n${date}`,
    "# Output:",
  ].join("\n\n");
}
