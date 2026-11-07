// Adding videos: each link becomes an `expand` job that lists the videos behind it, one link at a
// time, then a preview, and on confirm a new batch.
import type { EventCode, PlanVideo, PlaylistEntry, Provider } from "@eidolon/ingest/progress";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheckIcon,
  CircleSlashIcon,
  CircleXIcon,
  ClockIcon,
  LanguagesIcon,
  ListPlusIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ListCard, ListRow } from "@/components/list";
import { QuietBadge } from "@/components/quiet-badge";
import { SectionCard } from "@/components/section-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { reasonText } from "@/features/jobs/describe";
import { followJob, refreshJob } from "@/features/jobs/use-job-events";
import { ApiError, type BatchResponse, call, errorKey } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { formatBytes, formatCount, formatDuration } from "@/lib/format";
import { useLang, useT } from "@/lib/i18n";
import { EMPTY_JOB_VIEW, type JobView, jobOutcome, reduceJob, runSummary } from "@/lib/jobs";
import { cn } from "@/lib/utils";
import { Hint } from "./parts";
import { estimateAudioBytes, knownIn, parseLinks, summarizeEntries, uniqueEntries } from "./videos";

interface Failure {
  readonly code: EventCode | null;
  readonly provider: Provider | null;
  /** The locale key of a request that failed before the job could say why. */
  readonly errorKey: string | null;
  /** The CLI's or the server's English, shown as detail. */
  readonly detail: string | null;
}

interface Check {
  readonly url: string;
  readonly state: "waiting" | "running" | "done" | "failed" | "cancelled";
  readonly entries: readonly PlaylistEntry[];
  readonly failure: Failure | null;
  readonly job: string | null;
}

function failureOf(view: JobView, stderrTail: string): Failure {
  const stage = view.stages.find((entry) => entry.status === "failed");
  const listed = runSummary(view, "expand")?.failures?.[0]?.error;
  return {
    code: stage?.code ?? null,
    provider: stage?.provider ?? null,
    errorKey: null,
    detail: stage?.message ?? listed ?? (stderrTail.trim().split("\n").at(-1) || null),
  };
}

const STATE_ICONS = {
  waiting: ClockIcon,
  done: CircleCheckIcon,
  failed: CircleXIcon,
  cancelled: CircleSlashIcon,
} as const;

/** Rows of a compact list, where a row is one line. */
const COMPACT = "min-h-11 py-2";

function CheckRow({ check }: { readonly check: Check }) {
  const t = useT();
  const Icon = check.state === "running" ? null : STATE_ICONS[check.state];
  const reason =
    check.failure === null
      ? null
      : (reasonText(t, check.failure.code, check.failure.provider) ??
        t(check.failure.errorKey ?? "studio.videos.checkFailed"));
  return (
    <ListRow
      className={COMPACT}
      leading={
        Icon ? (
          <Icon
            className={cn(
              "size-4",
              check.state === "failed" && "text-destructive",
              check.state === "done" && "text-success",
            )}
          />
        ) : (
          <Spinner />
        )
      }
      title={
        <span className="block truncate font-mono font-normal text-xs" title={check.url}>
          {check.url}
        </span>
      }
      description={
        reason ? (
          <span className="text-destructive text-xs">
            {reason}
            {check.failure?.detail && (
              <span className="block break-words text-muted-foreground">
                {check.failure.detail}
              </span>
            )}
          </span>
        ) : undefined
      }
      trailing={
        <>
          {check.entries.length > 0 && (
            <span className="text-muted-foreground text-xs tabular-nums">
              {t("studio.videos.checkFound", { count: check.entries.length })}
            </span>
          )}
          {/* Link checks are kept only until the next one, so only the running one has a page. */}
          {check.job && check.state === "running" && (
            <Link
              to={`/jobs/${encodeURIComponent(check.job)}`}
              className="text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
            >
              {t("jobs.details")}
            </Link>
          )}
        </>
      }
    />
  );
}

