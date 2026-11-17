// A task's transcript, as its events stream gives the stored entries, laid out as the rows its
// page shows. Pure: replaying the file from offset 0 gives the view the live stream built.
import type { TaskBrief, TaskEntry, TaskOutcome, TaskPauseReason, TaskToolCall } from "@/lib/api";

type EntryOf<Type extends TaskEntry["type"]> = Extract<TaskEntry, { type: Type }>;

export interface ToolResultView {
  /** What the worker saw, as the transcript keeps it. */
  readonly content: string;
  readonly isError: boolean;
  /** An edit's display diff. */
  readonly diff: string | null;
  /** The path a refused call asked for. */
  readonly refused: EntryOf<"tool-result">["refused"] | null;
}

export interface ToolRow {
  readonly kind: "tool";
  readonly key: string;
  readonly callId: string;
  readonly name: string;
  /** Its arguments, cut to the part that names what it works on. */
  readonly head: string;
  /** The text a call sent whose arguments couldn't be read, which never ran. */
  readonly unparsed: string | null;
  /** A `tool-start` came: it ran, or runs. */
  readonly started: boolean;
  readonly result: ToolResultView | null;
}

export type TranscriptRow =
  | { readonly kind: "brief"; readonly key: string; readonly at: number; readonly brief: TaskBrief }
  | {
      readonly kind: "text";
      readonly key: string;
      readonly at: number;
      readonly text: string;
      /** A reply the output limit cut off, or its provider stopped. */
      readonly finish: "cut-off" | "stopped" | null;
    }
  | ToolRow
  | {
      readonly kind: "steer" | "follow-up";
      readonly key: string;
      readonly at: number;
      readonly text: string;
    }
  | {
      readonly kind: "compaction";
      readonly key: string;
      readonly at: number;
      readonly summary: string;
      readonly tokensBefore: number;
    }
  | {
      readonly kind: "pause";
      readonly key: string;
      readonly at: number;
      readonly reason: TaskPauseReason;
      /** The runtime's English. */
      readonly detail: string;
    }
  | { readonly kind: "resume"; readonly key: string; readonly at: number }
  | {
      readonly kind: "end";
      readonly key: string;
      readonly at: number;
      readonly outcome: TaskOutcome;
    };

export interface TranscriptView {
  readonly rows: readonly TranscriptRow[];
  /** Each call id's row: the latest call that has it. */
  readonly calls: ReadonlyMap<string, number>;
}

export const EMPTY_TRANSCRIPT: TranscriptView = { rows: [], calls: new Map() };

/** The engine's finish reasons for a reply cut off at the output limit or the context window. */
const CUT_OFF = new Set(["length", "max_tokens", "model_context_window_exceeded"]);
const STOPPED = new Set(["content_filter", "refusal"]);

/** Arguments that name what a call works on, in the order a head shows them. */
const HEAD_KEYS = ["pattern", "path", "url", "glob", "query", "command"] as const;
const HEAD_CHARS = 160;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string): string {
  return text.length <= HEAD_CHARS ? text : `${text.slice(0, HEAD_CHARS - 1)}…`;
}

/** What a call works on, in one short line: "src/a.ts", "TODO · src". */
export function argumentHead(call: TaskToolCall): string {
  if (call.unparsed !== undefined) return clip(oneLine(call.unparsed));
  const args = call.arguments;
  const named = HEAD_KEYS.flatMap((key) => {
    const value = args[key];
    return typeof value === "string" && value.trim() !== "" ? [oneLine(value)] : [];
  });
  if (named.length > 0) return clip(named.join(" · "));
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.trim() !== "") return clip(oneLine(value));
    if (Array.isArray(value)) {
      const texts = value.flatMap((item) =>
        typeof item === "object" && item !== null && typeof item.text === "string"
          ? [oneLine(item.text)]
          : [],
      );
      if (texts.length > 0) return clip(texts.join(" · "));
    }
  }
  const json = JSON.stringify(args);
  return json === "{}" ? "" : clip(json);
}

