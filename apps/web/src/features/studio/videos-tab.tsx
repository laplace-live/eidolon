// A persona's videos: add links, download them for free, see what transcribing, refining and
// indexing them would cost, then run it. Every step is a job; the table follows the running one.
import type { PlanVideo } from "@eidolon/ingest/progress";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  DownloadIcon,
  LanguagesIcon,
  PlayIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useId, useMemo, useState } from "react";
import { SettingsForm } from "@/components/settings-form";
import { settingsQuery } from "@/components/settings-form/queries";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toastError } from "@/features/jobs/feedback";
import { formatBytes, formatCount, formatUsd } from "@/features/jobs/format";
import { JobCard } from "@/features/jobs/parts";
import { jobsQuery, useStartJob } from "@/features/jobs/queries";
import { useJobEvents } from "@/features/jobs/use-job-events";
import type { JobCommand, PersonaSummary, Status } from "@/lib/api";
import { useLang, useT } from "@/lib/i18n";
import { latestJob, videoActivity } from "@/lib/jobs";
import { statusQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import { AddVideos } from "./add-videos";
import { LoadError, Section } from "./parts";
import { personaQueries } from "./queries";
import { usePlan } from "./use-plan";
import { VideoTable } from "./video-table";
import { downloadBatches, needsFfmpeg, paidRunOptions, planTotals } from "./videos";

/** The jobs this tab starts, of which the latest is the one it follows. */
const RUN_COMMANDS: readonly JobCommand[] = ["pipeline", "download", "transcribe"];
const COOKIE_PATHS = ["sources.cookiesFromBrowser", "sources.cookiesFile"] as const;
const TRANSCRIPTION_PATHS = [
  "transcription.language",
  "transcription.model",
  "refine.model",
  "refine.concurrency",
] as const;
/** Soniox runs up to 25 transcriptions per account at once; 4 leaves room for calls. */
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 25;

function Folded({
  label,
  defaultOpen = false,
  children,
}: {
  readonly label: string;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-2">
          <ChevronDownIcon className={open ? "rotate-180" : undefined} />
          {label}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">{open && children}</CollapsibleContent>
    </Collapsible>
  );
}

function ToolLines({
  status,
  videos,
}: {
  readonly status: Status | undefined;
  readonly videos: readonly PlanVideo[];
}) {
  const t = useT();
  const lang = useLang();
  if (!status) return null;
  const longOnes = videos.filter(needsFfmpeg).length;
  const ytDlp = status.ytDlp;
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      <li className={cn(ytDlp.state === "unavailable" && "text-destructive")}>
        {ytDlp.state === "installed"
          ? t("studio.videos.ytdlpInstalled", { tag: ytDlp.tag })
          : ytDlp.state === "installs-on-first-download"
            ? t("studio.videos.ytdlpFirst")
            : t("studio.videos.ytdlpUnavailable", { reason: ytDlp.reason })}
      </li>
      {ytDlp.state === "unavailable" && (
        <li className="text-muted-foreground text-xs">{t("studio.videos.ytdlpManual")}</li>
      )}
      <li className={cn(!status.ffmpeg && longOnes > 0 && "text-destructive")}>
        {status.ffmpeg
          ? t("studio.videos.ffmpegFound")
          : longOnes > 0
            ? t("studio.videos.ffmpegNeeded", { count: longOnes })
            : t("studio.videos.ffmpegMissing")}
      </li>
      {!status.ffmpeg && (
        <li className="text-muted-foreground text-xs">{t("studio.videos.ffmpegHint")}</li>
      )}
      <li>
        {status.freeBytes === null
          ? t("studio.videos.freeUnknown")
          : t("studio.videos.free", { size: formatBytes(status.freeBytes, lang) })}
      </li>
    </ul>
  );
}

/** Where downloads read cookies from, which the first download shows unasked. */
function CookieSource({ open, trouble }: { readonly open: boolean; readonly trouble: boolean }) {
  const t = useT();
  const settings = useQuery(settingsQuery());
  const rows = settings.data?.settings ?? [];
  const browser = rows.find((row) => row.path === "sources.cookiesFromBrowser")?.value;
  const file = rows.find((row) => row.path === "sources.cookiesFile")?.value;
  const summary =
    typeof file === "string" && file !== ""
      ? t("studio.videos.cookiesFile", { file })
      : typeof browser === "string" && browser !== "" && browser !== "none"
        ? t("studio.videos.cookiesBrowser", { browser })
        : browser === "none"
          ? t("studio.videos.cookiesNone")
          : t("studio.videos.cookiesDefault");
  return (
    <div
      className={cn("flex flex-col gap-2 rounded-lg border p-3", trouble && "border-destructive")}
    >
      {trouble && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>{t("events.cookies-unavailable")}</AlertTitle>
          <AlertDescription>{t("studio.videos.cookiesTrouble")}</AlertDescription>
        </Alert>
      )}
      <p className="text-sm">{summary}</p>
      <p className="text-muted-foreground text-xs">{t("studio.videos.cookiesHelp")}</p>
      <Folded label={t("studio.videos.cookiesChange")} defaultOpen={open || trouble}>
        <SettingsForm scope="app" paths={COOKIE_PATHS} />
      </Folded>
    </div>
  );
}

