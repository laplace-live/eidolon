// Every video the persona's sources know, as the plan last saw it, and what the running job is
// doing to each meanwhile.
import type { PlanVideo } from "@eidolon/ingest/progress";
import { ExternalLinkIcon, VideoIcon } from "lucide-react";
import { type FormEvent, memo, useId, useState } from "react";
import { EmptyState } from "@/components/empty-state";
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
import { progressText } from "@/features/jobs/parts";
import { formatDuration, formatUsd } from "@/lib/format";
import { type Lang, type Translate, useLang, useT } from "@/lib/i18n";
import type { ItemView } from "@/lib/jobs";
import { cn } from "@/lib/utils";
import { hasPaidWork, isFinished, needsFfmpeg } from "./videos";

/** Rows shown before "Show more". */
const PAGE = 100;

/** Edge to edge in its card: the first and last columns take the card's padding. */
const EDGE = "first:pl-6 last:pr-6";

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

/** A video's row: its plan entry and item keep their objects, so only changed rows render. */
const VideoRow = memo(function VideoRow({
  video,
  live,
  ffmpeg,
  busy,
  onSetDate,
}: {
  readonly video: PlanVideo;
  /** The running job's latest item for it. */
  readonly live: ItemView | undefined;
  readonly ffmpeg: boolean;
  readonly busy: boolean;
  readonly onSetDate: (video: PlanVideo) => void;
}) {
  const t = useT();
  const lang = useLang();
  const state = live ? liveState(t, lang, live) : planState(t, video);
  const usd = (video.estimate.transcribeUsd ?? 0) + (video.estimate.refineUsd ?? 0);
  const unpriced = video.estimate.basis === "unpriced" && hasPaidWork(video);
  return (
    <TableRow className="hover:bg-muted/30">
      <TableCell className={cn(EDGE, "max-w-80 whitespace-normal py-3")}>
        <div className="flex items-center gap-1.5">
          <span className="truncate" title={video.title ?? video.id}>
            {video.title ?? video.id}
          </span>
          <SourceLink url={video.url} />
        </div>
        {video.title && <div className="font-mono text-muted-foreground text-xs">{video.id}</div>}
      </TableCell>
      <TableCell className={cn(EDGE, "text-muted-foreground tabular-nums")}>
        {video.uploadDate ?? "—"}
      </TableCell>
      <TableCell className={cn(EDGE, "tabular-nums")}>
        {video.durationSec === undefined ? "—" : formatDuration(video.durationSec)}
        {!ffmpeg && needsFfmpeg(video) && (
          <Badge variant="destructive" className="ml-2">
            {t("studio.table.needsFfmpeg")}
          </Badge>
        )}
      </TableCell>
      <TableCell className={EDGE}>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={state.tone}>{state.label}</Badge>
          {!live && video.transcribe === "no-date" && video.download === "done" && (
            <Button variant="link" size="xs" disabled={busy} onClick={() => onSetDate(video)}>
              {t("studio.table.setDate")}
            </Button>
          )}
        </div>
      </TableCell>
      <TableCell className={cn(EDGE, "text-right tabular-nums")}>
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
});

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
      <EmptyState
        icon={<VideoIcon />}
        title={t("studio.table.emptyTitle")}
        description={t("studio.table.empty")}
      />
    );
  }

  const more = shown.length > limit;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-muted-foreground text-sm">
          {t("studio.table.counts", { total: videos.length, finished })}
        </p>
        {finished > 0 && finished < videos.length && (
          <div className="flex items-center gap-2">
            <Switch id={switchId} checked={showFinished} onCheckedChange={setShowFinished} />
            <Label htmlFor={switchId} className="font-normal text-sm">
              {t("studio.table.showFinished")}
            </Label>
          </div>
        )}
      </div>
      {/* Last in the card, its last row sits on the card's edge. */}
      <div className={cn("-mx-6 border-t", !more && "-mb-6")}>
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              {(["video", "date", "length", "state", "estimate"] as const).map((column) => (
                <TableHead
                  key={column}
                  className={cn(
                    EDGE,
                    "h-9 font-normal text-muted-foreground text-xs",
                    column === "estimate" && "text-right",
                  )}
                >
                  {t(`studio.table.${column}`)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.slice(0, limit).map((video) => (
              <VideoRow
                key={video.id}
                video={video}
                live={activity.get(video.id) ?? (video.url ? activity.get(video.url) : undefined)}
                ffmpeg={ffmpeg}
                busy={busy}
                onSetDate={setDating}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      {more && (
        <Button variant="outline" className="self-center" onClick={() => setLimit(limit + PAGE)}>
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
    </>
  );
}
