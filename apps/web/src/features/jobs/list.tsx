import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError, errorKey, type JobSnapshot } from "@/lib/api";
import { formatDateTime, formatUsd } from "@/lib/format";
import { type Lang, type Translate, useLang, useT } from "@/lib/i18n";
import { jobOutcome } from "@/lib/jobs";
import { Elapsed, OutcomeBadge } from "./parts";
import { jobsQuery } from "./queries";

/** The stage a snapshot is on, as `Transcribe 3/10`. */
function snapshotProgress(t: Translate, job: JobSnapshot): string {
  const stage = job.stages.at(-1);
  if (!stage) return "";
  const name = t(`jobs.stage.${stage.stage}`);
  const finished = stage.done + stage.failed + stage.skipped;
  return stage.total === null ? name : `${name} ${finished}/${stage.total}`;
}

function JobRow({ job, lang }: { job: JobSnapshot; lang: Lang }) {
  const t = useT();
  return (
    <TableRow>
      <TableCell>
        <Link
          to={`/jobs/${encodeURIComponent(job.id)}`}
          className="font-medium underline-offset-4 hover:underline"
        >
          {t(`jobs.command.${job.command}`)}
        </Link>
        <div className="text-muted-foreground text-xs">{job.persona}</div>
      </TableCell>
      <TableCell>
        <OutcomeBadge outcome={jobOutcome(job)} />
      </TableCell>
      <TableCell className="text-muted-foreground tabular-nums">
        {snapshotProgress(t, job)}
      </TableCell>
      <TableCell className="text-muted-foreground">{formatDateTime(job.startedAt, lang)}</TableCell>
      <TableCell className="text-muted-foreground tabular-nums">
        <Elapsed start={job.startedAt} end={job.endedAt} ticking={job.status === "running"} />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {job.costUsd === null ? "—" : formatUsd(job.costUsd, lang)}
      </TableCell>
    </TableRow>
  );
}

export function JobsList() {
  const t = useT();
  const lang = useLang();
  const { data: jobs, error, isPending } = useQuery(jobsQuery);
  const [showEphemeral, setShowEphemeral] = useState(false);

  const shown = (jobs ?? [])
    .filter((job) => showEphemeral || !job.ephemeral)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const hidden = (jobs ?? []).filter((job) => job.ephemeral).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading font-semibold text-2xl">{t("jobs.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("jobs.description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="jobs-ephemeral" checked={showEphemeral} onCheckedChange={setShowEphemeral} />
          <Label htmlFor="jobs-ephemeral" className="text-sm">
            {t("jobs.showEphemeral", { count: hidden })}
          </Label>
        </div>
      </div>
      {error && !(error instanceof ApiError && error.status === 401) && (
        <Alert variant="destructive">
          <AlertTitle>{t("jobs.loadFailed")}</AlertTitle>
          <AlertDescription>
            {t(errorKey(error))}
            {error instanceof ApiError && <span className="block text-xs">{error.message}</span>}
          </AlertDescription>
        </Alert>
      )}
      {isPending && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      )}
      {jobs && shown.length === 0 && (
        <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground text-sm">
          {t("jobs.empty")}
        </p>
      )}
      {shown.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("jobs.col.job")}</TableHead>
              <TableHead>{t("jobs.col.status")}</TableHead>
              <TableHead>{t("jobs.col.progress")}</TableHead>
              <TableHead>{t("jobs.col.started")}</TableHead>
              <TableHead>{t("jobs.col.duration")}</TableHead>
              <TableHead className="text-right">{t("jobs.col.cost")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((job) => (
              <JobRow key={job.id} job={job} lang={lang} />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
