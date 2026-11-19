// A task's card in the chat log, at her start_task call: what it works on and where, its state,
// the commands it runs in the background, what she passed on that it hasn't read, what it asks the
// owner, its plan, its latest step and the files it wrote, its steps on demand or as the chat's
// display opens them, and Stop. Every button a task has is here or on the waiting bar.

import type { ChatDisplay } from "@eidolon/chat";
import { ph, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon, ListTodoIcon, SquareIcon, TerminalIcon } from "lucide-react";
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
import type { BackgroundCommand, TaskSnapshot, TasksResponse } from "@/lib/api";
import { formatClock, formatDuration } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useLang } from "@/locales/i18n";
import { TaskPrompt } from "./cards";
import { PROFILE_LABELS } from "./labels";
import {
  CommandLine,
  FileList,
  ModelText,
  QueuedLines,
  SpendText,
  StatusBadge,
  TodoList,
} from "./parts";
import { chatTasksQuery, useAnswering, useChatTask, useStopTask } from "./queries";
import { ended, followsSteps, keepsLiveSteps, offers, stepsShown } from "./state";
import { latestStep, toolState } from "./transcript";
import { TranscriptLog } from "./transcript-view";
import { useTaskEvents } from "./use-task-events";

/** Whether task `id` is the newest running one, whose card follows it with its steps closed. */
function useNewest(chat: string, id: string): boolean {
  const select = useCallback((data: TasksResponse) => followsSteps(id, data.tasks, false), [id]);
  return useQuery({ ...chatTasksQuery(chat), select, refetchOnMount: false }).data ?? false;
}

function Meta({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/**
 * The commands it left running past their calls: each one, how long it has run, and when its
 * timeout stops it. Its own clock, so the rest of the card doesn't render each second.
 */
function BackgroundCommands({ commands }: { readonly commands: readonly BackgroundCommand[] }) {
  const { t } = useLingui();
  const lang = useLang();
  const now = useNow(true);
  return (
    <section className="flex flex-col gap-1.5" data-background>
      <h3 className="font-medium text-muted-foreground text-xs">{t`In the Background`}</h3>
      <ul className="flex flex-col gap-1">
        {commands.map((command) => (
          <li key={command.id} className="flex min-w-0 items-center gap-2 text-xs">
            <TerminalIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <CommandLine command={command.command} />
            <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
              {formatDuration((now - command.startedAt) / 1000)}
              {" · "}
              {t`Stops at ${ph({ time: formatClock(command.endsAt, lang) })}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Its MCP servers that didn't start, and the tools of theirs it was given none of. */
function McpNotes({ mcp }: { readonly mcp: NonNullable<TaskSnapshot["mcp"]> }) {
  const { t } = useLingui();
  const failed = mcp.failed ?? [];
  const left = mcp.left ?? [];
  if (failed.length === 0 && left.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-muted-foreground text-xs" data-mcp-notes>
      {failed.map(({ server, error }) => (
        <li key={`failed:${server ?? ""}:${error}`} className="wrap-anywhere">
          {server === undefined
            ? t`This task works without MCP servers: ${ph({ error })}`
            : t`${ph({ server })} didn't start, so this task works without it: ${ph({ error })}`}
        </li>
      ))}
      {left.map(({ server, count }) => (
        <li key={`left:${server}`} className="wrap-anywhere">
          {t`${plural(ph({ count }), { one: `# of ${ph({ server })}'s tools was left out: list the ones tasks need in its tools in mcp.json.`, other: `# of ${ph({ server })}'s tools were left out: list the ones tasks need in its tools in mcp.json.` })}`}
        </li>
      ))}
    </ul>
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

export function TaskCard({
  chatId,
  item,
  display,
}: {
  readonly chatId: string;
  readonly item: TaskItem;
  /** The chat's display; null while it isn't known. */
  readonly display: ChatDisplay | null;
}) {
  const { t } = useLingui();
  const titleId = useId();
  const task = useChatTask(chatId, item.task);
  const running = task?.status === "running";
  const newest = useNewest(chatId, item.task);
  // The owner's Show Steps or Hide Steps holds until the display changes.
  const [toggle, setToggle] = useState<{
    readonly display: ChatDisplay | null;
    readonly open: boolean;
  } | null>(null);
  if (toggle !== null && toggle.display !== display) setToggle(null);
  const chosen = toggle !== null && toggle.display === display ? toggle.open : null;
  const [live, setLive] = useState(false);
  const shownLive = keepsLiveSteps(live, { display, newest, running });
  if (shownLive !== live) setLive(shownLive);
  const open = stepsShown({ display, chosen, newest, shownLive });
  const follows = open || newest;
  const events = useTaskEvents(item.task, running, follows);
  const step = running && follows ? latestStep(events.view) : null;
  const status = task?.status ?? item.call.final?.result.status ?? null;
  const goal = task?.brief.goal ?? item.call.goal ?? "";
  const folder = task?.brief.folder ?? item.call.folder;
  const written = task?.files.written ?? item.call.final?.result.files ?? [];
  const moreWritten = task === undefined ? (item.call.final?.result.moreFiles ?? 0) : 0;
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
          {task?.profile !== undefined && (
            <Meta label={t`Kind`}>
              <span data-profile={task.profile}>{t(PROFILE_LABELS[task.profile])}</span>
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
                <span className="shrink-0 font-medium font-mono">{step.label}</span>
                <span className="truncate font-mono text-muted-foreground">{step.head}</span>
              </span>
            </Meta>
          )}
        </dl>
        {task !== undefined && !ended(task.status) && (task.background?.length ?? 0) > 0 && (
          <BackgroundCommands commands={task.background ?? []} />
        )}
        {task?.mcp !== undefined && <McpNotes mcp={task.mcp} />}
        {failure !== null && <p className="break-words text-destructive text-xs">{failure}</p>}
        {task?.denied && (
          <p className="text-muted-foreground text-xs">{t`You denied it when it asked to start.`}</p>
        )}
        {task !== undefined && <QueuedLines task={task} />}
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
              <FileList folder={folder ?? ""} files={written} more={moreWritten} />
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
          onClick={() => setToggle({ display, open: !open })}
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
