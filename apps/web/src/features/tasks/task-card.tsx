// A task's card in the chat log, at her start_task call: what it works on and where, its state,
// what it asks the owner, its plan, its latest step and the files it wrote, its steps on demand,
// and Stop. Every button a task has is here or on the waiting bar.

import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon, ListTodoIcon, SquareIcon } from "lucide-react";
import { type ReactNode, useCallback, useId, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { TaskItem } from "@/features/chats/items";
import type { TaskSnapshot, TasksResponse } from "@/lib/api";
import { cn } from "@/lib/utils";
import { TaskPrompt } from "./cards";
import { FileList, ModelText, SpendText, StatusBadge, TodoList } from "./parts";
import { chatTasksQuery, useAnswering, useStopTask } from "./queries";
import { followsSteps, offers } from "./state";
import { latestStep, toolState } from "./transcript";
import { TranscriptLog } from "./transcript-view";
import { useTaskEvents } from "./use-task-events";

/** One of the chat's tasks, as the chat's page last read them. */
function useChatTask(chat: string, id: string): TaskSnapshot | undefined {
  const select = useCallback(
    (data: TasksResponse) => data.tasks.find((task) => task.id === id),
    [id],
  );
  // The chat's page polls the list; a card only reads it.
  return useQuery({ ...chatTasksQuery(chat), select, refetchOnMount: false }).data;
}

/** Whether task `id`'s card follows its transcript, as followsSteps decides. */
function useFollows(chat: string, id: string, open: boolean): boolean {
  const select = useCallback(
    (data: TasksResponse) => followsSteps(id, data.tasks, open),
    [id, open],
  );
  return useQuery({ ...chatTasksQuery(chat), select, refetchOnMount: false }).data ?? open;
}

function Meta({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function StopButton({ task }: { readonly task: TaskSnapshot }) {
  const { t } = useLingui();
  const stop = useStopTask(task.id);
  const busy = useAnswering(task.id);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={busy} data-action="stop">
          {stop.isPending ? <Spinner /> : <SquareIcon />}
          {t`Stop`}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Stop this task?`}</AlertDialogTitle>
          <AlertDialogDescription>{t`It stops at once and can't go on afterwards. The files it already wrote stay.`}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t`Keep It`}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => stop.mutate()}>
            {t`Stop Task`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function TaskCard({ chatId, item }: { readonly chatId: string; readonly item: TaskItem }) {
  const { t } = useLingui();
  const titleId = useId();
  const task = useChatTask(chatId, item.task);
  const [open, setOpen] = useState(false);
  const running = task?.status === "running";
  const follows = useFollows(chatId, item.task, open);
  const events = useTaskEvents(item.task, running, follows);
  const step = running && follows ? latestStep(events.view) : null;
  const status = task?.status ?? item.call.final?.result.status ?? null;
  const goal = task?.brief.goal ?? item.call.goal ?? "";
  const folder = task?.brief.folder ?? item.call.folder;
  const written = task?.files.written ?? item.call.final?.result.files ?? [];
  const failure = task?.outcome?.status === "failed" ? task.outcome.error : null;
  const offer = task === undefined ? null : offers(task);

  return (
    <article
      data-task={item.task}
      tabIndex={-1}
      aria-labelledby={titleId}
      className="w-full max-w-xl overflow-hidden rounded-xl border bg-card text-card-foreground text-sm outline-none transition-shadow data-flash:ring-[3px] data-flash:ring-ring/50"
    >
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <ListTodoIcon aria-hidden className="size-4" />
          </span>
          <p
            id={titleId}
            className="line-clamp-3 min-w-0 flex-1 whitespace-pre-line break-words pt-0.5 font-medium"
          >
            <span className="sr-only">{t`Task:`} </span>
            {goal}
          </p>
          {status === null ? (
            <Spinner className="mt-1 size-4 text-muted-foreground" />
          ) : (
            <StatusBadge status={status} />
          )}
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
          {folder !== null && (
            <Meta label={t`Folder`}>
              <span className="wrap-anywhere font-mono">{folder}</span>
            </Meta>
          )}
          {task !== undefined && (
            <>
              <Meta label={t`Model`}>
                <ModelText model={task.model} />
              </Meta>
              <Meta label={t`Spent`}>
                <SpendText task={task} />
              </Meta>
            </>
          )}
          {step !== null && (
            <Meta label={t`Latest Step`}>
              <span className="flex min-w-0 items-center gap-1.5" data-step={step.name}>
                {toolState(step, true) === "running" && <Spinner className="size-3 shrink-0" />}
                <span className="shrink-0 font-medium font-mono">{step.name}</span>
                <span className="truncate font-mono text-muted-foreground">{step.head}</span>
              </span>
            </Meta>
          )}
        </dl>
        {failure !== null && <p className="break-words text-destructive text-xs">{failure}</p>}
        {task?.denied && (
          <p className="text-muted-foreground text-xs">{t`You denied it when it asked to start.`}</p>
        )}
      </div>
      {task !== undefined && <TaskPrompt task={task} />}
      {((task?.todo?.length ?? 0) > 0 || written.length > 0) && (
        <div className="flex flex-col gap-3 border-t px-4 py-3">
          {task?.todo !== undefined && task.todo.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h3 className="font-medium text-muted-foreground text-xs">
                {t({ message: "Plan", context: "task plan" })}
              </h3>
              <TodoList items={task.todo} />
            </section>
          )}
          {written.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h3 className="font-medium text-muted-foreground text-xs">{t`Files Written`}</h3>
              <FileList folder={folder ?? ""} files={written} />
            </section>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 border-t bg-muted/40 px-2 py-1">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          data-action="steps"
          onClick={() => setOpen((shown) => !shown)}
        >
          <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
          {open ? t`Hide Steps` : t`Show Steps`}
        </Button>
        {offer?.stop && task !== undefined && <StopButton task={task} />}
      </div>
      {open && (
        <TranscriptLog
          rows={events.view.rows}
          running={running}
          loading={!events.loaded}
          className="border-t px-4 py-3"
        />
      )}
    </article>
  );
}