function finishOf(reason: string | null | undefined): "cut-off" | "stopped" | null {
  if (reason === null || reason === undefined) return null;
  if (CUT_OFF.has(reason)) return "cut-off";
  return STOPPED.has(reason) ? "stopped" : null;
}

function diffOf(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  const { diff } = details as { readonly diff?: unknown };
  return typeof diff === "string" ? diff : null;
}

/** `view` with `entries` applied, in order; `view` itself is left as it was. */
export function reduceTranscript(
  view: TranscriptView,
  entries: readonly TaskEntry[],
): TranscriptView {
  if (entries.length === 0) return view;
  const rows = [...view.rows];
  const calls = new Map(view.calls);
  const toolAt = (callId: string): ToolRow | null => {
    const at = calls.get(callId);
    const row = at === undefined ? undefined : rows[at];
    return row?.kind === "tool" ? row : null;
  };
  const update = (callId: string, change: Partial<ToolRow>) => {
    const at = calls.get(callId);
    const row = toolAt(callId);
    if (at !== undefined && row !== null) rows[at] = { ...row, ...change };
  };

  for (const entry of entries) {
    const key = String(entry.seq);
    switch (entry.type) {
      case "brief":
        rows.push({ kind: "brief", key, at: entry.at, brief: entry.brief });
        break;
      case "assistant":
        if (entry.text.trim() !== "") {
          rows.push({
            kind: "text",
            key,
            at: entry.at,
            text: entry.text,
            finish: finishOf(entry.finishReason),
          });
        }
        entry.calls.forEach((call, index) => {
          calls.set(call.id, rows.length);
          rows.push({
            kind: "tool",
            key: `${key}:${index}`,
            callId: call.id,
            name: call.name,
            head: argumentHead(call),
            unparsed: call.unparsed ?? null,
            started: false,
            result: null,
          });
        });
        break;
      case "tool-start":
        update(entry.callId, { started: true });
        break;
      case "tool-result": {
        const result: ToolResultView = {
          content: entry.content,
          isError: entry.isError,
          diff: diffOf(entry.details),
          refused: entry.refused ?? null,
        };
        if (toolAt(entry.callId) === null) {
          calls.set(entry.callId, rows.length);
          rows.push({
            kind: "tool",
            key,
            callId: entry.callId,
            name: entry.name,
            head: "",
            unparsed: null,
            started: true,
            result,
          });
        } else {
          update(entry.callId, { result });
        }
        break;
      }
      case "steer":
      case "follow-up":
        rows.push({ kind: entry.type, key, at: entry.at, text: entry.text });
        break;
      case "compaction":
        rows.push({
          kind: "compaction",
          key,
          at: entry.at,
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
        });
        break;
      case "pause":
        rows.push({ kind: "pause", key, at: entry.at, reason: entry.reason, detail: entry.detail });
        break;
      case "resume":
        rows.push({ kind: "resume", key, at: entry.at });
        break;
      case "end":
        rows.push({ kind: "end", key, at: entry.at, outcome: entry.outcome });
        break;
    }
  }
  return { rows, calls };
}

/** The newest tool call: what the card says the task is on. */
export function latestStep(view: TranscriptView): ToolRow | null {
  for (let at = view.rows.length - 1; at >= 0; at--) {
    const row = view.rows[at];
    if (row?.kind === "tool") return row;
  }
  return null;
}

export type ToolState = "waiting" | "running" | "stopped" | "done" | "error";

/**
 * Where a call stands: waiting for the gate or its batch, running, or ended; one the task stopped
 * running under never got its result.
 */
export function toolState(row: ToolRow, running: boolean): ToolState {
  if (row.result !== null) return row.result.isError ? "error" : "done";
  if (!running) return "stopped";
  return row.started ? "running" : "waiting";
}
