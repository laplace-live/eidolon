import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ErrorAlert } from "@/components/error-alert";
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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { CopyCommand } from "@/features/setup/copy-command";
import { QDRANT_COMMAND } from "@/features/setup/wizard";
import { call, type MemoryStatus, type Status } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { useLang, useT } from "@/lib/i18n";
import { memoryView, shownMemories } from "./memory";
import { formatsFor } from "./readiness";

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
    <div className="flex flex-col gap-3">
      <p className="text-sm">{t(`home.memory.${view}`)}</p>
      <CopyCommand command={QDRANT_COMMAND} />
      <div className="flex flex-wrap gap-2">
        {view === "down" && (
          <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
            {retrying && <Spinner />}
            {t("home.memory.retry")}
          </Button>
        )}
        <Button variant="outline" size="sm" asChild>
          <Link to="/setup?step=memory">
            {t(view === "off" ? "home.memory.setup" : "home.memory.address")}
          </Link>
        </Button>
      </div>
    </div>
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
        <Button variant="outline" size="sm" disabled={pending || count === 0}>
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
  const count = list.data?.count ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("home.memory.title", { name })}</CardTitle>
        <CardDescription>{t("home.memory.description")}</CardDescription>
        {view === "list" && (
          <CardAction className="flex gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
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
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {(view === "off" || view === "down") && (
          <QdrantHelp view={view} retrying={list.isFetching} onRetry={() => void list.refetch()} />
        )}
        {view === "loading" && <Skeleton className="h-24" />}
        {view === "failed" && <ErrorAlert error={list.error} />}
        {view === "list" &&
          (memories.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("home.memory.empty", { name })}</p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground text-xs">
                {t("home.memory.count", { count: formats.count(count) })}
              </p>
              <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
                {memories.map((entry) => {
                  const when = entry.updated_at ?? entry.created_at;
                  return (
                    <li key={entry.id ?? entry.memory} className="flex flex-col gap-0.5 px-3 py-2">
                      <span className="break-words text-sm">{entry.memory}</span>
                      {when && (
                        <span className="text-muted-foreground text-xs">{formats.date(when)}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
