// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/core/src/processors/aggregators/async_tool_messages.ts@ce8f8bc
//
// The contents of the messages a tool that runs on past her reply (`take_selfie`) leaves in her
// view, byte for byte as pipedog's call context held them: a `tool` placeholder while it runs, then
// a `developer` message with its result or its cancellation.

const PAYLOAD_TYPE = "async_tool";
const RUNNING = "running";
const FINISHED = "finished";

// The descriptions name no message shape: a model told the shape of a message to expect calls the
// tool again with it as the arguments, since a function call is the only structured channel it has.
const STARTED_DESCRIPTION =
  "This tool is still running. You will be given its result later. Do not call it " +
  "again and do not invent a result in the meantime.";

const FINAL_DESCRIPTION =
  "This is the final result for the asynchronous task associated with this " +
  "tool_call_id. The task has completed. No further results will arrive for " +
  "this tool_call_id. You must convey this result to the user, even if the " +
  "conversation has moved on. Never leave it unsaid. If the user has said " +
  "something you have not answered yet, first finish responding to that, " +
  "then deliver the result at the end of your response; if you have already " +
  "answered, deliver just the result and do not repeat your earlier reply. " +
  "How you deliver it depends on its size: if the result is short, simply " +
  "state it; if it is long or complex, name what has come back and offer " +
  "the details. Convey it once; do not repeat it in later responses.";

// A bare "CANCELLED" reads as a statement about whatever the tool looks up: a model relaying it
// tells the user their order was cancelled.
const CANCELLED_RESULT = "CANCELLED: this tool call was cancelled before it returned a result";

const CANCELLED_DESCRIPTION =
  "The asynchronous task associated with this tool_call_id was cancelled " +
  "before it produced a result, either because it ran past its deadline or " +
  "because cancellation was requested. No further results will arrive for " +
  "this tool_call_id. If the user is still waiting on it, tell them it did " +
  "not complete rather than leaving it unanswered.";

/** Python's `json.dumps(payload, ensure_ascii=False)`, with its `", "` and `": "` separators. */
function payload(
  status: typeof RUNNING | typeof FINISHED,
  callId: string,
  description: string,
  result: string | null,
): string {
  const fields: Record<string, string> = {
    type: PAYLOAD_TYPE,
    status,
    tool_call_id: callId,
    description,
  };
  if (result !== null) fields.result = result;
  const entries = Object.entries(fields).map(
    ([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`,
  );
  return `{${entries.join(", ")}}`;
}

/** The `tool` message's content while call `callId` runs. */
export function startedEnvelope(callId: string): string {
  return payload(RUNNING, callId, STARTED_DESCRIPTION, null);
}

/** The `developer` message's content settling `callId`; `result` is already encoded. */
export function finalEnvelope(callId: string, result: string): string {
  return payload(FINISHED, callId, FINAL_DESCRIPTION, result);
}

/** The `developer` message's content settling `callId`, cancelled before it returned. */
export function cancelledEnvelope(callId: string): string {
  return payload(FINISHED, callId, CANCELLED_DESCRIPTION, CANCELLED_RESULT);
}

/** The call a `tool` or `developer` message's content is an async-tool payload for, else null. */
export function asyncToolCallId(content: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { type, tool_call_id: callId, status } = value as Record<string, unknown>;
  if (type !== PAYLOAD_TYPE || typeof callId !== "string") return null;
  return status === RUNNING || status === FINISHED ? callId : null;
}
