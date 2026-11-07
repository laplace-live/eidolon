import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  CircleXIcon,
  CornerDownRightIcon,
  HistoryIcon,
  RefreshCwIcon,
  SearchXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Link, useNavigate } from "react-router";
import { PersonaAvatar } from "@/components/avatar";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { SectionCard, SectionCardSkeleton } from "@/components/section-card";
import { personasQuery } from "@/components/settings-form/queries";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, errorKey, type JobSnapshot, stream } from "@/lib/api";
import { formatDateTime, formatDuration, formatUsd } from "@/lib/format";
import { useLang, useT } from "@/lib/i18n";
import { costSoFar, type JobView, type Outcome, runSummary, shownOutcome } from "@/lib/jobs";
import { studioPath } from "@/lib/paths";
import { cn } from "@/lib/utils";
import {
  CancelJobButton,
  Elapsed,
  Failures,
  JobLog,
  OutcomeBadge,
  ResumeJobButton,
  RunningItems,
  StageList,
} from "./parts";
import { jobQuery } from "./queries";
import { canResume } from "./resume";
import { showsStop, stopOffer } from "./stopping";
import { type JobEvents, useJobEvents } from "./use-job-events";

/** How much of a long stderr log the page shows: its end, where a crash is. */
const LOG_TAIL_CHARS = 200_000;

/** A card's body content that runs to its edges, under a rule, like a terminal pane. */
const FLUSH = "-mx-6 -mb-6 rounded-none border-0 border-t";

function BackLink() {
  const t = useT();
  return (
    <Link
      to="/jobs"
      className="inline-flex items-center gap-1.5 self-start rounded-md text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <ArrowLeftIcon className="size-4" />
      {t("jobs.back")}
    </Link>
  );
}

function Meta({
  label,
  className,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="min-w-0 font-medium text-sm">{children}</dd>
    </div>
  );
}

function Options({ options }: { readonly options: JobSnapshot["options"] }) {
  const t = useT();
  const entries = Object.entries(options);
  if (entries.length === 0) return null;
  return (
    <Meta label={t("jobs.meta.options")} className="col-span-full">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-normal text-xs">
        {entries.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground">{key}</dt>
            <dd className="break-all font-mono">
              {typeof value === "string" ? value : JSON.stringify(value)}
            </dd>
          </div>
        ))}
      </dl>
    </Meta>
  );
}

/** Why a failed or crashed run didn't finish, at the top of its card. */
function Failure({
  job,
  outcome,
  view,
}: {
  readonly job: JobSnapshot;
  readonly outcome: Outcome;
  readonly view: JobView;
}) {
  const t = useT();
  if (outcome !== "failed" && outcome !== "crashed") return null;
  const crashed = outcome === "crashed";
  const Icon = crashed ? TriangleAlertIcon : CircleXIcon;
  return (
    <div className="flex gap-3">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="font-medium text-destructive text-sm">
            {t(crashed ? "jobs.crashed.title" : "jobs.failed.title")}
          </p>
          {crashed && <p className="text-muted-foreground text-sm">{t("jobs.crashed.body")}</p>}
        </div>
        {crashed ? (
          job.stderrTail.trim() !== "" && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 px-4 py-3 font-mono text-xs">
              {job.stderrTail}
            </pre>
          )
        ) : (
          <Failures view={view} job={job} />
        )}
      </div>
    </div>
  );
}

/** Two lines: what happened, then what to do about it. */
function Note({ title, body }: { readonly title: string; readonly body?: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium text-foreground">{title}</span>
      {body && <span>{body}</span>}
    </span>
  );
}

/**
 * Who the job is for and what it took, with why it stopped short when it did; its footer says
 * what the page can do about it, beside the button that does.
 */
