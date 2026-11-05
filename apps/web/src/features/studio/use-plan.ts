// The persona's plan: where each video stands and what the rest would cost. The server reuses a
// plan until a job that changes her sources ends or a batch is written, so asking for one is cheap.
import type { PlanVideo } from "@eidolon/ingest/progress";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toastError } from "@/features/jobs/feedback";
import { useJobEvents } from "@/features/jobs/use-job-events";
import { call, type JobSnapshot } from "@/lib/api";
import { runSummary, type SummaryEvent } from "@/lib/jobs";

export function planQuery(persona: string) {
  return queryOptions({
    queryKey: ["personas", persona, "plan"],
    queryFn: ({ signal }) =>
      call("POST /api/local/jobs", { body: { command: "plan", persona }, signal }),
  });
}

export interface Plan {
  readonly job: JobSnapshot | null;
  readonly videos: readonly PlanVideo[];
  /** The plan's own summary: its counts and its estimate. */
  readonly summary: SummaryEvent | null;
  /** A newer plan is being made; what shows is the last complete one, if any. */
  readonly refreshing: boolean;
  /** The plan job ended without a plan. */
  readonly failed: boolean;
  readonly error: Error | null;
  /** Asks for the current plan again: after a batch is written, or a run ends. */
  readonly update: () => void;
  /** Plans anew even when nothing changed. */
  readonly refresh: () => void;
}

export function usePlan(persona: string): Plan {
  const queryClient = useQueryClient();
  const query = useQuery(planQuery(persona));
  const job = query.data ?? null;
  const events = useJobEvents(job?.id ?? null);
  const summary = runSummary(events.view, "plan");
  const complete = events.ended && summary !== null;

  // The last complete plan stays on screen while a newer one runs.
  const [settled, setSettled] = useState<{
    readonly id: string;
    readonly videos: readonly PlanVideo[];
    readonly summary: SummaryEvent;
  } | null>(null);
  if (complete && job !== null && settled?.id !== job.id) {
    setSettled({ id: job.id, videos: events.view.plan, summary });
  }

  const replan = useMutation({
    mutationFn: () =>
      call("POST /api/local/jobs", {
        body: { command: "plan", persona, options: { refresh: true } },
      }),
    onSuccess: (next) => queryClient.setQueryData(planQuery(persona).queryKey, next),
    onError: toastError,
  });
  const { refetch } = query;
  const update = useCallback(() => void refetch(), [refetch]);
  const { mutate } = replan;
  const refresh = useCallback(() => mutate(), [mutate]);

  return {
    job,
    videos: complete ? events.view.plan : (settled?.videos ?? events.view.plan),
    summary: complete ? summary : (settled?.summary ?? null),
    refreshing: query.error === null && (query.isPending || !events.ended || replan.isPending),
    failed: events.ended && summary === null,
    error: query.error,
    update,
    refresh,
  };
}
