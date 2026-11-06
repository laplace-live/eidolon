// Pieces the job page and the studio share: a job's state, its stages, its log, and a compact
// card for a job the studio started.
import { useQuery } from "@tanstack/react-query";
import {
  CircleCheckIcon,
  CirclePauseIcon,
  CircleSlashIcon,
  CircleXIcon,
  LoaderCircleIcon,
  OctagonXIcon,
  SquareIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress as ProgressBar } from "@/components/ui/progress";
import type { JobRecord, JobSnapshot } from "@/lib/api";
import {
  elapsedSeconds,
  formatBytes,
  formatClock,
  formatCount,
  formatDateTime,
  formatDuration,
} from "@/lib/format";
import { type Lang, type Translate, useLang, useT } from "@/lib/i18n";
import {
  currentStage,
  failedItems,
  type ItemView,
  type JobView,
  type LogLine,
  type Outcome,
  type Progress,
  runningItems,
  runSummary,
  type StageView,
  shownOutcome,
  stageFraction,
} from "@/lib/jobs";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { describeEvent, reasonText, stageName, type Tone } from "./describe";
import { jobQuery, useCancelJob, useForceStopJob } from "./queries";
import { forceStopIn, stopOffer, stoppingSince } from "./stopping";
import { type JobEvents, useJobEvents } from "./use-job-events";

/** How long a job ran, ticking while it runs: only this text renders each second. */
export function Elapsed({
  start,
  end,
  ticking,
}: {
  readonly start: string;
  readonly end: string | null;
  readonly ticking: boolean;
}) {
  const now = useNow(ticking);
  return formatDuration(elapsedSeconds(start, end, now));
}

const OUTCOME_ICONS = {
  running: LoaderCircleIcon,
  succeeded: CircleCheckIcon,
  failed: CircleXIcon,
  crashed: TriangleAlertIcon,
  cancelled: CircleSlashIcon,
  interrupted: CirclePauseIcon,
} as const satisfies Record<Outcome, unknown>;

export function OutcomeBadge({ outcome }: { readonly outcome: Outcome }) {
  const t = useT();
  const Icon = OUTCOME_ICONS[outcome];
  const variant =
    outcome === "failed" || outcome === "crashed"
      ? "destructive"
      : outcome === "succeeded"
        ? "secondary"
        : "outline";
  return (
    <Badge variant={variant}>
      <Icon className={cn(outcome === "running" && "animate-spin")} />
      {t(`jobs.status.${outcome}`)}
    </Badge>
  );
}

export function progressText(t: Translate, lang: Lang, progress: Progress): string {
  if (progress.unit === "percent") return `${Math.round(progress.done)}%`;
  if (progress.unit === "bytes") {
    const done = formatBytes(progress.done, lang);
    return progress.total === null
      ? done
      : t("jobs.progress.of", { done, total: formatBytes(progress.total, lang) });
  }
  return t(`jobs.progress.${progress.unit}`, {
    done: formatCount(progress.done, lang),
    total: progress.total === null ? "?" : formatCount(progress.total, lang),
  });
}

function stageCounts(t: Translate, lang: Lang, stage: StageView): string {
  const parts: string[] = [];
  const finished = stage.done + stage.skipped + stage.failed + stage.cancelled;
  if (stage.total !== null && stage.items > 0) {
    parts.push(t("jobs.progress.items", { done: finished, total: stage.total }));
  }
  if (stage.progress !== null && (stage.items === 0 || finished >= (stage.total ?? 0))) {
    parts.push(progressText(t, lang, stage.progress));
  }
  if (stage.skipped > 0) parts.push(t("jobs.progress.skipped", { count: stage.skipped }));
  if (stage.failed > 0) parts.push(t("jobs.progress.failed", { count: stage.failed }));
  return parts.join(" · ");
}

function Bar({
  fraction,
  running,
}: {
  readonly fraction: number | null;
  readonly running: boolean;
}) {
  if (fraction === null) {
    return <div className={cn("h-1 w-full rounded-full bg-muted", running && "animate-pulse")} />;
  }
  return <ProgressBar value={fraction * 100} />;
}

const TONE_CLASS: Record<Tone, string> = {
  info: "text-foreground",
  ok: "text-foreground",
  warn: "text-amber-700 dark:text-amber-400",
  error: "text-destructive",
};

