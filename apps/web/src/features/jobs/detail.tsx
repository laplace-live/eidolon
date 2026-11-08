import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
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
import { ApiError, type JobSnapshot, stream } from "@/lib/api";
import { formatDateTime, formatDuration, formatUsd } from "@/lib/format";
import { costSoFar, type JobView, type Outcome, runSummary, shownOutcome } from "@/lib/jobs";
import { errorMessage } from "@/lib/labels";
import { studioPath } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { useLang } from "@/locales/i18n";
import { COMMAND_ABOUT, COMMAND_LABELS } from "./labels";
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
  const { t } = useLingui();
  return (
    <Link
      to="/jobs"
      className="inline-flex items-center gap-1.5 self-start rounded-md text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <ArrowLeftIcon className="size-4" />
      {t`All Jobs`}
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
  const { t } = useLingui();
  const entries = Object.entries(options);
  if (entries.length === 0) return null;
  return (
    <Meta label={t`Options`} className="col-span-full">
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
  const { t } = useLingui();
  if (outcome !== "failed" && outcome !== "crashed") return null;
  const crashed = outcome === "crashed";
  const Icon = crashed ? TriangleAlertIcon : CircleXIcon;
  return (
    <div className="flex gap-3">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="font-medium text-destructive text-sm">
            {crashed ? t`This job stopped without finishing` : t`Some of the work failed`}
          </p>
          {crashed && (
            <p className="text-muted-foreground text-sm">{t`It ended before reporting a result. The end of its technical log usually says why.`}</p>
          )}
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
  const { t } = useLingui();
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
    note = (
      <Note
        title={t`Can't be stopped from here`}
        body={t`An earlier run of Eidolon started this job, so this one can't stop it. It will finish on its own, or be marked interrupted.`}
      />
    );
  } else if (offer !== null) {
    note = job.stopping
      ? t`It stops once it has finished what it is writing.`
      : t`It keeps running when you close this page.`;
  } else if (outcome === "interrupted") {
    note = (
      <Note
        title={t`Eidolon stopped while this job ran`}
        body={
          resumable
            ? t`Resume runs it again, and every stage skips the work it already finished.`
            : undefined
        }
      />
    );
  } else if (resumable) {
    note =
      outcome === "cancelled"
        ? t`Resume runs it again, and every stage skips the work it already finished.`
        : t`Resume runs it again, and every stage skips the work it already finished.`;
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
        <Meta label={t`Persona`}>
          <Link
            to={studioPath(job.persona)}
            className="inline-flex max-w-full items-center gap-2 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <PersonaAvatar persona={persona} size="xs" />
            <span className="truncate">{persona.name}</span>
          </Link>
        </Meta>
        <Meta label={t`Started`}>
          <time dateTime={job.startedAt}>{formatDateTime(job.startedAt, lang)}</time>
        </Meta>
        <Meta label={t`Duration`}>
          <span className="tabular-nums">
            <Elapsed start={job.startedAt} end={job.endedAt} ticking={job.status === "running"} />
          </span>
        </Meta>
        <Meta label={summary ? t`Cost` : t`Cost So Far`}>
          <span className="tabular-nums">
            {cost === null || cost === undefined ? "—" : formatUsd(cost, lang)}
          </span>
          {summary?.costSource === "unpriced" && (
            <span className="block font-normal text-muted-foreground text-xs">
              {t`Part of the cost couldn't be priced.`}
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
              {t`Reruns an earlier job`}
            </Link>
          )}
          {job.resumedBy && (
            <Link
              to={`/jobs/${encodeURIComponent(job.resumedBy)}`}
              className="inline-flex items-center gap-1.5 text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              <CornerDownRightIcon aria-hidden className="size-4" />
              {t`Resumed by a later job`}
            </Link>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function Entries({ view }: { readonly view: JobView }) {
  const { t } = useLingui();
  if (view.entries.length === 0) return null;
  return (
    <SectionCard title={t`Videos Found (${ph({ count: view.entries.length })})`}>
      <ul className={cn(FLUSH, "divide-y")}>
        {view.entries.map((entry) => (
          <li key={`${entry.id}:${entry.url}`} className="flex items-center gap-4 px-6 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-medium text-sm">{entry.title ?? entry.url}</span>
              <span className="truncate font-mono text-muted-foreground text-xs">{entry.id}</span>
            </div>
            <span className="shrink-0 text-muted-foreground text-sm tabular-nums">
              <span className="sr-only">{t`Length`} </span>
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
  const { t } = useLingui();
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
      title={t`Technical Log`}
      description={t`What the command printed. Its end usually says why a job stopped.`}
      action={
        <>
          {open && (
            <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCwIcon className={isFetching ? "animate-spin" : undefined} />
              {t`Refresh`}
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
            {open ? t`Hide` : t`Show`}
          </Button>
        </>
      }
    >
      {open &&
        (error ? (
          <p id={content} className="text-destructive text-sm">
            {t(errorMessage(error))}
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
              ? t`Loading…`
              : data.trim() === ""
                ? t`The technical log is empty.`
                : data.slice(-LOG_TAIL_CHARS)}
          </pre>
        ))}
    </SectionCard>
  );
}

function NotFound() {
  const { t } = useLingui();
  return (
    <EmptyState
      icon={<SearchXIcon />}
      title={t`There is no such job`}
      description={t`Eidolon keeps the last 50 jobs.`}
      action={
        <Button variant="outline" asChild>
          <Link to="/jobs">
            <ArrowLeftIcon />
            {t`All Jobs`}
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
  const { t } = useLingui();
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
        <AlertTitle>{t`Couldn't load the jobs`}</AlertTitle>
        <AlertDescription>{t(errorMessage(error))}</AlertDescription>
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
          title={t(COMMAND_LABELS[job.command])}
          badges={<OutcomeBadge outcome={outcome} />}
          description={t(COMMAND_ABOUT[job.command])}
        />
      </div>

      <Overview job={job} outcome={outcome} events={events} />

      <SectionCard title={t`Progress`}>
        {events.view.stages.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {outcome === "running" ? t`Starting…` : t`This job reported no progress.`}
          </p>
        ) : (
          <StageList view={events.view} />
        )}
        {outcome === "running" && <RunningItems view={events.view} />}
      </SectionCard>

      {job.command === "expand" && <Entries view={events.view} />}

      <SectionCard title={t`Log`} description={t`What the job reported, newest at the bottom.`}>
        <JobLog view={events.view} className={cn(FLUSH, "max-h-[28rem] px-6 py-4")} />
      </SectionCard>

      <TechnicalLog id={job.id} running={job.status === "running"} />
    </div>
  );
}
