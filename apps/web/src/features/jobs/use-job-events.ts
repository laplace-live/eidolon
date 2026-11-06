// Follows the events of the job on screen. Lists poll snapshots instead: a stream per job would use
// up the browser's six connections to the server.
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, type JobSnapshot, stream } from "@/lib/api";
import { EMPTY_JOB_VIEW, type JobEvent, type JobView, reduceJob } from "@/lib/jobs";
import { readNdjson } from "@/lib/ndjson";
import { jobQuery, jobsQuery } from "./queries";

/** Events are applied in batches, so a burst of progress lines renders once. */
const FLUSH_MS = 100;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5000;

export interface JobEvents {
  readonly view: JobView;
  /** The job has stopped and its events are read, so the view is final. */
  readonly ended: boolean;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Reads the job's events from the start, reconnecting from the last whole line, until the job has
 * stopped and its file is read to the end, or the server refuses the request.
 */
export async function followJob(
  id: string,
  signal: AbortSignal,
  onEvent: (event: JobEvent) => void,
  snapshot: () => Promise<JobSnapshot>,
): Promise<void> {
  let offset = 0;
  let wait = RETRY_MIN_MS;
  let readAfterStop: number | null = null;
  while (!signal.aborted) {
    try {
      const body = await stream("GET /api/local/jobs/:id/events", {
        params: { id },
        query: { after: offset },
        signal,
      });
      for await (const line of readNdjson<JobEvent>(body, offset)) {
        offset = line.offset;
        onEvent(line.value);
      }
      const job = await snapshot();
      if (job.status !== "running") {
        // A file can end in a line its writer never finished, which is never read whole.
        if (offset >= job.eventsSize || readAfterStop === offset) return;
        readAfterStop = offset;
        continue;
      }
      wait = RETRY_MIN_MS;
    } catch (error) {
      if (signal.aborted) return;
      // Gone, or no session: the snapshot's own query says which.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) return;
      // A line that isn't JSON would fail the same way on every retry.
      if (error instanceof SyntaxError) return;
    }
    await sleep(wait, signal);
    wait = Math.min(wait * 2, RETRY_MAX_MS);
  }
}

export function refreshJob(queryClient: QueryClient, id: string): Promise<JobSnapshot> {
  return queryClient.fetchQuery({ ...jobQuery(id), staleTime: 0 });
}

/** The view of job `id`'s events, live while it runs; null follows nothing. */
export function useJobEvents(id: string | null): JobEvents {
  const queryClient = useQueryClient();
  const [state, setState] = useState<JobEvents & { readonly id: string | null }>({
    id: null,
    view: EMPTY_JOB_VIEW,
    ended: false,
  });

  useEffect(() => {
    if (id === null) return;
    const controller = new AbortController();
    let pending: JobEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Each follow reads the file from its start, so it starts from an empty view too.
    setState({ id, view: EMPTY_JOB_VIEW, ended: false });
    const flush = () => {
      timer = undefined;
      const batch = pending;
      pending = [];
      setState((current) => ({ id, view: reduceJob(current.view, batch), ended: false }));
    };
    void followJob(
      id,
      controller.signal,
      (event) => {
        pending.push(event);
        timer ??= setTimeout(flush, FLUSH_MS);
      },
      () => refreshJob(queryClient, id),
    ).then(() => {
      if (controller.signal.aborted) return;
      clearTimeout(timer);
      flush();
      setState((current) => ({ ...current, ended: true }));
      void queryClient.invalidateQueries({ queryKey: jobsQuery.queryKey, exact: true });
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, queryClient]);

  return state.id === id ? state : { view: EMPTY_JOB_VIEW, ended: false };
}
