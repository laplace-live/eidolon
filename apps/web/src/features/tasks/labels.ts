// What the task pages call the codes the API defines: statuses, kinds, web access, plan steps and
// pauses, what an Allow of a path grants, and a command as its card shows it.
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type {
  TaskPauseReason,
  TaskPending,
  TaskProfile,
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

/** The kind she gave a task when she started it, which picks its account and model. */
export const PROFILE_LABELS: Readonly<Record<TaskProfile, MessageDescriptor>> = {
  quick: msg({ message: "Quick", context: "task kind" }),
  coding: msg({ message: "Coding", context: "task kind" }),
  research: msg({ message: "Research", context: "task kind" }),
};

export const WEB_MODE_LABELS: Readonly<Record<TaskWebMode, MessageDescriptor>> = {
  ask: msg`Ask for Each Site`,
  any: msg`Any Site`,
  off: msg`No Web`,
};

const WEB_MODE_HELP: Readonly<Record<TaskWebMode, MessageDescriptor>> = {
  ask: msg`It asks you before it fetches from a site for the first time.`,
  any: msg`It may fetch from any public site without asking.`,
  off: msg`It can't fetch anything from the web, and each call to an MCP server asks you first.`,
};

/** While the search role has an account: results bring any site's excerpts in unasked. */
const SEARCH_MODE_HELP: Readonly<Record<TaskWebMode, MessageDescriptor>> = {
  ask: msg`It may search the web without asking, and asks you before it fetches from a site for the first time.`,
  any: msg`It may search the web and fetch from any public site without asking.`,
  off: msg`It can't search or fetch from the web, and each call to an MCP server asks you first.`,
};

/** What a web access choice lets a task do, as it stands with web search on or off. */
export function webModeHelp(mode: TaskWebMode, search: boolean): MessageDescriptor {
  return (search ? SEARCH_MODE_HELP : WEB_MODE_HELP)[mode];
}

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

type McpHint = NonNullable<Extract<TaskPending, { readonly kind: "mcp" }>["hint"]>;

/** What an MCP server says of its tool: shown as its claim, and never deciding anything. */
export const MCP_HINT_TEXT: Readonly<Record<McpHint, MessageDescriptor>> = {
  "read-only": msg`The server says this tool only reads.`,
  destructive: msg`The server says this tool can change or delete things.`,
};

/** A run of a command as its card shows it: as written, or one hidden character spelled out. */
export interface CommandPart {
  /** Its offset in the command, in UTF-16 units. */
  readonly at: number;
  readonly text: string;
  /** A control, bidi or invisible character, shown as `\u{…}`. */
  readonly escaped: boolean;
}

/**
 * Code points that change how a command reads without showing, or don't show at all: controls but
 * tab and newline, bidi controls, zero-width and invisible marks, line and paragraph separators,
 * and Unicode tags.
 */
const HIDDEN: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

const hidden = (code: number) => HIDDEN.some(([from, to]) => code >= from && code <= to);

/**
 * A command as its card shows it, so what runs is what the owner reads: each hidden character is
 * spelled out as `\u{202E}`, since a worker or a page it read can write a command that displays
 * otherwise than it runs.
 */
export function visibleCommand(command: string): CommandPart[] {
  const parts: CommandPart[] = [];
  let start = 0;
  let at = 0;
  for (const char of command) {
    const code = char.codePointAt(0) ?? 0;
    if (hidden(code)) {
      if (at > start) parts.push({ at: start, text: command.slice(start, at), escaped: false });
      const hex = code.toString(16).toUpperCase().padStart(4, "0");
      parts.push({ at, text: `\\u{${hex}}`, escaped: true });
      start = at + char.length;
    }
    at += char.length;
  }
  if (at > start) parts.push({ at: start, text: command.slice(start), escaped: false });
  return parts;
}
