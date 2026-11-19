// Follows a task's transcript for its card, while followsSteps (state.ts) says the card follows.
import { useEffect, useRef, useState } from "react";
import { ApiError, stream, type TaskEntry, type TaskSnapshot } from "@/lib/api";
import { readNdjson } from "@/lib/ndjson";
import { fetchTask } from "./queries";
import { EMPTY_TRANSCRIPT, reduceTranscript, type TranscriptView } from "./transcript";

/** Entries are applied in batches, so a burst of them renders once. */
const FLUSH_MS = 100;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5000;

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
 * Reads the task's transcript from byte `from`, reconnecting from the last whole line, until its
 * stream ends with the task stopped, or the server refuses. `live` reads the snapshot that says
 * whether it still runs; without it, one stream to the end is all.
 */
export async function followTask(
  id: string,
  from: number,
  signal: AbortSignal,
  onEntry: (entry: TaskEntry, offset: number) => void,
  live: (() => Promise<TaskSnapshot>) | null,
): Promise<void> {
  let offset = from;
  let wait = RETRY_MIN_MS;
  while (!signal.aborted) {
    try {
      const body = await stream("GET /api/local/tasks/:id/events", {
        params: { id },
        query: { after: offset },
        signal,
      });
      for await (const line of readNdjson<TaskEntry>(body, offset)) {
        offset = line.offset;
        onEntry(line.value, offset);
      }
      if (live === null || (await live()).status !== "running") return;
      wait = RETRY_MIN_MS;
    } catch (error) {
      if (signal.aborted) return;
      // Gone, or no session: the card's own query says which.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) return;
      // A line that isn't JSON would fail the same way on every retry.
      if (error instanceof SyntaxError) return;
    }
    await sleep(wait, signal);
    wait = Math.min(wait * 2, RETRY_MAX_MS);
  }
}

/** What has been read of one task's transcript, and the entries not yet applied. */
interface Cursor {
  readonly id: string;
  offset: number;
  view: TranscriptView;
  pending: TaskEntry[];
  pendingOffset: number;
}

const fresh = (id: string): Cursor => ({
  id,
  offset: 0,
  view: EMPTY_TRANSCRIPT,
  pending: [],
  pendingOffset: 0,
});

export interface TaskEvents {
  readonly view: TranscriptView;
  /** Read to where the task stands, as of when it last stopped running. */
  readonly loaded: boolean;
}

/**
 * The view of task `id`'s transcript while `enabled`, live while it runs. Each time `running`
 * changes, a follow starts again where the last one stopped: a task that runs again after a pause
 * goes on, and one that stopped is read to its end.
 */
export function useTaskEvents(id: string, running: boolean, enabled: boolean): TaskEvents {
  const cursor = useRef<Cursor>(fresh(id));
  if (cursor.current.id !== id) cursor.current = fresh(id);
  const [shown, setShown] = useState<TaskEvents & { readonly id: string }>({
    id,
    view: EMPTY_TRANSCRIPT,
    loaded: false,
  });

  useEffect(() => {
    if (!enabled) return;
    const at = cursor.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = () => {
      timer = undefined;
      if (at.pending.length === 0) return;
      at.view = reduceTranscript(at.view, at.pending);
      at.offset = at.pendingOffset;
      at.pending = [];
    };
    const render = (loaded: boolean) =>
      setShown((current) => ({
        id,
        view: at.view,
        loaded: loaded || (current.id === id && current.loaded),
      }));
    // Entries the follow before this one read but never showed.
    if (at.view.rows.length > 0) render(false);
    void followTask(
      id,
      at.offset,
      controller.signal,
      (entry, offset) => {
        at.pending.push(entry);
        at.pendingOffset = offset;
        timer ??= setTimeout(() => {
          apply();
          render(false);
        }, FLUSH_MS);
      },
      running ? () => fetchTask(id) : null,
    ).then(() => {
      if (controller.signal.aborted) return;
      clearTimeout(timer);
      apply();
      render(true);
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
      // What arrived is kept, so the next follow goes on from it.
      apply();
    };
  }, [id, running, enabled]);

  return shown.id === id ? shown : { view: EMPTY_TRANSCRIPT, loaded: false };
}
