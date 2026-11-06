import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, ChevronDownIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError, errorKey, type JobSnapshot, stream } from "@/lib/api";
import { formatDateTime, formatDuration, formatUsd } from "@/lib/format";
import { useLang, useT } from "@/lib/i18n";
import { costSoFar, type JobView, runSummary } from "@/lib/jobs";
import { studioPath } from "@/lib/paths";
import {
  CancelJobButton,
  Elapsed,
  Failures,
  JobLog,
  OutcomeBadge,
  outcomeOf,
  RunningItems,
  StageList,
} from "./parts";
import { jobQuery, useResumeJob } from "./queries";
import { stopOffer } from "./stopping";
import { useJobEvents } from "./use-job-events";

/** How much of a long stderr log the page shows: its end, where a crash is. */
const LOG_TAIL_CHARS = 200_000;

function StderrLog({ id, running }: { readonly id: string; readonly running: boolean }) {
  const t = useT();
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["jobs", id, "log"],
    queryFn: async ({ signal }) =>
      new Response(await stream("GET /api/local/jobs/:id/log", { params: { id }, signal })).text(),
    refetchInterval: running ? 5000 : false,
  });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCwIcon className={isFetching ? "animate-spin" : undefined} />
          {t("jobs.stderr.refresh")}
        </Button>
      </div>
      {error ? (
        <p className="text-destructive text-sm">{t(errorKey(error))}</p>
      ) : (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 font-mono text-xs">
          {data === undefined
            ? t("jobs.stderr.loading")
            : data.trim() === ""
              ? t("jobs.stderr.empty")
              : data.slice(-LOG_TAIL_CHARS)}
        </pre>
      )}
    </div>
  );
}