function Overview({
  job,
  outcome,
  events,
}: {
  readonly job: JobSnapshot;
  readonly outcome: Outcome;
  readonly events: JobEvents;
}) {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const { data: personas } = useQuery(personasQuery);
  const persona = personas?.personas.find((entry) => entry.id === job.persona) ?? {
    id: job.persona,
    name: job.persona,
    shortName: "",
  };
  const summary = runSummary(events.view, job.command);
  const cost = summary?.costUsd ?? costSoFar(events.view) ?? job.costUsd;
  const offer = stopOffer(job);
  const resumable = canResume(job, outcome);
  const failed = outcome === "failed" || outcome === "crashed";

  let note: ReactNode;
  if (offer === "earlier-run") {
    note = <Note title={t("jobs.earlierRun.title")} body={t("jobs.earlierRun.body")} />;
  } else if (offer !== null) {
    note = t(job.stopping ? "jobs.note.stopping" : "jobs.note.running");
  } else if (outcome === "interrupted") {
    note = (
      <Note
        title={t("jobs.interrupted.title")}
        body={resumable ? t("jobs.interrupted.body") : undefined}
      />
    );
  } else if (resumable) {
    note = t(outcome === "cancelled" ? "jobs.cancelled.body" : "jobs.resumeNote");
  }
  const actions = showsStop(job) ? (
    <CancelJobButton job={job} size="default" />
  ) : resumable ? (
    <ResumeJobButton
      id={job.id}
      size="default"
      onResumed={(next) => {
        if (next.id !== job.id) navigate(`/jobs/${encodeURIComponent(next.id)}`);
      }}
    />
  ) : undefined;

  return (
    <SectionCard tone={failed ? "danger" : "default"} note={note} actions={actions}>
      <Failure job={job} outcome={outcome} view={events.view} />
      <dl
        className={cn("grid grid-cols-2 gap-x-6 gap-y-5 lg:grid-cols-4", failed && "border-t pt-6")}
      >
        <Meta label={t("jobs.meta.persona")}>
          <Link
            to={studioPath(job.persona)}
            className="inline-flex max-w-full items-center gap-2 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <PersonaAvatar persona={persona} size="xs" />
            <span className="truncate">{persona.name}</span>
          </Link>
        </Meta>
        <Meta label={t("jobs.meta.started")}>
          <time dateTime={job.startedAt}>{formatDateTime(job.startedAt, lang)}</time>
        </Meta>
        <Meta label={t("jobs.meta.duration")}>
          <span className="tabular-nums">
            <Elapsed start={job.startedAt} end={job.endedAt} ticking={job.status === "running"} />
          </span>
        </Meta>
        <Meta label={t(summary ? "jobs.meta.cost" : "jobs.meta.costSoFar")}>
          <span className="tabular-nums">
            {cost === null || cost === undefined ? "—" : formatUsd(cost, lang)}
          </span>
          {summary?.costSource === "unpriced" && (
            <span className="block font-normal text-muted-foreground text-xs">
              {t("jobs.meta.unpriced")}
            </span>
          )}
        </Meta>
        <Options options={job.options} />
      </dl>
      {(job.resumedFrom || job.resumedBy) && (
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {job.resumedFrom && (
            <Link
              to={`/jobs/${encodeURIComponent(job.resumedFrom)}`}
              className="inline-flex items-center gap-1.5 text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              <HistoryIcon aria-hidden className="size-4" />
              {t("jobs.resumedFrom")}
            </Link>
          )}
          {job.resumedBy && (
            <Link
              to={`/jobs/${encodeURIComponent(job.resumedBy)}`}
              className="inline-flex items-center gap-1.5 text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              <CornerDownRightIcon aria-hidden className="size-4" />
              {t("jobs.resumedBy")}
            </Link>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function Entries({ view }: { readonly view: JobView }) {
  const t = useT();
  if (view.entries.length === 0) return null;
  return (
    <SectionCard title={t("jobs.entries.title", { count: view.entries.length })}>
      <ul className={cn(FLUSH, "divide-y")}>
        {view.entries.map((entry) => (
          <li key={`${entry.id}:${entry.url}`} className="flex items-center gap-4 px-6 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-medium text-sm">{entry.title ?? entry.url}</span>
              <span className="truncate font-mono text-muted-foreground text-xs">{entry.id}</span>
            </div>
            <span className="shrink-0 text-muted-foreground text-sm tabular-nums">
              <span className="sr-only">{t("jobs.entries.length")} </span>
              {entry.durationSec === undefined ? "—" : formatDuration(entry.durationSec)}
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

/** The command's own output, read only once asked for: it can run to megabytes. */
function TechnicalLog({ id, running }: { readonly id: string; readonly running: boolean }) {
  const t = useT();
  const content = useId();
  const [open, setOpen] = useState(false);
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["jobs", id, "log"],
    queryFn: async ({ signal }) =>
      new Response(await stream("GET /api/local/jobs/:id/log", { params: { id }, signal })).text(),
    enabled: open,
    refetchInterval: open && running ? 5000 : false,
  });
  return (
    <SectionCard
      title={t("jobs.stderr.title")}
      description={t("jobs.stderr.description")}
      action={
        <>
          {open && (
            <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCwIcon className={isFetching ? "animate-spin" : undefined} />
              {t("jobs.stderr.refresh")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            aria-expanded={open}
            aria-controls={open ? content : undefined}
            onClick={() => setOpen(!open)}
          >
            <ChevronDownIcon className={open ? "rotate-180" : undefined} />
            {t(open ? "jobs.stderr.hide" : "jobs.stderr.show")}
          </Button>
        </>
      }
    >
      {open &&
        (error ? (
          <p id={content} className="text-destructive text-sm">
            {t(errorKey(error))}
          </p>
        ) : (
          <pre
            id={content}
            className={cn(
              FLUSH,
              "max-h-96 overflow-auto whitespace-pre-wrap break-words bg-muted/40 px-6 py-4 font-mono text-xs leading-relaxed",
            )}
          >
            {data === undefined
              ? t("jobs.stderr.loading")
              : data.trim() === ""
                ? t("jobs.stderr.empty")
                : data.slice(-LOG_TAIL_CHARS)}
          </pre>
        ))}
    </SectionCard>
  );
}

function NotFound() {
  const t = useT();
  return (
    <EmptyState
      icon={<SearchXIcon />}
      title={t("jobs.notFound.title")}
      description={t("jobs.notFound.body")}
      action={
        <Button variant="outline" asChild>
          <Link to="/jobs">
            <ArrowLeftIcon />
            {t("jobs.back")}
          </Link>
        </Button>
      }
    />
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <SectionCardSkeleton rows={1} footer={false} />
      <SectionCardSkeleton rows={1} footer={false} />
    </div>
  );
}

export function JobDetail({ id }: { readonly id: string }) {
  const t = useT();
  const { data: job, error } = useQuery(jobQuery(id));
  const events = useJobEvents(id);
  const [endedWhenShown, setEndedWhenShown] = useState<boolean | null>(null);
  if (job && endedWhenShown === null) setEndedWhenShown(job.status !== "running");

  // An id the server never minted is refused before it is looked up.
  if (error instanceof ApiError && (error.status === 404 || error.status === 400)) {
    return (
      <div className="flex flex-col gap-8">
        <BackLink />
        <NotFound />
      </div>
    );
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t("jobs.loadFailed")}</AlertTitle>
        <AlertDescription>{t(errorKey(error))}</AlertDescription>
      </Alert>
    );
  }
  if (!job) return <DetailSkeleton />;

  const outcome = shownOutcome(job, events.ended, endedWhenShown ?? false);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <BackLink />
        <PageHeader
          title={t(`jobs.command.${job.command}`)}
          badges={<OutcomeBadge outcome={outcome} />}
          description={t(`jobs.about.${job.command}`)}
        />
      </div>

      <Overview job={job} outcome={outcome} events={events} />

      <SectionCard title={t("jobs.stages.title")}>
        {events.view.stages.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {outcome === "running" ? t("jobs.stages.waiting") : t("jobs.stages.none")}
          </p>
        ) : (
          <StageList view={events.view} />
        )}
        {outcome === "running" && <RunningItems view={events.view} />}
      </SectionCard>

      {job.command === "expand" && <Entries view={events.view} />}

      <SectionCard title={t("jobs.log.title")} description={t("jobs.log.description")}>
        <JobLog view={events.view} className={cn(FLUSH, "max-h-[28rem] px-6 py-4")} />
      </SectionCard>

      <TechnicalLog id={job.id} running={job.status === "running"} />
    </div>
  );
}
