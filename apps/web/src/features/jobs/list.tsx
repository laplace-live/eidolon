import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { BookOpenIcon, TimerIcon, WorkflowIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { PersonaAvatar } from "@/components/avatar";
import { EmptyState } from "@/components/empty-state";
import { ListCard, ListRow } from "@/components/list";
import { PageHeader } from "@/components/page-header";
import { personasQuery } from "@/components/settings-form/queries";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ApiError, type JobSnapshot, type PersonaSummary } from "@/lib/api";
import { formatDateTime, formatUsd } from "@/lib/format";
import { jobOutcome } from "@/lib/jobs";
import { errorMessage } from "@/lib/labels";
import { studioPath } from "@/lib/paths";
import { statusQuery } from "@/lib/query";
import { useLang } from "@/locales/i18n";
import { stageName } from "./describe";
import { COMMAND_LABELS } from "./labels";
import { CancelJobButton, Elapsed, OutcomeBadge, ResumeJobButton } from "./parts";
import { jobsQuery } from "./queries";
import { canResume } from "./resume";
import { showsStop } from "./stopping";

/** The stage a snapshot is on, as `Transcribe 3/10`. */
function snapshotProgress(job: JobSnapshot): string {
  const stage = job.stages.at(-1);
  if (!stage) return "";
  const name = stageName(stage.stage);
  const finished = stage.done + stage.failed + stage.skipped;
  return stage.total === null ? name : `${name} ${finished}/${stage.total}`;
}

/** Cancel while it runs, Resume once it stopped short; a list leaves Force stop to the job's page. */
function RowAction({ job }: { readonly job: JobSnapshot }) {
  if (showsStop(job)) return <CancelJobButton job={job} forceStop={false} />;
  if (canResume(job, jobOutcome(job))) return <ResumeJobButton id={job.id} variant="outline" />;
  return null;
}

function Dot() {
  return (
    <span aria-hidden className="text-muted-foreground/50">
      ·
    </span>
  );
}

function JobRow({
  job,
  persona,
  actions,
}: {
  readonly job: JobSnapshot;
  readonly persona: Pick<PersonaSummary, "id" | "name" | "shortName">;
  /** Some row has a button, so each keeps a column for one. */
  readonly actions: boolean;
}) {
  const { t } = useLingui();
  const lang = useLang();
  const progress = snapshotProgress(job);
  const started = formatDateTime(job.startedAt, lang);
  const duration = (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <TimerIcon aria-hidden className="size-3.5" />
      <span className="sr-only">{t`Duration`} </span>
      <Elapsed start={job.startedAt} end={job.endedAt} ticking={job.status === "running"} />
    </span>
  );
  const cost = job.costUsd === null ? null : formatUsd(job.costUsd, lang);
  return (
    <ListRow
      href={`/jobs/${encodeURIComponent(job.id)}`}
      leading={<PersonaAvatar persona={persona} size="sm" />}
      title={t(COMMAND_LABELS[job.command])}
      description={
        <span className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-x-1.5">
            <span>{persona.name}</span>
            {progress && (
              <>
                <Dot />
                <span className="tabular-nums">{progress}</span>
              </>
            )}
          </span>
          <span className="flex flex-wrap items-center gap-x-3 md:hidden">
            <time dateTime={job.startedAt}>{started}</time>
            {duration}
            {cost && <span className="tabular-nums">{cost}</span>}
          </span>
        </span>
      }
      trailing={
        <>
          <div className="md:w-36">
            <OutcomeBadge outcome={jobOutcome(job)} />
          </div>
          <div className="hidden w-48 flex-col items-end gap-0.5 md:flex">
            <time dateTime={job.startedAt} className="text-muted-foreground text-sm">
              <span className="sr-only">{t`Started`} </span>
              {started}
            </time>
            <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
              {duration}
              {cost && (
                <>
                  <Dot />
                  <span className="tabular-nums">
                    <span className="sr-only">{t`Cost`} </span>
                    {cost}
                  </span>
                </>
              )}
            </span>
          </div>
          {actions && (
            <div className="flex justify-end md:w-28">
              <RowAction job={job} />
            </div>
          )}
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
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3.5 w-48" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function JobsList() {
  const { t } = useLingui();
  const { data: jobs, error, isPending } = useQuery(jobsQuery);
  const { data: personas } = useQuery(personasQuery);
  const { data: status } = useQuery(statusQuery);
  const [showEphemeral, setShowEphemeral] = useState(false);

  const shown = (jobs ?? [])
    .filter((job) => showEphemeral || !job.ephemeral)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const hidden = (jobs ?? []).filter((job) => job.ephemeral).length;
  const actions = shown.some((job) => job.status === "running" || canResume(job, jobOutcome(job)));
  // A persona deleted since keeps her id, and a monogram of it.
  const personaOf = (id: string) =>
    personas?.personas.find((persona) => persona.id === id) ?? { id, name: id, shortName: "" };
  const active = personas?.active ?? status?.persona.id;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={t`Jobs`}
        description={t`The offline work that builds each persona's knowledge. A job keeps running when you close this page.`}
        actions={
          (hidden > 0 || showEphemeral) && (
            <div className="flex items-center gap-2.5">
              <Switch
                id="jobs-ephemeral"
                checked={showEphemeral}
                onCheckedChange={setShowEphemeral}
              />
              <Label htmlFor="jobs-ephemeral" className="font-normal text-sm">
                {t`Show Plans and Link Checks (${ph({ count: hidden })})`}
              </Label>
            </div>
          )
        }
      />
      {error && !(error instanceof ApiError && error.status === 401) && (
        <Alert variant="destructive">
          <AlertTitle>{t`Couldn't load the jobs`}</AlertTitle>
          <AlertDescription>
            {t(errorMessage(error))}
            {error instanceof ApiError && <span className="block text-xs">{error.message}</span>}
          </AlertDescription>
        </Alert>
      )}
      {isPending && <ListSkeleton />}
      {jobs && shown.length === 0 && (
        <EmptyState
          icon={<WorkflowIcon />}
          title={t`No jobs yet`}
          description={t`They appear here when you index facts or add videos in a persona's studio.`}
          action={
            active !== undefined && (
              <Button variant="outline" asChild>
                <Link to={studioPath(active, "knowledge")}>
                  <BookOpenIcon />
                  {t`Open the Studio`}
                </Link>
              </Button>
            )
          }
        />
      )}
      {shown.length > 0 && (
        <ListCard label={t`Jobs`}>
          {shown.map((job) => (
            <JobRow key={job.id} job={job} persona={personaOf(job.persona)} actions={actions} />
          ))}
        </ListCard>
      )}
    </div>
  );
}
