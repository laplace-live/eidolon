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
import { useLang, useT } from "@/lib/i18n";
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

function QdrantHelp({
  view,
  retrying,
  onRetry,
}: {
  readonly view: "off" | "down";
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  const t = useT();
  return (
    <SectionCard
      note={t(`home.memory.${view}Note`)}
      actions={
        view === "off" ? (
          <Button asChild>
            <Link to="/setup?step=memory">{t("home.memory.setup")}</Link>
          </Button>
        ) : (
          <>
            <Button variant="outline" asChild>
              <Link to="/setup?step=memory">{t("home.memory.address")}</Link>
            </Button>
            <Button disabled={retrying} onClick={onRetry}>
              {retrying && <Spinner />}
              {t("home.memory.retry")}
            </Button>
          </>
        )
      }
    >
      <p className="text-sm">{t(`home.memory.${view}`)}</p>
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
  const t = useT();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" disabled={pending || count === 0}>
          {pending ? <Spinner /> : <Trash2Icon />}
          {t("home.memory.forget")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("home.memory.forgetTitle", { name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("home.memory.forgetBody", { name, count })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("home.memory.forgetKeep")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onForget}>
            {t("home.memory.forgetConfirm")}
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
  const t = useT();
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
      toast.success(t("home.memory.forgotten", { name }));
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
      title={t("home.memory.title", { name })}
      description={t("home.memory.description")}
      actions={
        view === "list" && (
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("home.memory.refresh")}
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
            title={t("home.memory.emptyTitle")}
            description={t("home.memory.empty", { name })}
          />
        ) : (
          <ListCard
            label={t("home.memory.label", { name })}
            header={t("home.memory.count", { count: formats.count(count) })}
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
                  {t("home.memory.showAll", { count: formats.count(memories.length) })}
                </Button>
              </li>
            )}
          </ListCard>
        ))}
    </HomeSection>
  );
}
