import { msg, ph, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrainIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ErrorAlert } from "@/components/error-alert";
import { ListCard, ListRow } from "@/components/list";
import { SectionCard } from "@/components/section-card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { CopyCommand } from "@/features/setup/copy-command";
import { QDRANT_COMMAND } from "@/features/setup/wizard";
import { call, type MemoryStatus, type Status } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { useLang } from "@/locales/i18n";
import { MEMORIES_SHOWN, memoryView, shownMemories } from "./memory";
import { formatsFor } from "./readiness";
import { HomeSection } from "./section";

function memoriesQuery(persona: string) {
  return queryOptions({
    queryKey: ["memories", persona],
    queryFn: ({ signal }) => call("GET /api/local/memories", { query: { persona }, signal }),
    // A 503 is Qdrant down, which the panel says at once instead of retrying.
    retry: false,
  });
}

const VIEWS = {
  off: {
    body: msg`Memory is off, so she forgets you after every call. It needs Qdrant, a database you run in Docker on this machine. Run this once in a terminal, then turn memory on:`,
    note: msg`Optional: calls work without it.`,
  },
  down: {
    body: msg`Qdrant isn't answering, so she can't remember or recall anything for now. Start Docker, or start Qdrant if it isn't running:`,
    note: msg`Calls go on without memory meanwhile.`,
  },
};

function QdrantHelp({
  view,
  retrying,
  onRetry,
}: {
  readonly view: "off" | "down";
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  const { t } = useLingui();
  return (
    <SectionCard
      note={t(VIEWS[view].note)}
      actions={
        view === "off" ? (
          <Button asChild>
            <Link to="/setup?step=memory">{t`Turn On Memory`}</Link>
          </Button>
        ) : (
          <>
            <Button variant="outline" asChild>
              <Link to="/setup?step=memory">{t`Check the Address`}</Link>
            </Button>
            <Button disabled={retrying} onClick={onRetry}>
              {retrying && <Spinner />}
              {t`Try Again`}
            </Button>
          </>
        )
      }
    >
      <p className="text-sm">{t(VIEWS[view].body)}</p>
      <CopyCommand command={QDRANT_COMMAND} />
    </SectionCard>
  );
}

function ForgetButton({
  name,
  count,
  pending,
  onForget,
}: {
  readonly name: string;
  readonly count: number;
  readonly pending: boolean;
  readonly onForget: () => void;
}) {
  const { t } = useLingui();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" disabled={pending || count === 0}>
          {pending ? <Spinner /> : <Trash2Icon />}
          {t`Forget Everything`}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Make ${name} forget you?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`${plural(count, { one: `This deletes the # memory ${name} keeps of you, for good. Other personas keep theirs.`, other: `This deletes all # memories ${name} keeps of you, for good. Other personas keep theirs.` })}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t`Keep Them`}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onForget}>
            {t`Forget`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** What the active persona remembers of the viewer, and a way to make her forget it all. */
export function MemoryPanel({
  persona,
  memory,
}: {
  readonly persona: Status["persona"];
  readonly memory: MemoryStatus;
}) {
  const { t } = useLingui();
  const lang = useLang();
  const formats = useMemo(() => formatsFor(lang), [lang]);
  const queryClient = useQueryClient();
  const query = memoriesQuery(persona.id);
  const list = useQuery({ ...query, enabled: memory.configured });
  const [all, setAll] = useState(false);
  const name = persona.shortName || persona.name;
  const forget = useMutation({
    // Named rather than left to the server's active one, which another tab can switch meanwhile.
    mutationFn: () => call("DELETE /api/local/memories", { query: { persona: persona.id } }),
    onSuccess: async () => {
      toast.success(t`${name} forgot you.`);
      await queryClient.invalidateQueries({ queryKey: query.queryKey });
    },
    onError: toastError,
  });
  const view = memoryView(memory, list);
  const memories = useMemo(() => shownMemories(list.data?.memories ?? []), [list.data]);
  const shown = all ? memories : memories.slice(0, MEMORIES_SHOWN);
  const count = list.data?.count ?? 0;

  return (
    <HomeSection
      title={t`What ${name} Remembers about You`}
      description={t`She picks these up in your calls, and only she reads them: each persona remembers on her own.`}
      actions={
        view === "list" && (
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t`Refresh`}
              disabled={list.isFetching}
              onClick={() => void list.refetch()}
            >
              <RefreshCwIcon className={list.isFetching ? "animate-spin" : undefined} />
            </Button>
            <ForgetButton
              name={name}
              count={count}
              pending={forget.isPending}
              onForget={() => forget.mutate()}
            />
          </>
        )
      }
    >
      {(view === "off" || view === "down") && (
        <QdrantHelp view={view} retrying={list.isFetching} onRetry={() => void list.refetch()} />
      )}
      {view === "loading" && (
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-6">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      )}
      {view === "failed" && <ErrorAlert error={list.error} />}
      {view === "list" &&
        (memories.length === 0 ? (
          <EmptyState
            icon={<BrainIcon />}
            title={t`No memories yet`}
            description={t`${name} starts remembering you from your next call.`}
          />
        ) : (
          <ListCard
            label={t`What ${name} Remembers`}
            header={t`Memories: ${ph({ count: formats.count(count) })}`}
          >
            {shown.map((entry) => {
              const when = entry.updated_at ?? entry.created_at;
              return (
                <ListRow
                  key={entry.id ?? entry.memory}
                  className="min-h-0"
                  title={<span className="font-normal">{entry.memory}</span>}
                  description={when ? formats.date(when) : undefined}
                />
              );
            })}
            {shown.length < memories.length && (
              <li className="flex justify-center px-4 py-2 sm:px-6">
                <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
                  {t`Show All ${ph({ count: formats.count(memories.length) })}`}
                </Button>
              </li>
            )}
          </ListCard>
        ))}
    </HomeSection>
  );
}
