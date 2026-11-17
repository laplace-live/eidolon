// What a task's state means for the pages: whether it waits on the owner and for what, what its
// card offers and lists, the Tasks list's order, and how often a page asks again.
import type {
  AssistantStatus,
  STEER_PREFIX as SteerPrefix,
  TaskApproveRequest,
  TaskPause,
  TaskPauseReason,
  TaskPending,
  TaskSnapshot,
  TaskStatus,
} from "@/lib/api";

const ENDED: ReadonlySet<TaskStatus> = new Set(["succeeded", "failed", "cancelled"]);
const WAITING: ReadonlySet<TaskStatus> = new Set(["awaiting-approval", "paused", "interrupted"]);
const STEER_PREFIX: typeof SteerPrefix = "The assistant updates the brief: ";

/** It will never run again. */
export function ended(status: TaskStatus): boolean {
  return ENDED.has(status);
}

/**
 * It goes on only once the owner answers it or presses Continue. An interrupted one resumes on
 * its own only when the server starts with Assistant Mode ready.
 */
export function waitsOnOwner(task: Pick<TaskSnapshot, "status">): boolean {
  return WAITING.has(task.status);
}

/** It waits for the owner's answer: to start, or to a path or a site it asked for. */
export function needsAnswer(task: Pick<TaskSnapshot, "status" | "pending">): boolean {
  if (task.pending === undefined) return false;
  return task.status === "awaiting-approval" || task.status === "paused";
}

export interface Offers {
  /** Allow Once, Always Allow and Deny. */
  readonly approve: boolean;
  readonly continue: boolean;
  readonly stop: boolean;
}

export function offers(task: Pick<TaskSnapshot, "status" | "pending">): Offers {
  const { status } = task;
  const answer = needsAnswer(task);
  return {
    approve: answer,
    continue: (status === "paused" && !answer) || status === "interrupted",
    stop: !ended(status),
  };
}

/**
 * Assistant Mode refuses this answer, as the approve route does while it is off or not ready: every
 * answer but a Deny at the start, which only ends the task.
 */
export function modeRefuses(
  pending: TaskPending["kind"],
  answer: TaskApproveRequest["answer"],
  assistant: Pick<AssistantStatus, "enabled" | "ready"> | undefined,
): boolean {
  if (assistant === undefined || (assistant.enabled && assistant.ready)) return false;
  return !(pending === "start" && answer === "deny");
}

/**
 * Her steer_task lines that a task waiting on the owner reads first when it goes on, her prefix
 * off; a running one reads them at its next request.
 */
export function queuedLines(task: Pick<TaskSnapshot, "status" | "inbox">): string[] {
  if (!waitsOnOwner(task)) return [];
  return (task.inbox?.steer ?? [])
    .filter((line) => line.startsWith(STEER_PREFIX))
    .map((line) => line.slice(STEER_PREFIX.length));
}

/** The pause a snapshot holds: its own, else the paused outcome laplace-task stores. */
function pauseOf(task: Pick<TaskSnapshot, "pause" | "outcome">): TaskPause | undefined {
  if (task.pause !== undefined) return task.pause;
  return task.outcome?.status === "paused" ? task.outcome : undefined;
}

/**
 * Why a task waits on Continue: its pause's reason, or that it was interrupted; null for one
 * waiting on an answer, and for the rest. A pause it can't name is an approval's.
 */
export function pauseKind(
  task: Pick<TaskSnapshot, "status" | "pending" | "pause" | "outcome">,
): TaskPauseReason | "interrupted" | null {
  if (task.status === "interrupted") return "interrupted";
  if (task.status !== "paused" || needsAnswer(task)) return null;
  return pauseOf(task)?.reason ?? "approval";
}

/** The pause's detail, in the runtime's English. */
export function pauseDetail(task: Pick<TaskSnapshot, "pause" | "outcome">): string | null {
  return pauseOf(task)?.detail || null;
}

/** What a task waiting on the owner waits for. */
export type Waiting =
  | { readonly kind: "start"; readonly folder: string }
  | Extract<TaskPending, { readonly kind: "path" }>
  | { readonly kind: "fetch"; readonly host: string }
  | { readonly kind: "spend"; readonly spentUsd: number }
  | { readonly kind: "stall" | "unpriced" | "paused" | "interrupted" };