function RunPaid({
  usd,
  unpriced,
  disabled,
  onRun,
}: {
  readonly usd: number;
  readonly unpriced: number;
  readonly disabled: boolean;
  readonly onRun: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const amount = formatUsd(usd, lang);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button disabled={disabled}>
          <PlayIcon />
          {t("studio.videos.run", { usd: amount })}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("studio.videos.runConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("studio.videos.runConfirmBody", { usd: amount })}
            {unpriced > 0 && ` ${t("studio.videos.runConfirmUnpriced", { count: unpriced })}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("studio.videos.runConfirmCancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onRun}>{t("studio.videos.runConfirm")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function VideosTab({ persona }: { readonly persona: PersonaSummary }) {
  const t = useT();
  const lang = useLang();
  const queryClient = useQueryClient();
  const concurrencyId = useId();
  const plan = usePlan(persona.id);
  const { data: status } = useQuery(statusQuery);
  const { data: jobs } = useQuery(jobsQuery);
  const runJob = latestJob(jobs ?? [], persona.id, RUN_COMMANDS);
  const runEvents = useJobEvents(runJob?.id ?? null);
  const running = runJob?.status === "running";
  const start = useStartJob();
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY);
  // The batch written on this page, which a run names first.
  const [batch, setBatch] = useState<string | null>(null);

  const totals = useMemo(() => planTotals(plan.videos), [plan.videos]);
  const activity = useMemo(
    () => (running ? videoActivity(runEvents.view) : new Map()),
    [running, runEvents.view],
  );
  const pendingBatches = downloadBatches(plan.videos);
  // A download names one batch, the oldest waiting, and fetches only its videos.
  const downloadBatch = pendingBatches[0] ?? null;
  const downloadCount = plan.videos.filter(
    (video) => video.download === "pending" && video.batch === downloadBatch,
  ).length;
  const busy = running || start.isPending || plan.refreshing;
  const usd = totals.transcribeUsd + totals.refineUsd;
  const firstDownload = !plan.videos.some((video) => video.download === "done");
  const cookieTrouble =
    runJob !== null &&
    runJob.status !== "running" &&
    runJob.failures.some((failure) => failure.code === "cookies-unavailable");

  const onRunEnded = useCallback(() => {
    plan.update();
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: personaQueries(persona.id).index.queryKey }),
    ]);
  }, [plan.update, queryClient, persona.id]);

  function download() {
    if (downloadBatch === null) return;
    start.mutate(
      {
        command: "pipeline",
        persona: persona.id,
        options: { batch: downloadBatch, stages: ["download"] },
      },
      { onError: toastError },
    );
  }

  function runPaid() {
    start.mutate(
      {
        command: "pipeline",
        persona: persona.id,
        options: paidRunOptions(plan.videos, batch, concurrency),
      },
      { onError: toastError },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Alert>
        <LanguagesIcon />
        <AlertTitle>{t("studio.videos.scopeTitle")}</AlertTitle>
        <AlertDescription>{t("studio.videos.scopeBody")}</AlertDescription>
      </Alert>

      <Section title={t("studio.videos.addTitle")} description={t("studio.videos.addHelp")}>
        <AddVideos
          persona={persona.id}
          videos={plan.videos}
          freeBytes={status?.freeBytes ?? null}
          onAdded={(result) => {
            if (result.batch !== null) setBatch(result.batch);
            plan.update();
          }}
        />
      </Section>

      <Section
        title={t("studio.videos.downloadTitle")}
        description={t("studio.videos.downloadHelp")}
      >
        <ToolLines status={status} videos={plan.videos} />
        <CookieSource open={firstDownload} trouble={cookieTrouble} />
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={download} disabled={busy || downloadBatch === null}>
            <DownloadIcon />
            {t("studio.videos.download", { count: formatCount(downloadCount, lang) })}
          </Button>
          <span className="text-muted-foreground text-xs">
            {totals.downloadPending === 0
              ? t("studio.videos.nothingToDownload")
              : pendingBatches.length === 0
                ? t("studio.videos.notInBatch")
                : pendingBatches.length > 1
                  ? t("studio.videos.batchesWaiting", { count: pendingBatches.length })
                  : t("studio.videos.downloadFree")}
          </span>
        </div>
      </Section>

      <Section title={t("studio.videos.runTitle")} description={t("studio.videos.runHelp")}>
        {totals.paidWork === 0 ? (
          <p className="text-muted-foreground text-sm">{t("studio.videos.nothingToRun")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {totals.transcribePending > 0 && (
              <li>
                {t("studio.videos.estimateTranscribe", {
                  count: formatCount(totals.transcribePending, lang),
                  usd: formatUsd(totals.transcribeUsd, lang),
                })}
              </li>
            )}
            {totals.refineChunks > 0 && (
              <li>
                {t("studio.videos.estimateRefine", {
                  count: formatCount(totals.refineChunks, lang),
                  usd: formatUsd(totals.refineUsd, lang),
                })}
              </li>
            )}
            {totals.unindexed > 0 && (
              <li>
                {t("studio.videos.estimateIndex", { count: formatCount(totals.unindexed, lang) })}
              </li>
            )}
            <li className="font-medium">
              {t("studio.videos.estimateTotal", { usd: formatUsd(usd, lang) })}
            </li>
            {totals.unpriced > 0 && (
              <li className="text-muted-foreground text-xs">
                {t("studio.videos.estimateUnpriced", { count: totals.unpriced })}
              </li>
            )}
            <li className="text-muted-foreground text-xs">{t("studio.videos.estimateNote")}</li>
          </ul>
        )}
        {totals.noDate > 0 && (
          <p className="text-sm">{t("studio.videos.noDate", { count: totals.noDate })}</p>
        )}
        <Folded label={t("studio.videos.advanced")}>
          <Field>
            <FieldLabel htmlFor={concurrencyId}>{t("studio.videos.concurrency")}</FieldLabel>
            <Input
              id={concurrencyId}
              type="number"
              min={1}
              max={MAX_CONCURRENCY}
              value={concurrency}
              onChange={(event) => {
                const value = Math.round(Number(event.target.value));
                if (value >= 1 && value <= MAX_CONCURRENCY) setConcurrency(value);
              }}
              className="w-24"
            />
            <FieldDescription>
              {t("studio.videos.concurrencyHelp", { max: MAX_CONCURRENCY })}
            </FieldDescription>
          </Field>
        </Folded>
        <div className="flex flex-wrap items-center gap-3">
          <RunPaid
            usd={usd}
            unpriced={totals.unpriced}
            disabled={busy || totals.paidWork === 0}
            onRun={runPaid}
          />
        </div>
      </Section>

      {runJob && <JobCard key={runJob.id} job={runJob} events={runEvents} onEnded={onRunEnded} />}

      <Section
        title={t("studio.videos.tableTitle")}
        description={t("studio.videos.tableHelp")}
        action={
          <Button variant="ghost" size="sm" disabled={plan.refreshing} onClick={plan.refresh}>
            <RefreshCwIcon className={plan.refreshing ? "animate-spin" : undefined} />
            {t("studio.videos.replan")}
          </Button>
        }
      >
        {plan.refreshing && (
          <p className="flex items-center gap-2 text-muted-foreground text-xs">
            <Spinner />
            {t("studio.videos.planning")}
          </p>
        )}
        {plan.failed && (
          <Alert variant="destructive">
            <AlertDescription>{t("studio.videos.planFailed")}</AlertDescription>
          </Alert>
        )}
        {plan.error && <LoadError error={plan.error} />}
        {(plan.videos.length > 0 || !plan.refreshing) && (
          <VideoTable
            videos={plan.videos}
            activity={activity}
            ffmpeg={status?.ffmpeg ?? true}
            busy={busy}
            onTranscribe={(video, date) =>
              start.mutate(
                {
                  command: "transcribe",
                  persona: persona.id,
                  options: { video: video.id, date },
                },
                { onError: toastError },
              )
            }
          />
        )}
      </Section>

      <Folded label={t("studio.videos.transcriptionSettings")}>
        <SettingsForm scope="persona" persona={persona.id} paths={TRANSCRIPTION_PATHS} />
      </Folded>
    </div>
  );
}