export function AddVideosCard({
  persona,
  videos,
  freeBytes,
  onAdded,
}: {
  readonly persona: string;
  /** What the persona has already, by the latest plan. */
  readonly videos: readonly PlanVideo[];
  readonly freeBytes: number | null;
  readonly onAdded: (result: BatchResponse) => void;
}) {
  const t = useT();
  const lang = useLang();
  const id = useId();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState<readonly string[]>([]);
  const [checks, setChecks] = useState<readonly Check[] | null>(null);
  const checking =
    checks?.some((check) => check.state === "waiting" || check.state === "running") ?? false;
  const run = useRef<AbortController | null>(null);
  const known = useMemo(() => knownIn(videos), [videos]);

  // Leaving the page stops following; a link check left running ends on its own.
  useEffect(() => () => run.current?.abort(), []);

  const update = (at: number, patch: Partial<Check>) =>
    setChecks((current) =>
      current === null
        ? null
        : current.map((check, i) => (i === at ? { ...check, ...patch } : check)),
    );

  async function checkLinks() {
    const links = parseLinks(text);
    setInvalid(links.invalid);
    if (links.invalid.length > 0 || links.urls.length === 0) return;
    const controller = new AbortController();
    run.current = controller;
    const { signal } = controller;
    setChecks(
      links.urls.map((url) => ({ url, state: "waiting", entries: [], failure: null, job: null })),
    );
    for (const [at, url] of links.urls.entries()) {
      if (signal.aborted) break;
      update(at, { state: "running" });
      try {
        const job = await call("POST /api/local/jobs", {
          body: { command: "expand", persona, options: { url } },
          signal,
        });
        update(at, { job: job.id });
        let view = EMPTY_JOB_VIEW;
        await followJob(
          job.id,
          signal,
          (event) => {
            view = reduceJob(view, [event]);
            if (event.type === "entry") update(at, { entries: view.entries });
          },
          () => refreshJob(queryClient, job.id),
        );
        if (signal.aborted) break;
        const ended = await refreshJob(queryClient, job.id);
        const outcome = jobOutcome(ended);
        update(
          at,
          outcome === "succeeded"
            ? { state: "done", entries: view.entries }
            : {
                state: outcome === "cancelled" ? "cancelled" : "failed",
                failure: failureOf(view, ended.stderrTail),
              },
        );
      } catch (error) {
        if (signal.aborted) break;
        update(at, {
          state: "failed",
          failure: {
            code: null,
            provider: null,
            errorKey: errorKey(error),
            detail: error instanceof ApiError ? error.message : null,
          },
        });
      }
    }
    if (signal.aborted) {
      setChecks((current) =>
        current === null
          ? null
          : current.map((check) =>
              check.state === "waiting" || check.state === "running"
                ? { ...check, state: "cancelled" }
                : check,
            ),
      );
    }
  }

  function stop() {
    const job = checks?.find((check) => check.state === "running")?.job;
    run.current?.abort();
    if (job) {
      void call("DELETE /api/local/jobs/:id", { params: { id: job } }).catch(() => {
        // It ends on its own; the jobs page shows how.
      });
    }
  }

  const add = useMutation({
    mutationFn: (urls: readonly string[]) =>
      call("POST /api/local/personas/:id/batches", { params: { id: persona }, body: { urls } }),
    onSuccess: (result) => {
      if (result.batch === null) toast.info(t("studio.videos.allKnown"));
      else {
        toast.success(
          result.known > 0
            ? t("studio.videos.addedSome", { count: result.count, known: result.known })
            : t("studio.videos.added", { count: result.count }),
        );
      }
      setChecks(null);
      setText("");
      onAdded(result);
    },
    onError: toastError,
  });

  const entries = uniqueEntries(checks?.flatMap((check) => check.entries) ?? []);
  const fresh = entries.filter((entry) => !known(entry));
  const summary = summarizeEntries(fresh);
  const bytes = estimateAudioBytes(summary.durationSec);
  const tooBig = freeBytes !== null && bytes > freeBytes;
  const previewing = entries.length > 0;

  return (
    <SectionCard
      title={t("studio.videos.addTitle")}
      description={t("studio.videos.addHelp")}
      actions={
        <>
          {checking && (
            <Button variant="outline" onClick={stop}>
              {t("studio.videos.stopCheck")}
            </Button>
          )}
          {checks !== null && !checking && (
            <Button variant="ghost" onClick={() => setChecks(null)}>
              {t("studio.videos.clear")}
            </Button>
          )}
          <Button
            variant={previewing ? "outline" : "default"}
            onClick={() => void checkLinks()}
            disabled={checking || text.trim() === ""}
          >
            {checking && <Spinner />}
            {t("studio.videos.check")}
          </Button>
          {previewing && (
            <Button
              onClick={() => add.mutate(entries.map((entry) => entry.url))}
              disabled={checking || add.isPending || fresh.length === 0}
            >
              {add.isPending ? <Spinner /> : <ListPlusIcon />}
              {fresh.length === 0
                ? t("studio.videos.nothingNew")
                : t("studio.videos.add", { count: fresh.length })}
            </Button>
          )}
        </>
      }
    >
      <Field data-invalid={invalid.length > 0}>
        <FieldLabel htmlFor={id}>{t("studio.videos.links")}</FieldLabel>
        <Textarea
          id={id}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t("studio.videos.linksPlaceholder")}
          disabled={checking}
          spellCheck={false}
          rows={4}
          className="font-mono md:text-[0.8125rem]"
        />
        {invalid.length > 0 ? (
          <FieldError>
            {t("studio.videos.invalidLinks")}
            <ul className="mt-1 font-mono text-xs">
              {invalid.map((line) => (
                <li key={line} className="truncate">
                  {line}
                </li>
              ))}
            </ul>
          </FieldError>
        ) : (
          <FieldDescription>{t("studio.videos.linksHelp")}</FieldDescription>
        )}
      </Field>
      <Hint icon={<LanguagesIcon />}>{t("studio.videos.scopeNote")}</Hint>
      {checks !== null && (
        <ListCard label={t("studio.videos.checksLabel")}>
          {checks.map((check) => (
            <CheckRow key={check.url} check={check} />
          ))}
        </ListCard>
      )}
      {previewing && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="font-medium text-sm">
              {t("studio.videos.preview", {
                count: fresh.length,
                known: formatCount(entries.length - fresh.length, lang),
              })}
            </p>
            <p className="text-muted-foreground text-sm">
              {t("studio.videos.previewLength", { duration: formatDuration(summary.durationSec) })}
              {summary.unknownDuration > 0 &&
                ` ${t("studio.videos.previewUnknown", { count: summary.unknownDuration })}`}
              {` ${t("studio.videos.previewDisk", {
                size: formatBytes(bytes, lang),
                free: freeBytes === null ? "?" : formatBytes(freeBytes, lang),
              })}`}
            </p>
          </div>
          {tooBig && (
            <Alert variant="destructive">
              <AlertDescription>{t("studio.videos.diskShort")}</AlertDescription>
            </Alert>
          )}
          <ListCard label={t("studio.videos.previewLabel")} className="max-h-80 overflow-y-auto">
            {entries.map((entry) => (
              <ListRow
                key={entry.id}
                className={COMPACT}
                title={
                  <span className="block truncate font-normal" title={entry.url}>
                    {entry.title ?? entry.url}
                  </span>
                }
                trailing={
                  <>
                    {known(entry) && <QuietBadge>{t("studio.videos.alreadyAdded")}</QuietBadge>}
                    <span className="w-14 text-right text-muted-foreground text-xs tabular-nums">
                      {entry.durationSec === undefined ? "—" : formatDuration(entry.durationSec)}
                    </span>
                  </>
                }
              />
            ))}
          </ListCard>
        </div>
      )}
    </SectionCard>
  );
}