export function waitingFor(task: TaskSnapshot): Waiting | null {
  const { pending } = task;
  if (pending !== undefined && needsAnswer(task)) {
    switch (pending.kind) {
      case "start":
        return { kind: "start", folder: task.brief.folder };
      case "path":
        return pending;
      case "fetch":
        return { kind: "fetch", host: pending.host };
    }
  }
  switch (pauseKind(task)) {
    case null:
      return null;
    case "spend":
      return { kind: "spend", spentUsd: task.spentUsd };
    case "stall":
      return { kind: "stall" };
    case "unpriced":
      return { kind: "unpriced" };
    case "interrupted":
      return { kind: "interrupted" };
    case "approval":
      return { kind: "paused" };
  }
}

type Created = Pick<TaskSnapshot, "createdAt">;
const newestFirst = (a: Created, b: Created) => b.createdAt - a.createdAt;

/** The live tasks, then the ended ones, each newest first. */
export function listOrder(tasks: readonly TaskSnapshot[]): TaskSnapshot[] {
  const live = tasks.filter((task) => !ended(task.status)).sort(newestFirst);
  return [...live, ...tasks.filter((task) => ended(task.status)).sort(newestFirst)];
}

export function waitingCount(tasks: readonly Pick<TaskSnapshot, "status">[]): number {
  return tasks.filter(waitsOnOwner).length;
}

/** The task the waiting bar asks about, the oldest of those waiting, and how many more wait. */
export function barChoice(
  tasks: readonly TaskSnapshot[],
): { readonly task: TaskSnapshot; readonly others: number } | null {
  const waiting = tasks.filter(waitsOnOwner).sort((a, b) => a.createdAt - b.createdAt);
  const [first] = waiting;
  return first === undefined ? null : { task: first, others: waiting.length - 1 };
}

/** How often a page asks for its tasks again while one runs, and while one waits on the owner. */
export const RUNNING_POLL_MS = 2000;
export const WAITING_POLL_MS = 5000;

/** A tasks query's refetch interval; `idle` while none is live. */
export function tasksPoll(
  tasks: readonly Pick<TaskSnapshot, "status">[] | undefined,
  idle: number | false,
): number | false {
  if (tasks === undefined) return false;
  if (tasks.some((task) => task.status === "running")) return RUNNING_POLL_MS;
  return tasks.some((task) => !ended(task.status)) ? WAITING_POLL_MS : idle;
}

/**
 * Whether task `id`'s card follows its transcript, given the chat's tasks: while its steps are open,
 * and for the newest running task, whose latest step it shows. A follow holds one of the six
 * connections the browser keeps to the server for as long as its task runs.
 */
export function followsSteps(
  id: string,
  tasks: readonly Pick<TaskSnapshot, "id" | "status" | "createdAt">[],
  open: boolean,
): boolean {
  if (open) return true;
  const [newest] = tasks.filter((task) => task.status === "running").sort(newestFirst);
  return newest?.id === id;
}

/** The tasks of `tasks` that were live in `before`, the statuses last seen, and have ended. */
export function endedSince(
  before: ReadonlyMap<string, TaskStatus>,
  tasks: readonly Pick<TaskSnapshot, "id" | "status">[],
): string[] {
  return tasks
    .filter((task) => {
      const was = before.get(task.id);
      return was !== undefined && !ended(was) && ended(task.status);
    })
    .map((task) => task.id);
}

/**
 * The spend it pauses at next, as the engine works it out from what it spent when its run started:
 * the next multiple of its step; null when the pauses are off.
 */
export function nextPauseAt(spentUsd: number, spendPauseUsd: number): number | null {
  if (spendPauseUsd <= 0) return null;
  return (Math.floor(spentUsd / spendPauseUsd) + 1) * spendPauseUsd;
}

/** `path` from inside `folder`, else as it is. */
export function pathIn(folder: string, path: string): string {
  const base = folder.replace(/[/\\]+$/, "");
  const rest = path.slice(base.length);
  return path.startsWith(base) && /^[/\\]./.test(rest) ? rest.slice(1) : path;
}