function Options({ options }: { readonly options: JobSnapshot["options"] }) {
  const entries = Object.entries(options);
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-foreground">{key}</dt>
          <dd className="break-all font-mono">
            {typeof value === "string" ? value : JSON.stringify(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Entries({ view }: { readonly view: JobView }) {
  const t = useT();
  if (view.entries.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("jobs.entries.title", { count: view.entries.length })}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("jobs.entries.video")}</TableHead>
              <TableHead className="text-right">{t("jobs.entries.length")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.entries.map((entry) => (
              <TableRow key={`${entry.id}:${entry.url}`}>
                <TableCell className="max-w-md whitespace-normal">
                  <div className="truncate">{entry.title ?? entry.url}</div>
                  <div className="font-mono text-muted-foreground text-xs">{entry.id}</div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {entry.durationSec === undefined ? "—" : formatDuration(entry.durationSec)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function NotFound() {
  const t = useT();
  return (
    <div className="flex flex-col items-start gap-4">
      <p className="text-muted-foreground">{t("jobs.notFound")}</p>
      <Button variant="outline" asChild>
        <Link to="/jobs">{t("jobs.back")}</Link>
      </Button>
    </div>
  );
}

export function JobDetail({ id }: { readonly id: string }) {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const { data: job, error } = useQuery(jobQuery(id));
  const events = useJobEvents(id);
  const resume = useResumeJob();
  const [stderrOpen, setStderrOpen] = useState(false);

  // An id the server never minted is refused before it is looked up.
  if (error instanceof ApiError && (error.status === 404 || error.status === 400)) {
    return <NotFound />;
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t("jobs.loadFailed")}</AlertTitle>
        <AlertDescription>{t(errorKey(error))}</AlertDescription>
      </Alert>
    );
  }
  if (!job) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  const outcome = outcomeOf(job, events);
  const summary = runSummary(events.view, job.command);
  const cost = summary?.costUsd ?? costSoFar(events.view) ?? job.costUsd;
  // A job resumes once: its rerun is the one to resume after that.
  const resumable =
    !job.ephemeral &&
    job.resumedBy === null &&
    (outcome === "interrupted" ||
      outcome === "cancelled" ||
      outcome === "failed" ||
      outcome === "crashed");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Button variant="ghost" size="sm" className="self-start" asChild>
          <Link to="/jobs">
            <ArrowLeftIcon />
            {t("jobs.back")}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading font-semibold text-2xl">
            {t(`jobs.command.${job.command}`)}
          </h1>
          <OutcomeBadge outcome={outcome} />
          <div className="ml-auto flex gap-2">
            <CancelJobButton job={job} />
            {resumable && (
              <Button
                size="sm"
                disabled={resume.isPending}
                onClick={() =>
                  resume.mutate(job.id, {
                    onSuccess: (next) => {
                      if (next.id !== job.id) navigate(`/jobs/${encodeURIComponent(next.id)}`);
                    },
                  })
                }
              >
                <PlayIcon />
                {t("jobs.resume")}
              </Button>
            )}
          </div>
        </div>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-sm">
          <span>
            {t("jobs.meta.persona")}{" "}
            <Link
              to={studioPath(job.persona)}
              className="text-foreground underline-offset-4 hover:underline"
            >
              {job.persona}
            </Link>
          </span>
          <span>
            {t("jobs.meta.started")} {formatDateTime(job.startedAt, lang)}
          </span>
          <span className="tabular-nums">
            {t("jobs.meta.duration")}{" "}
            <Elapsed start={job.startedAt} end={job.endedAt} ticking={job.status === "running"} />
          </span>
          {cost !== null && cost !== undefined && (
            <span className="tabular-nums">
              {t(summary ? "jobs.meta.cost" : "jobs.meta.costSoFar")} {formatUsd(cost, lang)}
            </span>
          )}
          {summary?.costSource === "unpriced" && <span>{t("jobs.meta.unpriced")}</span>}
        </p>
        <Options options={job.options} />
        {(job.resumedFrom || job.resumedBy) && (
          <p className="flex flex-wrap gap-x-4 text-muted-foreground text-sm">
            {job.resumedFrom && (
              <Link
                to={`/jobs/${encodeURIComponent(job.resumedFrom)}`}
                className="underline-offset-4 hover:underline"
              >
                {t("jobs.resumedFrom")}
              </Link>
            )}
            {job.resumedBy && (
              <Link
                to={`/jobs/${encodeURIComponent(job.resumedBy)}`}
                className="underline-offset-4 hover:underline"
              >
                {t("jobs.resumedBy")}
              </Link>
            )}
          </p>
        )}
      </div>

      {stopOffer(job) === "earlier-run" && (
        <Alert>
          <AlertTitle>{t("jobs.earlierRun.title")}</AlertTitle>
          <AlertDescription>{t("jobs.earlierRun.body")}</AlertDescription>
        </Alert>
      )}
      {outcome === "interrupted" && (
        <Alert>
          <AlertTitle>{t("jobs.interrupted.title")}</AlertTitle>
          <AlertDescription>{t("jobs.interrupted.body")}</AlertDescription>
        </Alert>
      )}
      {outcome === "cancelled" && !job.ephemeral && (
        <Alert>
          <AlertTitle>{t("jobs.cancelled.title")}</AlertTitle>
          <AlertDescription>{t("jobs.cancelled.body")}</AlertDescription>
        </Alert>
      )}
      {outcome === "crashed" && (
        <Alert variant="destructive">
          <AlertTitle>{t("jobs.crashed.title")}</AlertTitle>
          <AlertDescription>
            <p>{t("jobs.crashed.body")}</p>
            {job.stderrTail.trim() !== "" && (
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
                {job.stderrTail}
              </pre>
            )}
          </AlertDescription>
        </Alert>
      )}
      {outcome === "failed" && (
        <Alert variant="destructive">
          <AlertTitle>{t("jobs.failed.title")}</AlertTitle>
          <AlertDescription>
            <Failures view={events.view} job={job} />
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("jobs.stages.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {events.view.stages.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {outcome === "running" ? t("jobs.stages.waiting") : t("jobs.stages.none")}
            </p>
          ) : (
            <StageList view={events.view} />
          )}
          {outcome === "running" && <RunningItems view={events.view} />}
        </CardContent>
      </Card>

      {job.command === "expand" && <Entries view={events.view} />}

      <Card>
        <CardHeader>
          <CardTitle>{t("jobs.log.title")}</CardTitle>
          <CardDescription>{t("jobs.log.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <JobLog view={events.view} />
          <Collapsible open={stderrOpen} onOpenChange={setStderrOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm">
                <ChevronDownIcon className={stderrOpen ? "rotate-180" : undefined} />
                {t("jobs.stderr.title")}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              {stderrOpen && <StderrLog id={job.id} running={job.status === "running"} />}
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>
    </div>
  );
}
