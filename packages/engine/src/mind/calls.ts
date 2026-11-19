import { isPlainObject, logger, pyJsonLoads } from "@eidolon/config";
import type { MindToolCall } from "../types.ts";

/** A tool call as it streams in, its arguments' JSON in pieces, by its index in the response. */
export interface PendingCall {
  id: string;
  name: string;
  arguments: string;
}

/** A call's arguments as their streamed JSON parses, `{}` for none; null when it doesn't. */
export function parsedArguments(text: string): unknown {
  try {
    return pyJsonLoads(text || "{}");
  } catch {
    return null;
  }
}

/** How much of a call's unreadable arguments a warning shows: a cut-off write's run to 64,000 tokens. */
const LOGGED_CHARS = 200;

/**
 * The round's calls in order. One whose arguments don't parse to an object, or every one when the
 * output limit `cut` the reply off, comes `unparsed`, for the caller to answer rather than run.
 */
export function assembleCalls(
  pending: ReadonlyMap<number, PendingCall>,
  cut = false,
): MindToolCall[] {
  const calls: MindToolCall[] = [];
  for (const [, call] of [...pending].sort(([a], [b]) => a - b)) {
    if (!call.name) continue;
    const args = parsedArguments(call.arguments);
    if (isPlainObject(args) && !cut) {
      calls.push({ id: call.id, name: call.name, arguments: args });
      continue;
    }
    // A cut reply's mind has said it was cut off.
    if (!isPlainObject(args) && !cut) {
      const text = call.arguments;
      const more = text.length > LOGGED_CHARS ? `… (${text.length} characters)` : "";
      logger.warning(
        `Failed to parse ${call.name}'s arguments: ${JSON.stringify(text.slice(0, LOGGED_CHARS))}${more}`,
      );
    }
    calls.push({ id: call.id, name: call.name, arguments: {}, unparsed: call.arguments });
  }
  return calls;
}
