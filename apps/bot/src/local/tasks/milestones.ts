// What makes a milestone of her task's plan, which a verbose chat's call is told of, and how often a
// call may be handed one. The runner keeps what each call was handed.
import type { TaskSnapshot } from "../api.ts";

/** The least time between two milestones handed to one call. */
export const MILESTONE_GAP_MS = 30_000;

/** How many items of a task's plan are done. */
export function doneOf(todo: TaskSnapshot["todo"]): number {
  return todo?.filter((item) => item.status === "done").length ?? 0;
}

/**
 * The done count of `task`'s plan when it is a milestone past `handed`, the count her call was last
 * handed for it: above that while some item is still to do and the task runs. Else null: her end
 * tells the plan's last item.
 */
export function milestoneOf(task: TaskSnapshot, handed: number): number | null {
  const { status, todo } = task;
  if (status !== "running" || todo === undefined) return null;
  const done = doneOf(todo);
  return done > handed && done < todo.length ? done : null;
}

/** Whether a call last handed a milestone at `last`, null for never, may be handed one at `now`. */
export function gapPassed(last: number | null, now: number): boolean {
  return last === null || now - last >= MILESTONE_GAP_MS;
}
