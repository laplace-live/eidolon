// What the page offers to stop a job, and when it first saw each one stopping. Force stop, a
// SIGKILL that can cut an index rebuild in half, is offered only once a job has been stopping for
// FORCE_STOP_AFTER_MS.
import type { JobSnapshot } from "@/lib/api";

export const FORCE_STOP_AFTER_MS = 20_000;

/**
 * How the page can stop a job: Cancel, then Force stop while the cancel is under way; null once it
 * has ended. A job an earlier server started gets neither, since a server signals only what it
 * spawned and would answer both with 409: the page says it will finish or be marked interrupted.
 */
export function stopOffer(
  job: Pick<JobSnapshot, "status" | "stopping" | "signalable">,
): "cancel" | "force-stop" | "earlier-run" | null {
  if (job.status !== "running") return null;
  if (!job.signalable) return "earlier-run";
  return job.stopping ? "force-stop" : "cancel";
}

const seen = new Map<string, number>();

/** When this page first saw job `id` stopping. */
export function stoppingSince(id: string, now: number): number {
  const at = seen.get(id);
  if (at !== undefined) return at;
  seen.set(id, now);
  return now;
}

/** How long until a job seen stopping since `since` may be forced; 0 once it may. */
export function forceStopIn(since: number, now: number): number {
  return Math.max(0, since + FORCE_STOP_AFTER_MS - now);
}
