// A persona's videos: add links, download them for free, see what transcribing, refining and
// indexing them would cost, then run it. Every step is a job; the table follows the running one.
import type { PlanVideo } from "@eidolon/ingest/progress";
import { ph, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleXIcon,
  CookieIcon,
  DownloadIcon,
  HardDriveIcon,
  InfoIcon,
  PlayIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useId, useMemo, useState } from "react";
import { SectionCard } from "@/components/section-card";
import { settingsQuery } from "@/components/settings-form/queries";
import { SettingsCard } from "@/components/settings-form/settings-card";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { JobCard } from "@/features/jobs/parts";
import { jobsQuery, useStartJob } from "@/features/jobs/queries";
import { useJobEvents } from "@/features/jobs/use-job-events";
import type { JobCommand, PersonaSummary, Status } from "@/lib/api";
import { formatBytes, formatUsd } from "@/lib/format";
import { latestJob, videoActivity } from "@/lib/jobs";
import { statusQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import { useLang } from "@/locales/i18n";
import { AddVideosCard } from "./add-videos";
import { LoadError } from "./parts";
import { personaQueries } from "./queries";
import { CARD_PATHS } from "./sections";
import { usePlan } from "./use-plan";
import { VideoTable } from "./video-table";
import { downloadBatches, needsFfmpeg, outdatesPlan, paidRunOptions, planTotals } from "./videos";

/** The jobs this section starts, of which the latest is the one it follows. */
const RUN_COMMANDS: readonly JobCommand[] = ["pipeline", "download", "transcribe"];
/** Settings every persona shares, which downloads read. */
const COOKIE_PATHS = ["sources.cookiesFromBrowser", "sources.cookiesFile"] as const;
/** Soniox runs up to 25 transcriptions per account at once; 4 leaves room for calls. */
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 25;

/** A card title with a word on what it costs. */
function Priced({ title, price }: { readonly title: string; readonly price: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2.5">
      {title}
      <Badge variant="secondary" className="font-normal">
        {price}
      </Badge>
    </span>
  );
}

type Tone = "ok" | "info" | "error";

const TONE_ICONS = { ok: CircleCheckIcon, info: InfoIcon, error: CircleXIcon } as const;

/** One line of what downloads need: an icon of how it stands, the line, and a hint under it. */
function ToolLine({
  tone,
  icon,
  hint,
  trailing,
  children,
}: {
  readonly tone: Tone;
  readonly icon?: ReactNode;
  readonly hint?: ReactNode;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}) {
  const Icon = TONE_ICONS[tone];
  return (
    <li className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
      <span
        className={cn(
          "mt-0.5 shrink-0 [&_svg]:size-4",
          tone === "ok" && "text-success",
          tone === "info" && "text-muted-foreground",
          tone === "error" && "text-destructive",
        )}
      >
        {icon ?? <Icon />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("text-sm", tone === "error" && "text-destructive")}>{children}</span>
        {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
      </div>
      {trailing}
    </li>
  );
}

/** Where downloads read cookies from, in words. */
function useCookieSummary(): string {
  const { t } = useLingui();
  const settings = useQuery(settingsQuery());
  const rows = settings.data?.settings ?? [];
  // The environment wins over settings.yaml for these, as for every app setting.
  const applied = (path: string) => {
    const row = rows.find((entry) => entry.path === path);
    return row?.envOverride ? row.envValue : row?.value;
  };
  const browser = applied("sources.cookiesFromBrowser");
  const file = applied("sources.cookiesFile");
  if (typeof file === "string" && file !== "") return t`Cookies come from the file ${file}.`;
  if (browser === "none") return t`Downloads use no cookies.`;
  return typeof browser === "string" && browser !== ""
    ? t`Cookies come from ${browser}.`
    : t`Cookies come from Chrome, the default.`;
}

function DownloadCard({
  status,
  videos,
  cookiesShown,
  onCookies,
  busy,
  onDownload,
  downloadCount,
  hint,
}: {
  readonly status: Status | undefined;
  readonly videos: readonly PlanVideo[];
  /** The cookies card shows below; null while it must, after a download failed on them. */
  readonly cookiesShown: boolean | null;
  readonly onCookies: () => void;
  readonly busy: boolean;
  readonly onDownload: (() => void) | null;
  readonly downloadCount: number;
  readonly hint: string;
}) {
  const { t } = useLingui();
  const lang = useLang();
  const cookies = useCookieSummary();
  const longOnes = videos.filter(needsFfmpeg).length;
  const ytDlp = status?.ytDlp;
  return (
    <SectionCard
      title={<Priced title={t`Download`} price={t`Free`} />}
      description={t`yt-dlp downloads each video's audio into your data home. Nothing is billed.`}
      note={hint}
      actions={
        <Button onClick={() => onDownload?.()} disabled={busy || onDownload === null}>
          <DownloadIcon />
          {t`${plural(ph({ count: downloadCount }), { one: `Download # video`, other: `Download # videos` })}`}
        </Button>
      }
    >
      {status && ytDlp && (
        <ul className="flex flex-col divide-y">
          {ytDlp.state === "installed" ? (
            <ToolLine tone="ok">{t`yt-dlp ${ph({ tag: ytDlp.tag })} is installed.`}</ToolLine>
          ) : ytDlp.state === "installs-on-first-download" ? (
            <ToolLine tone="info">{t`yt-dlp installs itself on the first download.`}</ToolLine>
          ) : (
            <ToolLine
              tone="error"
              hint={t`Install it yourself with brew install yt-dlp or pip install yt-dlp, and Eidolon uses the one on your PATH.`}
            >
              {t`yt-dlp is unavailable: ${ph({ reason: ytDlp.reason })}`}
            </ToolLine>
          )}
          {status.ffmpeg ? (
            <ToolLine tone="ok">{t`ffmpeg is installed.`}</ToolLine>
          ) : (
            <ToolLine
              tone={longOnes > 0 ? "error" : "info"}
              hint={t`macOS: brew install ffmpeg · Windows: winget install ffmpeg · Linux: your package manager's ffmpeg.`}
            >
              {longOnes > 0
                ? t`${plural(ph({ count: longOnes }), { one: `ffmpeg isn't installed, and # video is over 5 hours, which needs it to be transcribed.`, other: `ffmpeg isn't installed, and # videos are over 5 hours, which need it to be transcribed.` })}`
                : t`ffmpeg isn't installed. Only videos over 5 hours need it.`}
            </ToolLine>
          )}
          <ToolLine tone="info" icon={<HardDriveIcon />}>
            {status.freeBytes === null
              ? t`The free space on the data home's disk is unknown.`
              : t`${ph({ size: formatBytes(status.freeBytes, lang) })} free on the data home's disk.`}
          </ToolLine>
          <ToolLine
            tone="info"
            icon={<CookieIcon />}
            trailing={
              cookiesShown === null ? undefined : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-my-1"
                  aria-expanded={cookiesShown}
                  onClick={onCookies}
                >
                  {t`Change`}
                  <ChevronDownIcon className={cn(cookiesShown && "rotate-180")} />
                </Button>
              )
            }
          >
            {cookies}
          </ToolLine>
        </ul>
      )}
    </SectionCard>
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
  const { t } = useLingui();
  const lang = useLang();
  const amount = formatUsd(usd, lang);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button disabled={disabled}>
          <PlayIcon />
          {t`Run, about ${ph({ usd: amount })}`}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Start the billed run?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`This bills your Soniox, OpenRouter and embedding accounts: about ${ph({ usd: amount })} by the estimate.`}
            {unpriced > 0 &&
              ` ${t`${plural(ph({ count: unpriced }), { one: `# video isn't in the estimate.`, other: `# videos aren't in the estimate.` })}`}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t`Not Now`}</AlertDialogCancel>
          <AlertDialogAction onClick={onRun}>{t`Run`}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A line of the estimate: what, and what it costs. */
function Cost({
  label,
  amount,
  strong = false,
}: {
  readonly label: string;
  readonly amount: string;
  readonly strong?: boolean;
}) {
  return (
    <div
      className={cn("flex items-baseline justify-between gap-4 py-2.5", strong && "font-medium")}
    >
      <dt className={cn(!strong && "text-muted-foreground")}>{label}</dt>
      <dd className="tabular-nums">{amount}</dd>
    </div>
  );
}

export function VideosSection({ persona }: { readonly persona: PersonaSummary }) {
  const { t } = useLingui();
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
  const [advanced, setAdvanced] = useState(false);
  // The batch written on this page, which a run names first.
  const [batch, setBatch] = useState<string | null>(null);
  const [cookiesOpen, setCookiesOpen] = useState(false);

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
  // The first download, and one after cookies failed, show where cookies come from unasked.
  const cookiesForced = firstDownload || cookieTrouble;

  const onRunEnded = useCallback(() => {
    plan.update();
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: personaQueries(persona.id).index.queryKey }),
    ]);
  }, [plan.update, queryClient, persona.id]);

  function download() {
    if (downloadBatch === null) return;
    start.mutate({
      command: "pipeline",
      persona: persona.id,
      options: { batch: downloadBatch, stages: ["download"] },
    });
  }

  function runPaid() {
    start.mutate({
      command: "pipeline",
      persona: persona.id,
      options: paidRunOptions(plan.videos, batch, concurrency),
    });
  }

  return (
    <>
      <AddVideosCard
        persona={persona.id}
        videos={plan.videos}
        freeBytes={status?.freeBytes ?? null}
        onAdded={(result) => {
          if (result.batch !== null) setBatch(result.batch);
          plan.update();
        }}
      />

      <DownloadCard
        status={status}
        videos={plan.videos}
        cookiesShown={cookiesForced ? null : cookiesOpen}
        onCookies={() => setCookiesOpen((open) => !open)}
        busy={busy}
        onDownload={downloadBatch === null ? null : download}
        downloadCount={downloadCount}
        hint={
          totals.downloadPending === 0
            ? t`Every video is downloaded.`
            : pendingBatches.length === 0
              ? t`These videos come from your own URL lists, which only laplace-pipeline in a terminal downloads.`
              : pendingBatches.length > 1
                ? t`${plural(ph({ count: pendingBatches.length }), { one: `# batch is waiting; this downloads it.`, other: `# batches are waiting; this downloads the oldest first.` })}`
                : t`Free: only yt-dlp runs.`
        }
      />

      {(cookiesForced || cookiesOpen) && (
        <SettingsCard
          scope="app"
          paths={COOKIE_PATHS}
          title={t`Cookies`}
          description={t`Some videos need a signed-in browser's cookies. Reading a browser's cookies may ask for your password (the macOS Keychain), and yt-dlp writes the cookies it used back into a cookies file.`}
        >
          {cookieTrouble && (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>{t`yt-dlp couldn't read the browser's cookies, or the site asked for them.`}</AlertTitle>
              <AlertDescription>{t`The last download failed on cookies. Pick another browser, a cookies file or none, then download again.`}</AlertDescription>
            </Alert>
          )}
        </SettingsCard>
      )}

      <SectionCard
        title={<Priced title={t`Transcribe, Refine and Index`} price={t`Billed`} />}
        description={t`Soniox transcribes the audio, the refine model cleans up each transcript, and the embedding API indexes it. Each step skips what's already done.`}
        note={t`Estimates come from price tables or past runs, and leave out indexing's embedding cost.`}
        actions={
          <RunPaid
            usd={usd}
            unpriced={totals.unpriced}
            disabled={busy || totals.paidWork === 0}
            onRun={runPaid}
          />
        }
      >
        {totals.paidWork === 0 ? (
          <p className="text-muted-foreground text-sm">{t`Nothing is left to transcribe, refine or index.`}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <dl className="flex flex-col divide-y text-sm">
              {totals.transcribePending > 0 && (
                <Cost
                  label={t`${plural(ph({ count: totals.transcribePending }), { one: `Transcribe # video`, other: `Transcribe # videos` })}`}
                  amount={formatUsd(totals.transcribeUsd, lang)}
                />
              )}
              {totals.refineChunks > 0 && (
                <Cost
                  label={t`${plural(ph({ count: totals.refineChunks }), { one: `Refine # chunk`, other: `Refine # chunks` })}`}
                  amount={formatUsd(totals.refineUsd, lang)}
                />
              )}
              {totals.unindexed > 0 && (
                <Cost
                  label={t`${plural(ph({ count: totals.unindexed }), { one: `Index # video`, other: `Index # videos` })}`}
                  amount="—"
                />
              )}
              <Cost label={t`Estimated Total`} amount={formatUsd(usd, lang)} strong />
            </dl>
            {totals.unpriced > 0 && (
              <p className="text-muted-foreground text-xs">
                {t`${plural(ph({ count: totals.unpriced }), { one: `# video can't be priced yet: its length is known only once it downloads.`, other: `# videos can't be priced yet: their length is known only once they download.` })}`}
              </p>
            )}
          </div>
        )}
        {totals.noDate > 0 && (
          <p className="text-sm">{t`${plural(ph({ count: totals.noDate }), { one: `# downloaded video has no upload date, so it waits until you give one in the table below.`, other: `# downloaded videos have no upload date, so they wait until you give one in the table below.` })}`}</p>
        )}
        <Collapsible open={advanced} onOpenChange={setAdvanced}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="-ml-2.5 text-muted-foreground">
              <ChevronDownIcon className={cn(advanced && "rotate-180")} />
              {t`Advanced`}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <Field>
              <FieldLabel htmlFor={concurrencyId}>{t`Transcriptions at Once`}</FieldLabel>
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
                className="max-w-24"
              />
              <FieldDescription>
                {t`Soniox allows up to ${ph({ max: MAX_CONCURRENCY })} at once per account.`}
              </FieldDescription>
            </Field>
          </CollapsibleContent>
        </Collapsible>
      </SectionCard>

      {runJob && <JobCard key={runJob.id} job={runJob} events={runEvents} onEnded={onRunEnded} />}

      <SectionCard
        title={t`Videos`}
        description={t`Where each video stands by the latest plan, and what the running job is doing.`}
        action={
          <Button variant="outline" size="sm" disabled={plan.refreshing} onClick={plan.refresh}>
            <RefreshCwIcon className={cn(plan.refreshing && "animate-spin")} />
            {t`Plan Again`}
          </Button>
        }
      >
        {plan.refreshing && (
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            <Spinner />
            {t`Reading the persona's sources…`}
          </p>
        )}
        {plan.failed && (
          <Alert variant="destructive">
            <AlertDescription>{t`The plan couldn't be made. Its job page has the details.`}</AlertDescription>
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
              start.mutate({
                command: "transcribe",
                persona: persona.id,
                options: { video: video.id, date },
              })
            }
          />
        )}
      </SectionCard>

      <SettingsCard
        scope="persona"
        persona={persona.id}
        paths={CARD_PATHS.transcription}
        title={t`Transcription`}
        description={t`How her videos become transcripts: the language and model Soniox transcribes with, and the model that refines them, with how many chunks it works on at once.`}
        onSaved={(values) => {
          if (outdatesPlan(values)) plan.outdated();
        }}
      />
    </>
  );
}
