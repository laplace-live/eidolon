import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { call, type JobRequest, type JobSnapshot } from "@/lib/api";
import { toastError } from "@/lib/feedback";

/** Snapshots poll this often while a job runs, and the list this often when none does. */
export const RUNNING_POLL_MS = 2000;
export const IDLE_POLL_MS = 15_000;

export const jobsQuery = queryOptions({
  queryKey: ["jobs"],
  queryFn: ({ signal }) => call("GET /api/local/jobs", { signal }),
  refetchInterval: (query) =>
    query.state.data?.some((job) => job.status === "running") ? RUNNING_POLL_MS : IDLE_POLL_MS,
});

export function jobQuery(id: string) {
  return queryOptions({
    queryKey: ["jobs", id],
    queryFn: ({ signal }) => call("GET /api/local/jobs/:id", { params: { id }, signal }),
    refetchInterval: (query) => (query.state.data?.status === "running" ? RUNNING_POLL_MS : false),
  });
}

/** Keeps a snapshot the API answered with, in the list too until it catches up. */
function useRemember() {
  const queryClient = useQueryClient();
  return (job: JobSnapshot) => {
    queryClient.setQueryData(jobQuery(job.id).queryKey, job);
    queryClient.setQueryData(jobsQuery.queryKey, (jobs) => [
      job,
      ...(jobs ?? []).filter((other) => other.id !== job.id),
    ]);
    void queryClient.invalidateQueries({ queryKey: jobsQuery.queryKey, exact: true });
  };
}

/** A job call: its answer goes into the caches, and a failure shows as a toast. */
function useJobMutation<T>(mutationFn: (input: T) => Promise<JobSnapshot>) {
  const remember = useRemember();
  return useMutation({ mutationFn, onSuccess: remember, onError: toastError });
}

export function useStartJob() {
  return useJobMutation((request: JobRequest) => call("POST /api/local/jobs", { body: request }));
}

export function useCancelJob() {
  return useJobMutation((id: string) => call("DELETE /api/local/jobs/:id", { params: { id } }));
}

/** SIGKILL for a cancelled job that won't exit. */
export function useForceStopJob() {
  return useJobMutation((id: string) =>
    call("DELETE /api/local/jobs/:id", { params: { id }, query: { force: 1 } }),
  );
}

export function useResumeJob() {
  return useJobMutation((id: string) =>
    call("POST /api/local/jobs/:id/resume", { params: { id } }),
  );
}
