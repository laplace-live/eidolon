// The text the Python ingest tokenized into each table's `tokens` column, for the parity checks.
import { pyStr } from "@eidolon/config";

function decodedList(raw: unknown): unknown[] {
  try {
    const value: unknown = JSON.parse(String(raw ?? ""));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** persona_facts: ingest_facts.py tokenizes the stored text as is. */
export function factFtsText(row: Record<string, unknown>): string {
  return str(row.text);
}

/**
 * stream_chunks: ingest_streams.py tokenizes the refined fields when there are any, else the
 * heading and the raw transcript.
 */
export function chunkFtsText(row: Record<string, unknown>): string {
  const topics = decodedList(row.topics);
  const mentions = decodedList(row.mentions);
  if (row.summary || row.details || topics.length > 0 || mentions.length > 0) {
    return [
      str(row.heading),
      str(row.summary),
      str(row.details),
      topics.map(pyStr).join(" "),
      mentions.map(pyStr).join(" "),
    ].join(" ");
  }
  return `${str(row.heading)} ${str(row.text)}`;
}

export const FTS_COLUMNS = {
  persona_facts: ["id", "text", "tokens"],
  stream_chunks: ["id", "heading", "text", "summary", "details", "topics", "mentions", "tokens"],
} as const;
