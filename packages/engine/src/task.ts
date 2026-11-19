// A task: a worker that runs tools in rounds toward a brief, apart from any chat, its every step in
// a transcript it resumes from. The tools are injected, so the engine imports none of them.
import type { ToolSchema } from "@eidolon/core";
import type { Mind, MindToolCall } from "./types.ts";

/** What a task was asked to do: OpenClaw's objective, output, write scope and verification. */
export interface TaskBrief {
  readonly goal: string;
  readonly deliverable: string;
  /** Absolute. */
  readonly folder: string;
  readonly check: string;
}

export interface TaskToolContext {
  readonly signal: AbortSignal;
  /** Progress while it runs, for the UI; never stored. */
  onUpdate(text: string): void;
  /** Whether a steering line waits for the run: a call that would wait long can return early. */
  steered?(): boolean;
}

export interface TaskFiles {
  readonly read?: readonly string[];
  readonly written?: readonly string[];
}

export interface TaskToolResult {
  /** What the model sees. */
  readonly content: string;
  readonly isError?: boolean;
  /** For the UI and the transcript; the model never sees it. */
  readonly details?: unknown;
  readonly files?: TaskFiles;
  /** The path this call was refused, so the caller can ask for it. */
  readonly refused?: { readonly path: string; readonly access: "read" | "write" };
  /** The run may end after this batch, once every result in it says so (pi's terminate). */
  readonly terminate?: boolean;
}

export interface TaskTool {
  readonly schema: ToolSchema;
  /** After a restart left its outcome unknown: run it again, or report it interrupted. */
  readonly replay: "safe" | "never";
  /** "sequential": a batch holding this tool runs one call at a time (pi's executionMode). */
  readonly executionMode?: "parallel" | "sequential";
  /** pi's prepareArguments: a call's arguments reshaped before they are validated. */
  prepareArguments?(args: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
  /**
   * What stands in for an old result of this tool, `characters` long, once the context masks it,
   * from its `details`; undefined for the stub that says to call it again.
   */
  elided?(details: unknown, characters: number): string | undefined;
  execute(
    args: Readonly<Record<string, unknown>>,
    context: TaskToolContext,
  ): Promise<TaskToolResult>;
}

/**
 * Why a task paused: its spend reached the next multiple of its pause, it made the same calls three
 * turns running, it waits on an approval, or its spend can't be counted toward the pause.
 */
export type TaskPauseReason = "spend" | "stall" | "approval" | "unpriced";

export type TaskOutcome =
  | { readonly status: "succeeded"; readonly report: string }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "cancelled" }
  | { readonly status: "paused"; readonly reason: TaskPauseReason; readonly detail: string };

/** A transcript line before the store numbers and stamps it. */
export type TaskEntryDraft =
  | { readonly type: "brief"; readonly brief: TaskBrief }
  | {
      readonly type: "assistant";
      readonly text: string;
      readonly calls: readonly MindToolCall[];
      /** Why the reply ended, as its provider put it: one cut off or stopped is no report. */
      readonly finishReason?: string | null;
    }
  | { readonly type: "tool-start"; readonly callId: string; readonly name: string }
  | {
      readonly type: "tool-result";
      readonly callId: string;
      readonly name: string;
      readonly content: string;
      readonly isError: boolean;
      readonly details?: unknown;
      readonly files?: TaskFiles;
      readonly refused?: { readonly path: string; readonly access: "read" | "write" };
    }
  | { readonly type: "steer"; readonly text: string }
  | { readonly type: "follow-up"; readonly text: string }
  /** A runtime fact from the task's background work, such as a command ending: never its output. */
  | { readonly type: "notice"; readonly text: string }
  | {
      readonly type: "compaction";
      readonly summary: string;
      /** The first entry the rebuilt context keeps after the summary. */
      readonly firstKeptSeq: number;
      readonly files: { readonly read: readonly string[]; readonly written: readonly string[] };
      readonly tokensBefore: number;
    }
  | { readonly type: "pause"; readonly reason: TaskPauseReason; readonly detail: string }
  | { readonly type: "resume" }
  | { readonly type: "end"; readonly outcome: TaskOutcome };

