// What the task pages call the codes the API defines: statuses, web access, plan steps and pauses,
// and what an Allow of a path grants.
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type {
  TaskPauseReason,
  TaskPending,
  TaskStatus,
  TaskTodoStatus,
  TaskWebMode,
} from "@/lib/api";
import type { ToolState } from "./transcript";

export const STATUS_LABELS: Readonly<Record<TaskStatus, MessageDescriptor>> = {
  "awaiting-approval": msg`Awaiting Approval`,
  running: msg`Running`,
  paused: msg`Paused`,
  interrupted: msg`Interrupted`,
  succeeded: msg({ message: "Done", context: "task status" }),
  failed: msg`Failed`,
  cancelled: msg({ message: "Stopped", context: "task status" }),
};

export const WEB_MODE_LABELS: Readonly<Record<TaskWebMode, MessageDescriptor>> = {
  ask: msg`Ask for Each Site`,
  any: msg`Any Site`,
  off: msg`No Web`,
};

export const WEB_MODE_HELP: Readonly<Record<TaskWebMode, MessageDescriptor>> = {
  ask: msg`It asks you before it fetches from a site for the first time.`,
  any: msg`It may fetch from any public site without asking.`,
  off: msg`It can't fetch anything from the web.`,
};

const PATH_ALWAYS_HELP = msg`Always Allow This Folder adds {folder} to Assistant Mode's folders: from then on every task may read and write in it, and tasks start there without asking.`;

/** A path question's waiting line and Allow Once sentence, by its access and what an Allow grants. */
const PATH_GRANTS = {
  read: {
    folder: {
      line: msg`Waiting for your OK to read everything in {folder}`,
      allow: msg`Allow Once lets this task read everything in {folder} until it ends; Deny tells it it can't.`,
    },
    alone: {
      line: msg`Waiting for your OK to read {path}`,
      allow: msg`Allow Once lets this task read {path} alone until it ends; Deny tells it it can't.`,
    },
  },
  write: {
    folder: {
      line: msg`Waiting for your OK to read and write everything in {folder}`,
      allow: msg`Allow Once lets this task read and write everything in {folder} until it ends; Deny tells it it can't.`,
    },
    alone: {
      line: msg`Waiting for your OK to read and write {path}`,
      allow: msg`Allow Once lets this task read and write {path} alone until it ends; Deny tells it it can't.`,
    },
  },
} satisfies Readonly<
  Record<"read" | "write", Record<"folder" | "alone", Record<"line" | "allow", MessageDescriptor>>>
>;

export interface PathGrantText {
  /** The waiting bar's line, and the Tasks list's. */
  readonly line: MessageDescriptor;
  /** The card's: what Allow Once grants. */
  readonly allow: MessageDescriptor;
  /** What Always Allow This Folder adds; null where the card doesn't offer it. */
  readonly always: MessageDescriptor | null;
}

/**
 * What an Allow of a path question grants, its placeholders filled: everything in the folder it
 * names, else the path alone, to read, or to read and write for a write. Always is offered only to
 * add a write's folder: assistant.folders would let every task write there, and hold no file.
 */
export function pathGrant(
  pending: Pick<Extract<TaskPending, { readonly kind: "path" }>, "path" | "access" | "folder">,
): PathGrantText {
  const { access, folder } = pending;
  const values = { path: pending.path, folder };
  const { line, allow } = PATH_GRANTS[access][folder === undefined ? "alone" : "folder"];
  return {
    line: { ...line, values },
    allow: { ...allow, values },
    always: access === "write" && folder !== undefined ? { ...PATH_ALWAYS_HELP, values } : null,
  };
}

/** A plan step's state, said for screen readers beside its mark. */
export const TODO_STATUS_LABELS: Readonly<Record<TaskTodoStatus, MessageDescriptor>> = {
  pending: msg`To Do`,
  in_progress: msg`In Progress`,
  done: msg`Done`,
};

/** Why it paused, as its transcript's line says. */
export const PAUSE_REASONS: Readonly<Record<TaskPauseReason, MessageDescriptor>> = {
  spend: msg`It reached its spend pause.`,
  stall: msg`It repeated the same steps three turns running.`,
  approval: msg`It waited for your answer.`,
  unpriced: msg`Its spend couldn't be counted.`,
};

/** Where a tool call stands, said for screen readers beside its mark. */
export const TOOL_STATE_TEXT: Readonly<Record<ToolState, MessageDescriptor>> = {
  waiting: msg`Waiting`,
  running: msg({ message: "Running", context: "tool call" }),
  stopped: msg`No result`,
  done: msg({ message: "Done", context: "tool call" }),
  error: msg`Failed`,
};