export function StageRow({ stage }: { readonly stage: StageView }) {
  const t = useT();
  const lang = useLang();
  const reason = reasonText(t, stage.code, stage.provider);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
        <span className="font-medium">{stageName(t, stage.stage)}</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {[t(`jobs.stageStatus.${stage.status}`), stageCounts(t, lang, stage)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <Bar fraction={stageFraction(stage)} running={stage.status === "start"} />
      {(reason || (stage.status === "failed" && stage.message)) && (
        <p className="text-destructive text-xs">
          {reason}
          {stage.message && <span className="text-muted-foreground"> {stage.message}</span>}
        </p>
      )}
    </div>
  );
}

export function StageList({ view }: { readonly view: JobView }) {
  return (
    <div className="flex flex-col gap-4">
      {view.stages.map((stage) => (
        <StageRow key={stage.stage} stage={stage} />
      ))}
    </div>
  );
}

function ItemRow({ item }: { readonly item: ItemView }) {
  const t = useT();
  const lang = useLang();
  const fraction =
    item.progress === null
      ? null
      : item.progress.unit === "percent"
        ? item.progress.done / 100
        : item.progress.total
          ? item.progress.done / item.progress.total
          : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate font-mono" title={item.item}>
          {item.index !== null && item.total !== null && (
            <span className="text-muted-foreground">
              [{item.index}/{item.total}]{" "}
            </span>
          )}
          {item.item}
        </span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {item.progress === null ? stageName(t, item.stage) : progressText(t, lang, item.progress)}
        </span>
      </div>
      <Bar fraction={fraction === null ? null : Math.min(1, fraction)} running />
    </div>
  );
}

/** What is in flight now, at most `limit` of it. */
export function RunningItems({
  view,
  limit = 8,
}: {
  readonly view: JobView;
  readonly limit?: number;
}) {
  const t = useT();
  const running = runningItems(view);
  if (running.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {running.slice(0, limit).map((item) => (
        <ItemRow key={`${item.stage}:${item.item}`} item={item} />
      ))}
      {running.length > limit && (
        <p className="text-muted-foreground text-xs">
          {t("jobs.items.more", { count: running.length - limit })}
        </p>
      )}
    </div>
  );
}