/** A stored transcript line. */
export type TaskEntry = TaskEntryDraft & { readonly seq: number; readonly at: number };

export interface TaskStore {
  /** Every entry, oldest first. */
  entries(): Promise<readonly TaskEntry[]>;
  /** Stores `entry` durably, numbered after the last, and resolves with it. */
  append(entry: TaskEntryDraft): Promise<TaskEntry>;
}

export interface TaskInbox {
  /** Whether a steering line is waiting; doesn't take it. */
  hasSteering(): boolean;
  /** One queued steering line, or all of them; takes them. */
  takeSteering(all: boolean): readonly string[];
  /** One queued follow-up, or all of them; takes them. */
  takeFollowUps(all: boolean): readonly string[];
}

export interface TaskMeter {
  /** The task's spend so far, from every usage record its mind reported. */
  spentUsd(): number;
  /** The last request's input tokens, when its provider reported them. */
  lastInputTokens(): number | null;
  /**
   * Why the first request it couldn't count went uncounted ("No price is known for <model> at
   * <provider>", "No usage was reported for <model> at <account>"), or null.
   */
  unpriced(): string | null;
  /** A request's reply came back whole, a summary's included: one that reported no usage can't count. */
  requestEnded(): void;
}

export type TaskGateDecision =
  | null
  | { readonly block: string; readonly terminate?: boolean }
  | { readonly pause: string };

/** Work a task's tools left running past their calls, such as commands moved to the background. */
export interface TaskBackground {
  /** Whether any of it still runs: a run that would end waits for it instead. */
  running(): boolean;
  /** Runtime lines about work that ended unseen since the last take, each given once. */
  takeEnded(): readonly string[];
}

export interface TaskRequest {
  readonly id: string;
  readonly mind: Mind;
  readonly system: string;
  readonly tools: readonly TaskTool[];
  readonly store: TaskStore;
  readonly inbox: TaskInbox;
  readonly meter: TaskMeter;
  /** pi's beforeToolCall: runs before each call whose arguments validated. */
  readonly gate?: (call: MindToolCall) => Promise<TaskGateDecision>;
  /** pi's afterToolCall: runs before a result is stored. */
  readonly afterToolCall?: (
    call: MindToolCall,
    result: TaskToolResult,
  ) => Promise<Partial<TaskToolResult> | undefined>;
  /** Default "all" for both. */
  readonly steeringMode?: "one-at-a-time" | "all";
  readonly followUpMode?: "one-at-a-time" | "all";
  readonly limits: {
    readonly contextTokens: number;
    readonly spendPauseUsd: number;
    /**
     * Tool results older than this many tokens of newer context become stubs in the request, half
     * of it at a time. Default 40,000.
     */
    readonly maskAfterTokens?: number;
  };
  /** The summary request compaction sends through `mind`. */
  readonly compaction: { readonly system: string; readonly instructions: string };
  /** A refused path pauses the task (reason "approval") rather than only telling the model. */
  readonly pauseOnRefused?: boolean;
  /** Its tools' work past their calls: a run doesn't end while it runs, and hears when it ends. */
  readonly background?: TaskBackground;
  /** Cancels the task: its manager's, never a chat turn's. */
  readonly signal: AbortSignal;
  /** Tests stand in for the retry backoff's waits, and the background wait's. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type TaskEvent =
  | { readonly type: "entry"; readonly entry: TaskEntry }
  | { readonly type: "run"; readonly state: "start" | "end" }
  | { readonly type: "turn"; readonly state: "start" | "end"; readonly turn: number }
  | {
      readonly type: "request";
      readonly state: "start" | "end";
      readonly error?: string;
      readonly retryInMs?: number;
    }
  | { readonly type: "delta"; readonly text: string }
  /** Once a second while the run waits on its background work, so a reader that leaves stops it. */
  | { readonly type: "wait" }
  | {
      readonly type: "tool";
      readonly state: "start" | "update" | "end";
      readonly callId: string;
      readonly name: string;
      readonly text?: string;
      readonly isError?: boolean;
    };

export { runTask } from "./task/loop.ts";
export { UsageMeter, type UsageMeterOptions } from "./task/meter.ts";
