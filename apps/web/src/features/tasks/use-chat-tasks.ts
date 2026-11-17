// The open chat's tasks, for its page: read while her log holds any, polled while one is live, the
// one the waiting bar asks about, and when it saw one end whose report isn't in the log yet.
import type { ChatEvent } from "@eidolon/chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskSnapshot, TaskStatus } from "@/lib/api";
import { reportStored, taskCalls } from "./calls";
import { chatTasksQuery, tasksQuery } from "./queries";
import { barChoice, ended, endedSince, tasksPoll } from "./state";

export interface ChatTasks {
  /** The task the waiting bar asks about, and how many more wait. */
  readonly bar: { readonly task: TaskSnapshot; readonly others: number } | null;
  /** When the page saw a task end whose report isn't in the log yet, the latest; null for none. */
  readonly awaitingReport: number | null;
}

export function useChatTasks(chatId: string, events: readonly ChatEvent[]): ChatTasks {
  const queryClient = useQueryClient();
  const calls = useMemo(() => taskCalls(events), [events]);
  const ids = useMemo(
    () => calls.flatMap((call) => (call.task === null ? [] : [call.task])),
    [calls],
  );
  const query = useQuery({
    ...chatTasksQuery(chatId),
    enabled: ids.length > 0,
    refetchInterval: (read) => tasksPoll(read.state.data?.tasks, false),
  });
  const tasks = query.data?.tasks;

  // A task her turn just started is listed from the next read, once.
  const unlisted =
    tasks === undefined ? "" : ids.filter((id) => !tasks.some((task) => task.id === id)).join();
  const { refetch } = query;
  useEffect(() => {
    if (unlisted === "") return;
    void refetch();
    void queryClient.invalidateQueries({ queryKey: tasksQuery.queryKey, exact: true });
  }, [unlisted, refetch, queryClient]);

  const seen = useRef<ReadonlyMap<string, TaskStatus> | null>(null);
  // Tasks whose report the page waits for, each with when it saw the end.
  const [watch, setWatch] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEffect(() => {
    if (tasks === undefined) return;
    const before = seen.current;
    seen.current = new Map(tasks.map((task) => [task.id, task.status]));
    const started =
      before === null
        ? // Ended while no page watched, with no final stored for her yet.
          tasks
            .filter(
              (task) =>
                ended(task.status) &&
                !calls.some((call) => call.task === task.id && call.final !== null),
            )
            .map((task) => task.id)
        : endedSince(before, tasks);
    if (started.length === 0) return;
    const at = Date.now();
    setWatch((current) => new Map([...current, ...started.map((id) => [id, at] as const)]));
  }, [tasks, calls]);

  const awaitingReport = useMemo(() => {
    let latest: number | null = null;
    for (const [id, at] of watch) {
      const call = calls.find((entry) => entry.task === id);
      if (call === undefined || !reportStored(events, call)) latest = Math.max(latest ?? at, at);
    }
    return latest;
  }, [watch, calls, events]);

  const bar = useMemo(() => (tasks === undefined ? null : barChoice(tasks)), [tasks]);
  return { bar, awaitingReport };
}