/** The run's failures: each failed item, else the failures its summary lists. */
export function Failures({ view, job }: { readonly view: JobView; readonly job: JobRecord }) {
  const t = useT();
  const failed = failedItems(view);
  const listed = failed.length === 0 ? (runSummary(view, job.command)?.failures ?? []) : [];
  if (failed.length === 0 && listed.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {failed.map((item) => (
        <li key={`${item.stage}:${item.item}`} className="flex flex-col">
          <span className="break-all font-mono text-xs">{item.item}</span>
          <span className="text-destructive">
            {reasonText(t, item.code, item.provider) ?? t("jobs.item.failed")}
          </span>
          {item.message && (
            <span className="whitespace-pre-wrap break-words text-muted-foreground text-xs">
              {item.message}
            </span>
          )}
        </li>
      ))}
      {listed.map((failure) => (
        <li key={`${failure.item}:${failure.error}`} className="flex flex-col">
          <span className="font-mono text-xs">{failure.item}</span>
          <span className="whitespace-pre-wrap break-words text-muted-foreground text-xs">
            {failure.error}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The events as lines, following the newest while the reader is at the bottom. */
export function JobLog({
  view,
  className,
}: {
  readonly view: JobView;
  readonly className?: string;
}) {
  const t = useT();
  const lang = useLang();
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // A line's number in the whole log, which stays its own as earlier lines are dropped.
  const lines = view.log.map((line, at) => ({ line, n: view.logDropped + at }));
  // Every line so far: past the cap, the lines shown stay as many while new ones arrive.
  const written = view.logDropped + view.log.length;

  useLayoutEffect(() => {
    const element = box.current;
    if (element && atBottom.current && written > 0) element.scrollTop = element.scrollHeight;
  }, [written]);

  return (
    <div
      ref={box}
      onScroll={(event) => {
        const element = event.currentTarget;
        atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
      className={cn(
        "max-h-96 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed",
        className,
      )}
    >
      {view.logDropped > 0 && (
        <p className="text-muted-foreground">
          {t("jobs.log.dropped", { count: formatCount(view.logDropped, lang) })}
        </p>
      )}
      {view.log.length === 0 && <p className="text-muted-foreground">{t("jobs.log.empty")}</p>}
      {lines.map(({ line, n }) => (
        <LogRow key={n} line={line} />
      ))}
    </div>
  );
}

/** One log line; a line keeps its object as events arrive, so only new ones are described. */
const LogRow = memo(function LogRow({ line }: { readonly line: LogLine }) {
  const t = useT();
  const lang = useLang();
  const described = describeEvent(t, lang, line.event);
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {line.t === null ? "--:--:--" : formatClock(line.t, lang)}
      </span>
      <span className="min-w-0 break-words">
        <span className={TONE_CLASS[described.tone]}>{described.text}</span>
        {described.detail && <span className="text-muted-foreground"> {described.detail}</span>}
      </span>
    </div>
  );
});

/** Shown once a cancelled job has had FORCE_STOP_AFTER_MS to exit and hasn't. */
function ForceStopButton({ id }: { readonly id: string }) {
  const t = useT();
  const force = useForceStopJob();
  const [since] = useState(() => stoppingSince(id, Date.now()));
  const [ready, setReady] = useState(() => forceStopIn(since, Date.now()) === 0);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setReady(true), forceStopIn(since, Date.now()));
    return () => clearTimeout(timer);
  }, [since, ready]);
  if (!ready) return null;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm" disabled={force.isPending}>
          <OctagonXIcon />
          {t("jobs.forceStop.button")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("jobs.forceStop.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("jobs.forceStop.body")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("jobs.forceStop.wait")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => force.mutate(id)}>
            {t("jobs.forceStop.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * A running job's stop buttons: Cancel, then Stopping beside Force stop. A job an earlier server
 * started, which this one can't signal, shows only whether it is stopping.
 */
export function CancelJobButton({
  job,
}: {
  readonly job: Pick<JobSnapshot, "id" | "status" | "stopping" | "signalable">;
}) {
  const t = useT();
  const cancel = useCancelJob();
  const offer = stopOffer(job);
  if (job.stopping) {
    return (
      <>
        <Button variant="outline" size="sm" disabled>
          <LoaderCircleIcon className="animate-spin" />
          {t("jobs.cancel.stopping")}
        </Button>
        {offer === "force-stop" && <ForceStopButton id={job.id} />}
      </>
    );
  }
  if (offer !== "cancel") return null;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={cancel.isPending}>
          <SquareIcon />
          {t("jobs.cancel.button")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("jobs.cancel.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("jobs.cancel.body")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("jobs.cancel.keep")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => cancel.mutate(job.id)}>
            {t("jobs.cancel.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Calls `onEnded` once when a job this page saw running stops and its events are read. */
function useOnEnded(
  status: JobRecord["status"],
  outcome: Outcome,
  onEnded: ((outcome: Outcome) => void) | undefined,
) {
  const sawRunning = useRef(false);
  const fired = useRef(false);
  const callback = useRef(onEnded);
  useEffect(() => {
    callback.current = onEnded;
  });
  useEffect(() => {
    if (status === "running") sawRunning.current = true;
    if (sawRunning.current && outcome !== "running" && !fired.current) {
      fired.current = true;
      callback.current?.(outcome);
    }
  }, [status, outcome]);
}

/** One line on why a finished job didn't succeed. */
function endNote(t: Translate, view: JobView, job: JobSnapshot, outcome: Outcome): string | null {
  if (outcome === "crashed") return job.stderrTail.trim().split("\n").at(-1) ?? null;
  if (outcome !== "failed") return null;
  const item = failedItems(view)[0];
  if (item) return reasonText(t, item.code, item.provider) ?? item.message;
  const stage = view.stages.find((entry) => entry.status === "failed");
  if (stage) return reasonText(t, stage.code, stage.provider) ?? stage.message;
  return runSummary(view, job.command)?.failures?.[0]?.error ?? null;
}

/**
 * A job the studio started, kept small: its state, the stage it is on, and a way to stop it or
 * open it. Give it a `key` of the job's id, so another job starts it afresh.
 */
export function JobCard({
  job: initial,
  events: followed,
  title,
  onEnded,
  className,
}: {
  readonly job: JobSnapshot;
  /** Its events, when the page follows them already: a second stream would cost a connection. */
  readonly events?: JobEvents;
  /** What to call it; the command's name by default. */
  readonly title?: string;
  readonly onEnded?: (outcome: Outcome) => void;
  readonly className?: string;
}) {
  const t = useT();
  const lang = useLang();
  const { data: job = initial } = useQuery({ ...jobQuery(initial.id), initialData: initial });
  const own = useJobEvents(followed ? null : initial.id);
  const events = followed ?? own;
  const [endedWhenShown] = useState(initial.status !== "running");
  const outcome = shownOutcome(job, events.ended, endedWhenShown);
  useOnEnded(job.status, outcome, onEnded);
  const stage = currentStage(events.view);
  const note = outcome === "running" ? null : endNote(t, events.view, job, outcome);

  return (
    <div className={cn("flex flex-col gap-3 rounded-lg border p-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm">{title ?? t(`jobs.command.${job.command}`)}</span>
        <OutcomeBadge outcome={outcome} />
        <span className="text-muted-foreground text-xs">{formatDateTime(job.startedAt, lang)}</span>
        <div className="ml-auto flex items-center gap-1">
          <CancelJobButton job={job} />
          <Button variant="ghost" size="sm" asChild>
            <Link to={`/jobs/${encodeURIComponent(job.id)}`}>{t("jobs.details")}</Link>
          </Button>
        </div>
      </div>
      {stopOffer(job) === "earlier-run" && (
        <p className="text-muted-foreground text-xs">{t("jobs.earlierRun.body")}</p>
      )}
      {outcome === "running" && stage && <StageRow stage={stage} />}
      {outcome === "running" && <RunningItems view={events.view} limit={4} />}
      {note && <p className="break-words text-destructive text-xs">{note}</p>}
    </div>
  );
}
