// The Tasks list: what she is working on and has done, read-only. Each row opens its chat at the
// task's card, where its answers and Stop are.

import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { ListTodoIcon, SettingsIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { PersonaAvatar } from "@/components/avatar";
import { EmptyState } from "@/components/empty-state";
import { ListCard, ListRow } from "@/components/list";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime, shortDate } from "@/features/chats/format";
import { type ChatPersona, usePersonaOf } from "@/features/chats/persona";
import { chatsQuery } from "@/features/chats/queries";
import { ApiError, type AssistantStatus, type TaskSnapshot } from "@/lib/api";
import { formatSpend } from "@/lib/format";
import { errorMessage } from "@/lib/labels";
import { useNow } from "@/lib/use-now";
import { useLang } from "@/locales/i18n";
import { useWaitingText } from "./cards";
import { ASSISTANT_SETTINGS, ModelText, StatusBadge } from "./parts";
import { tasksQuery } from "./queries";
import { listOrder, RUNNING_POLL_MS } from "./state";

/** A list's ages move on about this often. */
const CLOCK_MS = 30_000;

/** Its chat, at its card. */
export function taskInChatPath(chat: string, task: string): string {
  return `/chats/${encodeURIComponent(chat)}?task=${encodeURIComponent(task)}`;
}

/** What keeps tasks from starting while Assistant Mode is on, with the way to Settings. */
function NotReadyNotice({ assistant }: { readonly assistant: AssistantStatus }) {
  const { t } = useLingui();
  if (!assistant.enabled || assistant.ready) return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-xl border bg-card p-4 sm:px-6"
    >
      <div className="flex min-w-0 flex-1 basis-72 items-start gap-3.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-warning/10 text-warning [&_svg]:size-4">
          <TriangleAlertIcon aria-hidden />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5 pt-1.5 text-sm">
          <p className="font-medium leading-5">{t`Tasks can't start yet`}</p>
          <p className="text-muted-foreground">{t`Choose the account and model tasks run on in Settings, and add a key for that account.`}</p>
          {assistant.problem && (
            <p className="wrap-anywhere text-muted-foreground text-xs">{assistant.problem}</p>
          )}
        </div>
      </div>
      <Button variant="outline" asChild className="ml-auto">
        <Link to={ASSISTANT_SETTINGS}>
          <SettingsIcon />
          {t`Open Settings`}
        </Link>
      </Button>
    </div>
  );
}

function Dot() {
  return (
    <span aria-hidden className="text-muted-foreground/50">
      ·
    </span>
  );
}

function TaskRow({
  task,
  chat,
  persona,
  now,
}: {
  readonly task: TaskSnapshot;
  /** Its chat's name: null once the chat is deleted, undefined while the chats load. */
  readonly chat: string | null | undefined;
  readonly persona: ChatPersona | null;
  readonly now: number;
}) {
  const { t } = useLingui();
  const lang = useLang();
  const waiting = useWaitingText()(task);
  const age = relativeTime(task.createdAt, now, lang);
  const started = new Date(task.createdAt).toISOString();
  const spent = formatSpend(task.spentUsd, lang);
  return (
    <ListRow
      href={
        chat === null || task.chat === undefined ? undefined : taskInChatPath(task.chat.id, task.id)
      }
      leading={
        persona === null ? (
          <span className="flex size-8 items-center justify-center rounded-full border bg-muted/40">
            <ListTodoIcon aria-hidden className="size-4" />
          </span>
        ) : (
          <PersonaAvatar persona={persona} size="sm" />
        )
      }
      title={<span className="line-clamp-2 whitespace-pre-line">{task.brief.goal}</span>}
      description={
        <span className="flex flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
            {persona !== null && <span>{persona.name}</span>}
            {persona !== null && chat !== undefined && <Dot />}
            {chat !== undefined && (
              <span className="min-w-0 break-all">{chat ?? t`Chat deleted`}</span>
            )}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
            <span className="sr-only">{t`Folder`} </span>
            <span className="wrap-anywhere font-mono">{task.brief.folder}</span>
            <Dot />
            <span className="sr-only">{t`Model`} </span>
            <ModelText model={task.model} />
          </span>
          {waiting !== null && (
            <span className="wrap-anywhere text-warning text-xs" data-waiting-for>
              {waiting}
            </span>
          )}
          <span className="flex flex-wrap items-center gap-x-3 text-xs md:hidden">
            <time dateTime={started}>{age}</time>
            <span className="tabular-nums">{spent}</span>
          </span>
        </span>
      }
      trailing={
        <>
          <div className="flex flex-wrap items-center justify-end gap-1.5 md:w-36">
            <StatusBadge status={task.status} />
          </div>
          <div className="hidden w-28 flex-col items-end gap-0.5 md:flex">
            <time dateTime={started} className="text-muted-foreground text-sm">
              <span className="sr-only">{t`Started`} </span>
              {age}
            </time>
            <span className="text-muted-foreground text-xs tabular-nums">
              <span className="sr-only">{t`Spent`} </span>
              {spent}
            </span>
          </div>
        </>
      }
    />
  );
}

