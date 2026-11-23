// Notifications of her tasks while the window isn't focused: one waiting on the owner, and one that
// ended. They carry runtime facts, her name, her goal and fixed words alone, never what a worker
// wrote or a page it read could have, and they answer nothing: only the task's card does. A click
// opens the task. Electron-free: index.ts shows them through native.ts.
import { type DesktopCommand, openTaskCommand } from "../shared/bridge.ts";
import type { NoticeHandle } from "./background.ts";
import type { BackendFetch } from "./quit-check.ts";
import type { Strings } from "./strings.ts";

export type NoticeKind =
  | "start"
  | "read"
  | "write"
  | "fetch"
  | "command"
  | "mcp"
  | "spend"
  | "stall"
  | "unpriced"
  | "interrupted"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Notice {
  readonly task: string;
  /** The task's chat, or null for a task without one. */
  readonly chat: string | null;
  /** The persona's display name, or null when unknown. */
  readonly persona: string | null;
  readonly kind: NoticeKind;
  /** Her goal for it on one line, clipped; may be empty. */
  readonly goal: string;
}

export interface TaskWatchOptions {
  /** A GET to the server ready now (Backend.get), Bearer included. */
  readonly fetch: BackendFetch;
  /** Whether the window is focused now. */
  readonly focused: () => boolean;
  /** Shows a notice; null when notifications can't show. */
  readonly show: (notice: Notice) => NoticeHandle | null;
  readonly log: { info(message: string): void; warn(message: string): void };
  /** Tests' clock. */
  readonly timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

export class TaskWatch {
  // Biome calls it unnecessary, but without it `new TaskWatch(options)` doesn't type-check.
  constructor(_options: TaskWatchOptions) {}

  /** A server is ready (owned or attached): a new baseline, then polls. */
  ready(): void {}

  /** No server is ready, or Eidolon quits: stops polling. */
  stop(): void {}
}

/** The notice's title (the persona, else "Eidolon") and body (the phrase, then the goal on a second line when there is one). */
export function noticeText(notice: Notice, strings: Strings): { title: string; body: string } {
  const phrase = strings.notice[notice.kind];
  const goal = notice.goal.trim();
  return {
    title: notice.persona?.trim() || "Eidolon",
    body: goal === "" ? phrase : `${phrase}\n${goal}`,
  };
}

const STATUS = "/api/local/status";
const STATUS_TIMEOUT_MS = 2_000;

/**
 * What a notice's click asks of the page once the window shows: the task in its chat, or the Tasks
 * page for one without a chat. Null while the server counts a live call, since a page that leaves a
 * call hangs it up. Rejects when the status can't be read.
 */
export async function noticeCommand(
  notice: Notice,
  fetch: BackendFetch,
): Promise<DesktopCommand | null> {
  const response = await fetch(STATUS, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`GET ${STATUS} answered ${response.status}`);
  const { activeCalls } = ((await response.json()) ?? {}) as { activeCalls?: unknown };
  if (activeCalls !== 0) return null;
  return notice.chat === null ? "tasks" : openTaskCommand(notice.chat, notice.task);
}
