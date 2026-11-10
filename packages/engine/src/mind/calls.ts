import { isPlainObject, logger, pyJsonLoads } from "@eidolon/config";
import type { MindToolCall } from "../types.ts";

/** A tool call as it streams in, its arguments' JSON in pieces, by its index in the response. */
export interface PendingCall {
  id: string;
  name: string;
  arguments: string;
}

function parsed(text: string): unknown {
  try {
    return pyJsonLoads(text);
  } catch {
    return null;
  }
}

/** The round's calls in order, each whose arguments parse to an object. */
export function assembleCalls(pending: ReadonlyMap<number, PendingCall>): MindToolCall[] {
  const calls: MindToolCall[] = [];
  for (const [, call] of [...pending].sort(([a], [b]) => a - b)) {
    if (!call.name) continue;
    const args = parsed(call.arguments || "{}");
    if (isPlainObject(args)) calls.push({ id: call.id, name: call.name, arguments: args });
    else logger.warning(`Failed to parse ${call.name}'s arguments: ${call.arguments}`);
  }
  return calls;
}