function ListSkeleton() {
  const { t } = useLingui();
  return (
    <div className="overflow-hidden rounded-xl border bg-card" role="status" aria-busy="true">
      <span className="sr-only">{t`Loading…`}</span>
      {["a", "b", "c"].map((key) => (
        <div
          key={key}
          className="flex min-h-16 items-center gap-4 border-b px-4 py-3 last:border-b-0 sm:px-6"
        >
          <Skeleton className="size-8 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3.5 w-64" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function TasksList({ assistant }: { readonly assistant: AssistantStatus }) {
  const { t } = useLingui();
  const lang = useLang();
  // The nav polls the list while any task is live; this page adds a faster pace while one runs.
  const { data, error, isPending } = useQuery({
    ...tasksQuery,
    refetchInterval: (read) =>
      read.state.data?.tasks.some((task) => task.status === "running") ? RUNNING_POLL_MS : false,
  });
  const chats = useQuery(chatsQuery).data;
  const personaOf = usePersonaOf();
  const now = useNow(true, CLOCK_MS);
  const tasks = useMemo(() => listOrder(data?.tasks ?? []), [data]);

  /**
   * A task's chat's name, as the chat list gives it: null when it is gone, undefined while the chats
   * load, when a row links anyway, since a deleted chat's page says so.
   */
  const chatOf = (task: TaskSnapshot): string | null | undefined => {
    if (task.chat === undefined) return null;
    if (chats === undefined) return undefined;
    const chat = chats.find((entry) => entry.id === task.chat?.id);
    if (chat === undefined) return null;
    // Her name is beside it, so an untitled chat goes by the day it started.
    return chat.title ?? shortDate(chat.createdAt, lang, now);
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={t`Tasks`}
        description={t`Work she does on this computer when you ask her in a chat, such as writing a page or sorting files. Each row opens its chat at the task, where you answer what it asks.`}
      />
      <NotReadyNotice assistant={assistant} />
      {error && !(error instanceof ApiError && error.status === 401) && (
        <Alert variant="destructive">
          <AlertTitle>{t`Couldn't load the tasks`}</AlertTitle>
          <AlertDescription>
            {t(errorMessage(error))}
            {error instanceof ApiError && <span className="block text-xs">{error.message}</span>}
          </AlertDescription>
        </Alert>
      )}
      {isPending && <ListSkeleton />}
      {data && tasks.length === 0 && (
        <EmptyState
          icon={<ListTodoIcon />}
          title={t`No tasks yet`}
          description={t`Ask her in a chat to do something on this computer, and the task shows here while she works on it.`}
        />
      )}
      {tasks.length > 0 && (
        <ListCard label={t`Tasks`}>
          {tasks.map((task) => {
            const chat = chatOf(task);
            return (
              <TaskRow
                key={task.id}
                task={task}
                chat={chat}
                persona={task.chat === undefined ? null : personaOf(task.chat.persona)}
                now={now}
              />
            );
          })}
        </ListCard>
      )}
    </div>
  );
}
