// Every video the persona's sources know, as the plan last saw it, and what the running job is
// doing to each meanwhile.
import type { PlanVideo } from "@eidolon/ingest/progress";
import { ExternalLinkIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { reasonText } from "@/features/jobs/describe";
import { formatDuration, formatUsd } from "@/features/jobs/format";
import { progressText } from "@/features/jobs/parts";
import { type Lang, type Translate, useLang, useT } from "@/lib/i18n";
import type { ItemView } from "@/lib/jobs";
import { hasPaidWork, isFinished, needsFfmpeg } from "./videos";

/** Rows shown before "Show more". */
const PAGE = 100;

type Tone = "default" | "secondary" | "destructive" | "outline";

function planState(t: Translate, video: PlanVideo): { label: string; tone: Tone } {
  if (video.download === "pending")
    return { label: t("studio.table.notDownloaded"), tone: "outline" };
  if (video.transcribe === "no-date")
    return { label: t("studio.table.noDate"), tone: "destructive" };
  if (video.transcribe === "no-speech")
    return { label: t("studio.table.noSpeech"), tone: "secondary" };
  if (video.transcribe === "pending")
    return { label: t("studio.table.toTranscribe"), tone: "outline" };
  if (video.refine === null) return { label: t("studio.table.unreadable"), tone: "destructive" };
  if (video.refine.done < video.refine.chunks) {
    return {
      label: t("studio.table.toRefine", { done: video.refine.done, total: video.refine.chunks }),
      tone: "outline",
    };
  }
  if (!video.indexed) return { label: t("studio.table.toIndex"), tone: "outline" };
  return { label: t("studio.table.indexed"), tone: "secondary" };
}

function liveState(t: Translate, lang: Lang, item: ItemView): { label: string; tone: Tone } {
  const stage = t(`jobs.stage.${item.stage}`);
  if (item.status === "start") {
    const progress = item.progress === null ? null : progressText(t, lang, item.progress);
    return {
      label: progress === null ? t("studio.table.working", { stage }) : `${stage} · ${progress}`,
      tone: "default",
    };
  }
  if (item.status === "failed") {
    return {
      label: `${stage}: ${reasonText(t, item.code, item.provider) ?? t("jobs.item.failed")}`,
      tone: "destructive",
    };
  }
  return { label: `${stage}: ${t(`jobs.item.${item.status}`)}`, tone: "secondary" };
}

/** A link out, only to an https: page. */
function SourceLink({ url }: { readonly url: string | undefined }) {
  const t = useT();
  if (url === undefined || !url.startsWith("https://")) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={t("studio.table.open")}
      className="text-muted-foreground hover:text-foreground"
    >
      <ExternalLinkIcon className="size-3.5" />
    </a>
  );
}

/** A video without an upload date, transcribed as if streamed on the day the viewer gives. */
function DateDialog({
  video,
  busy,
  onClose,
  onTranscribe,
}: {
  readonly video: PlanVideo | null;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onTranscribe: (video: PlanVideo, date: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [date, setDate] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (video !== null && /^\d{4}-\d{2}-\d{2}$/.test(date)) onTranscribe(video, date);
  }
  return (
    <Dialog open={video !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t("studio.table.dateTitle")}</DialogTitle>
            <DialogDescription>
              {t("studio.table.dateHelp", { video: video?.title ?? video?.id ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={id}>{t("studio.table.dateLabel")}</FieldLabel>
            <Input
              id={id}
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              required
              className="w-48"
            />
            <FieldDescription>{t("studio.table.dateBilled")}</FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("studio.references.cancel")}
            </Button>
            <Button type="submit" disabled={busy || date === ""}>
              {t("studio.table.dateSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function VideoTable({
  videos,
  activity,
  ffmpeg,
  busy,
  onTranscribe,
}: {
  readonly videos: readonly PlanVideo[];
  /** The running job's latest item per video id and per URL. */
  readonly activity: ReadonlyMap<string, ItemView>;
  /** ffmpeg is installed. */
  readonly ffmpeg: boolean;
  /** A job runs, so no other can start. */
  readonly busy: boolean;
  readonly onTranscribe: (video: PlanVideo, date: string) => void;
}) {
  const t = useT();
  const lang = useLang();
  const switchId = useId();
  const finished = videos.filter(isFinished).length;
  const [showFinished, setShowFinished] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [dating, setDating] = useState<PlanVideo | null>(null);
  // With nothing left to do, hiding the finished ones would hide everything.
  const all = showFinished || finished === videos.length;
  const shown = all ? videos : videos.filter((video) => !isFinished(video));

  if (videos.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
        {t("studio.table.empty")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          {t("studio.table.counts", { total: videos.length, finished })}
        </p>
        {finished > 0 && finished < videos.length && (
          <div className="flex items-center gap-2">
            <Switch id={switchId} checked={showFinished} onCheckedChange={setShowFinished} />
            <Label htmlFor={switchId} className="text-sm">
              {t("studio.table.showFinished")}
            </Label>
          </div>
        )}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("studio.table.video")}</TableHead>
            <TableHead>{t("studio.table.date")}</TableHead>
            <TableHead>{t("studio.table.length")}</TableHead>
            <TableHead>{t("studio.table.state")}</TableHead>
            <TableHead className="text-right">{t("studio.table.estimate")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.slice(0, limit).map((video) => {
            const live =
              activity.get(video.id) ?? (video.url ? activity.get(video.url) : undefined);
            const state = live ? liveState(t, lang, live) : planState(t, video);
            const usd = (video.estimate.transcribeUsd ?? 0) + (video.estimate.refineUsd ?? 0);
            const unpriced = video.estimate.basis === "unpriced" && hasPaidWork(video);
            return (
              <TableRow key={video.id}>
                <TableCell className="max-w-80 whitespace-normal">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate" title={video.title ?? video.id}>
                      {video.title ?? video.id}
                    </span>
                    <SourceLink url={video.url} />
                  </div>
                  {video.title && (
                    <div className="font-mono text-muted-foreground text-xs">{video.id}</div>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {video.uploadDate ?? "—"}
                </TableCell>
                <TableCell className="tabular-nums">
                  {video.durationSec === undefined ? "—" : formatDuration(video.durationSec)}
                  {!ffmpeg && needsFfmpeg(video) && (
                    <Badge variant="destructive" className="ml-2">
                      {t("studio.table.needsFfmpeg")}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={state.tone}>{state.label}</Badge>
                    {!live && video.transcribe === "no-date" && video.download === "done" && (
                      <Button
                        variant="link"
                        size="xs"
                        disabled={busy}
                        onClick={() => setDating(video)}
                      >
                        {t("studio.table.setDate")}
                      </Button>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {unpriced ? (
                    <span className="text-muted-foreground" title={t("studio.table.unpriced")}>
                      ?
                    </span>
                  ) : usd > 0 ? (
                    formatUsd(usd, lang)
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {shown.length > limit && (
        <Button
          variant="outline"
          size="sm"
          className="self-center"
          onClick={() => setLimit(limit + PAGE)}
        >
          {t("studio.table.more", { count: shown.length - limit })}
        </Button>
      )}
      <DateDialog
        key={dating?.id ?? ""}
        video={dating}
        busy={busy}
        onClose={() => setDating(null)}
        onTranscribe={(video, date) => {
          setDating(null);
          onTranscribe(video, date);
        }}
      />
    </div>
  );
}
