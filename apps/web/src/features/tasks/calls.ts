// Her start_task calls in a chat's log. A task's card sits at her call, the call's `started` result
// names the task, and its `final` is the outcome she reports.
import type { ChatEvent, ParticipantId } from "@eidolon/chat";
import type { StartTaskFinal, StartTaskToolName } from "@/lib/api";

export const START_TASK: StartTaskToolName = "start_task";

export interface TaskCall {
  /** Her tool-call's seq: where the card sits. */
  readonly seq: number;
  readonly callId: string;
  readonly persona: ParticipantId;
  /** As her call put them; null where they aren't text. */
  readonly goal: string | null;
  readonly folder: string | null;
  /** Null until its `started` result is stored, and for a start that was refused. */
  readonly task: string | null;
  readonly final: { readonly seq: number; readonly result: StartTaskFinal } | null;
}

const ENDINGS: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function finalOf(result: Readonly<Record<string, unknown>>): StartTaskFinal | null {
  const { status, report, files, spentUsd } = result;
  if (typeof status !== "string" || !ENDINGS.has(status)) return null;
  return {
    status: status as StartTaskFinal["status"],
    report: typeof report === "string" ? report : "",
    files: Array.isArray(files) ? files.filter((file) => typeof file === "string") : [],
    spentUsd: typeof spentUsd === "number" && Number.isFinite(spentUsd) ? spentUsd : 0,
  };
}

/** Each start_task call in the log, in its order. */
export function taskCalls(events: readonly ChatEvent[]): TaskCall[] {
  const calls: TaskCall[] = [];
  // A provider may use a call id again in a later turn: a result goes to the newest call with it.
  const latest = new Map<string, number>();
  for (const event of events) {
    if (event.type === "tool-call" && event.name === START_TASK) {
      latest.set(`${event.persona}\n${event.callId}`, calls.length);
      calls.push({
        seq: event.seq,
        callId: event.callId,
        persona: event.persona,
        goal: text(event.arguments.goal),
        folder: text(event.arguments.folder),
        task: null,
        final: null,
      });
    } else if (event.type === "tool-result") {
      const at = latest.get(`${event.persona}\n${event.callId}`);
      const entry = at === undefined ? undefined : calls[at];
      if (at === undefined || entry === undefined) continue;
      if (event.stage === "started") {
        calls[at] = { ...entry, task: text(event.result.task) };
      } else if (event.stage === "final") {
        const result = finalOf(event.result);
        if (result !== null) calls[at] = { ...entry, final: { seq: event.seq, result } };
      }
    }
  }
  return calls;
}

/**
 * Her report on `call` is in the log: its final, then for a task that ended on its own, her line or
 * her failed turn. One of hers after a line of the owner's may answer that line instead.
 */
export function reportStored(events: readonly ChatEvent[], call: TaskCall): boolean {
  const { final } = call;
  if (final === null) return false;
  if (final.result.status === "cancelled") return true;
  for (const event of events) {
    if (event.seq <= final.seq) continue;
    if (event.type === "message") {
      if (event.speaker.kind === "user") return false;
      if (event.speaker.id === call.persona) return true;
    } else if (event.type === "turn-failed" && event.persona === call.persona) {
      return true;
    }
  }
  return false;
}
