import {
  type QueryClient,
  queryOptions,
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  call,
  type TaskApproveRequest,
  type TaskContinueRequest,
  type TaskSnapshot,
  type TasksResponse,
} from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { ended } from "./state";

/** The app's tasks, newest first: the Tasks list, and the count beside its nav entry. */
export const tasksQuery = queryOptions({
  queryKey: ["tasks", "all"],
  queryFn: ({ signal }) => call("GET /api/local/tasks", { signal }),
});

/**
 * The tasks she started in one chat. It has no interval of its own: the chat's page polls it while
 * one is live, and each card reads it.
 */
export function chatTasksQuery(chat: string) {
  return queryOptions({
    queryKey: ["tasks", "chat", chat],
    queryFn: ({ signal }) => call("GET /api/local/tasks", { query: { chat }, signal }),
  });
}

export function fetchTask(id: string): Promise<TaskSnapshot> {
  return call("GET /api/local/tasks/:id", { params: { id } });
}

/**
 * How many of the app's tasks turning Assistant Mode off stops, read afresh: every one that hasn't
 * ended, those waiting on the owner too. Null when they can't be counted.
 */
export function stoppedByTurningOff(queryClient: QueryClient): Promise<number | null> {
  return queryClient.fetchQuery({ ...tasksQuery, staleTime: 0 }).then(
    ({ tasks }) => tasks.filter((task) => !ended(task.status)).length,
    () => null,
  );
}

/** A snapshot an answer brought, in every list holding it, until the next read. */
function remember(queryClient: QueryClient, task: TaskSnapshot): void {
  const replace = (list: TasksResponse | undefined) =>
    list === undefined
      ? list
      : { tasks: list.tasks.map((entry) => (entry.id === task.id ? task : entry)) };
  queryClient.setQueryData(tasksQuery.queryKey, replace);
  if (task.chat !== undefined) {
    queryClient.setQueryData(chatTasksQuery(task.chat.id).queryKey, replace);
  }
}

const mutationKey = (id: string) => ["task", id] as const;

/**
 * An answer to task `id`: what it brings goes into the lists, and a refusal shows as a toast, the
 * lists read again since the task may have moved on.
 */
function useTaskMutation<T>(id: string, send: (input: T) => Promise<TaskSnapshot>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: mutationKey(id),
    mutationFn: send,
    onSuccess: (task) => remember(queryClient, task),
    onError: (error) => {
      toastError(error);
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useApproveTask(id: string) {
  return useTaskMutation(id, (body: TaskApproveRequest) =>
    call("POST /api/local/tasks/:id/approve", { params: { id }, body }),
  );
}

export function useContinueTask(id: string) {
  return useTaskMutation(id, (body: TaskContinueRequest) =>
    call("POST /api/local/tasks/:id/continue", { params: { id }, body }),
  );
}

/** The card's Stop: a live task comes back cancelled. */
export function useStopTask(id: string) {
  return useTaskMutation<void>(id, () => call("DELETE /api/local/tasks/:id", { params: { id } }));
}

/** An answer to task `id` is on its way, from its card or the waiting bar. */
export function useAnswering(id: string): boolean {
  return useIsMutating({ mutationKey: mutationKey(id) }) > 0;
}
