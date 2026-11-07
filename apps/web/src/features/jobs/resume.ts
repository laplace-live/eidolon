import type { JobSnapshot } from "@/lib/api";
import type { Outcome } from "@/lib/jobs";

const UNFINISHED: ReadonlySet<Outcome> = new Set(["interrupted", "cancelled", "failed", "crashed"]);

/** A job that didn't finish resumes once: after that, its rerun is the one to resume. */
export function canResume(
  job: Pick<JobSnapshot, "ephemeral" | "resumedBy">,
  outcome: Outcome,
): boolean {
  return !job.ephemeral && job.resumedBy === null && UNFINISHED.has(outcome);
}
