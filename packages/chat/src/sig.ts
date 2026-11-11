import type { ChatEvent } from "./format.ts";

/** JSON with every object's keys sorted by UTF-16 code unit, undefined members dropped. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * What the production endpoint signs for `event` in chat `chatId`: the chat id, a newline, then
 * the event without `sig` as JSON with sorted keys and no whitespace.
 */
export function canonicalForSig(chatId: string, event: ChatEvent): string {
  const { sig: _, ...signed } = event;
  return `${chatId}\n${canonicalJson(signed)}`;
}
